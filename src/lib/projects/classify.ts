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

/**
 * What the production froze about itself, plus the two pointers the contract
 * walk needs.
 *
 * `kind` and `contract_id` are the snapshot — written at creation and never
 * backfilled. `show_id` and `client_id` are NOT a snapshot of anything and are
 * only here so `contractNameFor` can run its fallbacks; `classifyProduction`
 * never reads them.
 */
export type ProductionSnapshot = {
  /** productions.kind — 'client' | 'internal' | 'contract' (enum, 0002 + 0012). */
  kind?: string | null;
  /** productions.contract_id — which contract, when it was billed through one. */
  contract_id?: string | null;
  /** for the contract-name fallbacks only */
  show_id?: string | null;
  /** for the contract-name fallbacks only */
  client_id?: string | null;
};

/** A `contracts` row as the name walk reads it. */
export type ContractForName = {
  id: string;
  name: string;
  show_id?: string | null;
  client_id?: string | null;
  status?: string | null;
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
 * WHICH contract a contract-billed episode belongs to.
 *
 * 🔴 THE GATE IS THE FIX. THE WALK BELOW IT IS THE ORIGINAL, RESTORED
 * UNCHANGED (owner ruling 2026-10-06, on the report of 8febad1).
 *
 * 8febad1 answered from `productions.contract_id` alone and nothing else. That
 * killed the EY bug and took 27 shows' contract names down with it: the comment
 * it replaced recorded that `contract_id` was set on 1 production in 765, while
 * 27 of the 28 contract-mode shows resolved their name through the third step.
 * The owner rejected that trade, and was right to — "מחויב בחוזה" with no name
 * on almost every contract row is a different wrong answer, not a smaller one.
 *
 * So the three-step walk comes back verbatim, and the one thing that changes is
 * WHO IS ALLOWED TO ASK IT:
 *
 *   kind='contract'            the full walk. This episode really was billed
 *                              through a contract; the only open question is
 *                              which one, and the show is a legitimate witness
 *                              to that.
 *   kind='client' | 'internal' NO NAME, EVER, BY ANY ROUTE. Not a label, not a
 *                              name beside the show. This is the EY episode of
 *                              2.8: per-episode work whose show later signed a
 *                              contract. No walk may reach it, because the
 *                              question "which contract is this episode under"
 *                              has no answer for a row that was never under one.
 *
 * That gate is what 8febad1 got right and this keeps. The bug was never that
 * the walk existed — it was that a `kind='client'` row was sent down it at all.
 *
 * ⚠️ WHY THE `contractName` GATE CANNOT LIVE IN THE UI INSTEAD. The billing cell
 * prints "בחוזה: {name}" only for `billing === "contract"` (ProjectsClient:328),
 * so a stray name would be invisible there — but the "תוכנית / עבודה" column
 * prints `· {contractName}` beside the show name for ANY row that carries one
 * (ProjectsClient:300-305). EY's row would have shown the contract's name there
 * with no label and no price next to it, which is the owner's original complaint
 * in a quieter font. The name has to be absent from the payload, not merely
 * unlabelled, and that is why the gate is here.
 *
 * THE WALK ITSELF, unchanged from projects/page.tsx at 23feaca, strongest
 * evidence first, stopping at the first UNAMBIGUOUS answer (measured 2026-08-27):
 *
 *   1. productions.contract_id — exact, and set on exactly 1 of 765 rows.
 *   2. contracts.show_id — exact, and set on 1 of 3 contracts (icr spotlight).
 *      NULL is the CORRECT state for an umbrella contract like מכירת ביפו that
 *      covers a whole catalogue rather than one show (0056 says so explicitly),
 *      so its absence is not a defect to route around.
 *   3. the client's sole ACTIVE contract — how the 27 ביפו-era shows resolve.
 *      Only when there is exactly one; two would make the answer a guess.
 *
 * Both fallbacks read the show's situation TODAY, and for a contract row that is
 * accepted with open eyes: the day a show moves from one contract to another,
 * step 3 will relabel its older episodes with the new contract's name. The
 * durable repair for that is a backfill of `productions.contract_id`, which the
 * owner filed as its own ticket. Until then, a name that is right for 27 shows
 * and stale for a hypothetical 28th beats no name at all — and inventing a
 * contract for an episode that had none is the failure this gate stops.
 */
export function contractNameFor(
  production: ProductionSnapshot,
  show: { client_id?: string | null } | null | undefined,
  contracts: ContractForName[]
): string | null {
  // ═══ THE GATE ═══ a per-episode or internal row is under no contract, and no
  // amount of evidence about the SHOW can make it be under one.
  if (production.kind !== "contract") return null;

  if (production.contract_id) {
    const exact = contracts.find((c) => c.id === production.contract_id);
    if (exact) return exact.name;
  }
  const byShow = contracts.filter((c) => c.show_id && c.show_id === production.show_id);
  if (byShow.length === 1) return byShow[0].name;

  const clientId = production.client_id ?? show?.client_id ?? null;
  if (!clientId) return null;
  const byClient = contracts.filter((c) => c.client_id === clientId && c.status === "active");
  return byClient.length === 1 ? byClient[0].name : null;
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
