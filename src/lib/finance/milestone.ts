// Contract-milestone display state (owner spec 2026-07-18). Three visible
// states plus the "invoiced, awaiting payment" middle. Open commitment is
// CYAN, never red — it isn't a debt, it's money not yet due.

export type MilestoneState = "paid" | "invoiced" | "open" | "overdue";

export type MilestoneFacts = {
  status: string; // pending | invoiced | paid
  expected_date: string | null;
  is_estimated: boolean;
  jobPaid?: string | null; // linked job's paid, if any ('כן' closes it)
};

export function deriveMilestoneState(m: MilestoneFacts): MilestoneState {
  if (m.status === "paid" || m.jobPaid === "כן") return "paid";
  if (m.status === "invoiced") return "invoiced";
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
