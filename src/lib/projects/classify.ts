/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW A PRODUCTION ROW IS CLASSIFIED — FROM THE SNAPSHOT ON THE PRODUCTION,
 * NOT FROM THE SHOW'S CURRENT CONFIGURATION.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔴 THE BUG THIS MODULE EXISTS TO END (owner report 2026-10-06).
 *
 * An EY episode recorded 2.8.2026 was shown on /projects as
 *     "בחוזה: ey 2026 -2027 חצי ראשון 041026"
 * and carried no price. Every word of that is false. The episode was billed PER
 * EPISODE — work order 10302, deal invoice 40306 — months before that contract
 * existed (4.10) and before the show was moved to billing_mode='contract'.
 *
 * The production row itself was right all along: kind='client', contract_id=NULL,
 * written at creation while the show was still per_episode. The screen never
 * asked it. `classify()` in projects/page.tsx asked `shows.billing_mode` — the
 * show's configuration TODAY — and `resolveContractName` then walked to the
 * show's current contract and printed its name. So changing a show's billing
 * mode retroactively rewrote the billing history of every episode ever recorded
 * under it, and a per-episode charge that had already been invoiced and paid was
 * displayed as money arriving through a contract milestone instead.
 *
 * THE RULE, and it is a single sentence: a production row is classified by what
 * was written ON THE PRODUCTION when the work happened — `productions.kind` and
 * `productions.contract_id` — and the show is consulted only for the questions
 * that are genuinely about the show as it stands now (its rate, whether it is
 * switched off, whether its billing is silenced).
 *
 * ═══ WHY kind IS THE RIGHT SNAPSHOT AND NOT A SECOND GUESS ═══
 * All three creation paths derive `kind` from the show's billing_mode AT THE
 * MOMENT OF CREATION and freeze it on the row — calendar/sync/route.ts:293,
 * api/productions/route.ts:120-125, shows/[id]/record-past-productions:350. It
 * is exactly the historical record of the question this screen was asking the
 * live column for. Nothing backfills it when a show changes mode, and that is
 * the point, not an omission: the episode really was billed the old way.
 *
 * A mismatch between `kind` and the show's current billing_mode is therefore
 * NORMAL and expected after any mode change. This module does not correct it and
 * does not flag it — the owner filed that as a separate ticket. It only stops
 * the screen from lying about it.
 *
 * ═══ WHAT THE SHOW IS STILL ASKED, AND WHY THAT IS NOT A CONTRADICTION ═══
 *   default_rate / price_override   the price. A per-episode price has no
 *                                   snapshot of its own unless a job froze one
 *                                   (see `jobAmount`), so the show's effective
 *                                   rate stays the fallback, exactly as before.
 *   active === false                "the show is switched off, it is not owed a
 *                                   rate". A statement about the show now.
 *   billing_mode === 'none'         billing deliberately silenced. Deliberately
 *                                   LEFT as a live read and left in its old
 *                                   position for kind='client' rows, so no row
 *                                   that reads "חיוב מושתק" today changes. The
 *                                   owner's rule list does not mention this
 *                                   class at all, and reclassifying a silenced
 *                                   show's episodes into `priced` would push
 *                                   money into the "expected" card that nobody
 *                                   asked to put there.
 *
 * ZERO IMPORTS, like lib/projects/stuck.ts beside it: a pure rule a test can
 * reach without a database, a server or a clock.
 */

/**
 * Why a row carries no per-episode price — or that it does.
 *
 * `internal` IS NEW (2026-10-06) and it is a gap being closed, not a category
 * being invented. An internal production — the studio's own podcasts, אילון
 * among them — bills nobody. On a show whose billing_mode is 'none' the old
 * code happened to answer "חיוב מושתק", which was approximately true. On a
 * per_episode show it answered `priced` and printed the show's rate in a money
 * column, or `missing_rate` and demanded somebody go and fix a rate that is not
 * missing. Both are false statements about work that was never going to be
 * billed, and `productions.kind='internal'` says so plainly.
 *
 * No card total moves because of it: every summary figure on /projects is
 * derived from `billable`, which is `all.filter(r => !r.internal && ...)` and
 * has excluded these rows from the arithmetic since the screen was written.
 */
export type BillingClass =
  | "priced"
  | "contract"
  | "no_billing"
  | "inactive"
  | "missing_rate"
  | "internal";

