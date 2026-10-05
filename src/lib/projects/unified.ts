/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE ROW PER PIECE OF WORK — the unified row model behind /projects.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Owner decision 5.10: the projects screen must show EVERY piece of work the
 * system carries, so Shiri can follow all of it and its statuses in one place.
 * Until now it showed one table — `productions` — and the 5.10 investigation
 * measured what that costs: **47 of the 94 jobs in the database carry no
 * `job_productions` row** (measured 2026-09-14, recorded at
 * lib/misc/workOrder.ts:88-89), so roughly half the work in the business was
 * invisible on the screen whose name is "project tracking". Those jobs were
 * never excluded by a decision — 0074's own ledger calls their appearance here
 * "מחוץ להיקף במכוון … צעד נפרד אחרי שהמסך עובד", and projects/page.tsx:383-400
 * carries the ⚠ BACKLOG note that measured the gap. This is that step.
 *
 * Five sources, and they are not five code paths:
 *
 *   הפקה          a production, with or without a job      (the old screen)
 *   מרוכזת        bundle-from-show — a job with NO productions at all
 *   רדיו ושונות   misc_productions, billed through its own job
 *   אבן דרך       a contract milestone, placed by its anchor document
 *   ייבוא         a job that arrived from a CSV import
 *
 * ═══ 🔴 THE DEDUPLICATION RULE IS ONE SET SUBTRACTION, AND THAT IS THE POINT ═══
 *
 *     excluded = {job_productions.job_id} ∪ {misc_productions.job_id}
 *                                         ∪ {contract_milestones.job_id}
 *     job-only rows = jobs WHERE NOT dismissed AND id ∉ excluded
 *
 * ONE set, built once, subtracted once. Not three checks at the point of use —
 * three checks are three chances to forget one, and the fourth anchor somebody
 * adds next year gets no protection at all. This is the same shape as the
 * decision already standing at projects/page.tsx:832-836 ("MILESTONES LIVE IN
 * THEIR OWN ARRAY, AND THAT IS THE EXCLUSION … no filter CAN forget it"), and
 * it matters here for a reason the schema makes real: NOTHING stops one job id
 * from sitting in both `misc_productions.job_id` and
 * `contract_milestones.job_id`. Both are plain nullable FKs with no uniqueness
 * and no cross-table constraint (0074:188 and the milestone column alike), so
 * the collision is a data defect waiting to happen rather than an impossibility
 * to be assumed away. `jobOwner` below records who won and `conflicts` reports
 * that it happened, instead of silently drawing the row twice.
 *
 * PRECEDENCE when more than one anchor claims a job — production > milestone >
 * misc, strongest link first:
 *   · `job_productions` is written by the database itself
 *     (ensure_job_for_production, 0090:160) — it is not an app's opinion.
 *   · a milestone job carries `contract_id` and is already a named subject on
 *     /contracts; its row has a contract behind it.
 *   · misc last, not because it matters least but because it is the newest
 *     pointer and the one a defect is most likely to have written by mistake.
 *
 * ═══ 🔴 WHAT THIS FUNCTION REFUSES TO HIDE ═══
 * A job can be in `excluded` and still produce NO row. Two ways, both real:
 *
 *   1. its milestone has no anchor document, so page.tsx:770-783 emits no
 *      milestone row at all (an open milestone has no date and therefore no
 *      month it could honestly belong to);
 *   2. its production/misc anchor sits outside the July floor, or has no date.
 *
 * A job in that state would simply VANISH — and a money screen that quietly
 * drops a billing row is the failure this whole file exists to prevent. So
 * every job that reaches no row is returned in `unrepresented`, with the reason,
 * and the canary in scripts/test_projects_unified.ts asserts the list's exact
 * contents. Declared, not hidden: the owner can then decide whether an
 * anchor-less milestone job deserves a job-only row, which is a billing
 * question and not a rendering one.
 *
 * ═══ NO SUPABASE, NO FETCH, NO DATE "NOW" ═══
 * Everything here is sorting, set arithmetic and string comparison on
 * caller-supplied facts. `todayInIsrael()` is NOT called — a pure function that
 * reads the clock is a function whose tests expire. The floor month arrives as
 * an argument for the same reason.
 *
 * ═══ WHAT IS DELIBERATELY NOT RE-IMPLEMENTED HERE ═══
 *   · `deriveState` / `TAB_META`  — lib/finance/state.ts, imported below
 *   · `STATUS_LABEL`              — lib/productions/status.ts, imported below
 *   · `MISC_STATUS_TONE`          — lib/misc/status.ts, imported below
 *   · `MILESTONE_META`            — read by the client from lib/finance/milestone
 *   · document resolution         — lib/documents/forProduction.ts; the caller
 *     resolves and hands the rows in, so there is ONE resolver for every source
 * Each of those is an existing rule with existing tests. A second spelling of
 * any of them is a second chance to disagree about money.
 */
import { deriveState, TAB_META, type FinanceJobFacts, type FinanceState } from "@/lib/finance/state";
import { STATUS_LABEL } from "@/lib/productions/status";
import { MISC_CANCELLED, miscStatusTone } from "@/lib/misc/status";
import type { ProjectDoc } from "@/lib/projects/row";

// ---------------------------------------------------------------------------
// the vocabulary — owner-approved wording, 5.10
// ---------------------------------------------------------------------------

export type RowSource = "production" | "bundle" | "misc" | "milestone" | "import";

/** Source order on screen and in the filter chips — the order the owner listed. */
export const ROW_SOURCES: RowSource[] = ["production", "bundle", "misc", "milestone", "import"];

export const SOURCE_LABEL: Record<RowSource, string> = {
  production: "הפקה",
  bundle: "מרוכזת",
  misc: "רדיו ושונות",
  milestone: "אבן דרך",
  import: "ייבוא",
};

/**
 * The source tag's hue. Reuses the palette the three screens already speak
 * (DESIGN.md §2) rather than inventing a fifth: cyan is where /projects already
 * puts contract money and bundled documents, violet-light is /misc's own card
 * hue (modules/misc.ts:11), and `--dim` is for a row whose provenance is
 * INFERRED rather than recorded — see `jobOnlySource`.
 */
export const SOURCE_TONE: Record<RowSource, string> = {
  production: "var(--violet)",
  bundle: "var(--cyan)",
  misc: "var(--violet-light)",
  milestone: "var(--cyan)",
  import: "var(--dim)",
};

/**
 * ⚠️ FOUR MEANINGS OF "DATE", IN ONE COLUMN.
 *
 * This is the sharpest compromise in the model and it is a conscious one. The
 * five sources date themselves by four different facts:
 *
 *   record     productions.record_date      — when it was recorded
 *   work       misc_productions.work_date   — when the work was done (0074:182)
 *   issued     jobs.date                    — ⚠️ for bundle-from-show this is
 *                                             `todayInIsrael()` at creation
 *                                             (bundle-from-show/route.ts:113),
 *                                             NOT when the work happened.
 *                                             Owner 5.10: show it as it is; a
 *                                             real work date for bundles is a
 *                                             SEPARATE ticket, not this one.
 *   document   the anchor document's date   — a milestone has no recording
 *
 * projects/page.tsx:838-842 warns exactly about this: "one mixed sort over two
 * different meanings of 'date' would order neither correctly". The compromise
 * accepted here is one column with a per-row `title` naming which date it is —
 * the precedent being MilestoneTableRow, which already renders
 * `title="תאריך המסמך, לא תאריך הקלטה"` (ProjectsClient.tsx:204). A reader who
 * hovers gets the truth; a reader who does not gets a chronology that is right
 * within each source and approximate across them. The alternative — four date
 * columns, three of them empty on every row — was rejected as unreadable.
 */
export type DateMeaning = "record" | "work" | "issued" | "document" | "milestone_expected";

export const DATE_MEANING_TITLE: Record<DateMeaning, string> = {
  record: "תאריך הקלטה",
  work: "תאריך העבודה",
  issued: "תאריך הנפקת ההזמנה, לא תאריך העבודה",
  document: "תאריך המסמך",
  // The FIFTH meaning, added 5.10 for a milestone that has a job and no
  // document yet. It is the only one that names its own absence, and it has to:
  // the date is the milestone's `expected_date` (or, failing that, its job's
  // date), which is a PLAN rather than a record of anything. Every other row on
  // this screen is dated by something that happened.
  milestone_expected: "תאריך אבן הדרך (אין עדיין מסמך)",
};

/** How a row is opened. `entity` goes to the existing drawer; `href` is a link. */
export type RowOpen =
  | { kind: "entity"; type: "production" | "job" | "contract"; id: string }
  | { kind: "href"; href: string };

/**
 * The billing status cell.
 *
 * `state` is `deriveState`'s own four values and nothing else. A row with NO
 * job is `state: null` — and that is the whole reason this is a nullable field
 * rather than a fifth FinanceState:
 *
 *   🔴 `{paid:null, invoice_biz:null, invoice_tax:null}` makes deriveState
 *      return "purple" = "לא חויב", and that is a DIFFERENT and false claim.
 *      "לא חויב" means there is a job waiting for an invoice. A row with no job
 *      has no billing object at all — nothing is waiting, because nothing was
 *      ever opened.
 *
 *   🔴 And extending FinanceState would change ANOTHER screen: a fifth value
 *      needs a fifth TAB_META entry, and TAB_META's keys feed PIPELINE_TABS and
 *      ALL_TABS (state.ts:164-165), which are the /finance tab bar. A new tab on
 *      the finance screen as a side effect of a projects-screen row shape is not
 *      a trade anyone agreed to. Owner 5.10 says so in as many words: "לא
 *      להרחיב את FinanceState".
 *
 * So the absence is modelled OUTSIDE the enum, and `label` carries the wording
 * /misc already shows for exactly this state ("טרם חויבה",
 * MiscClient.tsx:607) — the bookkeeper has met the phrase before.
 */
export type BillStatus = {
  state: FinanceState | null;
  label: string;
  color: string;
};

/** The approved wording for a row that has no job. */
export const NO_JOB_LABEL = "טרם חויבה";
export const NO_JOB_COLOR = "var(--amber)";

/** The production-status cell: a label and the tone, or null for "—". */
export type ProdStatus = { label: string; color: string } | null;

export type UnifiedRow = {
  /** Unique within the result. Prefixed by source so two tables cannot collide. */
  key: string;
  source: RowSource;
  /** YYYY-MM, the bucket this row sorts into. */
  month: string;
  date: string | null;
  dateMeaning: DateMeaning;
  client: string | null;
  /** The show, the contract, or the misc job's own name. */
  show: string | null;
  /** Guest, milestone name, campaign — whatever this source calls the detail. */
  description: string | null;
  amount: number | null;
  /**
   * PRODUCTION ROWS ONLY — why this row carries no per-episode price, as the
   * `BillingClass` string. Null on every other source, because the question does
   * not apply: a bundle order, a radio job and a milestone all carry their own
   * amount by construction and never had a per-episode rate to be missing.
   *
   * It survives into the unified model deliberately. "חסר תעריף" was once the
   * only answer this screen could give and it was wrong in 9 cases out of 9
   * (measured 2026-08-27, recorded above `classify` in projects/page.tsx):
   * contract-billed, silenced and inactive shows are not shows somebody forgot
   * to price. Dropping the distinction to make one tidy `amount` column would
   * re-introduce that error.
   *
   * Typed `string` and not `BillingClass` on purpose: `BillingClass` is declared
   * in the client component, which imports THIS module — naming it here would be
   * the import cycle lib/projects/row.ts was extracted to break. The client
   * indexes its own label map with a fallback.
   */
  billing: string | null;
  /** Production rows only: the contract a contract-billed episode sits under. */
  contractName: string | null;
  /**
   * PRODUCTION ROWS ONLY — the owner's 17.9 empty-cell label, carried through.
   *
   * It replaces the dash in a document column ONLY where the blank is EXPECTED:
   * a monthly client mid-month, an `every_n` bundle still filling, a contract
   * show, a silenced one. Before it, "—" meant both "nothing is due yet" and
   * "something went wrong" and the screen could not tell the bookkeeper which.
   *
   * Null on every other source, and that is not an omission to fill in later:
   * `emptyReasonFor` answers from a client's billing CADENCE and a production's
   * record month, and a bundle order, a radio job and a milestone have neither.
   * A label there would be describing a rhythm the row does not belong to.
   */
  emptyReasonText: string | null;
  prodStatus: ProdStatus;
  billStatus: BillStatus;
  docs: ProjectDoc[];
  open: RowOpen;
  /**
   * THE JOBS THIS ROW REPRESENTS — the canary's subject, and the reason it can
   * be a real invariant rather than a hopeful comment.
   *
   * Summed across every row, each non-dismissed job must appear EXACTLY ONCE or
   * be named in `unrepresented`. Without this field the test could only count
   * rows, which proves nothing about whether a billing row was dropped: two
   * rows and one missing job look identical from outside.
   *
   * A production row can carry several (record-past-productions adds productions
   * to one existing job, route.ts:264-268); a milestone or misc row carries at
   * most one; a job-only row carries exactly its own.
   */
  jobIds: string[];
  /** Out of every money total: internal work, a cancelled episode, a cancelled misc job. */
  excludedFromMoney: boolean;
  /** Rendered struck through / faded. */
  cancelled: boolean;
  /** The one-sentence "where the chain stopped" strings, for the row title. */
  stuckSentences: string[];
};

// ---------------------------------------------------------------------------
// the inputs — one shape per source, carrying only what a row needs
// ---------------------------------------------------------------------------

/**
 * A production row, ALREADY derived by the caller.
 *
 * It arrives as a finished `ProjectRow` + month rather than as a raw
 * `productions` row, and that is deliberate: price, `BillingClass` and the
 * stuck verdict are computed once in page.tsx and read twice, which is the drift
 * the comment at projects/page.tsx:688-690 already names ("classifying twice is
 * how the cell and the rule drift apart"). Re-deriving them here would be a
 * second opinion on a money figure.
 */
export type ProductionInput = {
  month: string;
  id: string;
  record_date: string | null;
  podcast_name: string;
  show_name: string | null;
  client_name: string | null;
  guest: string | null;
  status: string;
  episode_no: number | null;
  internal: boolean;
  cancelled: boolean;
  price: number | null;
  /** The `BillingClass` the caller already computed — read, never recomputed. */
  billing: string;
  contract_name: string | null;
  /** `emptyReasonFor(...)?.text`, already derived by the caller. */
  empty_reason_text: string | null;
  docs: ProjectDoc[];
  /**
   * This production's jobs — ids included, dismissed ones already gone. Empty
   * means no job yet, which is the ordinary state for an episode that has not
   * been recorded. The ids feed `jobIds` and therefore the canary; the three
   * invoice/paid fields feed `billStatusFor`.
   */
  jobs: ({ id: string } & FinanceJobFacts)[];
  stuckSentences: string[];
};

export type MilestoneInput = {
  month: string;
  id: string;
  name: string;
  contract_id: string;
  contract_name: string | null;
  client_name: string | null;
  /** The milestone's own state label and colour, from MILESTONE_META. */
  stateLabel: string;
  stateColor: string;
  /**
   * The gross of the ANCHOR DOCUMENT when there is one — ₪5,900 and not ₪5,000,
   * because a row that attributes a number already inside the month cards has to
   * show the number it is attributing. When there is NO document (the 5.10 case
   * below) it is the milestone's own amount, which is the only figure that
   * exists; nothing is being attributed, so nothing can be misattributed.
   */
  amount: number | null;
  /**
   * The date the CALLER chose, and `dateMeaning` says which fact it is. Two
   * shapes reach this field:
   *
   *   document            the anchor document's date. The money landed (320/400)
   *                       or the bill went out (300/305), and the row is placed
   *                       in the month that happened.
   *   milestone_expected  🔴 NEW, owner 5.10. The milestone has a JOB and no
   *                       anchor document — it was enqueued and nothing has been
   *                       issued yet. Before this it claimed its job through
   *                       `excluded` and produced no row, so the job reached no
   *                       row at all and came back in `unrepresented`. A billing
   *                       row that exists and is invisible is the failure this
   *                       screen was rebuilt to end, so it gets a row, dated by
   *                       `expected_date` (or its job's date as a fallback) and
   *                       LABELLED as a plan rather than a record.
   *
   * The choosing happens in page.tsx because that is where expected_date, the
   * anchor and the job all are; the builder only places what it is handed.
   */
  date: string | null;
  dateMeaning: Extract<DateMeaning, "document" | "milestone_expected">;
  job_id: string | null;
  jobFacts: FinanceJobFacts | null;
  docs: ProjectDoc[];
};

export type MiscInput = {
  id: string;
  name: string;
  client_name: string | null;
  work_date: string;
  amount: number | null;
  description: string | null;
  status: string;
  job_id: string | null;
  jobFacts: FinanceJobFacts | null;
  docs: ProjectDoc[];
};

export type JobInput = {
  id: string;
  client_name: string | null;
  campaign: string | null;
  date: string | null;
  amount: number | null;
  paid: string | null;
  invoice_biz: string | null;
  invoice_tax: string | null;
  dismissed: boolean;
  /** NULL for a job the app created; set by the CSV importer (import/apply:226). */
  external_id: string | null;
  legacy: boolean;
  docs: ProjectDoc[];
};

export type UnifiedInput = {
  /** Inclusive floor, YYYY-MM. One floor for every source — owner 5.10. */
  rangeStartMonth: string;
  productions: ProductionInput[];
  milestones: MilestoneInput[];
  misc: MiscInput[];
  jobs: JobInput[];
  /** Every job id that has at least one `job_productions` row. */
  linkedJobIds: string[];
};

/** Why a non-dismissed job reached no row at all. */
export type UnrepresentedReason =
  | "milestone_without_anchor"
  | "misc_out_of_range"
  | "production_out_of_range"
  | "no_date"
  | "before_range";

export type Unrepresented = { jobId: string; reason: UnrepresentedReason };

export type UnifiedResult = {
  rows: UnifiedRow[];
  /** Which row claimed each job. The canary's subject. */
  jobOwner: Map<string, { source: RowSource; key: string }>;
  /** Jobs claimed by more than one anchor — a data defect, reported not hidden. */
  conflicts: { jobId: string; claimedBy: RowSource[]; wonBy: RowSource }[];
  /** Jobs that reached no row, with the reason. */
  unrepresented: Unrepresented[];
};

// ---------------------------------------------------------------------------
// the derivations
// ---------------------------------------------------------------------------

const monthOf = (iso: string | null): string | null =>
  iso && iso.length >= 7 ? iso.slice(0, 7) : null;

/**
 * The billing cell for a set of job facts.
 *
 * `deriveState` and `TAB_META` are IMPORTED. The four labels, the four colours
 * and the mapping between them are /finance's, and this screen is a second
 * reader of them rather than a second author.
 *
 * MORE THAN ONE JOB on one production is possible (0090's duplicate guard stops
 * a second job being born automatically, but record-past-productions can add
 * productions to an existing job and a hand-made job can join one). The cell
 * shows the LEAST FINISHED state, by the pipeline order /finance itself
 * declares in PIPELINE_TABS: a production with one closed job and one unbilled
 * job has unbilled work on it, and saying "סגור" would hide the open money.
 */
const BILL_ORDER: FinanceState[] = ["purple", "blue", "red", "closed"];

export function billStatusFor(facts: FinanceJobFacts[]): BillStatus {
  if (!facts.length) return { state: null, label: NO_JOB_LABEL, color: NO_JOB_COLOR };
  let worst: FinanceState = "closed";
  for (const f of facts) {
    const s = deriveState(f);
    if (BILL_ORDER.indexOf(s) < BILL_ORDER.indexOf(worst)) worst = s;
  }
  const meta = TAB_META[worst];
  return { state: worst, label: meta.label, color: meta.color };
}

/**
 * The production-status cell.
 *
 * 🔴 STATUS_LABEL, imported — and this REPLACES a hand-rolled
 * `s.replace(/_/g," ")` that stood at ProjectsClient.tsx:101. That expression
 * was a second implementation of an existing rule, and it was already wrong in
 * one place the enum cares about: `אושר_ע"י_לקוח` carries a quote mark, and
 * STATUS_LABEL spells the human form out by hand for exactly that reason. The
 * regex produced `אושר ע"י לקוח` by luck, not by rule, and would have produced
 * nonsense for the next value with punctuation in it.
 *
 * An unknown value renders ITSELF rather than throwing or blanking — the same
 * discipline MilestoneTableRow applies to an unknown MilestoneState
 * (ProjectsClient.tsx:200): a version skew must render a smaller truth, never a
 * stack trace.
 */
export function productionStatusCell(status: string | null | undefined): ProdStatus {
  if (!status) return null;
  return { label: STATUS_LABEL[status] ?? status, color: "var(--dim)" };
}

/** The misc status cell — its own four-value vocabulary, its own four tones. */
export function miscStatusCell(status: string | null | undefined): ProdStatus {
  if (!status) return null;
  return { label: status, color: miscStatusTone(status) };
}

/**
 * 🔵 INFERRED, NOT RECORDED — and the one place this model guesses.
 *
 * A job-only row is either a bundle-from-show order or a CSV import, and
 * **nothing on the `jobs` row records which**. There is no `source` column. The
 * two facts available:
 *
 *   · `external_id` — the CSV importer always writes one
 *     (import/apply/route.ts:226, `C0001`-style from nextExternalId); the app's
 *     own creation paths never do. bundle-from-show leaves it null
 *     (bundle-from-show/route.ts:107-115).
 *   · `legacy` — true on rows the V1a backfill and 0087/0093 inserted.
 *
 * So: either one means "this did not come from the bundle button". That rule is
 * right for every path measured on 5.10, and it is a GUESS for any job created
 * by hand in a migration with `legacy false` and no `external_id` — 0087 writes
 * exactly three such rows, and they would read "מרוכזת" when they are neither.
 * Three rows, mislabelled, on a screen that is otherwise blind to them
 * entirely.
 *
 * Recorded here rather than smoothed over: the real fix is a `jobs.source`
 * column, which is a migration and is NOT this change. The alternative
 * available without one — joining `pending_documents` on `job_id` for a
 * `work_order` row with `production_id` null — was rejected as a second
 * unbounded read that still mislabels a CSV job somebody later raised an order
 * for.
 */
export function jobOnlySource(j: Pick<JobInput, "external_id" | "legacy">): RowSource {
  const hasExternal = j.external_id != null && String(j.external_id).trim() !== "";
  return hasExternal || j.legacy ? "import" : "bundle";
}

// ---------------------------------------------------------------------------
// the builder
// ---------------------------------------------------------------------------

/**
 * 🔴 THE EXCLUDED SET — the owner's rule, as one function.
 *
 *     excluded = {job_productions.job_id} ∪ {misc_productions.job_id}
 *                                         ∪ {contract_milestones.job_id}
 *
 * Exported because it has TWO readers and they must not disagree:
 * `buildUnifiedRows` subtracts it to find the job-only rows, and
 * projects/page.tsx asks it first so it knows which jobs' documents to go and
 * fetch. Two spellings of this set would mean a row rendered with no documents
 * because the server never looked for them — the quietest possible failure on a
 * money screen.
 *
 * Note what it is built from: the three COLUMNS, not the three rendered sets.
 * A milestone outside the July floor still keeps its job out of the job-only
 * population, because the job belongs to that milestone whether or not the
 * milestone is on screen this month. The consequence is the `unrepresented`
 * list — see the file header.
 */
export function excludedJobIds(args: {
  linkedJobIds: string[];
  miscJobIds: (string | null | undefined)[];
  milestoneJobIds: (string | null | undefined)[];
}): Set<string> {
  const out = new Set<string>(args.linkedJobIds.filter((id) => !!id));
  for (const id of args.miscJobIds) if (id) out.add(id);
  for (const id of args.milestoneJobIds) if (id) out.add(id);
  return out;
}

/**
 * The job-only population: not withdrawn, not claimed by any anchor.
 *
 * Generic over the row shape so projects/page.tsx can call it on its raw job
 * rows in wave 1 — before it has built a single `JobInput` — and still be
 * asking the same question the builder asks later. `dismissed` is 0041's rule:
 * a soft-removed job is out of every money surface, and it must be out of this
 * one before any document is fetched for it.
 */
export function jobOnlyCandidates<T extends { id: string; dismissed: boolean }>(
  jobs: T[],
  excluded: Set<string>
): T[] {
  return jobs.filter((j) => !j.dismissed && !excluded.has(j.id));
}

export function buildUnifiedRows(input: UnifiedInput): UnifiedResult {
  const floor = input.rangeStartMonth;
  const rows: UnifiedRow[] = [];

  // ---- the ONE excluded set, and who owns each member ---------------------
  // The set comes from the shared function above, so the server's document
  // prefetch and this builder cannot drift. `claims` is a SEPARATE record of
  // every anchor that pointed at a job — not only the winner — because a job
  // claimed twice is the data defect worth reporting, and a Map that keeps only
  // the winner cannot see that it happened.
  const excluded = excludedJobIds({
    linkedJobIds: input.linkedJobIds,
    miscJobIds: input.misc.map((w) => w.job_id),
    milestoneJobIds: input.milestones.map((m) => m.job_id),
  });

  // The keys of the rows each pass actually emitted. One set per anchor kind,
  // because "claimed" and "rendered" are different facts — see step 1.
  const productionRowKeys = new Set<string>();
  const claims = new Map<string, { source: RowSource; key: string }[]>();
  const claim = (jobId: string | null | undefined, source: RowSource, key: string) => {
    if (!jobId) return;
    const arr = claims.get(jobId);
    if (arr) arr.push({ source, key });
    else claims.set(jobId, [{ source, key }]);
  };

  // ---- 1. productions ------------------------------------------------------
  //
  // ⚠️ TWO DIFFERENT QUESTIONS, TWO DIFFERENT SOURCES, AND CONFUSING THEM WAS A
  // REAL BUG THE CANARY CAUGHT.
  //
  //   "is this job claimed?"      → `excluded`, built from the FULL
  //                                 `linkedJobIds` (every job_productions row in
  //                                 the database). A production below the July
  //                                 floor still has its job linked, and that link
  //                                 still has to keep the job out of the job-only
  //                                 set — otherwise a hidden episode's job would
  //                                 resurface as an invented "מרוכזת" row.
  //
  //   "did a row actually show it?" → `claims`, recorded HERE, from the rows this
  //                                 pass emits. Nothing else can answer it.
  //
  // The first version of this file claimed nothing in step 1 and left the second
  // question to `linkedJobIds`, which cannot see whether a row rendered. Every
  // linked job then came out as `production_out_of_range` — the canary reported
  // two jobs as both represented and missing, which is exactly the contradiction
  // it exists to make impossible to ship.
  for (const p of input.productions) {
    if (p.month < floor) continue;
    const key = `production:${p.id}`;
    for (const j of p.jobs) claim(j.id, "production", key);
    productionRowKeys.add(key);
    rows.push({
      key,
      source: "production",
      month: p.month,
      date: p.record_date,
      dateMeaning: "record",
      client: p.client_name,
      show: p.show_name ?? p.podcast_name,
      description: p.guest,
      amount: p.price,
      billing: p.billing,
      contractName: p.contract_name,
      emptyReasonText: p.empty_reason_text,
      prodStatus: productionStatusCell(p.status),
      billStatus: billStatusFor(p.jobs),
      jobIds: p.jobs.map((j) => j.id),
      docs: p.docs,
      open: { kind: "entity", type: "production", id: p.id },
      excludedFromMoney: p.internal || p.cancelled,
      cancelled: p.cancelled,
      stuckSentences: p.stuckSentences,
    });
  }

  // ---- 2. contract milestones ---------------------------------------------
  // A milestone claims its job whether or not it produced a row. That is the
  // owner's rule stated literally — `excluded` is the union of the three
  // columns, not of the three RENDERED sets — and the consequence (an
  // anchor-less milestone job reaching no row) is reported in `unrepresented`
  // rather than papered over with a job-only row this screen was told not to
  // draw.
  const milestoneRowKeys = new Set<string>();
  for (const m of input.milestones) {
    const key = `milestone:${m.id}`;
    claim(m.job_id, "milestone", key);
    if (m.month < floor) continue;
    milestoneRowKeys.add(key);
    rows.push({
      key,
      source: "milestone",
      month: m.month,
      date: m.date,
      dateMeaning: m.dateMeaning,
      client: m.client_name,
      show: m.contract_name,
      description: m.name,
      amount: m.amount,
      billing: null,
      contractName: m.contract_name,
      emptyReasonText: null,
      // The milestone's OWN vocabulary, never a production status: "שולם" /
      // "חויב — ממתין לתשלום" cannot be mistaken for a pipeline stage. Same
      // reasoning MilestoneTableRow already carries (ProjectsClient.tsx:177-183).
      prodStatus: { label: m.stateLabel, color: m.stateColor },
      billStatus: billStatusFor(m.jobFacts ? [m.jobFacts] : []),
      jobIds: m.job_id ? [m.job_id] : [],
      docs: m.docs,
      open: { kind: "entity", type: "contract", id: m.contract_id },
      // ⚠️ A milestone is ALREADY inside the month cards above (its note at
      // projects/page.tsx:744-746). It must never be added to a money total
      // computed from these rows, which is what this flag is for.
      excludedFromMoney: true,
      cancelled: false,
      stuckSentences: [],
    });
  }

  // ---- 3. misc productions -------------------------------------------------
  const miscRowKeys = new Set<string>();
  for (const w of input.misc) {
    const key = `misc:${w.id}`;
    claim(w.job_id, "misc", key);
    const month = monthOf(w.work_date);
    // work_date is NOT NULL in the schema (0074:182), so a missing month here
    // means a payload shape this build does not know — skipped rather than
    // bucketed into "".
    if (!month || month < floor) continue;
    miscRowKeys.add(key);
    const cancelled = w.status === MISC_CANCELLED;
    rows.push({
      key,
      source: "misc",
      month,
      date: w.work_date,
      dateMeaning: "work",
      client: w.client_name,
      show: w.name,
      description: w.description,
      amount: w.amount,
      billing: null,
      contractName: null,
      emptyReasonText: null,
      prodStatus: miscStatusCell(w.status),
      billStatus: billStatusFor(w.jobFacts ? [w.jobFacts] : []),
      jobIds: w.job_id ? [w.job_id] : [],
      docs: w.docs,
      // No entity type for a misc job (ENTITY_TYPES, lib/entities.ts:27, lists
      // five and this is not one). Owner 5.10: link to /misc, do not add a
      // sixth type — a drawer that can open it is a separate piece of work.
      open: { kind: "href", href: "/misc" },
      // A cancelled misc job is out of the totals and stays on screen, exactly
      // as a cancelled episode does (projects/page.tsx:852). 'בוטל' NAMED, never
      // ranged — it is the LAST enum value (0074:59-67).
      excludedFromMoney: cancelled,
      cancelled,
      stuckSentences: [],
    });
  }

  // ---- 4. the subtraction, and the job-only rows --------------------------
  //
  // THE SUBTRACTION ITSELF IS `jobOnlyCandidates`, and it is called here rather
  // than inlined so that projects/page.tsx — which has to know the same ids one
  // wave earlier, to fetch their documents — asks the same function. The loop
  // below then has two passes with no shared predicate between them: the
  // candidates become rows, and everything else that is not dismissed is
  // accounted for in `unrepresented`.
  const unrepresented: Unrepresented[] = [];
  const candidates = jobOnlyCandidates(input.jobs, excluded);
  const candidateIds = new Set(candidates.map((j) => j.id));

  for (const j of input.jobs) {
    // 0041: a dismissed job is out of EVERY money surface. Not reported as
    // unrepresented either — it is not missing, it is withdrawn.
    if (j.dismissed) continue;
    if (candidateIds.has(j.id)) continue; // becomes a row in the pass below

    // Claimed by an anchor. Did that anchor actually RENDER?
    const mine = claims.get(j.id) ?? [];
    if (
      mine.some(
        (c) =>
          productionRowKeys.has(c.key) || milestoneRowKeys.has(c.key) || miscRowKeys.has(c.key)
      )
    ) {
      continue;
    }
    if (mine.length) {
      // Claimed by an anchor that emitted no row. The reason names WHICH kind,
      // because the three have different fixes: an anchor-less milestone is a
      // billing question for the owner, an out-of-range misc row or production
      // is the July floor doing its job.
      const src = mine[0].source;
      unrepresented.push({
        jobId: j.id,
        reason:
          src === "milestone"
            ? "milestone_without_anchor"
            : src === "misc"
              ? "misc_out_of_range"
              : "production_out_of_range",
      });
      continue;
    }
    // In `linkedJobIds` — a production holds it, and no production row carries
    // it. Not knowable from `claims` by design (see the note at step 1), so
    // this is the honest residue: the job is linked and nothing shows it.
    unrepresented.push({ jobId: j.id, reason: "production_out_of_range" });
  }

  for (const j of candidates) {
    const month = monthOf(j.date);
    if (!month) {
      // THE SAME RULE THE PRODUCTION ROWS FOLLOW, and for the same reason
      // (projects/page.tsx:50-77): a row that cannot say when the work was done
      // has no month it could honestly belong to. `jobs.date` is nullable in
      // the schema, so this is reachable — and it is reported, not dropped.
      unrepresented.push({ jobId: j.id, reason: "no_date" });
      continue;
    }
    if (month < floor) {
      unrepresented.push({ jobId: j.id, reason: "before_range" });
      continue;
    }

    const source = jobOnlySource(j);
    const key = `job:${j.id}`;
    claim(j.id, source, key);
    rows.push({
      key,
      source,
      month,
      date: j.date,
      dateMeaning: "issued",
      client: j.client_name,
      show: j.campaign,
      // A job-only row has no third fact to show. The campaign IS its name and
      // repeating it under itself reads as a bug — the same reason an internal
      // production prints no client fallback beside its "פנימי" tag
      // (ProjectsClient.tsx:276-278, which once rendered "פנימיפנימי").
      description: null,
      amount: j.amount,
      billing: null,
      contractName: null,
      emptyReasonText: null,
      // No production status: there is no production. An em dash, exactly as
      // MilestoneTableRow renders for guest/status/episode — "a milestone HAS
      // no guest, and printing anything there would be the invented value this
      // row exists to avoid" (ProjectsClient.tsx:177-183).
      prodStatus: null,
      billStatus: billStatusFor([
        { paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax },
      ]),
      jobIds: [j.id],
      docs: j.docs,
      open: { kind: "entity", type: "job", id: j.id },
      excludedFromMoney: false,
      cancelled: false,
      stuckSentences: [],
    });
  }

  // ---- 5. the winner, and the conflicts ------------------------------------
  const PRECEDENCE: RowSource[] = ["production", "milestone", "misc", "bundle", "import"];
  const jobOwner = new Map<string, { source: RowSource; key: string }>();
  const conflicts: { jobId: string; claimedBy: RowSource[]; wonBy: RowSource }[] = [];
  claims.forEach((cs, jobId) => {
    const sorted = cs
      .slice()
      .sort((a, b) => PRECEDENCE.indexOf(a.source) - PRECEDENCE.indexOf(b.source));
    jobOwner.set(jobId, sorted[0]);
    // Two claims from the SAME source is not a conflict — a job legitimately
    // links to several productions (record-past-productions adds them to one
    // job, route.ts:264-268). Two different anchors IS one.
    const distinct = Array.from(new Set(cs.map((c) => c.source)));
    if (distinct.length > 1) {
      conflicts.push({ jobId, claimedBy: distinct, wonBy: sorted[0].source });
    }
  });

  return { rows, jobOwner, conflicts, unrepresented };
}

/**
 * Chronological order inside one month.
 *
 * Dateless rows sort LAST rather than first: an empty string sorts before every
 * date in a plain localeCompare, which would put the least informative rows at
 * the top of a money table. `key` is the final tiebreak so the order is TOTAL —
 * without it two rows sharing a date can swap between renders, which is how a
 * screenshot and the screen stop agreeing.
 */
export function compareUnified(a: UnifiedRow, b: UnifiedRow): number {
  if (!a.date && b.date) return 1;
  if (a.date && !b.date) return -1;
  return (a.date ?? "").localeCompare(b.date ?? "") || a.key.localeCompare(b.key);
}

// ---------------------------------------------------------------------------
// the filters — pure predicates, so the chips and the counts cannot disagree
// ---------------------------------------------------------------------------

/**
 * The billing-status filter's values: the four `FinanceState`s plus the absence.
 *
 * "none" is a FILTER key, not a FinanceState — the distinction `BillStatus`
 * exists to hold. Spelled as a separate string so no code path can hand it to
 * `TAB_META` and read `undefined.label`.
 */
export type BillFilterKey = FinanceState | "none";

export const BILL_FILTER_KEYS: BillFilterKey[] = ["purple", "blue", "red", "closed", "none"];

export const billFilterLabel = (k: BillFilterKey): string =>
  k === "none" ? NO_JOB_LABEL : TAB_META[k].label;

export type UnifiedFilter = {
  /** Empty = every source. Never "no sources": an empty chip set shows all. */
  sources: RowSource[];
  /** Empty string = every client. */
  client: string;
  /** Empty = every billing status. */
  bills: BillFilterKey[];
};

export const EMPTY_FILTER: UnifiedFilter = { sources: [], client: "", bills: [] };

/**
 * ONE predicate, read by the table and by every count beside it.
 *
 * An EMPTY list means "no filter on this axis" and not "match nothing" — the
 * same decision isFinanceFilterKey makes for an unrecognised query string
 * (state.ts:117-126): "a money screen must never hide rows because it
 * half-recognised a filter".
 */
export function matchesFilter(r: UnifiedRow, f: UnifiedFilter): boolean {
  if (f.sources.length && !f.sources.includes(r.source)) return false;
  if (f.client && (r.client ?? "") !== f.client) return false;
  if (f.bills.length) {
    const key: BillFilterKey = r.billStatus.state ?? "none";
    if (!f.bills.includes(key)) return false;
  }
  return true;
}

export const isFilterActive = (f: UnifiedFilter): boolean =>
  f.sources.length > 0 || f.client !== "" || f.bills.length > 0;

/** Distinct client names present in a row set, sorted — the client dropdown. */
export function clientOptions(rows: UnifiedRow[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) if (r.client) seen.add(r.client);
  return Array.from(seen).sort((a, b) => a.localeCompare(b, "he"));
}

/** How many rows each source contributes, for the chip counts. */
export function countBySource(rows: UnifiedRow[]): Record<RowSource, number> {
  const out = { production: 0, bundle: 0, misc: 0, milestone: 0, import: 0 };
  for (const r of rows) out[r.source] += 1;
  return out;
}
