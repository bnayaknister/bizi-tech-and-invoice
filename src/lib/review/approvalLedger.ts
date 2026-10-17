import { latestShownVersionId, type VersionForClient } from "@/lib/review/clientVersions";

// ═══════════════════════════════════════════════════════════════════════════
// E13-8a — the approvals ledger (client_review_approvals, 0114), from now on.
// ═══════════════════════════════════════════════════════════════════════════
//
// Until now nothing in src/ wrote it: the 52 rows are the 16.10 backfill.
// E13-8 revokes an approval when the client comments on an approved item, and
// the 90-day deletion (v_review_media_purge_due) reads only this table — so
// every decision a client makes through a link is recorded here, one row per
// item, approved or revisions, naming the version the client was SHOWN
// (latestShownVersionId: the E13-6 rules).
//
// An item with no version row at all (old, or skipped by the backfill) gets
// no row: 0114's cra_version_chk forbids a live decision without a version,
// and owner decision 6 (17.10) is that such an item is commented on but never
// re-approved. It is reported, not invented.
//
// PURE: the caller reads the versions and writes the rows.

export type ItemDecision = { id: string; response: string; note: string | null };

export type LedgerRow = {
  item_id: string;
  version_id: string;
  link_id: string;
  decision: "approved" | "revisions";
  note: string | null;
  decided_at: string;
};

export function buildApprovalLedgerRows(
  decisions: ItemDecision[],
  versionsByItem: Map<string, VersionForClient[]>,
  linkId: string,
  decidedAt: string
): { rows: LedgerRow[]; withoutVersion: string[] } {
  const rows: LedgerRow[] = [];
  const withoutVersion: string[] = [];
  for (const d of decisions) {
    if (d.response !== "approved" && d.response !== "revisions") continue;
    const versionId = latestShownVersionId(versionsByItem.get(d.id) ?? []);
    if (!versionId) {
      withoutVersion.push(d.id);
      continue;
    }
    rows.push({
      item_id: d.id,
      version_id: versionId,
      link_id: linkId,
      decision: d.response,
      note: d.response === "revisions" ? d.note?.trim() || null : null,
      decided_at: decidedAt,
    });
  }
  return { rows, withoutVersion };
}