/** The two columns the production froze about itself. */
export type ProductionSnapshot = {
  /** productions.kind — 'client' | 'internal' | 'contract' (enum, 0002 + 0012). */
  kind?: string | null;
  /** productions.contract_id — which contract, when it was billed through one. */
  contract_id?: string | null;
};

/** The show as it stands TODAY. Consulted only for price / active / silenced. */
export type ShowConfig = { billing_mode?: string | null; active?: boolean | null } | null | undefined;

export type ClassifyArgs = {
  production: ProductionSnapshot;
  show: ShowConfig;
  /**
   * The show's effective per-episode price for this production —
   * `price_override ?? default_rate` plus approved add-ons, i.e. exactly what
   * lib/productions/price.ts already computes. Null means "not priced".
   */
  showPrice: number | null;
  /**
   * `jobs.amount` of the job that billed THIS production alone, when there is
   * one. See `soleJobAmount` for what "alone" has to mean and why.
   *
   * This is the only true price snapshot that exists. Migration 0033 writes
   * `price_override ?? default_rate` + add-ons into jobs.amount at client
   * approval, so the job holds the number that actually went onto the deal
   * invoice. It is what rescues the EY row: its show's default_rate was cleared
   * when the show moved to contract mode (ShowsClient.tsx:705 nulls the rate on
   * that switch), so the show can no longer answer the price question at all,
   * while job 10302 still carries the ₪ that was genuinely charged.
   */
  jobAmount: number | null;
};

/**
 * The classification AND the price, answered together and returned together.
 *
 * One function, one call site, because the two answers are the same decision:
 * "priced" is only true if a price was found, and which price was found depends
 * on the class. page.tsx computed them apart and the comment there already
 * named the hazard — "classifying twice is how the cell and the rule drift
 * apart". This is that comment, enforced by the type system.
 */
export function classifyProduction(args: ClassifyArgs): { billing: BillingClass; price: number | null } {
  const kind = args.production.kind ?? null;

  // ═══ THE SNAPSHOT ANSWERS FIRST ═══
  // Before the price, before active, before billing_mode. This ordering IS the
  // fix: every question below it is about the show as it stands now, and none of
  // them may overrule what the production recorded about itself.
  if (kind === "internal") return { billing: "internal", price: null };
  if (kind === "contract") return { billing: "contract", price: null };

  // ═══ kind='client' — BILLED PER EPISODE, AND STILL IS, WHATEVER THE SHOW
  //     SAYS TODAY ═══
  //
  // 'none' keeps its old position and its old meaning (see the header note).
  // Unknown or absent kind falls through here too: the old code's answer for a
  // row it could not place was the show's configuration, and a defensive
  // fallback is not the place to introduce a new verdict.
  if (kind === "client" || kind == null || (kind !== "internal" && kind !== "contract")) {
    // 🔴 THE PRICE IS PASSED THROUGH HERE, NOT NULLED, AND THE ASYMMETRY WITH
    // `internal` ABOVE IS DELIBERATE.
    //
    // The old code returned "no_billing" while leaving the price alone, so a
    // silenced show that still carries a rate shows that ₪ in the money column
    // today (WorkRow prints the amount when it has one and falls back to the
    // class label only when it does not). The owner asked for `internal` to
    // read "פנימי" and said nothing about silenced shows, so silenced rows keep
    // the exact cell they have. Nothing is at stake in a total either way:
    // `expected` sums only `priced` rows, so this number reaches no card.
    if (args.show?.billing_mode === "none") return { billing: "no_billing", price: args.showPrice };

    // The frozen number beats the live one. A job that has already billed this
    // episode is a fact; the show's current rate is a configuration that may
    // have been changed or cleared since.
    const price = args.jobAmount ?? args.showPrice;
    if (price != null) return { billing: "priced", price };

    // unchanged, in its original order: switched-off shows are not owed a rate,
    // and only an active per-episode show with no rate is the real defect
    if (args.show && args.show.active === false) return { billing: "inactive", price: null };
    return { billing: "missing_rate", price: null };
  }

  /* istanbul ignore next — unreachable: the branch above accepts every kind */
  return { billing: "missing_rate", price: null };
}

