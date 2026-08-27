/**
 * What one production is worth.
 *
 * The rule is not new — it is migration 0033, which is what the client-approval
 * trigger writes into jobs.amount and therefore what reaches the deal invoice:
 *
 *     effective base = price_override ?? show.default_rate
 *     total          = base + Σ(approved, priced add-ons)
 *
 * It was already written three times by hand — documents/enqueue.ts:160,
 * review/links.ts:189 and api/productions/[id]/addons/route.ts:84 — and this
 * module exists so a fourth reader (the projects screen) does not become a
 * fourth copy. Those three are DELIBERATELY not converted here: they are live
 * billing paths, and a read-only screen has no business editing them. Folding
 * them in is its own change, once this screen has proven the helper.
 *
 * NULL IS NOT ZERO, and this is the one thing worth being strict about. A
 * production whose show has no default_rate is *not priced*; a production worth
 * nothing would be 0. Collapsing the two would silently drag a monthly total
 * downwards and make an incomplete number look like a complete one — so the
 * base stays null all the way out, and the caller has to decide what to show.
 * 0033 makes the same choice for exactly the same reason ("when there's no base
 * price the deal invoice is blocked anyway, so leave the job amount null").
 *
 * Note for anyone reading a total today: production_addons is EMPTY in
 * production (0 rows, verified 2026-08-27), so the add-on term contributes
 * nothing yet. It is implemented because 0033 says it is part of the number,
 * not because it currently changes one.
 */

export type PricedProduction = { price_override: number | null };
export type PricedShow = { default_rate: number | null } | null | undefined;
export type AddonRow = { production_id: string; status: string; total: number | null };

/** price_override ?? show.default_rate — null when neither exists. */
export function effectiveBase(production: PricedProduction, show: PricedShow): number | null {
  if (production.price_override != null) return Number(production.price_override);
  if (show?.default_rate != null) return Number(show.default_rate);
  return null;
}

/**
 * Σ of a production's approved, priced add-ons.
 *
 * `status = 'approved'` and `total is not null` are both required, matching
 * 0033's `where status = 'approved' and total is not null`: a pending add-on is
 * a request, not money, and an approved one with no price is a line somebody
 * still has to fill in. Neither belongs in a total. Returns 0, not null — an
 * absent add-on genuinely is zero add-on money, unlike an absent base price.
 */
export function approvedAddonTotal(rows: AddonRow[]): number {
  let sum = 0;
  for (const r of rows) {
    if (r.status === "approved" && r.total != null) sum += Number(r.total);
  }
  return sum;
}

/** base + add-ons, propagating "not priced" as null. */
export function productionTotal(base: number | null, addonTotal: number): number | null {
  if (base == null) return null;
  return base + addonTotal;
}
