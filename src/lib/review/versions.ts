import { randomUUID } from "node:crypto";
import { bunnyApiConfig, bunnyCdnReferer, isBunnyDryRun } from "@/lib/bunny/config";
import { deleteVideo, fetchVideoFromUrl, findVideosByTitle, getVideo } from "@/lib/bunny/client";
import { driveFileViewUrl } from "./itemLinks";
import { isStuck } from "./versionLabel";
import { describeError } from "@/lib/bunny/errors";
import { signedOriginalUrl } from "@/lib/bunny/sign";
import { deriveVersionFromVideo, type BunnyVideo, type ReviewVersionStatus } from "@/lib/bunny/status";
import { checkReviewFile, driveMediaUrl, folderChain, reviewFolderId, serviceAccountToken, type CheckedReviewFile } from "@/lib/google/drive";
import {
  folderWarning,
  nameKindWarning,
  otherShowInName,
  sameFileWarnings,
  targetLabel,
  type SameFileRow,
  type SendWarning,
  type ShowForWarn,
} from "./sendWarnings";

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
  /** set only after Bunny confirmed a delete (0114) */
  media_deleted_at?: string | null;
  /** 0122: withdrawn from the client's view (sent by mistake) */
  withdrawn_at?: string | null;
  withdrawn_reason?: string | null;
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
  /** set ONLY after Bunny confirmed the delete (0114) — the resend of a stuck version */
  media_deleted_at: string;
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
  // ── E13-5: the webhook and the crons ──
  /** The version that already carries this Bunny guid. */
  versionByGuid(guid: string): Promise<VersionRow | null>;
  /** Bunny versions that still need polling (isFinal false, media not deleted), oldest fetch first, with their production. */
  pendingVersions(limit: number): Promise<{ row: VersionRow; productionId: string }[]>;
  /** Which of these guids some version already carries. */
  knownGuids(guids: string[]): Promise<Set<string>>;
  /** An event of this type whose payload[key] = value already exists — so a recurring finding is written once. */
  eventExists(type: string, key: string, value: string): Promise<boolean>;
  /** An event that belongs to no production (an orphan video): entity 'system', the zero uuid. */
  systemEvent(type: string, payload: Record<string, unknown>): Promise<void>;
  // ── owner 22.10: the warnings and the confirmation screen (optional: a store without them sends no warnings) ──
  /** the production's show and date, for the confirmation screen */
  sendContext?(productionId: string): Promise<{ showId: string | null; showName: string | null; podcastName: string | null; recordDate: string | null }>;
  /** every non-failed version carrying this Drive file, with where it lives */
  sameDriveFile?(driveFileId: string): Promise<SameFileRow[]>;
  /** the active shows, for the name / folder warnings */
  warnShows?(): Promise<ShowForWarn[]>;
  /** the item's highest version number (0 = none) — the number the next one gets is this + 1 */
  itemMaxNumber?(itemId: string): Promise<number>;
  /** owner 22.10: the item a version belongs to — the resend sends to the same slot */
  itemOf?(itemId: string): Promise<{ kind: ItemKind; reel_index: number | null } | null>;
  /** 0122: mark withdrawn (who, why) — false when it already was */
  withdraw?(versionId: string, userId: string | null, reason: string): Promise<boolean>;
}

export type Deps = {
  store: VersionStore;
  /** owner 22.10: the Drive folder walk for the confirmation screen; absent = the live one */
  folderChain?: typeof folderChain;
  /** owner 22.10: the Bunny delete of a stuck version that is re-sent; absent = the live one */
  deleteVideo?: typeof deleteVideo;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
};