/**
 * WHICH contract a contract-billed episode belongs to — the production's own
 * pointer, and nothing else.
 *
 * 🔴 THE THREE-STEP WALK THAT USED TO LIVE HERE IS GONE, DELIBERATELY, AND IT
 * COSTS NAMES ON SCREEN.
 *
 * It resolved `productions.contract_id`, then `contracts.show_id`, then "the
 * client's sole active contract". Steps 2 and 3 are both the same sentence —
 * "the contract the show is on TODAY" — and that sentence is the second half of
 * the EY bug. It is how a show signing a contract in October printed that
 * contract's name onto an August episode that predates it. It would do it again
 * the day a show moves from one contract to another: every episode ever
 * recorded under the old one would be relabelled with the new one's name.
 *
 * CONSEQUENCE, stated plainly because it is a real loss and not a free fix: the
 * comment this replaces recorded that `contract_id` was set on 1 production in
 * 765 (measured 2026-08-27) while 27 of the 28 contract-mode shows resolved a
 * name through step 3. Those rows now read "מחויב בחוזה" with no name. The
 * umbrella contract מכירת ביפו is exactly the case — it covers a catalogue, so
 * `contracts.show_id` is correctly NULL (0056) and nothing points from those
 * episodes at it.
 *
 * Newer rows are better off: calendar/sync (route.ts:325) and api/productions
 * (route.ts:128-145) both write `contract_id` at creation from the contract
 * whose `show_id` names the show, so a contract with a show_id gets named. The
 * umbrella case and `record-past-productions` (which writes contract_id: null
 * outright, route.ts:357) do not.
 *
 * Saying "מחויב בחוזה" without naming one is the honest output when nothing
 * records which contract it was. Naming the wrong contract on a finance screen
 * is the failure that was actually happening.
 */
export function contractNameFor(
  production: ProductionSnapshot,
  contracts: { id: string; name: string }[]
): string | null {
  if (!production.contract_id) return null;
  return contracts.find((c) => c.id === production.contract_id)?.name ?? null;
}

/**
 * The price a job froze for ONE production — `null` unless the attribution is
 * unambiguous.
 *
 * ⚠️ THE ONE-TO-ONE TEST IS NOT CAUTION, IT IS ARITHMETIC. `jobs.amount` on a
 * bundled or consolidated work order is the total for EVERY production in the
 * bundle (lib/misc/workOrder.ts builds those; the 2026-08-30 consolidated
 * redemption is the live example). Reading it onto an episode row would print
 * the bundle's total on each of its episodes — and since `priced` rows are
 * summed into the "expected" card, it would multiply that total by the number of
 * episodes in the bundle. The screen would overstate the month's expected
 * revenue, which is the worst failure mode a money screen has.
 *
 * So the amount is used only when the job covers this production and no other,
 * and the production has exactly one such job. Anything else falls back to the
 * show's rate, which is the behaviour that stands today.
 *
 * `links` MUST be the FULL job_productions table, not a copy filtered to the
 * months on screen: a bundle reaching one episode above the July floor and one
 * below it is still a bundle, and a filtered list would show it as one-to-one.
 * This is the same load-bearing distinction page.tsx already documents for
 * `allLinks` vs `jobLinks` (page.tsx:477-481).
 *
 * Dismissed jobs are excluded by the caller, which passes only live jobs: a
 * dismissed job is out of every money surface (0041).
 */
export function soleJobAmounts(
  links: { job_id: string; production_id: string }[],
  jobAmountById: Map<string, number | null>
): Map<string, number> {
  // How many productions each job covers, counted over the whole table before
  // any production is looked at — this is the bundle test.
  const productionsPerJob = new Map<string, number>();
  for (const l of links) {
    productionsPerJob.set(l.job_id, (productionsPerJob.get(l.job_id) ?? 0) + 1);
  }
  // How many live jobs each production has. Two of them and the production has
  // no single frozen price either, so it falls back to the show's rate.
  const jobsPerProduction = new Map<string, string[]>();
  for (const l of links) {
    if (!jobAmountById.has(l.job_id)) continue; // not a live job
    jobsPerProduction.set(l.production_id, [...(jobsPerProduction.get(l.production_id) ?? []), l.job_id]);
  }

  const out = new Map<string, number>();
  // Array.from and not a for…of over the Map itself: tsconfig targets a level
  // below es2015 downlevel iteration, and the whole project compiles under it.
  for (const [productionId, jobIds] of Array.from(jobsPerProduction.entries())) {
    if (jobIds.length !== 1) continue;
    if (productionsPerJob.get(jobIds[0]) !== 1) continue;
    const amount = jobAmountById.get(jobIds[0]);
    if (amount == null) continue;
    out.set(productionId, Number(amount));
  }
  return out;
}
