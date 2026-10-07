// The finance pipeline state machine (owner spec 2026-07-18): a job is
// placed by WHAT TO DO NEXT, not by date. Derived from three facts — is there
// a business invoice (עסקה), did the money come in (paid), is there a tax
// invoice (מס). Verified against real data: red = 5 jobs / 5,650 ₪.

export type FinanceState = "purple" | "blue" | "red" | "closed";

export type FinanceJobFacts = {
  paid: string | null; // 'כן' | 'לא' | 'לא ידוע' | 'ללא חיוב'
  invoice_biz: string | null; // business-invoice (עסקה) doc number, or null
  invoice_tax: string | null; // tax-invoice (מס) doc number, or null
};

const present = (v: string | null): boolean => v != null && String(v).trim() !== "";

export function deriveState(j: FinanceJobFacts): FinanceState {
  const hasBiz = present(j.invoice_biz);
  const hasTax = present(j.invoice_tax);
  if (j.paid === "כן") {
    // money is in — the only question is whether the tax invoice went out
    return hasTax ? "closed" : "red";
  }
  if (j.paid === "ללא חיוב") return "closed"; // no charge — nothing to collect
  // money not in yet
  return hasBiz ? "blue" : "purple";
}

/** The two facts the paid-no-tax rule needs — nothing else is consulted. */
export type PaidNoTaxFacts = Pick<FinanceJobFacts, "paid" | "invoice_tax">;

/**
 * "שולם — ואין חשבונית מס": the money came in and no tax document went out.
 *
 * THE ONE DEFINITION. Three surfaces ask this question and each used to spell
 * it itself: the red radar alert (alerts.ts), the hub card's critical count
 * (alerts.ts, which also forgot `dismissed`), and now /finance?filter=
 * paid_no_tax. Three spellings of one rule is three chances to disagree about
 * a red money alert, so there is one function and the call sites import it.
 *
 * `present` and not `!j.invoice_tax` — deliberately. A whitespace-only string
 * is NOT a document number, and the truthiness test called it one: a job
 * carrying `invoice_tax = ' '` looked closed to the radar while /finance and
 * deriveState below both called it red. Zero rows are in that shape today
 * (measured 2026-09-16); the test is written for the day one is.
 *
 * ⚠️ INVARIANT: `isPaidNoTax(j) === (deriveState(j) === "red")`, by
 * construction — both are `paid === 'כן' && !present(invoice_tax)`. The red
 * tab on /finance and this alert are the same population, and if one of the
 * two is ever changed alone, the screen and the radar start reporting
 * different numbers for the same money.
 *
 * `dismissed` is NOT tested here: a soft-removed job is out of every money
 * surface (0041), and that filter belongs to whoever loads the rows — the
 * radar does it in the query, /finance does it in page.tsx.
 */
export function isPaidNoTax(j: PaidNoTaxFacts): boolean {
  return j.paid === "כן" && !present(j.invoice_tax);
}

/** The one fact the amount-missing rule needs. */
export type AmountMissingFacts = { amount: number | null };

/**
 * "חיוב ללא סכום": a job nobody has priced.
 *
 * The second 🔴 alert, and the second half of the hub card's criticalTotal —
 * extracted for the same reason isPaidNoTax was (a1cbf32): the full radar and
 * the hub card each spelled it, and the card's spelling was missing
 * `dismissed`. It reported 3 where the radar reported 1, and the two extra
 * rows were dismissed test productions from 2026-07-29 — a critical alert
 * pointing at records /finance refuses to show.
 *
 * `== null` and not `!j.amount` or `== 0`: an UNPRICED job is the alert. A job
 * deliberately priced at zero is a decision someone made, and `!0` is true —
 * the truthiness test would have nagged about it forever. (Zero rows carry
 * amount = 0 today, measured 2026-09-16.) Loose equality on purpose, so an
 * absent field reads the same as a null column.
 *
 * `dismissed` is NOT tested here, exactly as in isPaidNoTax: it belongs to
 * whoever loads the rows.
 */
export function isAmountMissing(j: AmountMissingFacts): boolean {
  return j.amount == null;
}

/** The one fact the debt rule needs. */
export type DebtFacts = { paid: string | null };

