// Contract-milestone display state (owner spec 2026-07-18). Three visible
// states plus the "invoiced, awaiting payment" middle. Open commitment is
// CYAN, never red — it isn't a debt, it's money not yet due.

export type MilestoneState = "paid" | "invoiced" | "open" | "overdue";

/**
 * THE JOB IS THE SOURCE OF TRUTH, NOT THE `status` COLUMN (owner decision
 * 2026-09-15). The column is kept in step but nothing is derived from it alone.
 *
 * WHY, measured on live data the day this was decided: of the three milestones
 * displaying green, ZERO got it from the column — all three came from
 * `jobPaid`. And the single manual write to `status` in the system's entire
 * history (2026-09-01) landed on a row whose job already said paid, so it
 * changed nothing. The column had never once carried a fact the job did not.
 *
 * It could not have. FOUR independent paths move `jobs.paid` and not one of
 * them mentions contract_milestones:
 *   • issue.ts:105,107        a 320 or 400 reaching Morning
 *   • reconcile.ts:426        linkDocumentToJob — auto-match on pull, and the
 *                             gaps screen, and reconcile-payments
 *   • mark-paid/route.ts:26   "סמן שולם" on one job
 *   • mark-paid/route.ts:61   the same, in bulk
 * Teaching each of them to write the milestone means the same rule in four
 * places and a guaranteed fifth hole. Reading the job instead means one place.
 *
 * ═══ WHY THE `status ===` ARMS STAY — THEY ARE NOT DECORATION ═══
 * They are the OR that keeps the display honest while the column lags. Removing
 * them is safe only on the day every path above also writes the milestone, and
 * that day is not this one. They are also the manual menu's only remaining
 * power (contracts/milestones/[mid]/route.ts): it can push a milestone forward
 * when no job exists to speak for it, which is the ordinary state of a
 * milestone before its first document is issued.
 *
 * ORDER IS THE WHOLE RULE: `paid` is tested first, so a job that is billed AND
 * paid reads paid. Nothing else enforces the precedence — moving these two
 * lines would silently invert it.
 */
export type MilestoneFacts = {
  status: string; // pending | invoiced | paid — kept in step, never trusted alone
  expected_date: string | null;
  is_estimated: boolean;
  jobPaid?: string | null; // linked job's paid, if any ('כן' closes it)
  /**
   * The linked job carries a document number — invoice_biz (a 300) or
   * invoice_tax (a 305/320). Either one means a bill went out.
   *
   * A 305 deliberately does NOT reach 'paid' through this: it declares a debt
   * and says nothing about money arriving (issue.ts:104), so it stops at
   * 'invoiced' exactly like the 300 before it. Only a 320 or a 400 flips
   * jobs.paid, and that is what the arm above reads.
   */
  jobBilled?: boolean;
};

export function deriveMilestoneState(m: MilestoneFacts): MilestoneState {
  if (m.status === "paid" || m.jobPaid === "כן") return "paid";
  if (m.status === "invoiced" || m.jobBilled) return "invoiced";
  // pending: overdue only if the date has really passed AND isn't a guess
  if (m.expected_date && !m.is_estimated) {
    const past = new Date(m.expected_date).getTime() < Date.now();
    if (past) return "overdue";
  }
  return "open";
}

export const MILESTONE_META: Record<MilestoneState, { label: string; color: string; dot: string }> = {
  paid: { label: "שולם", color: "var(--green)", dot: "var(--green)" },
  invoiced: { label: "חויב — ממתין לתשלום", color: "var(--cyan)", dot: "var(--cyan)" },
  open: { label: "פתוח", color: "var(--cyan)", dot: "var(--cyan)" },
  overdue: { label: "עבר המועד ואין חשבונית", color: "var(--red)", dot: "var(--red)" },
};
