import { israelMonthKey } from "@/lib/dates";

/**
 * WHICH ACCRUED ROWS BELONG TO ONE RECORDING MONTH.
 *
 * Owner decision 2026-10-04: a monthly client's redemption screen shows one
 * card per recording month, and redeeming a card folds ONLY that month's rows.
 * Before this, /documents/accrued grouped by client alone and
 * /api/documents/redeem selected every accrued row the client had, so an
 * episode recorded on 1 Oct went into the September work order -- which is the
 * bug this file closes.
 *
 * ⚠️ WHY A PURE FUNCTION, AND WHY THE ROUTE MAY NOT DO THIS INLINE.
 * The screen renders the cards and the route re-selects the rows straight from
 * the database; the route never sees what the screen rendered. That is by
 * design (it is the same reason the hasBeenPerformed filter is duplicated in
 * both), but it means the two can only agree if they run the SAME partition of
 * rows into months. A `.filter()` spelled out at the call site is a second
 * implementation of that partition, and a second implementation on a money
 * path is how the bug being fixed here was born: `israelMonthKey` was already
 * lifted into src/lib/dates.ts for exactly this reason and the copies stayed
 * behind anyway.
 *
 * So the rule lives here once, it is pure, and it is therefore the only part
 * of the split that a test can actually pin down -- there is no Morning
 * sandbox and the redemption cannot be exercised end to end.
 *
 * The month anchor is israelMonthKey and nothing else: record_date (a plain
 * `date` column, sliced as a string) with created_at in Israel time standing
 * in when the production carries no date.
 */

/** The loosest row shape this partition needs: nothing but the two date fields. */
export type MonthKeyedRow = {
  created_at: string;
  productions?: { record_date?: string | null } | null;
};

/** The recording month of one accrued row, "YYYY-MM". */
export function accruedMonthKey(row: MonthKeyedRow): string {
  return israelMonthKey(row.productions?.record_date ?? null, row.created_at);
}

/**
 * The rows of `rows` whose recording month is exactly `monthKey`.
 *
 * Generic over the row type on purpose: the route passes rows carrying payload,
 * amount and production_id, and gets the SAME objects back rather than a
 * narrowed copy -- createWorkOrderBundle needs every field, and a function that
 * silently dropped them would turn a filter into a data loss.
 */
export function rowsInAccruedMonth<T extends MonthKeyedRow>(rows: T[], monthKey: string): T[] {
  return rows.filter((r) => accruedMonthKey(r) === monthKey);
}

/**
 * The DISTINCT recording months of `rows` that have already closed, sorted.
 *
 * The radar's "חודש נסגר ולא נפדה" counts these (owner 2026-10-04). It used to
 * ask `rows.some(month < currentMonth)` and add ONE per client, which was
 * right only while the redemption screen drew one card per client: a client
 * sitting on two unredeemed months is now two cards, two buttons and two work
 * orders, and a radar that said "1" would send the bookkeeper to a screen
 * showing two.
 *
 * Returned as the months rather than a number so the caller can say WHICH, and
 * so a test can assert the partition and not just its size.
 */
export function closedAccruedMonths(rows: MonthKeyedRow[], currentMonth: string): string[] {
  const closed = new Set<string>();
  for (const r of rows) {
    const mk = accruedMonthKey(r);
    if (mk < currentMonth) closed.add(mk);
  }
  return Array.from(closed).sort();
}
