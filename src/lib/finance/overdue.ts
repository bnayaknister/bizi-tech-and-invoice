import { deriveState, type FinanceJobFacts } from "./state";

/**
 * Should the due-date column say anything at all about this job?
 *
 * B11: /finance computed `dueDays` straight off `jobs.due_date` and never
 * asked whether the money had arrived, so a job that was paid in July still
 * read "באיחור 60 יום" in September. The figure was true and the sentence was
 * false: a debt that is settled cannot be late.
 *
 * `false` means "say nothing", and it covers two states:
 *   · 'closed' — paid with its tax invoice out, or 'ללא חיוב'
 *   · 'red'    — paid, tax invoice still missing
 *
 * ⚠️ 'red' is in that list on purpose, and dropping it would leave the bug
 * standing in the case most likely to hit it. `red` means the MONEY IS IN
 * (paid === 'כן') and only the tax document is outstanding — state.ts:20. The
 * job still owes a document; it does not owe money, and the due-date column is
 * about money. A rule written as `state === "closed"` alone would keep
 * printing "באיחור" over every paid-but-untaxed job, which is the exact
 * population the radar already shouts about for a different reason.
 *
 * Built on deriveState rather than on `paid` directly so the next screen that
 * asks "is this late" inherits one definition of settled instead of spelling a
 * second one — which is how B11 happened in the first place.
 *
 * The radar does NOT need this: it counts overdue out of `debtJobs`, which is
 * already filtered to `paid === 'לא'` (alerts.ts:301), so a paid job never
 * reaches its buckets. Checked 2026-09-17 rather than assumed.
 */
export function dueDateApplies(facts: FinanceJobFacts): boolean {
  const state = deriveState(facts);
  return state !== "closed" && state !== "red";
}
