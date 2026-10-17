import { bunnyApiConfig } from "@/lib/bunny/config";
import { getVideo, listVideos } from "@/lib/bunny/client";
import { describeError } from "@/lib/bunny/errors";
import type { BunnyVideo } from "@/lib/bunny/status";
import { verifyBunnySignature, type HeaderSource } from "@/lib/bunny/webhookSignature";
import { integrityLog, syncVersion, type Answer, type Deps } from "./versions";

// ═══════════════════════════════════════════════════════════════════════════
// E13-5 — Bunny's webhook and the two backup crons (plan §9.2 E13-5).
// Server-side only. Every path ends in syncVersion (lib/review/versions.ts),
// the same code the drawer's refresh runs: no second status logic anywhere.
// ═══════════════════════════════════════════════════════════════════════════
//
// The webhook is an ACCELERATOR, not the source of truth: Bunny documents no
// retries and no timeout, so the hourly cron catches whatever it missed.
// Its Status number is never read as a status — the webhook enum differs from
// the video object's (webhook 3 = Finished, video 4 = Finished, §3). It only
// says "fetch this video again".
//
// An ORPHAN is a video titled bizi-<uuid> with no version row. Since decision
// 15 (16.10) the row is written only after Bunny accepted the fetch, so an
// orphan means our request "failed" and the title search found nothing, yet
// Bunny made the video later — or the row's insert failed after Bunny accepted
// it. Orphans are REPORTED once per guid, never deleted: a delete is a Bunny
// write, and that is the owner's call.

const BIZI_TITLE = /^bizi-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (body: Record<string, unknown>, log?: Record<string, unknown>): Answer => ({ status: 200, body: { ok: true, ...body }, ...(log ? { log } : {}) });

// ── the webhook ────────────────────────────────────────────────────────────

/** POST /api/bunny/webhook. `raw` is the body exactly as received. */
export async function handleBunnyWebhook(raw: string, headers: HeaderSource, deps: Deps): Promise<Answer> {
  const { store } = deps;
  const key = (process.env.BUNNY_STREAM_READONLY_KEY ?? "").trim();
  // never "accept everything" when the key is missing
  if (!key) return { status: 503, body: { ok: false }, log: { result: "rejected", reason: "no_readonly_key" } };

  const sig = verifyBunnySignature(raw, headers, key);
  if (!sig.ok) return { status: 401, body: { ok: false }, log: { result: "rejected", reason: sig.reason } };

  let payload: { VideoLibraryId?: unknown; VideoGuid?: unknown; Status?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: { ok: false }, log: { result: "bad_body", reason: "not_json" } };
  }
  const guid = typeof payload.VideoGuid === "string" ? payload.VideoGuid.trim() : "";
  if (!GUID.test(guid)) return { status: 400, body: { ok: false }, log: { result: "bad_body", reason: "no_guid" } };
  const webhookStatus = typeof payload.Status === "number" ? payload.Status : null;

  const { libraryId } = bunnyApiConfig();
  if (String(payload.VideoLibraryId ?? "") !== libraryId) {
    return ok({ ignored: "library" }, { result: "ignored", reason: "other_library", library: String(payload.VideoLibraryId ?? ""), guid });
  }

  const known = await store.versionByGuid(guid);
  if (known) {
    const productionId = await store.versionProduction(known.id);
    if (!productionId) return ok({}, { result: "ignored", reason: "version_without_production", guid });
    const synced = await syncVersion(known, productionId, deps);
    return ok({}, { result: "synced", guid, webhook_status: webhookStatus, status: synced.row.bunny_status, ...(integrityLog(synced, productionId) ?? {}) });
  }

  // a guid we do not carry: the title says which version (or nobody's) it is
  const video = await getVideo(guid);
  if (!video) return ok({}, { result: "ignored", reason: "unknown_guid_gone_at_bunny", guid });
  return resolveUnlinked(video, deps, "webhook");
}

/**
 * A Bunny video no version row carries yet. bizi-<uuid> naming a row without
 * a guid → link it (the webhook beat the send route's title search). Naming a
 * row with ANOTHER guid → a duplicate, reported once. Naming no row → an
 * orphan, reported once. Any other title → not ours (a test or manual upload).
 */
async function resolveUnlinked(video: BunnyVideo, deps: Deps, source: "webhook" | "sweep"): Promise<Answer> {
  const { store } = deps;
  const title = video.title ?? "";
  const m = BIZI_TITLE.exec(title);
  if (!m) return ok({}, { result: "ignored", reason: "not_a_bizi_title", guid: video.guid, title, source });
  const versionId = m[1].toLowerCase();
  const row = await store.getVersion(versionId);

  if (row && !row.bunny_video_id) {
    const productionId = await store.versionProduction(row.id);
    if (!productionId) return ok({}, { result: "ignored", reason: "version_without_production", guid: video.guid });
    if (await store.attachGuid(row.id, video.guid)) {
      const fresh = (await store.getVersion(row.id)) ?? row;
      const synced = await syncVersion(fresh, productionId, deps);
      return ok({}, { result: "linked", guid: video.guid, version_id: row.id, status: synced.row.bunny_status, source });
    }
    return ok({}, { result: "ignored", reason: "attach_lost_race", guid: video.guid, version_id: row.id, source });
  }

  if (row && row.bunny_video_id && row.bunny_video_id !== video.guid) {
    const productionId = await store.versionProduction(row.id);
    if (productionId && !(await store.eventExists("review_fetch_duplicate", "other_guid", video.guid))) {
      await store.event("review_fetch_duplicate", productionId, {
        version_id: row.id,
        title,
        linked_guid: row.bunny_video_id,
        other_guid: video.guid,
        source,
      });
      return ok({}, { result: "duplicate_reported", guid: video.guid, version_id: row.id, source });
    }
    return ok({}, { result: "duplicate_known", guid: video.guid, version_id: row.id, source });
  }

  if (!row) {
    if (!(await store.eventExists("review_orphan_video", "guid", video.guid))) {
      await store.systemEvent("review_orphan_video", {
        guid: video.guid,
        title,
        version_id: versionId,
        date_uploaded: video.dateUploaded ?? null,
        bunny_status: video.status,
        storage_size: video.storageSize ?? null,
        source,
      });
      return ok({}, { result: "orphan_reported", guid: video.guid, source });
    }
    return ok({}, { result: "orphan_known", guid: video.guid, source });
  }

  return ok({}, { result: "ignored", reason: "already_linked", guid: video.guid, source });
}

