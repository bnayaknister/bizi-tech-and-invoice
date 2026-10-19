import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteVideo } from "@/lib/bunny/client";
import { describeError } from "@/lib/bunny/errors";
import { driveFileMeta, serviceAccountToken, DriveError } from "@/lib/google/drive";
import { probeDriveDownload, type DriveAvailability } from "@/lib/review/driveAvailability";

// ═══════════════════════════════════════════════════════════════════════════
// E13-10 — Bunny media deleted 90 days after approval (plan §6, §9.2 E13-10;
// owner decisions 18.10, (ה) 1–7). The nightly cron calls runPurge.
//
//   · REVIEW_PURGE_LIVE must be exactly "true" to delete. Anything else (unset,
//     a typo) = REPORT: every check runs, nothing is deleted at Bunny, and the
//     run says what WOULD have been deleted. BUNNY_DRY_RUN still applies under it.
//   · at most 20 versions per run (owner (ה)2), oldest purge date first.
//   · ITEM checks, re-read fresh right before the item's deletions:
//       a valid approval and purge_after <= now (v_review_media_purge_due) ·
//       no upload in progress · no version newer than the one the date was
//       computed from · no LIVE unanswered link whose scope covers the item.
//   · VERSION checks, right before each DELETE: a version the client was (or
//     could be) shown needs integrity hash_match / size_match and its Drive
//     original: not trashed, the same size (and sha256 when both are known) as
//     when it was sent, and downloadable anonymously — exactly what the
//     client's archive view (clientVersions.isArchivedBunny) and the Drive
//     download need. A FAILED Bunny version was never shown: deleted without
//     a Drive check.
//   · media_deleted_at is written ONLY after Bunny answered 2xx or 404.
//     A failure: delete_attempts + 1, delete_last_error; event after 5.
//   · a skip for a reason the team must fix (Drive missing / incomplete / not
//     shared, integrity not OK) is an ALERT: one event per (version, reason)
//     and the run's `alerts` list, which /radar reads (B29, owner (ה)6).
//     A Drive check that could not decide (timeout, 5xx) is a plain skip:
//     tomorrow's run tries again.
//   · nothing else is touched: rows, comments and approvals stay as history.
// ═══════════════════════════════════════════════════════════════════════════

export const PURGE_MAX_PER_RUN = 20;
export const PURGE_FAIL_EVENT_AT = 5;
export const PURGE_RUN_EVENT = "review_media_purge_run";
export const PURGE_ENTITY = "review_purge_cron";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const LIST_CAP = 50;

export function isPurgeLive(): boolean {
  return process.env.REVIEW_PURGE_LIVE === "true";
}

export type ItemSkip = "approval_revoked" | "not_due" | "upload_pending" | "new_version" | "live_link";
export type VersionSkip = "integrity_not_ok" | "no_drive_file" | "drive_missing" | "drive_incomplete" | "drive_not_shared" | "drive_unverified";
/** reasons the team must act on → event + /radar */
export const ALERT_REASONS: ReadonlySet<string> = new Set(["integrity_not_ok", "no_drive_file", "drive_missing", "drive_incomplete", "drive_not_shared"]);

export const SKIP_LABEL: Record<ItemSkip | VersionSkip, string> = {
  approval_revoked: "אין אישור תקף",
  not_due: "עוד לא הגיע המועד",
  upload_pending: "גרסה חדשה בהעלאה",
  new_version: "נוספה גרסה חדשה",
  live_link: "יש קישור חי שלא נענה",
  integrity_not_ok: "בדיקת השלמות לא עברה",
  no_drive_file: "לגרסה אין קובץ Drive",
  drive_missing: "הקובץ חסר ב-Drive",
  drive_incomplete: "הקובץ ב-Drive שונה ממה שנשלח",
  drive_not_shared: "הקובץ ב-Drive לא פתוח להורדה",
  drive_unverified: "לא ניתן היה לבדוק את Drive",
};

export type DueRow = { item_id: string; approval_id: string | null; purge_after: string | null; latest_version_id: string | null; upload_pending: boolean | null };
export type PurgeVersion = {
  id: string;
  item_id: string;
  number: number | null;
  source: string;
  bunny_video_id: string | null;
  bunny_status: string | null;
  integrity: string | null;
  drive_file_id: string | null;
  drive_size_bytes: number | null;
  drive_sha256: string | null;
  media_deleted_at: string | null;
  delete_attempts: number;
};
export type LiveLink = { scope: string; expires_at: string; superseded: boolean; responded_at: string | null };

