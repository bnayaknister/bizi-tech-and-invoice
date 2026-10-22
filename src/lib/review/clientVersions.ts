import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { signedPlaybackUrl, PLAYBACK_TTL_SECONDS, type SignedUrl } from "@/lib/bunny/sign";

// ═══════════════════════════════════════════════════════════════════════════
// E13-6 — which versions the CLIENT sees on /r/[token] (plan §9.2 E13-6 (a)).
// Server-side only. The page, the playback-renewal route and the download
// route all decide through these functions, so the three never disagree.
// ═══════════════════════════════════════════════════════════════════════════
//
// A version is SHOWN when it is:
//   · drive  — Drive history (the backfill v1, or older): shown in today's iframe
//   · bunny  — ready, integrity hash_match / size_match (Q14), original kept,
//              media not deleted: our player + a download button
//   · archived — a bunny version that WAS shown and whose media Bunny has since
//              deleted (E13-10): the download button only, no player
//              (owner 16.10, §4b (1))
// The download is ALWAYS the version's own file in Drive (drive_file_id),
// before and after Bunny deletes the media — owner 17.10: Bunny is for
// playback only, never for downloading. Replaces "download through the
// system" (/original) of 11.10.
// Everything else — processing, unchecked, mismatch, failed — is NOT shown, and
// the client simply sees the previous shown version, with no notice (owner
// 17.10). An item with no SHOWN bunny/archived version is left exactly as it
// renders today (media_link): E13-6 changes only items that reached Bunny.

export type VersionForClient = {
  id: string;
  item_id: string;
  number: number | null;
  source: string;
  media_link: string | null;
  bunny_video_id: string | null;
  bunny_status: string | null;
  integrity: string | null;
  has_original: boolean | null;
  is_audio_only: boolean;
  original_filename: string | null;
  drive_file_id: string | null;
  media_deleted_at: string | null;
  /** 0122 (owner 22.10): withdrawn — sent by mistake. Never shown, never served, never "current". */
  withdrawn_at?: string | null;
};

export type ClientVersion =
  | { id: string; number: number; kind: "bunny"; isAudio: boolean; fileName: string | null; playbackUrl: string; expires: number; downloadable: boolean }
  | { id: string; number: number; kind: "drive"; mediaLink: string }
  | { id: string; number: number; kind: "archived"; isAudio: boolean; fileName: string | null };

const INTEGRITY_OK = new Set(["hash_match", "size_match"]);

/** Ready, verified, original kept, not deleted — what the player and the download route may serve. */
export function isPlayableBunny(v: VersionForClient): boolean {
  return (
    v.source === "bunny" &&
    !!v.bunny_video_id &&
    v.bunny_status === "ready" &&
    INTEGRITY_OK.has(v.integrity ?? "") &&
    v.has_original === true &&
    !v.media_deleted_at &&
    !v.withdrawn_at &&
    v.number !== null
  );
}

/** Verified once, deleted since (E13-10): the client gets the Drive original instead. */
export function isArchivedBunny(v: VersionForClient): boolean {
  return v.source === "bunny" && !!v.media_deleted_at && !v.withdrawn_at && INTEGRITY_OK.has(v.integrity ?? "") && !!v.drive_file_id && v.number !== null;
}

/**
 * Drive's direct-download address (the current form of uc?export=download —
 * drive.google.com/uc now redirects here). confirm=t skips the "can't scan for
 * viruses" page Google puts in front of large files. Works only for a file
 * shared "anyone with the link" — the review folder is (memory: BIZI PODCLUB).
 */
