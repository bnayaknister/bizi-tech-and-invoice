// A project whose money chain stopped moving, and the reason a document column
// is legitimately empty. Both live here because the screen answers one question
// with two halves: "is this row stuck" and, when it is not, "why is that cell
// blank". The vocabulary has to be the same on both sides or the same row says
// two things.
//
// ⚠️ NO DUE-DATE ARITHMETIC IN THIS FILE, and that is the whole point of
// migration 0089. The payment-terms calculation lives once, in
// public.due_date_for(base, terms), and the caller hands the answer in.
// Everything here does with a date is add a constant number of days to it,
// which is this screen's own rule and not Morning's terms.

/**
 * Days of grace after the due date before a chain counts as stuck.
 *
 * Zero, deliberately (owner decision 2026-09-17). The slack this screen needs
 * is already in NO_TERMS_DAYS below — it is not needed twice, and a second
 * fudge factor is how an alert quietly stops meaning what it says.
 */
export const STUCK_GRACE_DAYS = 0;

/**
 * Days allowed a client with no payment terms configured.
 *
 * `immediate` COUNTS AS UNCONFIGURED, and that is a measurement, not a
 * reading of the enum: `clients.payment_terms` is `not null default
 * 'immediate'` (0002:116), 65 of 68 clients carry it, and zero rows are NULL.
 * So the value mostly records that nobody chose, not that payment is due on
 * the day the invoice goes out — and treating it literally made every 300
 * overdue the morning after it was issued. Measured over the live data on
 * 2026-09-17: 11 rows flagged reading `immediate` literally, 5 reading it as
 * unconfigured.
 *
 * The real fix is a "not configured" value in the enum so `immediate` can mean
 * what it says — ticket F10. Until then this constant is the honest reading.
 */
export const NO_TERMS_DAYS = 45;

/**
 * Days after the end of the recording month before an accrued client's episode
 * counts as stuck for having no document at all.
 *
 * This is a BILLING question, not a payment one, so it deliberately does not
 * consult payment terms: nothing has been billed yet, so there is no document
 * date for terms to measure from.
 */
export const UNBILLED_ACCRUAL_DAYS = 45;

export type PaymentTerms = "immediate" | "net_30" | "net_60" | "eom_30" | "eom_60" | "eom_90" | null;
export type Cadence = "per_episode" | "monthly" | "every_n" | null;

/** See NO_TERMS_DAYS — `immediate` is the column default, not a decision. */
export function termsUnconfigured(terms: PaymentTerms): boolean {
  return !terms || terms === "immediate";
}

/** The terms as the bookkeeper's sentence names them. */
export const TERMS_LABEL: Record<string, string> = {
  immediate: "ללא תנאי תשלום מוגדרים",
  net_30: "שוטף 30",
  net_60: "שוטף 60",
  eom_30: "שוטף+30",
  eom_60: "שוטף+60",
  eom_90: "שוטף+90",
};
export const termsLabel = (t: PaymentTerms) => TERMS_LABEL[t ?? ""] ?? "ללא תנאי תשלום מוגדרים";

// ---- small date helpers ---------------------------------------------------
// Plain calendar arithmetic on an ISO day string, in UTC so no timezone can
// shift a date that has no time. NOT due-date logic — see the file header.
export const addDays = (iso: string, n: number): string =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

export const endOfMonth = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

/** "9.9" — the form both approved sentences use. */
export const dayMonth = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;
};

/**
 * When a document becomes overdue for THIS screen.
 *
 * `dbDueDate` is what public.due_date_for returned for (document date, terms).
 * It is required whenever the terms are configured, and ignored when they are
 * not — an unconfigured client is measured by NO_TERMS_DAYS from the document
 * date instead. Returns null only when there is nothing to measure from.
 */
export function stuckDeadline(args: {
  docDate: string | null;
  terms: PaymentTerms;
  dbDueDate: string | null;
}): string | null {
  if (!args.docDate) return null;
  if (termsUnconfigured(args.terms)) return addDays(args.docDate, NO_TERMS_DAYS);
  if (!args.dbDueDate) return null;
  return addDays(args.dbDueDate, STUCK_GRACE_DAYS);
}

// ---- the empty-cell labels ------------------------------------------------

export type EmptyReason =
  | { kind: "monthly_current"; text: string }
  | { kind: "every_n"; text: string }
  | { kind: "contract"; text: string }
  | { kind: "no_billing"; text: string };

