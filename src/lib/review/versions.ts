import { randomUUID } from "node:crypto";
import { bunnyApiConfig, isBunnyDryRun } from "@/lib/bunny/config";
import { fetchVideoFromUrl, findVideosByTitle, getVideo } from "@/lib/bunny/client";
import { describeError } from "@/lib/bunny/errors";
import { signedOriginalUrl } from "@/lib/bunny/sign";
import { deriveVersionFromVideo, type BunnyVideo, type ReviewVersionStatus } from "@/lib/bunny/status";
import { checkReviewFile, driveMediaUrl, serviceAccountToken, type CheckedReviewFile } from "@/lib/google/drive";

// ═══════════════════════════════════════════════════════════════════════════
// E13-4 — "שלח לביקורת": a Drive file becomes a Bunny review version (plan §5).
// Server-side only. The routes are thin; every decision is here.
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ORDER (deliberate, differs from §5.1 step 5 — see the E13-4 report):
//   check the Drive file → id generated HERE → ONE Fetch Video titled
//   "bizi-<id>" → only then the version row, with that id.
// 0116 lets a Bunny row lack a guid ONLY while 'uploading' (crv_bunny_fields_chk),
// so a row written before a fetch that then failed could never be marked
// 'failed' — it would sit in 'uploading' forever, and the Q17 index
// (uq_crv_item_drive_sha) would refuse the same file again. Writing the row
// after Bunny accepted the request means a failed request leaves NO row,
// only an event, and the technician simply sends again.
//
// A failed request is NEVER re-sent automatically (lesson of 00f475d: Bunny
// may have created the video anyway). Instead the title is searched once:
// found → the row is written with that guid; not found → nothing is written.
//
// THE GUID: Fetch Video returns none (§5.3). It is found by title — in the
// send route (a short search), and by every refresh after that. It is written
// once (`where bunny_video_id is null`).
//
// STATUS: applyVideoState() is the one place a fetched video object becomes
// our columns — moves forward only, numbers the version once the upload is
// confirmed (Q11, via assign_review_version_number), and runs the integrity
// check (decision 4) once Bunny says ready. The webhook (E13-5) will call it too.
//
// DRY RUN (BUNNY_DRY_RUN, rule 40): every Drive check runs for real; nothing
// is sent to Bunny, NO item and NO version row is written, and the answer
// shows what would have been sent (Authorization redacted).

export type Integrity = "hash_match" | "size_match" | "mismatch" | "unchecked";

export type VersionRow = {
  id: string;
  item_id: string;
  number: number | null;
  source: "drive" | "bunny";
  media_link: string | null;
  bunny_video_id: string | null;
  bunny_status: ReviewVersionStatus | null;
  bunny_status_raw: number | null;
  is_audio_only: boolean;
  original_filename: string | null;
  original_size_bytes: number | null;
  drive_file_id: string | null;
  drive_sha256: string | null;
  drive_size_bytes: number | null;
  integrity: Integrity | null;
  ready_at: string | null;
  fetch_requested_at: string | null;
  is_backfill: boolean;
  created_at: string;
};

export type NewBunnyVersion = {
  id: string;
  item_id: string;
  source: "bunny";
  bunny_library_id: number;
  bunny_video_id: string | null;
  bunny_status: "uploading";
  bunny_status_at: string;
  is_audio_only: boolean;
  original_filename: string;
  original_size_bytes: number;
  drive_file_id: string;
  drive_sha256: string | null;
  drive_size_bytes: number;
  drive_mime_type: string;
  fetch_requested_at: string;
  created_by: string;
};

export type VersionPatch = Partial<{
  bunny_status: ReviewVersionStatus;
  bunny_status_raw: number;
  bunny_status_at: string;
  duration_ms: number | null;
  has_original: boolean;
  original_sha256: string | null;
  ready_at: string;
  integrity: Integrity;
  integrity_at: string;
}>;

export type ItemKind = "episode" | "reel";