export const driveDownloadUrl = (fileId: string) =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=t`;

/**
 * One item's versions as the client sees them, oldest first (the last one is
 * "the current version"). Empty when nothing ever reached Bunny for this item:
 * the page then renders the item exactly as before E13-6. PURE apart from
 * `sign`, which is injected so tests need no keys.
 */
export function clientVersionsForItem(
  allRows: VersionForClient[],
  sign: (guid: string) => SignedUrl = (g) => signedPlaybackUrl(g, PLAYBACK_TTL_SECONDS)
): ClientVersion[] {
  // 0122: a withdrawn version does not exist for the client — not in the
  // list, not as "pending", not as history. Its number stays taken.
  const rows = allRows.filter((r) => !r.withdrawn_at);
  const sorted = [...rows].filter((r) => r.number !== null).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  if (!sorted.some((r) => isPlayableBunny(r) || isArchivedBunny(r))) {
    // owner 18.10: "שלח לביקורת" now writes the item's media_link to the NEW
    // version's Drive file at send time. While that version is not shown yet
    // (processing, unchecked, mismatch — decision 14: the client sees the
    // previous one), media_link must not be the fallback: show the Drive
    // history instead. No pending Bunny version, or no history → as before.
    const pendingBunny = rows.some((r) => r.source === "bunny" && r.bunny_status !== "failed" && !isPlayableBunny(r) && !isArchivedBunny(r));
    const history = sorted.filter((r) => r.source === "drive" && r.media_link);
    if (!pendingBunny || !history.length) return [];
    return history.map((r) => ({ id: r.id, number: r.number as number, kind: "drive" as const, mediaLink: r.media_link as string }));
  }
  const out: ClientVersion[] = [];
  for (const r of sorted) {
    const n = r.number as number;
    if (r.source === "drive" && r.media_link) {
      out.push({ id: r.id, number: n, kind: "drive", mediaLink: r.media_link });
    } else if (isPlayableBunny(r)) {
      const s = sign(r.bunny_video_id as string);
      out.push({ id: r.id, number: n, kind: "bunny", isAudio: r.is_audio_only, fileName: r.original_filename, playbackUrl: s.url, expires: s.expires, downloadable: !!r.drive_file_id });
    } else if (isArchivedBunny(r)) {
      out.push({ id: r.id, number: n, kind: "archived", isAudio: r.is_audio_only, fileName: r.original_filename });
    }
  }
  return out;
}

const SELECT =
  "id,item_id,number,source,media_link,bunny_video_id,bunny_status,integrity,has_original,is_audio_only,original_filename,drive_file_id,media_deleted_at,withdrawn_at";
/** The columns VersionForClient needs, for callers that read versions themselves. */
export const CLIENT_VERSION_SELECT = SELECT;

/**
 * The version the client is looking at as "the current one" — the version a
 * decision on this item is about (E13-8: the approvals ledger, and "respond on
 * the latest version only"). The last entry of clientVersionsForItem; when
 * nothing reached Bunny the page shows the item's Drive media, so the latest
 * Drive history row. null when the item has no version row at all (28 items,
 * 17.10): such a decision cannot name a version (0114 cra_version_chk).
 */
export function latestShownVersionId(rows: VersionForClient[]): string | null {
  const shown = clientVersionsForItem(rows, () => ({ url: "", expires: 0 }));
  if (shown.length) return shown[shown.length - 1].id;
  const drive = rows.filter((r) => r.source === "drive" && r.number !== null && !r.withdrawn_at).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  return drive.length ? drive[drive.length - 1].id : null;
}

/** All items' client versions in one read. Throws on a read error — the page catches it (rule 38). */
export async function loadClientVersions(admin: SupabaseClient<Database>, itemIds: string[]): Promise<Record<string, ClientVersion[]>> {
  if (!itemIds.length) return {};
  const { data, error } = await admin.from("client_review_versions").select(SELECT).in("item_id", itemIds);
  if (error) throw new Error(`client_review_versions: ${error.message}`);
  const byItem = new Map<string, VersionForClient[]>();
  for (const r of data ?? []) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
  const out: Record<string, ClientVersion[]> = {};
  byItem.forEach((rows, itemId) => {
    const list = clientVersionsForItem(rows);
    if (list.length) out[itemId] = list;
  });
  return out;
}

// ── the gate for the playback-renewal and download routes ─────────────────

export type LinkForGate = { production_id: string; scope: "episode" | "reels" | "all" };
export type ItemForGate = { id: string; production_id: string; kind: string };

/** Same rule as the page: the item belongs to the link's production and its kind is in the link's scope. */
export function itemInLinkScope(link: LinkForGate, item: ItemForGate, reelsRequired: boolean): boolean {
  if (item.production_id !== link.production_id) return false;
  if (item.kind === "episode") return link.scope === "episode" || link.scope === "all";
  if (item.kind === "reel") return (link.scope === "reels" || link.scope === "all") && reelsRequired;
  return false;
}

export type GateResult = { ok: true } | { ok: false; reason: "not_in_scope" | "not_playable" };
export type DownloadGateResult = { ok: true; driveFileId: string } | { ok: false; reason: "not_in_scope" | "not_downloadable" };

/** May this link renew playback of this version? The playback route asks exactly this, after resolveLink said "ok". */
export function gateVersionForLink(link: LinkForGate, reelsRequired: boolean, item: ItemForGate, version: VersionForClient): GateResult {
  if (version.item_id !== item.id || !itemInLinkScope(link, item, reelsRequired)) return { ok: false, reason: "not_in_scope" };
  if (!isPlayableBunny(version)) return { ok: false, reason: "not_playable" };
  return { ok: true };
}

/**
 * May this link download this version? Exactly the versions that carry a
 * download button on the page: shown bunny (before deletion) and archived
 * (after), with a Drive file id. The bytes always come from Drive.
 */
export function gateDownloadForLink(link: LinkForGate, reelsRequired: boolean, item: ItemForGate, version: VersionForClient): DownloadGateResult {
  if (version.item_id !== item.id || !itemInLinkScope(link, item, reelsRequired)) return { ok: false, reason: "not_in_scope" };
  if (!version.drive_file_id || !(isPlayableBunny(version) || isArchivedBunny(version))) return { ok: false, reason: "not_downloadable" };
  return { ok: true, driveFileId: version.drive_file_id };
}

export async function loadVersionWithItem(
  admin: SupabaseClient<Database>,
  versionId: string
): Promise<{ version: VersionForClient; item: ItemForGate } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) return null;
  const { data: version, error } = await admin.from("client_review_versions").select(SELECT).eq("id", versionId).maybeSingle();
  if (error || !version) return null;
  const { data: item } = await admin.from("client_review_items").select("id,production_id,kind").eq("id", version.item_id).maybeSingle();
  if (!item) return null;
  return { version, item };
}
