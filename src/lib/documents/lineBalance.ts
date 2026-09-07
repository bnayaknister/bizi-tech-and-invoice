import type { MorningIncomeRow } from "@/lib/morning/types";

/**
 * Σ of a document's detail lines, and the rule that it must equal the amount
 * column (owner spec 2026-09-02).
 *
 * WHY THIS EXISTS. `pending_documents.amount` and `payload.income` are two
 * independent statements of the same money: the column is what our books say
 * the document is worth, the lines are what Morning will print. Nothing
 * checked they agreed. The amount lock added in d952b85 kept them aligned by
 * refusing to let either move on a bundle — which worked only while the lines
 * were text-only. Once a line's price is editable the lock is not enough, and
 * the real invariant has to be stated and enforced:
 *
 *     Σ (price × quantity) === amount
 *
 * Audited across every queue row carrying income on 2026-09-02: 51 of 51
 * already satisfy it, zero exceptions. So this is a gate that documents an
 * invariant the data always had — not a new constraint anything must be
 * migrated to. scripts/audit_line_balance.py re-runs that audit.
 *
 * NET, NOT GROSS. For a 305/320 the amount column is the NET figure and so are
 * the income lines (Morning adds VAT itself — see MorningPaymentRow). The
 * payment block is the gross one, and it is checked against the PARENT's gross
 * by a separate gate in the review route. These two gates measure different
 * things and neither replaces the other.
 */

/** Rounding to agorot: two float multiplications must not fail an equality. */
const CENTS = 2;
export const BALANCE_EPSILON = 0.01;

/**
 * Agorot, at every point a money figure is derived. Lives here, beside the gate
 * that judges the result, because every caller rounds FOR that gate.
 *
 * Was a private const in enqueue.ts until 2026-09-07; moved rather than copied
 * when the edit route needed it too. Two roundings of one number is exactly the
 * drift this file exists to refuse, and there were already two spellings in the
 * codebase (`Number(n.toFixed(2))` here, `Math.round(n * 100) / 100` in
 * bundle-from-show:94) — one home, one spelling.
 *
 * The owner's example is the reason the rounding is stated rather than assumed:
 * 1.5 h × 333.33 ₪ = 499.995. Unrounded, that number reaches
 * `pending_documents.amount` with three decimals while the SQL side of
 * ensure_job_for_production (0067 §7) rounds to 500.00, and every downstream
 * comparison — BALANCE_EPSILON below, the issue-time amount check
 * (issue.ts:476) — is then judging a difference of half an agora that nobody
 * can see, reconcile by hand, or explain.
 */
export const roundAgorot = (n: number) => Number(n.toFixed(CENTS));

/**
 * Can this document total be carried by N units of a whole-agora price?
 *
 * WHY THIS IS A GATE AND NOT A ROUNDING. `amount` is the document's total and
 * `price` is per unit, so the edit route divides. When the division leaves a
 * remainder there is NO per-unit price that multiplies back to the total: 1,000
 * over 7 gives 142.86, and 142.86 × 7 is 1,000.02. Whatever we store, the lines
 * and the amount column then state two different numbers for the same document
 * — which is the exact drift this file exists to refuse.
 *
 * WHOLE AGOROT, NOT BALANCE_EPSILON. The tempting test is
 * `|roundAgorot(amount / qty) * qty - amount| <= BALANCE_EPSILON`, and it is
 * wrong twice over. It admits a real one-agora disagreement between the lines
 * and the column as though it were rounding noise; and being float arithmetic
 * it decides borderline cases by luck — measured 2026-09-07, 1000/3 lands on
 * 0.009999999999990905 and passes while 100/3 lands on 0.010000000000005116
 * and fails, though they are the same question. Integer agorot has neither
 * problem: `amountAgorot % quantity === 0` is exact, and it is what "divides
 * into whole agorot" actually means.
 *
 * Negatives divide the same way (a discount line: -1,200 over 6 is -200), and
 * zero divides into anything.
 */
export type UnitSplit =
  | { ok: true; price: number }
  | { ok: false; lower: number; upper: number };

export function splitAmountIntoUnits(amount: number, quantity: number): UnitSplit {
  const qty = Number(quantity);
  // one unit (or a quantity we cannot read) — the total IS the unit price, and
  // there is nothing to divide or to refuse
  if (!Number.isFinite(qty) || qty <= 1) return { ok: true, price: roundAgorot(amount) };
  if (!Number.isFinite(amount)) return { ok: true, price: amount };

  const agorot = Math.round(amount * 100);
  if (agorot % qty === 0) return { ok: true, price: roundAgorot(agorot / qty / 100) };

  // the nearest totals that DO divide — floor/ceil rather than ±qty so this is
  // right for negatives too, where "below" is the more negative side
  return {
    ok: false,
    lower: roundAgorot((Math.floor(agorot / qty) * qty) / 100),
    upper: roundAgorot((Math.ceil(agorot / qty) * qty) / 100),
  };
}

/** ₪1,000.02 — two decimals always, so the two suggestions read as money. */
const shekels = (n: number) =>
  "₪" + n.toLocaleString("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The refusal, naming the two amounts that would work. One source, so the form
 * hint and the server's 400 say the same sentence — she should not be told one
 * thing before saving and another after.
 */
export function unitSplitError(amount: number, quantity: number, split: UnitSplit): string | null {
  if (split.ok) return null;
  return (
    `הסכום ${shekels(amount)} לא מתחלק ל-${quantity} יחידות. ` +
    `הזיני סכום שמתחלק, למשל ${shekels(split.lower)} או ${shekels(split.upper)}.`
  );
}

export type IncomeLike = Partial<Pick<MorningIncomeRow, "description" | "quantity" | "price">>;

/**
 * Σ (price × quantity) over the lines, rounded to agorot.
 *
 * `quantity ?? 1` because every one of the 67 income lines in the account
 * carries quantity 1 and a row that somehow omits it means one unit, never
 * zero — reading a missing quantity as 0 would silently zero out a line.
 */
export function sumIncome(income: IncomeLike[] | null | undefined): number {
  const rows = Array.isArray(income) ? income : [];
  const total = rows.reduce((sum, r) => sum + Number(r?.price ?? 0) * Number(r?.quantity ?? 1), 0);
  return Number(total.toFixed(CENTS));
}

/**
 * null when the lines and the amount agree; otherwise the sentence to refuse
 * with — naming BOTH numbers, because "the amounts do not match" tells the
 * bookkeeper nothing about which one she should be changing.
 *
 * An empty line set is not judged here. Whether a document may carry no lines
 * at all is a question of its TYPE (a receipt carries none by design), and the
 * review route already answers it; a balance gate that also refused emptiness
 * would be two rules wearing one name.
 */
export function balanceError(
  income: IncomeLike[] | null | undefined,
  amount: number | null | undefined
): string | null {
  const rows = Array.isArray(income) ? income : [];
  if (rows.length === 0) return null;
  const declared = Number(amount ?? 0);
  const sum = sumIncome(rows);
  if (Math.abs(sum - declared) <= BALANCE_EPSILON) return null;
  return (
    `סכום שורות הפירוט (${sum.toLocaleString("he-IL")} ₪) אינו תואם את סכום המסמך ` +
    `(${declared.toLocaleString("he-IL")} ₪). יש לתקן את אחד מהם לפני האישור.`
  );
}