/** Everything the logic needs from the database — Supabase in the routes, memory in the tests. */
export interface VersionStore {
  production(id: string): Promise<{ id: string; has_episode: boolean; reels_count: number } | null>;
  findItem(productionId: string, kind: ItemKind, reelIndex: number | null): Promise<{ id: string } | null>;
  /** Q6 (owner 16.10): an item born here is ALWAYS approved=false. Seeded concurrently → the existing one. */
  createItem(productionId: string, kind: ItemKind, reelIndex: number | null): Promise<{ id: string }>;
  /** Q17: a version of this item, same Drive file AND same sha256, not failed, media not deleted. */
  activeSameFile(itemId: string, driveFileId: string, sha256: string): Promise<{ id: string; number: number | null } | null>;
  /** "duplicate" = the Q17 unique index refused it (a concurrent send of the same file). */
  insertVersion(row: NewBunnyVersion): Promise<"ok" | "duplicate">;
  /** Writes the guid only where none is set yet. false = already set, or the guid belongs to another version. */
  attachGuid(versionId: string, guid: string): Promise<boolean>;
  update(versionId: string, patch: VersionPatch): Promise<void>;
  getVersion(versionId: string): Promise<VersionRow | null>;
  /** The production a version belongs to (through its item) — refresh is scoped to the production in the URL. */
  versionProduction(versionId: string): Promise<string | null>;
  assignNumber(versionId: string): Promise<number>;
  event(type: string, productionId: string, payload: Record<string, unknown>, actorId?: string | null): Promise<void>;
}

export type Deps = {
  store: VersionStore;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
};

export type Answer = { status: number; body: Record<string, unknown> };

const err = (status: number, error: string, extra: Record<string, unknown> = {}): Answer => ({ status, body: { error, ...extra } });

export const versionTitle = (versionId: string) => `bizi-${versionId}`;

/** How long the send route waits for Bunny to list the new video: GUID_TRIES searches, GUID_WAIT_MS apart. */
export const GUID_TRIES = 3;
export const GUID_WAIT_MS = 1500;

// The fetch route's order: WE write 'uploading' when the request is sent,
// THEN Bunny reports its video Created (0) while it pulls. (The TUS-era order
// of 0114 was the reverse — created by us, then uploaded by the browser.)
const RANK: Record<Exclude<ReviewVersionStatus, "failed">, number> = {
  uploading: 0,
  created: 1,
  processing: 2,
  playable: 3,
  ready: 4,
};

/** A version that needs no more polling. Drive history is always final. */
export function isFinal(v: Pick<VersionRow, "source" | "bunny_status" | "integrity">): boolean {
  if (v.source !== "bunny") return true;
  if (v.bunny_status === "failed") return true;
  return v.bunny_status === "ready" && (v.integrity === "hash_match" || v.integrity === "size_match" || v.integrity === "mismatch");
}

// ── the guid, by title ─────────────────────────────────────────────────────

/**
 * The video Bunny created for this title, if it lists one yet. Exact title
 * match only (the API's search is a substring). Two with the same title: the
 * earliest is the one, and the event says so (§5.3) — the other is never linked.
 */
async function videoByTitle(
  title: string,
  productionId: string,
  versionId: string,
  store: VersionStore
): Promise<BunnyVideo | null> {
  const found = (await findVideosByTitle(title)).filter((v) => v.title === title && typeof v.guid === "string");
  if (!found.length) return null;
  found.sort((a, b) => String(a.dateUploaded ?? "").localeCompare(String(b.dateUploaded ?? "")));
  if (found.length > 1) {
    await store.event("review_fetch_duplicate", productionId, {
      version_id: versionId,
      title,
      linked_guid: found[0].guid,
      other_guids: found.slice(1).map((v) => v.guid),
    });
  }
  return found[0];
}

// ── send ───────────────────────────────────────────────────────────────────

export type SendInput = {
  productionId: string;
  kind: unknown;
  reelIndex: unknown;
  driveUrl: unknown;
  userId: string;
};