/** `log` is for the route to write to the server log — never sent to the browser. */
export type Answer = { status: number; body: Record<string, unknown>; log?: Record<string, unknown> };

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
export async function videoByTitle(
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
  /** owner 22.10: only check and describe — nothing is sent */
  preview?: boolean;
  /** owner 22.10: the sender saw the warnings and chose "לשלוח בכל זאת" */
  ackWarnings?: boolean;
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

  // 3b. owner 22.10 — the warnings, and what the confirmation screen shows.
  // Each is a warning, never a refusal: the sender may send anyway, and the
  // server holds a send with warnings until it is acknowledged.
  const ctx = store.sendContext ? await store.sendContext(input.productionId) : null;
  const warnings: SendWarning[] = [];
  let folders: string[] = [];
  if (ctx) {
    const [shows, same] = await Promise.all([
      store.warnShows ? store.warnShows() : Promise.resolve([] as ShowForWarn[]),
      store.sameDriveFile ? store.sameDriveFile(file.fileId) : Promise.resolve([] as SameFileRow[]),
    ]);
    folders = file.parents?.length ? await (deps.folderChain ?? folderChain)(file.parents, reviewFolderId(), token) : [];
    warnings.push(...sameFileWarnings(same, { productionId: input.productionId, showId: ctx.showId, itemId: item?.id ?? null }));
    const nk = nameKindWarning(file.name, kind);
    if (nk) warnings.push(nk);
    const os = otherShowInName(file.name, shows, ctx.showId);
    if (os) warnings.push(os);
    const fw = folderWarning(folders, shows, ctx.showId);
    if (fw) warnings.push(fw);
  }
  if (input.preview) {
    const max = item && store.itemMaxNumber ? await store.itemMaxNumber(item.id) : 0;
    return {
      status: 200,
      body: {
        preview: {
          file: { name: file.name, size_bytes: file.sizeBytes },
          folder: folders.join(" / ") || null,
          show: ctx?.showName ?? ctx?.podcastName ?? null,
          record_date: ctx?.recordDate ?? null,
          target: targetLabel(kind, reelIndex),
          next_version: max + 1,
          warnings,
        },
      },
    };
  }
  if (warnings.length && !input.ackWarnings) {
    return err(409, "יש אזהרות לפני השליחה — יש לאשר \"לשלוח בכל זאת\"", { code: "warnings", warnings });
  }
  if (warnings.length) {
    await store.event(
      "review_send_warnings_overridden",
      input.productionId,
      { kind, reel_index: reelIndex, file_name: file.name, drive_file_id: file.fileId, warnings: warnings.map((w) => w.code) },
      input.userId
    );
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

// ── owner 22.10: "שליחה מחדש" of a stuck / failed version ──────────────────

/**
 * The version is marked failed (it never becomes the client's), its Bunny
 * video deleted (best effort — a delete that fails is recorded and the resend
 * still happens; the daily orphan sweep reports what is left), and the SAME
 * Drive file is sent again to the SAME item: a new version, the next number.
 * Only a version that is failed, or not ready an hour after it was sent.
 */
export async function resendVersion(
  input: { productionId: string; versionId: string; userId: string },
  deps: Deps
): Promise<Answer> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if ((await store.versionProduction(input.versionId)) !== input.productionId) return err(404, "הגרסה לא נמצאה בהפקה הזאת");
  const row = await store.getVersion(input.versionId);
  if (!row || row.source !== "bunny" || !row.drive_file_id) return err(400, "אפשר לשלוח מחדש רק גרסה שנשלחה מ-Drive ל-Bunny");
  const stuck = isStuck({ final: isFinal(row), status: row.bunny_status, sent_at: row.fetch_requested_at ?? row.created_at }, now);
  if (row.bunny_status !== "failed" && !stuck) return err(409, "הגרסה לא תקועה — אין מה לשלוח מחדש");
  const item = store.itemOf ? await store.itemOf(row.item_id) : null;
  if (!item) return err(404, "הפריט של הגרסה לא נמצא");

  if (row.bunny_status !== "failed") await store.update(row.id, { bunny_status: "failed", bunny_status_at: now.toISOString() });
  let deleted: string = "no_guid";
  if (row.bunny_video_id) {
    try {
      const r = await (deps.deleteVideo ?? deleteVideo)(row.bunny_video_id);
      if ("dryRun" in r && r.dryRun) deleted = "dry_run";
      else {
        await store.update(row.id, { media_deleted_at: now.toISOString() });
        deleted = "deleted";
      }
    } catch (e) {
      deleted = `failed: ${describeError(e)}`;
    }
  }
  await store.event(
    "review_version_resent",
    input.productionId,
    { version_id: row.id, was: row.bunny_status, stuck, bunny_delete: deleted, drive_file_id: row.drive_file_id },
    input.userId
  );
  return sendForReview(
    {
      productionId: input.productionId,
      kind: item.kind,
      reelIndex: item.reel_index,
      driveUrl: driveFileViewUrl(row.drive_file_id),
      userId: input.userId,
      // the same file to the same slot, chosen again on purpose
      ackWarnings: true,
    },
    deps
  );
}

// ── 0122 (owner 22.10): "הסרת גרסה" ───────────────────────────────────────

export const WITHDRAW_REASON_MIN = 3;
export const WITHDRAW_REASON_MAX = 500;

/** The reason's rule — the same as crv_withdrawn_chk, so the form and the route agree. PURE. */
export function withdrawReasonError(raw: unknown): string | null {
  const r = typeof raw === "string" ? raw.trim() : "";
  if (r.length < WITHDRAW_REASON_MIN) return "יש לכתוב סיבה להסרה";
  if (r.length > WITHDRAW_REASON_MAX) return `הסיבה ארוכה מדי (עד ${WITHDRAW_REASON_MAX} תווים)`;
  return null;
}

/**
 * Withdraw a version: the client never sees it again (clientVersions.ts), its
 * row, number, comments and approvals stay. Then its Bunny video is deleted
 * (best effort: a failed delete is recorded in the event and the row keeps
 * media_deleted_at null — the daily orphan sweep and a retry see it).
 */
export async function withdrawVersion(
  input: { productionId: string; versionId: string; userId: string | null; reason: unknown },
  deps: Deps
): Promise<Answer> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const bad = withdrawReasonError(input.reason);
  if (bad) return err(400, bad);
  const reason = (input.reason as string).trim();
  if ((await store.versionProduction(input.versionId)) !== input.productionId) return err(404, "הגרסה לא נמצאה בהפקה הזאת");
  const row = await store.getVersion(input.versionId);
  if (!row) return err(404, "הגרסה לא נמצאה");
  if (row.withdrawn_at) return err(409, "הגרסה כבר הוסרה");
  if (!store.withdraw || !(await store.withdraw(row.id, input.userId, reason))) return err(409, "הגרסה כבר הוסרה");

  let bunnyDelete = "not_bunny";
  if (row.source === "bunny" && row.bunny_video_id && !row.media_deleted_at) {
    try {
      const r = await (deps.deleteVideo ?? deleteVideo)(row.bunny_video_id);
      if ("dryRun" in r && r.dryRun) bunnyDelete = "dry_run";
      else {
        await store.update(row.id, { media_deleted_at: now.toISOString() });
        bunnyDelete = (r as { alreadyGone?: boolean }).alreadyGone ? "already_gone" : "deleted";
      }
    } catch (e) {
      bunnyDelete = `failed: ${describeError(e)}`;
    }
  } else if (row.media_deleted_at) {
    bunnyDelete = "already_deleted";
  }
  await store.event(
    "review_version_withdrawn",
    input.productionId,
    { version_id: row.id, item_id: row.item_id, number: row.number, file_name: row.original_filename, reason, bunny_delete: bunnyDelete },
    input.userId
  );
  return {
    status: 200,
    body: {
      ok: true,
      bunny_delete: bunnyDelete,
      message: bunnyDelete.startsWith("failed") ? "הגרסה הוסרה מתצוגת הלקוח. המחיקה מ-Bunny נכשלה ותיבדק שוב." : "הגרסה הוסרה מתצוגת הלקוח.",
    },
  };
}