/**
 * Why the document columns of this row are blank, when the blank is expected.
 *
 * Returns null when a dash is the honest answer: a row that really is missing
 * a document it should have. The order matters — contract and no-billing are
 * statements about whether money is expected at all and answer first.
 */
export function emptyReasonFor(args: {
  billing: "priced" | "contract" | "no_billing" | "inactive" | "missing_rate";
  internal: boolean;
  cadence: Cadence;
  everyN: number | null;
  /** how many of the client's episodes have accrued toward the next bundle */
  accruedCount: number;
  /** the row's recording month, and the current Israeli month */
  recordMonth: string | null;
  currentMonth: string;
  hasDocs: boolean;
}): EmptyReason | null {
  if (args.hasDocs) return null;
  if (args.billing === "contract") return { kind: "contract", text: "חוזה · לפי אבני דרך" };
  if (args.billing === "no_billing" || args.internal) return { kind: "no_billing", text: "ללא חיוב" };
  if (args.cadence === "every_n" && args.everyN) {
    return { kind: "every_n", text: `מצטבר · ${args.accruedCount} מתוך ${args.everyN}` };
  }
  // Only for the month that is still running: an episode from a month that has
  // closed is no longer "about to go out", and saying so would explain away
  // exactly the row the stuck rule is trying to raise a hand about.
  if (args.cadence === "monthly" && args.recordMonth === args.currentMonth) {
    return { kind: "monthly_current", text: "חודשי · ייצא בסוף החודש" };
  }
  return null;
}

// ---- the stuck rule -------------------------------------------------------

export type StuckReason =
  | "billing_no_tax"
  | "tax_no_receipt"
  | "monthly_unbilled"
  | "every_n_full"
  | "not_enqueued";

export type Stuck = {
  reason: StuckReason;
  /** one Hebrew sentence, for the detail window */
  sentence: string;
  /**
   * What this row is stuck ON. The popup counts distinct keys, not rows: one
   * bundled 300 reaches four productions of כפיר ארביב, and counting rows
   * reported four stuck projects where there are two stuck documents.
   */
  key: string;
  /** the document to open in the registry, when the row is stuck on one */
  docNumber: string | null;
};

export type StuckDoc = {
  id: string;
  type: number;
  number: string | null;
  date: string | null;
  /** Morning's status; only 0 is open (parentOpenness, registry) */
  status: number | null;
  cancelled: boolean;
  /** the answer from public.due_date_for for (date, terms) — null when unconfigured */
  dbDueDate: string | null;
};

const DOC_NAME: Record<number, string> = { 300: "חשבון עסקה", 305: "חשבונית מס", 320: "חשבונית מס קבלה", 400: "קבלה" };

/**
 * Is this project's chain stuck, and on what?
 *
 * The owner's definition, 2026-09-17, in the order it is asked:
 *
 *   contract / no-billing / internal   never stuck — billed elsewhere or not at all
 *   every job dismissed                never stuck — a dismissed job is out of
 *                                      every money surface (0041), and saying
 *                                      "not billed" about work somebody
 *                                      deliberately removed is a false alarm
 *   open 300, no 305/320, past due     stuck
 *   open 305, no 400, past due         stuck
 *   accrued client, no document at all:
 *     no queue row either              stuck the moment the recording month
 *                                      closes — this fell between the chairs
 *                                      rather than waiting its turn
 *     monthly                          stuck UNBILLED_ACCRUAL_DAYS after the
 *                                      end of the recording month
 *     every_n                          stuck only once N episodes have
 *                                      accrued, measured from the one that
 *                                      completed the N. Below N it is waiting
 *                                      by design and carries the progress label
 *
 * A 320 closes the chain and never appears here: it is invoice and receipt in
 * one.
 */