/** POST /api/productions/[id]/review-versions — the caller already checked can_edit_stages. */
export async function sendForReview(input: SendInput, deps: Deps): Promise<Answer> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // 1. what is being sent where
  const kind = input.kind === "episode" || input.kind === "reel" ? input.kind : null;
  if (!kind) return err(400, "סוג פריט לא תקין");
  const driveUrl = typeof input.driveUrl === "string" ? input.driveUrl.trim() : "";
  if (!driveUrl) return err(400, "הדבק קישור לקובץ ב-Drive");
  const prod = await store.production(input.productionId);
  if (!prod) return err(404, "ההפקה לא נמצאה");
  let reelIndex: number | null = null;
  if (kind === "episode") {
    if (!prod.has_episode) return err(400, "להפקה אין פרק");
  } else {
    const idx = Number(input.reelIndex);
    const count = Number(prod.reels_count) || 0;
    if (!Number.isInteger(idx) || idx < 1 || idx > count) return err(400, `אינדקס ריל לא תקין (1–${count})`);
    reelIndex = idx;
  }

  // 2. the Drive gate (decision 3). A fresh token, used for the check AND handed to Bunny (decision 6).
  const { token } = await serviceAccountToken();
  const check = await checkReviewFile(driveUrl, { token });
  if (!check.ok) return err(422, check.message, { code: check.code });
  const file: CheckedReviewFile = check.file;

  // 3. Q17 — the same file, unchanged, already sent to this item
  const item = await store.findItem(input.productionId, kind, reelIndex);
  if (item && file.sha256) {
    const same = await store.activeSameFile(item.id, file.fileId, file.sha256);
    if (same) {
      return err(409, `הקובץ הזה כבר נשלח לפריט${same.number ? ` (v${same.number})` : " ועדיין בעיבוד"}. אם החלפת אותו ב-Drive, העלה את הגרסה החדשה`, {
        code: "duplicate",
        version_id: same.id,
      });
    }
  }

  const versionId = (deps.newId ?? randomUUID)();
  const title = versionTitle(versionId);
  const sourceUrl = driveMediaUrl(file.fileId);
  const fileSummary = {
    name: file.name,
    size_bytes: file.sizeBytes,
    mime_type: file.mimeType,
    sha256: file.sha256 ? "present" : null,
    is_audio_only: file.isAudioOnly,
  };

  // 4. dry run: everything above ran for real; nothing below runs
  if (isBunnyDryRun()) {
    return {
      status: 200,
      body: {
        dryRun: true,
        message: "בדיקה בלבד (BUNNY_DRY_RUN): הקובץ עבר את כל הבדיקות, ולא נשלח ל-Bunny",
        file: fileSummary,
        wouldSend: { url: sourceUrl, title, headers: { Authorization: "<redacted>" } },
        item: item ? "existing" : "would_be_created",
      },
    };
  }

  // 5. ONE Fetch Video. Never re-sent here.
  const { libraryId } = bunnyApiConfig();
  const requestedAt = now().toISOString();
  let guid: string | null = null;
  try {
    await fetchVideoFromUrl(sourceUrl, { Authorization: `Bearer ${token}` }, title);
  } catch (e) {
    // the request failed — but Bunny may have made the video anyway (00f475d)
    let found: BunnyVideo | null = null;
    try {
      found = await videoByTitle(title, input.productionId, versionId, store);
    } catch {
      found = null;
    }
    if (!found) {
      await store.event(
        "review_version_fetch_failed",
        input.productionId,
        { version_id: versionId, kind, reel_index: reelIndex, file: fileSummary, error: describeError(e) },
        input.userId
      );
      return err(502, `Bunny לא קיבל את הבקשה: ${describeError(e)}. לא נשמר כלום, אפשר לשלוח שוב`);
    }
    guid = found.guid;
  }

  // 6. the row — now, with the id Bunny already carries in its title
  const target = item ?? (await store.createItem(input.productionId, kind, reelIndex));
  const inserted = await store.insertVersion({
    id: versionId,
    item_id: target.id,
    source: "bunny",
    bunny_library_id: Number(libraryId),
    bunny_video_id: guid,
    bunny_status: "uploading",
    bunny_status_at: requestedAt,
    is_audio_only: file.isAudioOnly,
    original_filename: file.name,
    original_size_bytes: file.sizeBytes,
    drive_file_id: file.fileId,
    drive_sha256: file.sha256,
    drive_size_bytes: file.sizeBytes,
    drive_mime_type: file.mimeType,
    fetch_requested_at: requestedAt,
    created_by: input.userId,
  });
  if (inserted === "duplicate") {
    // a concurrent send of the same file won the race; this request's video is the orphan
    await store.event("review_fetch_duplicate", input.productionId, { version_id: versionId, title, reason: "q17_concurrent_send" }, input.userId);
    return err(409, "הקובץ הזה נשלח הרגע לאותו פריט מבקשה אחרת", { code: "duplicate" });
  }
  await store.event(
    "review_version_fetch_requested",
    input.productionId,
    { version_id: versionId, item_id: target.id, kind, reel_index: reelIndex, file: fileSummary, item_created: !item },
    input.userId
  );

  // 7. a short wait for the guid; whatever is not found now, refresh finds later
  if (!guid) {
    for (let i = 0; i < GUID_TRIES && !guid; i++) {
      if (i > 0) await sleep(GUID_WAIT_MS);
      try {
        const v = await videoByTitle(title, input.productionId, versionId, store);
        if (v && (await store.attachGuid(versionId, v.guid))) guid = v.guid;
      } catch {
        break; // a listing failure is not a send failure — refresh retries
      }
    }
  }
  if (guid) {
    try {
      const video = await getVideo(guid);
      const row = await store.getVersion(versionId);
      if (video && row) await applyVideoState(row, video, input.productionId, deps);
    } catch {
      /* the first status read is a courtesy; refresh does it again */
    }
  }

  const row = await store.getVersion(versionId);
  return {
    status: 200,
    body: { ok: true, message: "נשלח. Bunny מושך את הקובץ מ-Drive", version: row ? publicVersion(row) : { id: versionId } },
  };
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * A freshly FETCHED video object → our columns. Forward only; 'failed' and
 * 'ready' are never undone by a later read. Numbers the version once the
 * upload is confirmed (Q11). Runs the integrity check once ready (decision 4).
 */
