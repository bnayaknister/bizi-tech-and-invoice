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
