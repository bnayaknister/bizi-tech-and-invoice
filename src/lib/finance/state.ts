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