export async function applyVideoState(row: VersionRow, video: BunnyVideo, productionId: string, deps: Deps): Promise<void> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  if (row.source !== "bunny" || !row.bunny_video_id) return;
  const d = deriveVersionFromVideo(video);
  const current = row.bunny_status;

  let next: ReviewVersionStatus | null = current;
  if (current === "failed") {
    next = "failed";
  } else if (d.bunny_status === "failed") {
    next = current === "ready" ? "ready" : "failed";
  } else if (current === null || RANK[d.bunny_status] > RANK[current]) {
    next = d.bunny_status;
  }

  const patch: VersionPatch = { bunny_status_raw: d.bunny_status_raw, bunny_status_at: now, duration_ms: d.duration_ms };
  if (next && next !== current) patch.bunny_status = next;
  // crv_ready_needs_original_chk: a ready row keeps has_original + its hash
  if (next !== "ready" || (d.has_original && d.original_sha256)) {
    patch.has_original = d.has_original;
    patch.original_sha256 = d.original_sha256;
  }
  if (next === "ready" && !row.ready_at) patch.ready_at = now;
  await store.update(row.id, patch);

  if (next === "failed" && current !== "failed") {
    await store.event("review_version_failed", productionId, { version_id: row.id, bunny_status_raw: d.bunny_status_raw });
  }
  if (d.originalMissing && row.bunny_status_raw !== 4) {
    await store.event("review_original_missing", productionId, { version_id: row.id });
  }

  let number = row.number;
  if (d.uploadConfirmed && number === null && next !== "failed") number = await store.assignNumber(row.id);

  if (next === "ready" && (row.integrity === null || row.integrity === "unchecked")) {
    const original = patch.original_sha256 ?? d.original_sha256;
    const integrity = await checkIntegrity(row, original);
    await store.update(row.id, { integrity, integrity_at: now });
    if (integrity === "hash_match" || integrity === "size_match") {
      await store.event("review_version_ready", productionId, { version_id: row.id, number, integrity });
    } else if (integrity === "mismatch") {
      await store.event("review_integrity_mismatch", productionId, {
        version_id: row.id,
        number,
        kind: row.is_audio_only || !row.drive_sha256 ? "size" : "hash",
        drive_sha256: row.drive_sha256,
        bunny_original_sha256: original,
        drive_size_bytes: row.drive_size_bytes,
      });
    }
  }
}