/**
 * "חוב לגבייה": charged, and the money has not come in.
 *
 * ═══ WHY THIS IS A FUNCTION NOW ═══
 * It was spelled `j.paid === "לא"` in TWO places — the /finance summary
 * (page.tsx:117, feeding the "חוב לגבייה" card) and the radar's debtToCollect
 * (alerts.ts:315) — and /clients would have been a third. The isPaidNoTax note
 * above says what happens then, from experience: three spellings of one money
 * rule is three chances to disagree, and the hub card's own copy of a different
 * rule WAS wrong. A client's debt that does not add up to the /finance total is
 * a bug the owner would find by adding a column with a calculator.
 *
 * 🔴 `=== "לא"` AND NOT `!== "כן"`. `jobs.paid` is text, not a boolean, and it
 * has four values (FinanceJobFacts above): 'כן', 'לא', 'לא ידוע', 'ללא חיוב'.
 * Only 'לא' is debt. 'ללא חיוב' is nothing to collect by decision, and
 * 'לא ידוע' is an UNKNOWN — counting either as money owed would inflate a
 * number the owner collects against. This is the behaviour both call sites
 * already had; it is preserved exactly, not tidied.
 *
 * `amount` is deliberately NOT consulted — an unpriced job is still a debt row,
 * it just contributes 0 to a sum. The radar additionally requires
 * `amount != null` for its own COUNT; that stays at the call site, because it
 * is a different question ("how many priced debts") and not this rule.
 *
 * `dismissed` is NOT tested here, exactly as in isPaidNoTax: a soft-removed job
 * is out of every money surface (0041), and that filter belongs to whoever
 * loads the rows.
 */
export function isUnpaidDebt(j: DebtFacts): boolean {
  return j.paid === "לא";
}

// ---- the radar's red alerts, as views of /finance -------------------------

/** Everything a filter predicate may consult. FinanceJob satisfies it. */
export type FinanceFilterFacts = PaidNoTaxFacts & AmountMissingFacts;

/** The `?filter=` values /finance answers to. Nothing else is a filter. */
export type FinanceFilterKey = "paid_no_tax" | "amount_missing";

/**
 * The registry behind `/finance?filter=…` — ONE row per red radar alert that
 * links here, holding the three things the screen needs and nothing else.
 *
 * `match` is the alert's own predicate by reference, never a re-spelling: the
 * count in the filter bar has to be the same population the alert counted, and
 * pointing at the same function is the only way to guarantee it. `tone` mirrors
 * the alert's `severity` in alerts.ts (both are "red" today) so the bar and the
 * badge the bookkeeper clicked are the same colour.
 *
 * Adding a filter is adding a row here — the server's validation
 * (isFinanceFilterKey), the predicate and the bar text all read from it, so
 * there is no second place to update and no way to ship a key that validates
 * but has no predicate.
 */
export const FINANCE_FILTERS: Record<
  FinanceFilterKey,
  { label: string; tone: string; match: (j: FinanceFilterFacts) => boolean }
> = {
  paid_no_tax: { label: "שולם בלי חשבונית מס", tone: "var(--red)", match: isPaidNoTax },
  amount_missing: { label: "חיוב ללא סכום", tone: "var(--red)", match: isAmountMissing },
};

/**
 * Is this URL value a filter we serve?
 *
 * Everything else — a stale link, a typo, an empty `?filter=` — is NOT a
 * filter and the screen shows every row. A money screen must never hide rows
 * because it half-recognised a query string.
 */
export function isFinanceFilterKey(v: unknown): v is FinanceFilterKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(FINANCE_FILTERS, v);
}

export const TAB_META: Record<
  FinanceState,
  { label: string; short: string; color: string; dot: string; hint: string }
> = {
  purple: {
    label: "לא חויב",
    short: "הופק ונמסר, אין חשבונית עסקה",
    color: "var(--violet-light)",
    dot: "var(--violet)",
    hint: "הנפק חשבונית עסקה",
  },
  blue: {
    label: "ממתין לתשלום",
    short: "חשבונית יצאה, הכסף עוד לא נכנס",
    color: "var(--cyan)",
    dot: "var(--cyan)",
    hint: "עקוב אחרי הגבייה",
  },
  red: {
    label: "חסרה חשבונית מס",
    short: "הכסף נכנס — חשבונית המס לא יצאה",
    color: "var(--red)",
    dot: "var(--red)",
    hint: "דחוף — חשיפה מול רשויות המס",
  },
  closed: {
    label: "סגור",
    short: "שולם + חשבונית מס",
    color: "var(--green)",
    dot: "var(--green)",
    hint: "הושלם",
  },
};

// tabs 1-3 are the "to do" pipeline shown by default; closed is available
// but out of the way, exactly like active/inactive on the shows screen
export const PIPELINE_TABS: FinanceState[] = ["purple", "blue", "red"];
export const ALL_TABS: FinanceState[] = ["purple", "blue", "red", "closed"];