export function stuckFor(args: {
  billing: "priced" | "contract" | "no_billing" | "inactive" | "missing_rate";
  internal: boolean;
  cancelled: boolean;
  allJobsDismissed: boolean;
  recordDate: string | null;
  cadence: Cadence;
  everyN: number | null;
  accruedCount: number;
  /** the episode whose recording completed the every_n bundle, if it is full */
  bundleCompletedOn: string | null;
  terms: PaymentTerms;
  docs: StuckDoc[];
  /** does the production hold a queue row that is accrued or pending? */
  inQueue: boolean;
  productionId: string;
  today: string;
}): Stuck[] {
  if (args.cancelled || args.internal) return [];
  if (args.billing === "contract" || args.billing === "no_billing") return [];
  if (args.allJobsDismissed) return [];

  const live = args.docs.filter((d) => !d.cancelled);
  const has = (t: number) => live.some((d) => d.type === t);
  const open = live.filter((d) => d.status === 0);
  const out: Stuck[] = [];

  for (const d of open.filter((x) => x.type === 300)) {
    if (has(305) || has(320)) continue;
    const due = stuckDeadline({ docDate: d.date, terms: args.terms, dbDueDate: d.dbDueDate });
    if (!due || args.today <= due) continue;
    out.push({
      reason: "billing_no_tax",
      key: `doc:${d.id}`,
      docNumber: d.number,
      sentence:
        `${DOC_NAME[300]} ${d.number ?? ""} יצא ב-${dayMonth(d.date as string)} · ${termsLabel(args.terms)} · ` +
        `הפירעון היה ב-${dayMonth(due)} — עוד לא יצאה עליו חשבונית מס`,
    });
  }
  for (const d of open.filter((x) => x.type === 305)) {
    if (has(400)) continue;
    const due = stuckDeadline({ docDate: d.date, terms: args.terms, dbDueDate: d.dbDueDate });
    if (!due || args.today <= due) continue;
    out.push({
      reason: "tax_no_receipt",
      key: `doc:${d.id}`,
      docNumber: d.number,
      sentence:
        `${DOC_NAME[305]} ${d.number ?? ""} יצאה ב-${dayMonth(d.date as string)} · ${termsLabel(args.terms)} · ` +
        `הפירעון היה ב-${dayMonth(due)} — עוד לא יצאה עליה קבלה`,
    });
  }
  if (out.length || live.length) return out;

  // ---- nothing was ever billed ------------------------------------------
  if (!args.recordDate) return out;
  if (args.cadence !== "monthly" && args.cadence !== "every_n") return out;
  const cadenceText =
    args.cadence === "monthly" ? "חיוב חודשי מרוכז" : `חיוב מצטבר כל ${args.everyN ?? "?"} פרקים`;
  const key = `prod:${args.productionId}`;

  if (!args.inQueue) {
    // the recording month has to be over — inside it there is nothing late yet
    if (args.recordDate.slice(0, 7) >= args.today.slice(0, 7)) return out;
    out.push({
      reason: "not_enqueued",
      key,
      docNumber: null,
      sentence:
        `הוקלט ב-${dayMonth(args.recordDate)} · ${cadenceText} — לא נוצרה שורת חיוב ולא יצא מסמך`,
    });
    return out;
  }

  if (args.cadence === "monthly") {
    const deadline = addDays(endOfMonth(args.recordDate), UNBILLED_ACCRUAL_DAYS);
    if (args.today <= deadline) return out;
    out.push({
      reason: "monthly_unbilled",
      key,
      docNumber: null,
      sentence:
        `הוקלט ב-${dayMonth(args.recordDate)} · ${cadenceText} — עברו ${UNBILLED_ACCRUAL_DAYS} יום ` +
        `מסוף חודש ההקלטה ולא יצא מסמך`,
    });
    return out;
  }

  // every_n — below N it is accruing exactly as intended
  if (!args.everyN || !args.bundleCompletedOn) return out;
  if (args.accruedCount < args.everyN) return out;
  const deadline = addDays(args.bundleCompletedOn, UNBILLED_ACCRUAL_DAYS);
  if (args.today <= deadline) return out;
  out.push({
    reason: "every_n_full",
    key,
    docNumber: null,
    sentence:
      `הוקלט ב-${dayMonth(args.recordDate)} · ${cadenceText} — האגד התמלא ב-` +
      `${dayMonth(args.bundleCompletedOn)} ולא יצא מסמך`,
  });
  return out;
}

/** The popup's per-month counts: distinct things stuck, not rows showing them. */
export function countByMonth(rows: { month: string; stuck: Stuck[] }[]): { month: string; count: number }[] {
  const byMonth = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const s of r.stuck) {
      const set = byMonth.get(r.month) ?? new Set<string>();
      set.add(s.key);
      byMonth.set(r.month, set);
    }
  }
  return Array.from(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([month, set]) => ({ month, count: set.size }));
}