/**
 * Decision 4. Video with a Drive sha256: Bunny's originalHash against it.
 * Audio (Bunny's hash does not match an mp3, 16.10), or no sha256 from
 * Drive: the size of /original (a signed HEAD, valid one minute) against
 * Drive's size. A HEAD that fails is 'unchecked' — the next refresh retries.
 */
async function checkIntegrity(row: VersionRow, bunnyHash: string | null): Promise<Integrity> {
  if (!row.is_audio_only && row.drive_sha256) {
    return bunnyHash && bunnyHash.toLowerCase() === row.drive_sha256.toLowerCase() ? "hash_match" : "mismatch";
  }
  if (!row.bunny_video_id || row.drive_size_bytes === null) return "unchecked";
  try {
    const { url } = signedOriginalUrl(row.bunny_video_id, 60);
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    const len = res.headers.get("content-length");
    if (!res.ok || !len || !/^\d+$/.test(len)) return "unchecked";
    return Number(len) === row.drive_size_bytes ? "size_match" : "mismatch";
  } catch {
    return "unchecked";
  }
}

// ── refresh (the drawer's 30-second poll; the webhook's fallback) ──────────

export async function refreshVersion(productionId: string, versionId: string, deps: Deps): Promise<Answer> {
  const { store } = deps;
  const owner = await store.versionProduction(versionId);
  if (!owner || owner !== productionId) return err(404, "הגרסה לא נמצאה בהפקה הזו");
  let row = await store.getVersion(versionId);
  if (!row) return err(404, "הגרסה לא נמצאה");
  if (isFinal(row)) return { status: 200, body: { version: publicVersion(row) } };

  try {
    if (!row.bunny_video_id) {
      const v = await videoByTitle(versionTitle(row.id), productionId, row.id, store);
      if (v) await store.attachGuid(row.id, v.guid);
      row = (await store.getVersion(versionId)) ?? row;
    }
    if (row.bunny_video_id) {
      const video = await getVideo(row.bunny_video_id);
      if (video) await applyVideoState(row, video, productionId, deps);
      row = (await store.getVersion(versionId)) ?? row;
    }
  } catch (e) {
    return err(502, `לא הצלחתי לקרוא את הסטטוס מ-Bunny: ${describeError(e)}`, { version: publicVersion(row) });
  }
  return { status: 200, body: { version: publicVersion(row) } };
}

// ── what the drawer sees ───────────────────────────────────────────────────

export type PublicVersion = {
  id: string;
  number: number | null;
  source: "drive" | "bunny";
  status: ReviewVersionStatus | null;
  integrity: Integrity | null;
  has_guid: boolean;
  is_audio_only: boolean;
  file_name: string | null;
  is_backfill: boolean;
  final: boolean;
  created_at: string;
};

/** No guid, no Drive id, no hashes — the drawer needs a label and whether to keep polling. */
export function publicVersion(v: VersionRow): PublicVersion {
  return {
    id: v.id,
    number: v.number,
    source: v.source,
    status: v.bunny_status,
    integrity: v.integrity,
    has_guid: !!v.bunny_video_id,
    is_audio_only: v.is_audio_only,
    file_name: v.original_filename,
    is_backfill: v.is_backfill,
    final: isFinal(v),
    created_at: v.created_at,
  };
}
