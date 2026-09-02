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