// ── the hourly cron: versions that are not final ───────────────────────────

export const CRON_BATCH = 50;
export const STUCK_AFTER_MS = 24 * 3_600_000; // no guid this long → failed (0117)
export const INTEGRITY_STUCK_MS = 3 * 24 * 3_600_000; // still unchecked this long after ready → reported once

export type CronSummary = Record<string, unknown>;

export async function runVersionsCron(deps: Deps): Promise<CronSummary> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const pending = await store.pendingVersions(CRON_BATCH);
  const summary = { checked: 0, advanced: 0, ready: 0, stuck_failed: 0, video_missing_failed: 0, integrity_stuck_reported: 0, errors: 0 };
  const lines: Record<string, unknown>[] = [];

  for (const { row, productionId } of pending) {
    summary.checked++;
    try {
      const before = `${row.bunny_status}|${row.integrity}|${row.bunny_video_id ?? ""}`;
      const synced = await syncVersion(row, productionId, deps, { markMissingFailed: true, stuckAfterMs: STUCK_AFTER_MS });
      const after = synced.row;
      if (`${after.bunny_status}|${after.integrity}|${after.bunny_video_id ?? ""}` !== before) summary.advanced++;
      if (after.bunny_status === "ready" && (after.integrity === "hash_match" || after.integrity === "size_match")) summary.ready++;
      if (synced.note === "stuck_failed") summary.stuck_failed++;
      if (synced.note === "video_missing_failed") summary.video_missing_failed++;
      const log = integrityLog(synced, productionId);
      if (log) lines.push(log);

      // decision (c)(2): unchecked for 3 days after ready → one event, the version stays hidden (Q14)
      if (
        after.bunny_status === "ready" &&
        after.integrity === "unchecked" &&
        after.ready_at &&
        now.getTime() - Date.parse(after.ready_at) > INTEGRITY_STUCK_MS &&
        !(await store.eventExists("review_integrity_stuck", "version_id", after.id))
      ) {
        await store.event("review_integrity_stuck", productionId, {
          version_id: after.id,
          ready_at: after.ready_at,
          last_detail: synced.outcome.integrityDetail ?? null,
        });
        summary.integrity_stuck_reported++;
      }
    } catch (e) {
      summary.errors++;
      lines.push({ version_id: row.id, production_id: productionId, error: describeError(e) });
    }
  }
  return { ...summary, details: lines };
}

// ── the daily cron: orphans in the library ─────────────────────────────────

export const SWEEP_PAGE_SIZE = 100;
export const SWEEP_MAX_PAGES = 50;
export const ORPHAN_MIN_AGE_MS = 3_600_000; // younger than an hour may still be mid-send

export async function runOrphanSweep(deps: Deps): Promise<CronSummary> {
  const { store } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const all: BunnyVideo[] = [];
  let pages = 0;
  for (let page = 1; page <= SWEEP_MAX_PAGES; page++) {
    const { items } = await listVideos(page, SWEEP_PAGE_SIZE);
    pages++;
    all.push(...items);
    if (items.length < SWEEP_PAGE_SIZE) break;
  }

  const bizi = all.filter((v) => typeof v.guid === "string" && BIZI_TITLE.test(v.title ?? ""));
  const old = bizi.filter((v) => !v.dateUploaded || now.getTime() - Date.parse(v.dateUploaded) > ORPHAN_MIN_AGE_MS);
  const known = await store.knownGuids(old.map((v) => v.guid));
  const unlinked = old.filter((v) => !known.has(v.guid));

  const results: Record<string, number> = {};
  const details: Record<string, unknown>[] = [];
  for (const v of unlinked) {
    try {
      const r = await resolveUnlinked(v, deps, "sweep");
      const res = String(r.log?.result ?? "unknown");
      results[res] = (results[res] ?? 0) + 1;
      if (res !== "orphan_known" && res !== "duplicate_known") details.push(r.log ?? {});
    } catch (e) {
      results.errors = (results.errors ?? 0) + 1;
      details.push({ guid: v.guid, error: describeError(e) });
    }
  }
  return {
    pages,
    videos_in_library: all.length,
    bizi_titled: bizi.length,
    unlinked: unlinked.length,
    ...results,
    details,
    ...(pages === SWEEP_MAX_PAGES ? { truncated: true } : {}),
  };
}