/** Pure: does a live, unanswered link cover this item? (scope by kind — reels_required is not consulted: when in doubt, keep the file) */
export function liveLinkCovers(links: LiveLink[], kind: string, nowMs: number): boolean {
  return links.some(
    (l) =>
      !l.superseded &&
      !l.responded_at &&
      Date.parse(l.expires_at) > nowMs &&
      (l.scope === "all" || (kind === "episode" ? l.scope === "episode" : l.scope === "reels"))
  );
}

/** Pure: the item-level re-check. `selectedLatest` = latest_version_id when the run picked the item. */
export function itemSkipReason(input: { due: DueRow | null; selectedLatest: string | null; kind: string; links: LiveLink[]; nowMs: number }): ItemSkip | null {
  const { due, selectedLatest, kind, links, nowMs } = input;
  if (!due || !due.approval_id) return "approval_revoked";
  if (due.upload_pending) return "upload_pending";
  if (!due.purge_after || Date.parse(due.purge_after) > nowMs) return "not_due";
  if (due.latest_version_id !== selectedLatest) return "new_version";
  if (liveLinkCovers(links, kind, nowMs)) return "live_link";
  return null;
}

/** Pure: the versions of an item still holding media at Bunny. */
export function purgeTargets(versions: PurgeVersion[]): PurgeVersion[] {
  return versions
    .filter((v) => v.source === "bunny" && !!v.bunny_video_id && !v.media_deleted_at)
    .sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER));
}

/** Pure: does this version need its Drive original checked? A failed Bunny version was never shown. */
export function needsDriveCheck(v: PurgeVersion): boolean {
  return v.bunny_status !== "failed";
}

const INTEGRITY_OK = new Set(["hash_match", "size_match"]);

/** Pure: before any Drive call — integrity and a file id. */
export function preDriveSkip(v: PurgeVersion): VersionSkip | null {
  if (!needsDriveCheck(v)) return null;
  if (!INTEGRITY_OK.has(v.integrity ?? "")) return "integrity_not_ok";
  if (!v.drive_file_id) return "no_drive_file";
  return null;
}

export type DriveMetaResult =
  | { ok: true; trashed: boolean; size: number | null; sha256: string | null }
  | { ok: false; notFound: boolean };

/** Pure: the Drive metadata + the anonymous probe → skip reason or null (OK to delete). */
export function driveVerdict(v: PurgeVersion, meta: DriveMetaResult, probe: DriveAvailability): VersionSkip | null {
  if (!meta.ok) return meta.notFound ? "drive_missing" : "drive_unverified";
  if (meta.trashed) return "drive_missing";
  if (meta.size === null || (v.drive_size_bytes !== null && meta.size !== v.drive_size_bytes)) return "drive_incomplete";
  if (v.drive_sha256 && meta.sha256 && v.drive_sha256.toLowerCase() !== meta.sha256.toLowerCase()) return "drive_incomplete";
  if (probe.state === "unavailable") return probe.reason === "missing" ? "drive_missing" : "drive_not_shared";
  if (probe.state === "unknown") return "drive_unverified";
  return null;
}

// ─── the run ────────────────────────────────────────────────────────────────

export type ItemInfo = { id: string; production_id: string; kind: string };
export type DeleteOutcome = { kind: "deleted"; alreadyGone: boolean } | { kind: "bunny_dry_run" } | { kind: "failed"; error: string };

export type PurgeDeps = {
  nowMs: number;
  live: boolean;
  limit: number;
  listDue(nowIso: string): Promise<DueRow[]>;
  dueFor(itemId: string): Promise<DueRow | null>;
  item(itemId: string): Promise<ItemInfo | null>;
  versions(itemId: string): Promise<PurgeVersion[]>;
  liveLinks(productionId: string): Promise<LiveLink[]>;
  driveMeta(fileId: string): Promise<DriveMetaResult>;
  driveProbe(fileId: string): Promise<DriveAvailability>;
  deleteAtBunny(videoId: string): Promise<DeleteOutcome>;
  markDeleted(versionId: string, atIso: string): Promise<boolean>;
  recordFailure(v: PurgeVersion, error: string, atIso: string): Promise<number>;
  event(productionId: string, type: string, payload: Record<string, unknown>, dedupeKey?: { version_id: string; reason: string }): Promise<void>;
};

