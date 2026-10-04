// "יצירת עבודה לחיוב" — the small set of facts BOTH the server and the screen
// need in order to create a job for a production that has none.
//
// WHY A SEPARATE FILE, and not a few `if`s in the route. Exactly the argument
// lib/productions/hours.ts makes two files over: the billing side lives in
// lib/documents/enqueue.ts, which imports the Supabase client and the whole
// Morning type surface, and a "use client" component that imported it would
// drag all of that into the browser bundle. Everything here is plain data.
//
// ═══ WHAT THIS FEATURE IS, AND WHAT IT IS NOT ═══
// A job is "the work, priced". Two live cases arrive at the same dead end —
// a production with no job, and therefore nothing to bill:
//
//   · SFI, two productions of 17.8.2026 in 'ממתין_לתגובת_לקוח' with ISSUED
//     work orders 10311/10312. 0060 created the 'הוקלט' trigger on 24.8 —
//     seven days after they were recorded — and they never reached client
//     approval, so NEITHER entry point of ensure_job_for_production ever fired
//     (0077:205-212 names these two rows and leaves them deliberately null).
//   · מכון דוידסון, a historical episode of 12.7.2026 recorded straight into
//     Morning. Its show is per_hour, so `shows_one_rate_per_model` (0067:166)
//     forces default_rate NULL and record-past-productions' "מסמכים" mode
//     cannot derive an amount at all.
//
// 0077 says why neither was fixed by a migration: "giving them a job would
// CREATE MONEY, which is an owner decision and not a data fix". This is that
// decision, taken in the screen, by a human, with the amount in front of them.
//
// IT ISSUES NOTHING. No pending_documents row, no Morning call. The job and
// its link, and that is all — see the route's header for the three structural
// reasons that is true rather than merely intended.

/**
 * The ceiling, shared by the form and the route that validates it.
 *
 * A route-level judgement with a readable sentence rather than a CHECK
 * constraint, the same call 0067 made for MAX_HOURS: `jobs.amount` is bare
 * numeric and a constraint violation is not a message anyone can act on. The
 * number is deliberately far above any real session — its job is to catch a
 * keyboard slip (a stray digit turns ₪1,000 into ₪10,000), not to express a
 * price policy.
 */
export const MAX_JOB_AMOUNT = 1_000_000;

/** The approved copy, in one place, so the screen and the tests cannot drift. */
export const CREATE_JOB_COPY = {
  button: "יצירת עבודה לחיוב",
  title: "יצירת עבודה להפקה",
  why: "להפקה הזו אין עבודה במערכת, ולכן אי אפשר לחייב אותה.",
  amountLabel: "סכום לפני מע״מ",
  suggested: "מחושב לפי מחיר התוכנית",
  noSuggestion: "לתוכנית אין מחיר מוגדר. הזינו סכום.",
  note: "יצירת העבודה לא מוציאה שום מסמך. אחריה אפשר להוציא חשבון עסקה או לשייך מסמך קיים.",
  submit: "יצירה",
  cancel: "ביטול",
  done: "העבודה נוצרה.",
  /**
   * The ONE word here that is not in the owner's approved list, and it is
   * flagged rather than smuggled: once the job exists the form is gone and the
   * remaining control is a dismiss. Labelling it "ביטול" would be a lie —
   * there is nothing left to cancel. "סגירה" is the house word for it (the
   * drawers' own close control is aria-label "סגור"). One place to change if
   * the owner wants other wording.
   */
  close: "סגירה",
} as const;

/**
 * The three refusals, as a function of three facts.
 *
 * `hasJob` is 409 and the other two are 400, and that split is not cosmetic:
 * "already has one" is a state the caller can resolve by looking at the
 * screen again (another tab, or a status transition that fired the trigger in
 * between), while a cancelled production and a client-less one are the request
 * being wrong about what it is asking for.
 *
 * Returned rather than thrown so the route and the form can ask the same
 * question — the route is still the wall.
 */
export type CreateJobFacts = {
  hasJob: boolean;
  cancelled: boolean;
  clientId: string | null;
};
export type CreateJobGate = { ok: true } | { ok: false; status: 409 | 400; error: string };

export function createJobGate(f: CreateJobFacts): CreateJobGate {
  if (f.hasJob) return { ok: false, status: 409, error: "להפקה כבר יש עבודה." };
  if (f.cancelled) return { ok: false, status: 400, error: "ההפקה מבוטלת — אין מה לחייב." };
  if (!f.clientId) {
    return { ok: false, status: 400, error: "להפקה אין לקוח משויך — אי אפשר ליצור עבודה." };
  }
  return { ok: true };
}

/**
 * Is this a number the amount field may submit?
 *
 * ONE spelling, called by both sides — deliberately tighter than the
 * hours precedent, which re-states its checks in the route. The amount is the
 * whole point of this feature: two spellings of "which numbers are money" is
 * two chances for the form to accept what the server refuses, on the one field
 * the owner is being asked to confirm.
 *
 * The two-decimal refusal is 0067's rule about money that changes itself on
 * the way into the database, applied one column over. `jobs.amount` is bare
 * numeric and would in fact keep a third decimal — but the deal invoice built
 * from this job splits it into income lines and the balance gate compares
 * Σ(price × quantity) to it within one agora (lineBalance.ts), so a third
 * decimal entered here surfaces as a refusal three screens later with nothing
 * naming this field. Refuse while its author is still looking at it.
 */
export function jobAmountError(raw: unknown): string | null {
  const s = raw == null ? "" : String(raw);
  if (s.trim() === "") return "יש להזין סכום";
  const n = Number(s);
  if (!Number.isFinite(n)) return "הסכום אינו מספר תקין";
  if (n <= 0) return "הסכום חייב להיות גדול מאפס";
  if (n > MAX_JOB_AMOUNT) return `הסכום חייב להיות עד ${MAX_JOB_AMOUNT.toLocaleString("he-IL")}`;
  if (Number(n.toFixed(2)) !== n) return "הסכום מוגבל לשתי ספרות אחרי הנקודה";
  return null;
}
