import { deriveState, type FinanceJobFacts, type FinanceState } from "@/lib/finance/state";

// ═══════════════════════════════════════════════════════════════════════════
// Q10 — may this production be archived off the "הופץ" column? PURE.
// Owner decisions 18.9 + 13.10 (docs/TICKETS.md, Q10).
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ONE DEFINITION of "the money closed" for the board archive. The page (to
// draw the button and its reason), the route (to re-check at the moment of
// execution) and the tests all import this — a second spelling would be the
// B12 problem again: two truths about one word.
//
// ═══ "CLOSED" IS deriveState === "closed", NOT A NEW RULE ═══
// lib/finance/state.ts already says what a closed job is: paid AND a tax
// invoice went out, or "ללא חיוב". That is the state /finance files under
// "סגור" and the one the radar stops alerting on. "Paid without a tax invoice"
// (`red`) is deliberately NOT closed: it is an open action (the red radar
// alert, isPaidNoTax), and the whole reason for the money gate is that an
// archive must not take an open action out of sight. 0 of the 42 "הופץ"
// productions were in that shape on 13.10, so the choice costs nothing today.
//
// ═══ A FOLDED JOB IS JUDGED BY ITS TARGET (owner 13.10) ═══
// A job inside a bundle document (bundle_job_ids) or under a consolidated work
// order (pending_documents.consolidated_into) is closed only when EVERY job of
// that target is closed — the target is one document and one payment, so
// "this episode's money closed" means "that document's money closed".
//
// ⚠️ This decides the board only. It never changes status, money,
// merged_into, jobs.dismissed, or any document.

export const BOARD_ARCHIVE_STATUS = "הופץ";

export type ArchiveJob = FinanceJobFacts & { id: string; dismissed?: boolean | null };

export type ArchiveTarget = {
  kind: "bundle" | "consolidated";
  /** how the reason names it: "חשבון עסקה 40291", "הזמנת עבודה מאוחדת 10317" */
  label: string;
  jobs: ArchiveJob[];
};

export type ArchiveFacts = {
  status: string;
  /** productions.kind: client | internal | contract */
  kind: string | null;
  show: { client_id: string | null; billing_mode: string | null } | null;
  /** jobs linked through job_productions */
  jobs: ArchiveJob[];
  /** per linked job id: the bundle / consolidation targets it was folded into */
  targets: Record<string, ArchiveTarget[]>;
};

export type ArchiveEligibility = { eligible: true; reason: null } | { eligible: false; reason: string };

export const ARCHIVE_REASON = {
  notHofatz: 'רק הפקה בטור "הופץ" ניתנת לארכוב.',
  contract: "הפקת חוזה — ארכוב הפקות חוזה עדיין לא נתמך.",
  noJob: "אין להפקה עבודה לחיוב — אי אפשר לוודא שהכסף נסגר.",
  unknown: 'מצב התשלום "לא ידוע" — צריך לברר לפני ארכוב.',
  internalOpen: "הפקה פנימית עם עבודה שטרם נסגרה",
} as const;

const OPEN_STATE: Record<Exclude<FinanceState, "closed">, string> = {
  purple: "הכסף טרם נסגר: עוד לא הופק חשבון עסקה.",
  blue: "הכסף טרם נסגר: חשבון עסקה הופק והתשלום טרם התקבל.",
  red: "התשלום התקבל, אבל עוד לא הופקה חשבונית מס.",
};

const live = (jobs: ArchiveJob[]) => jobs.filter((j) => !j.dismissed);

type Verdict = { ok: true } | { ok: false; why: "unknown" | Exclude<FinanceState, "closed"> };

function judge(j: ArchiveJob): Verdict {
  if (j.paid === "לא ידוע") return { ok: false, why: "unknown" };
  const s = deriveState(j);
  return s === "closed" ? { ok: true } : { ok: false, why: s };
}

/** The production's internal-ness, exactly as the owner defined it (13.10). */
export function isInternalProduction(f: Pick<ArchiveFacts, "kind" | "show">): boolean {
  return f.kind === "internal" || !f.show?.client_id || f.show?.billing_mode === "none";
}

export function archiveEligibility(f: ArchiveFacts): ArchiveEligibility {
  if (f.status !== BOARD_ARCHIVE_STATUS) return { eligible: false, reason: ARCHIVE_REASON.notHofatz };
  if (f.kind === "contract" || f.show?.billing_mode === "contract") {
    return { eligible: false, reason: ARCHIVE_REASON.contract };
  }

  const internal = isInternalProduction(f);
  const jobs = live(f.jobs);
  if (jobs.length === 0) {
    return internal ? { eligible: true, reason: null } : { eligible: false, reason: ARCHIVE_REASON.noJob };
  }

  for (const job of jobs) {
    const targets = f.targets[job.id] ?? [];
    if (targets.length === 0) {
      const v = judge(job);
      if (!v.ok) return refuse(v.why, internal, null);
      continue;
    }
    for (const t of targets) {
      // the job itself always belongs to its target, whatever the row says
      const members = live(t.jobs.some((j) => j.id === job.id) ? t.jobs : [...t.jobs, job]);
      const closed = members.filter((j) => judge(j).ok).length;
      const firstBad = members.map(judge).find((v): v is Exclude<Verdict, { ok: true }> => !v.ok);
      if (firstBad) {
        return refuse(firstBad.why, internal, `${t.label}, שההפקה אוחדה אליו: ${closed} מתוך ${members.length} עבודות סגורות`);
      }
    }
  }
  return { eligible: true, reason: null };
}

function refuse(why: Exclude<Verdict, { ok: true }>["why"], internal: boolean, via: string | null): ArchiveEligibility {
  const base = why === "unknown" ? ARCHIVE_REASON.unknown : OPEN_STATE[why];
  const head = internal ? `${ARCHIVE_REASON.internalOpen} — ${base}` : base;
  return { eligible: false, reason: via ? `${head} (${via})` : head };
}