export type PurgeEntry = { version_id: string; item_id: string; production_id: string; number: number | null };
export type PurgeSummary = {
  mode: "report" | "live";
  due_items: number;
  would_delete: PurgeEntry[];
  deleted: PurgeEntry[];
  bunny_dry_run: PurgeEntry[];
  failed: (PurgeEntry & { error: string; attempts: number })[];
  skipped_items: { item_id: string; reason: ItemSkip }[];
  skipped_versions: (PurgeEntry & { reason: VersionSkip })[];
  alerts: (PurgeEntry & { reason: VersionSkip })[];
  capped: boolean;
};

export async function runPurge(d: PurgeDeps): Promise<PurgeSummary> {
  const nowIso = new Date(d.nowMs).toISOString();
  const out: PurgeSummary = {
    mode: d.live ? "live" : "report",
    due_items: 0,
    would_delete: [],
    deleted: [],
    bunny_dry_run: [],
    failed: [],
    skipped_items: [],
    skipped_versions: [],
    alerts: [],
    capped: false,
  };
  const due = (await d.listDue(nowIso)).sort((a, b) => (a.purge_after ?? "").localeCompare(b.purge_after ?? ""));
  out.due_items = due.length;
  let budget = Math.max(0, Math.min(d.limit, PURGE_MAX_PER_RUN));

  for (const row of due) {
    if (budget <= 0) {
      out.capped = true;
      break;
    }
    const item = await d.item(row.item_id);
    if (!item) continue;
    // fresh, right before this item's deletions
    const [fresh, links, versions] = await Promise.all([d.dueFor(item.id), d.liveLinks(item.production_id), d.versions(item.id)]);
    const skip = itemSkipReason({ due: fresh, selectedLatest: row.latest_version_id, kind: item.kind, links, nowMs: d.nowMs });
    if (skip) {
      out.skipped_items.push({ item_id: item.id, reason: skip });
      continue;
    }
    for (const v of purgeTargets(versions)) {
      if (budget <= 0) {
        out.capped = true;
        break;
      }
      const entry: PurgeEntry = { version_id: v.id, item_id: item.id, production_id: item.production_id, number: v.number };
      let reason = preDriveSkip(v);
      if (!reason && needsDriveCheck(v)) {
        const fileId = v.drive_file_id as string;
        const [meta, probe] = await Promise.all([d.driveMeta(fileId), d.driveProbe(fileId)]);
        reason = driveVerdict(v, meta, probe);
      }
      if (reason) {
        out.skipped_versions.push({ ...entry, reason });
        if (ALERT_REASONS.has(reason)) {
          out.alerts.push({ ...entry, reason });
          await d.event(item.production_id, "review_media_purge_skipped", { ...entry, reason, label: SKIP_LABEL[reason] }, { version_id: v.id, reason });
        }
        continue;
      }
      budget--;
      if (!d.live) {
        out.would_delete.push(entry);
        continue;
      }
      const res = await d.deleteAtBunny(v.bunny_video_id as string);
      if (res.kind === "bunny_dry_run") {
        out.bunny_dry_run.push(entry);
      } else if (res.kind === "deleted") {
        if (await d.markDeleted(v.id, nowIso)) {
          out.deleted.push(entry);
          await d.event(item.production_id, "review_media_deleted", { ...entry, bunny_video_id: v.bunny_video_id, already_gone: res.alreadyGone });
        }
      } else {
        const attempts = await d.recordFailure(v, res.error, nowIso);
        out.failed.push({ ...entry, error: res.error.slice(0, 300), attempts });
        if (attempts === PURGE_FAIL_EVENT_AT) {
          await d.event(item.production_id, "review_media_delete_failed", { ...entry, attempts, error: res.error.slice(0, 300) });
        }
      }
    }
  }
  return out;
}

/** The run's summary as stored (lists capped so a bad night cannot write a huge row). */
export function summaryPayload(s: PurgeSummary): Record<string, unknown> {
  const cap = <T>(a: T[]) => a.slice(0, LIST_CAP);
  return {
    mode: s.mode,
    due_items: s.due_items,
    counts: {
      would_delete: s.would_delete.length,
      deleted: s.deleted.length,
      bunny_dry_run: s.bunny_dry_run.length,
      failed: s.failed.length,
      skipped_items: s.skipped_items.length,
      skipped_versions: s.skipped_versions.length,
      alerts: s.alerts.length,
    },
    would_delete: cap(s.would_delete),
    deleted: cap(s.deleted),
    bunny_dry_run: cap(s.bunny_dry_run),
    failed: cap(s.failed),
    skipped_items: cap(s.skipped_items),
    skipped_versions: cap(s.skipped_versions),
    alerts: cap(s.alerts),
    capped: s.capped,
  };
}

// ─── the real dependencies ──────────────────────────────────────────────────