// ── status ─────────────────────────────────────────────────────────────────

/**
 * A freshly FETCHED video object → our columns. Forward only; 'failed' and
 * 'ready' are never undone by a later read. Numbers the version once the
 * upload is confirmed (Q11). Runs the integrity check once ready (decision 4).
 */
/** What a caller may want to log: set only when an integrity check did not end in a match. */
export type ApplyOutcome = { integrity?: Integrity; integrityDetail?: string | null };

export async function applyVideoState(row: VersionRow, video: BunnyVideo, productionId: string, deps: Deps): Promise<ApplyOutcome> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let outcome: ApplyOutcome = {};
  if (row.source !== "bunny" || !row.bunny_video_id) return outcome;
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
    const checked = await checkIntegrity(row, original);
    const integrity = checked.integrity;
    await store.update(row.id, { integrity, integrity_at: now });
    if (integrity === "unchecked" || integrity === "mismatch") outcome = { integrity, integrityDetail: checked.detail };
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
  return outcome;
}

/**
 * Decision 4. Video with a Drive sha256: Bunny's originalHash against it.
 * Audio (Bunny's hash does not match an mp3, 16.10), or no sha256 from
 * Drive: the size of /original (a signed HEAD, valid one minute) against
 * Drive's size. A HEAD that fails is 'unchecked' — the next refresh retries.
 *
 * The HEAD carries the pull zone's Referer (bunnyCdnReferer): without it the
 * CDN answers 403 even to a valid token, and the first live mp3 sat in
 * 'unchecked' for hours (16.10). `detail` says why a check did not conclude —
 * a status code or a reason, never the signed URL.
 */
export type IntegrityResult = { integrity: Integrity; detail: string | null };

async function checkIntegrity(row: VersionRow, bunnyHash: string | null): Promise<IntegrityResult> {
  if (!row.is_audio_only && row.drive_sha256) {
    const same = !!bunnyHash && bunnyHash.toLowerCase() === row.drive_sha256.toLowerCase();
    return { integrity: same ? "hash_match" : "mismatch", detail: same ? null : bunnyHash ? "hash differs" : "no originalHash from Bunny" };
  }
  if (!row.bunny_video_id) return { integrity: "unchecked", detail: "skipped: no guid" };
  if (row.drive_size_bytes === null) return { integrity: "unchecked", detail: "skipped: no Drive size" };
  try {
    const { url } = signedOriginalUrl(row.bunny_video_id, 60);
    const res = await fetch(url, { method: "HEAD", headers: { Referer: bunnyCdnReferer() }, signal: AbortSignal.timeout(15_000) });
    const len = res.headers.get("content-length");
    if (!res.ok) return { integrity: "unchecked", detail: `HEAD /original → HTTP ${res.status}` };
    if (!len || !/^\d+$/.test(len)) return { integrity: "unchecked", detail: "HEAD /original: no content-length" };
    if (Number(len) === row.drive_size_bytes) return { integrity: "size_match", detail: null };
    return { integrity: "mismatch", detail: `size ${len} ≠ Drive ${row.drive_size_bytes}` };
  } catch (e) {
    return { integrity: "unchecked", detail: `HEAD /original threw: ${describeError(e)}` };
  }
}

