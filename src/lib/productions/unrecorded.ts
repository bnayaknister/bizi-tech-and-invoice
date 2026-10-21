import { hasBeenPerformed } from "./status";

// ═══════════════════════════════════════════════════════════════════════════
// B38-2 — the 21:00 safety net. PURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// With the work order born when the recording is marked done (B38-1), a
// recording that happened and was never marked would never be billed. Every
// evening at 21:00 (Israel):
//   · the billable client productions of today and the 13 days before it that
//     are not cancelled and were not marked "הוקלט" → one WhatsApp to the owner
//     (owner decision 5: billable clients only) + a radar card for the past days
//   · the corrective sweep: a billable production in the same window that IS
//     performed and has no work order → its order is queued now (any app path
//     that missed it is caught within the day)
//   · B38-6, the job sweep (before the order sweep, so a new order carries its
//     job): a billable production in the same window that is performed, or
//     whose "פרק · הקלטה" stage is done, and has no job → ensure_job_for_production
//     (the same function the trigger and the stage tick use; it stamps the
//     production's existing work order and never queues one)

export const UNRECORDED_LOOKBACK_DAYS = 14;

export type UnrecordedRow = {
  id: string;
  kind: string | null;
  legacy?: boolean | null;
  status: string | null;
  record_date: string | null;
  record_time?: string | null;
  podcast_name: string | null;
  guest?: string | null;
  show_id: string | null;
  cancelled_at: string | null;
  merged_into: string | null;
};

/** A client production on a show that bills per episode (not internal / contract / none). */
export function isBillableProduction(p: UnrecordedRow, billingModeByShow: Map<string, string | null>): boolean {
  if (p.kind !== "client" || p.legacy || p.cancelled_at || p.merged_into) return false;
  const mode = p.show_id ? billingModeByShow.get(p.show_id) ?? null : null;
  return mode === "per_episode";
}

/** Israeli "YYYY-MM-DD" minus n days — string arithmetic, no time zone in play. */
export function minusDays(dateIsrael: string, n: number): string {
  const [y, m, d] = dateIsrael.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) - n * 86_400_000);
  return t.toISOString().slice(0, 10);
}

export function planUnrecordedCheck(
  rows: UnrecordedRow[],
  billingModeByShow: Map<string, string | null>,
  todayIsrael: string,
  /** B38-6: productions whose episode "record" stage is done */
  recordStageDone: ReadonlySet<string> = new Set(),
  /** B38-6: productions that already have a job */
  hasJob: ReadonlySet<string> = new Set()
): { unrecorded: UnrecordedRow[]; toSweep: UnrecordedRow[]; toJob: UnrecordedRow[] } {
  const from = minusDays(todayIsrael, UNRECORDED_LOOKBACK_DAYS - 1);
  const inWindow = rows.filter(
    (p) => !!p.record_date && p.record_date >= from && p.record_date <= todayIsrael && isBillableProduction(p, billingModeByShow)
  );
  const byDate = (a: UnrecordedRow, b: UnrecordedRow) =>
    `${a.record_date} ${a.record_time ?? ""}`.localeCompare(`${b.record_date} ${b.record_time ?? ""}`);
  return {
    unrecorded: inWindow.filter((p) => !hasBeenPerformed(p.status, p.cancelled_at)).sort(byDate),
    toSweep: inWindow.filter((p) => hasBeenPerformed(p.status, p.cancelled_at)),
    // B38-6: performed (or its recording stage ticked done) and still no job
    toJob: inWindow.filter((p) => (hasBeenPerformed(p.status, p.cancelled_at) || recordStageDone.has(p.id)) && !hasJob.has(p.id)),
  };
}

/** "21.10" from "2026-10-21" */
const dm = (iso: string) => `${Number(iso.slice(8, 10))}.${Number(iso.slice(5, 7))}`;

/** One line for the WhatsApp parameter: "פודקאסט אילון לוי 21.10 16:00 (בני גנץ) · …" */
export function unrecordedLine(list: UnrecordedRow[]): string {
  return list
    .map((p) => [p.podcast_name ?? "—", p.record_date ? dm(p.record_date) : "", p.record_time ?? "", p.guest ? `(${p.guest})` : ""].filter(Boolean).join(" "))
    .join(" · ");
}
