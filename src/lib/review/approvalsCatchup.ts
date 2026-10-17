import { latestShownVersionId, type VersionForClient } from "@/lib/review/clientVersions";

// ═══════════════════════════════════════════════════════════════════════════
// E13-8a — the approvals the ledger missed between the 16.10 backfill and the
// moment applyResponse started writing it (E13-8a). PURE; the script
// scripts/e13_approvals_catchup.ts reads, prints, and writes only on --apply.
// ═══════════════════════════════════════════════════════════════════════════
//
// SOURCE, the same two the backfill trusted: the responded link (responded_at
// = the decision time) and its client_review_approved / _revisions event,
// whose payload.items carries the per-item decisions (links.ts itemDetail).
// A track-mode response (no items in the event) maps its episode answer to
// the production's episode item, as the backfill's rule (a) did; a track-mode
// reels answer has no per-reel decision and is reported, not guessed.
//
// THE VERSION: the one the client was shown AT THAT MOMENT — a Bunny version
// counts only if it was ready by then (ready_at ≤ responded_at), the rest by
// the E13-6 rules (latestShownVersionId). None → the row is written without a
// version, which 0114 allows only as is_backfill (cra_version_chk).
//
// EVERY ROW is is_backfill=true with backfill_source
// `catchup:link:<link>:item:<item>` — unique in 0114, so a second run writes
// nothing. A (link, item) that already has ANY ledger row (the live write,
// the backfill, or an earlier catch-up) is skipped.
// An approval whose item is not approved today is written already revoked,
// as the backfill did ("revoked because the item is not approved today").

export type CuLink = { id: string; production_id: string; responded_at: string; episode_response: string | null; reels_response: string | null };
export type CuEvent = { event_type: string; payload: { link_id?: unknown; items?: unknown; episode_note?: unknown } | null };
export type CuItem = { id: string; production_id: string; kind: string; approved: boolean };
export type CuVersion = VersionForClient & { ready_at: string | null };
export type CuExisting = { link_id: string | null; item_id: string; backfill_source: string | null };

export type CuRow = {
  item_id: string;
  version_id: string | null;
  link_id: string;
  decision: "approved" | "revisions";
  note: string | null;
  decided_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
  is_backfill: true;
  backfill_source: string;
};

export type CuReport = { links: number; rows: number; approved: number; revisions: number; revokedNow: number; withoutVersion: number; skippedExisting: number; skippedTrackReels: number; linksWithoutEvent: number };

type Decision = { itemId: string; response: "approved" | "revisions"; note: string | null };

function decisionsFor(link: CuLink, ev: CuEvent | undefined, items: CuItem[]): { list: Decision[]; trackReels: boolean } {
  const raw = ev?.payload?.items;
  if (Array.isArray(raw) && raw.length) {
    const list: Decision[] = [];
    for (const d of raw as { id?: unknown; response?: unknown; note?: unknown }[]) {
      if (typeof d?.id !== "string" || (d.response !== "approved" && d.response !== "revisions")) continue;
      list.push({ itemId: d.id, response: d.response, note: typeof d.note === "string" ? d.note.trim() || null : null });
    }
    return { list, trackReels: false };
  }
  const list: Decision[] = [];
  const ep = items.find((i) => i.production_id === link.production_id && i.kind === "episode");
  if (ep && (link.episode_response === "approved" || link.episode_response === "revisions")) {
    const note = typeof ev?.payload?.episode_note === "string" ? ev.payload.episode_note.trim() || null : null;
    list.push({ itemId: ep.id, response: link.episode_response, note });
  }
  return { list, trackReels: link.reels_response === "approved" || link.reels_response === "revisions" };
}

export function planApprovalsCatchup(input: {
  links: CuLink[];
  events: CuEvent[];
  items: CuItem[];
  versions: CuVersion[];
  existing: CuExisting[];
  nowIso: string;
}): { rows: CuRow[]; report: CuReport } {
  const report: CuReport = { links: 0, rows: 0, approved: 0, revisions: 0, revokedNow: 0, withoutVersion: 0, skippedExisting: 0, skippedTrackReels: 0, linksWithoutEvent: 0 };
  const covered = new Set(input.existing.filter((e) => e.link_id).map((e) => `${e.link_id}|${e.item_id}`));
  const sources = new Set(input.existing.map((e) => e.backfill_source).filter((s): s is string => !!s));
  const itemById = new Map(input.items.map((i) => [i.id, i]));
  const rows: CuRow[] = [];

  for (const link of [...input.links].sort((a, b) => a.responded_at.localeCompare(b.responded_at))) {
    report.links++;
    const ev = input.events.find(
      (e) => (e.event_type === "client_review_approved" || e.event_type === "client_review_revisions") && e.payload?.link_id === link.id
    );
    if (!ev) report.linksWithoutEvent++;
    const { list, trackReels } = decisionsFor(link, ev, input.items);
    if (trackReels) report.skippedTrackReels++;
    for (const d of list) {
      const item = itemById.get(d.itemId);
      if (!item || item.production_id !== link.production_id) continue;
      const source = `catchup:link:${link.id}:item:${d.itemId}`;
      if (covered.has(`${link.id}|${d.itemId}`) || sources.has(source)) {
        report.skippedExisting++;
        continue;
      }
      const atThatTime = input.versions.filter(
        (v) => v.item_id === d.itemId && (v.source !== "bunny" || (v.ready_at !== null && v.ready_at <= link.responded_at))
      );
      const versionId = latestShownVersionId(atThatTime);
      if (!versionId) report.withoutVersion++;
      const revokeNow = d.response === "approved" && !item.approved;
      if (revokeNow) report.revokedNow++;
      rows.push({
        item_id: d.itemId,
        version_id: versionId,
        link_id: link.id,
        decision: d.response,
        note: d.response === "revisions" ? d.note : null,
        decided_at: link.responded_at,
        revoked_at: revokeNow ? input.nowIso : null,
        revoked_reason: revokeNow ? "catchup: הפריט אינו מאושר היום" : null,
        is_backfill: true,
        backfill_source: source,
      });
      if (d.response === "approved") report.approved++;
      else report.revisions++;
    }
  }
  report.rows = rows.length;
  return { rows, report };
}