export function supabasePurgeDeps(admin: SupabaseClient<Database>, opts: { nowMs: number; live: boolean; limit: number }): PurgeDeps {
  let tokenP: Promise<string> | null = null;
  const token = () => (tokenP ??= serviceAccountToken().then((t) => t.token));
  const VERSION_COLS = "id,item_id,number,source,bunny_video_id,bunny_status,integrity,drive_file_id,drive_size_bytes,drive_sha256,media_deleted_at,delete_attempts";
  return {
    ...opts,
    async listDue(nowIso) {
      const { data, error } = await admin.from("v_review_media_purge_due").select("item_id,approval_id,purge_after,latest_version_id,upload_pending").lte("purge_after", nowIso);
      if (error) throw new Error(`v_review_media_purge_due: ${error.message}`);
      return (data ?? []).filter((r): r is DueRow => !!r.item_id) as DueRow[];
    },
    async dueFor(itemId) {
      const { data, error } = await admin.from("v_review_media_purge_due").select("item_id,approval_id,purge_after,latest_version_id,upload_pending").eq("item_id", itemId).maybeSingle();
      if (error) throw new Error(`v_review_media_purge_due: ${error.message}`);
      return (data as DueRow | null) ?? null;
    },
    async item(itemId) {
      const { data, error } = await admin.from("client_review_items").select("id,production_id,kind").eq("id", itemId).maybeSingle();
      if (error) throw new Error(`client_review_items: ${error.message}`);
      return data ?? null;
    },
    async versions(itemId) {
      const { data, error } = await admin.from("client_review_versions").select(VERSION_COLS).eq("item_id", itemId);
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return (data ?? []) as PurgeVersion[];
    },
    async liveLinks(productionId) {
      const { data, error } = await admin
        .from("client_review_links")
        .select("scope,expires_at,superseded,responded_at")
        .eq("production_id", productionId)
        .eq("superseded", false)
        .is("responded_at", null);
      if (error) throw new Error(`client_review_links: ${error.message}`);
      return (data ?? []) as LiveLink[];
    },
    async driveMeta(fileId) {
      try {
        const m = await driveFileMeta(fileId, await token());
        return { ok: true, trashed: m.trashed, size: m.size, sha256: m.sha256Checksum };
      } catch (e) {
        return { ok: false, notFound: e instanceof DriveError && e.status === 404 };
      }
    },
    driveProbe: (fileId) => probeDriveDownload(fileId),
    async deleteAtBunny(videoId) {
      try {
        const r = await deleteVideo(videoId);
        if ("dryRun" in r && r.dryRun) return { kind: "bunny_dry_run" };
        return { kind: "deleted", alreadyGone: (r as { alreadyGone: boolean }).alreadyGone };
      } catch (e) {
        return { kind: "failed", error: describeError(e) };
      }
    },
    async markDeleted(versionId, atIso) {
      const { data, error } = await admin
        .from("client_review_versions")
        .update({ media_deleted_at: atIso, delete_last_error: null })
        .eq("id", versionId)
        .is("media_deleted_at", null)
        .select("id");
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return !!data?.length;
    },
    async recordFailure(v, err, atIso) {
      const attempts = (v.delete_attempts ?? 0) + 1;
      const { error } = await admin
        .from("client_review_versions")
        .update({ delete_attempts: attempts, delete_last_error: err.slice(0, 500), delete_last_attempt_at: atIso })
        .eq("id", v.id);
      if (error) throw new Error(`client_review_versions: ${error.message}`);
      return attempts;
    },
    async event(productionId, type, payload, dedupeKey) {
      if (dedupeKey) {
        const { data } = await admin
          .from("events")
          .select("id")
          .eq("event_type", type)
          .eq("payload->>version_id", dedupeKey.version_id)
          .eq("payload->>reason", dedupeKey.reason)
          .limit(1);
        if (data?.length) return;
      }
      const { error } = await admin.from("events").insert({ entity_type: "production", entity_id: productionId, event_type: type, payload: payload as never });
      if (error) console.warn(JSON.stringify({ tag: "review_purge_event_failed", type, error: error.message }));
    },
  };
}

/** The run's own event — /radar reads the LAST one (B29). */
export async function writeRunEvent(admin: SupabaseClient<Database>, s: PurgeSummary): Promise<void> {
  const { error } = await admin.from("events").insert({ entity_type: PURGE_ENTITY, entity_id: NIL_UUID, event_type: PURGE_RUN_EVENT, payload: summaryPayload(s) as never });
  if (error) console.warn(JSON.stringify({ tag: "review_purge_run_event_failed", error: error.message }));
}