// ── refresh (the drawer's 30-second poll; the webhook's fallback) ──────────

export async function refreshVersion(productionId: string, versionId: string, deps: Deps): Promise<Answer> {
  const { store } = deps;
  const owner = await store.versionProduction(versionId);
  if (!owner || owner !== productionId) return err(404, "הגרסה לא נמצאה בהפקה הזו");
  const row = await store.getVersion(versionId);
  if (!row) return err(404, "הגרסה לא נמצאה");
  let synced: SyncResult;
  try {
    // the drawer's poll never marks anything failed — that is the cron's call
    synced = await syncVersion(row, productionId, deps);
  } catch (e) {
    return err(502, `לא הצלחתי לקרוא את הסטטוס מ-Bunny: ${describeError(e)}`, { version: publicVersion(row) });
  }
  const log = integrityLog(synced, productionId);
  return { status: 200, body: { version: publicVersion(synced.row) }, ...(log ? { log } : {}) };
}

/** The server-log line for an integrity check that did not end in a match, or nothing. */
export function integrityLog(synced: SyncResult, productionId: string): Record<string, unknown> | undefined {
  const o = synced.outcome;
  return o.integrity
    ? { version_id: synced.row.id, production_id: productionId, integrity: o.integrity, detail: o.integrityDetail ?? null }
    : undefined;
}

// ── one sync, three callers: the drawer's refresh, the webhook, the hourly cron ──

export type SyncOptions = {
  /** cron only: a version whose guid Bunny no longer knows (404) becomes 'failed' */
  markMissingFailed?: boolean;
  /** cron only: no guid this long after the fetch → 'failed' (0117) */
  stuckAfterMs?: number;
};
export type SyncResult = { row: VersionRow; outcome: ApplyOutcome; note?: "stuck_failed" | "video_missing_failed" | "no_guid_yet" | "final" };

/** Exactly what refresh did in E13-4, plus the two cron-only endings. Reads Bunny; writes only our row. */
export async function syncVersion(row: VersionRow, productionId: string, deps: Deps, opts: SyncOptions = {}): Promise<SyncResult> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (isFinal(row)) return { row, outcome: {}, note: "final" };
  const reload = async () => (await store.getVersion(row.id)) ?? row;

  if (!row.bunny_video_id) {
    const v = await videoByTitle(versionTitle(row.id), productionId, row.id, store);
    if (v) await store.attachGuid(row.id, v.guid);
    row = await reload();
    if (!row.bunny_video_id) {
      const since = row.fetch_requested_at ? now.getTime() - Date.parse(row.fetch_requested_at) : 0;
      if (opts.stuckAfterMs && row.bunny_status === "uploading" && since > opts.stuckAfterMs) {
        await store.update(row.id, { bunny_status: "failed", bunny_status_at: now.toISOString() });
        await store.event("review_fetch_stuck", productionId, {
          version_id: row.id,
          fetch_requested_at: row.fetch_requested_at,
          hours_without_guid: Math.floor(since / 3_600_000),
          marked_failed: true,
        });
        return { row: await reload(), outcome: {}, note: "stuck_failed" };
      }
      return { row, outcome: {}, note: "no_guid_yet" };
    }
  }

  const video = await getVideo(row.bunny_video_id!);
  if (!video) {
    if (opts.markMissingFailed && row.bunny_status !== "ready") {
      await store.update(row.id, { bunny_status: "failed", bunny_status_at: now.toISOString() });
      await store.event("review_video_missing", productionId, { version_id: row.id, guid: row.bunny_video_id });
      return { row: await reload(), outcome: {}, note: "video_missing_failed" };
    }
    return { row, outcome: {} };
  }
  const outcome = await applyVideoState(row, video, productionId, deps);
  return { row: await reload(), outcome };
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
  /** 0122: withdrawn from the client's view, and why */
  withdrawn_at: string | null;
  withdrawn_reason: string | null;
  /** 0122: the last time a client opened this version (filled by the drawer read) */
  last_viewed_at?: string | null;
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
    // a withdrawn version is final for the drawer: never polled again
    final: isFinal(v) || !!v.withdrawn_at,
    created_at: v.created_at,
    withdrawn_at: v.withdrawn_at ?? null,
    withdrawn_reason: v.withdrawn_reason ?? null,
  };
}
