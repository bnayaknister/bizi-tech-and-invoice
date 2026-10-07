import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import { israelMonthKey, todayInIsrael } from "@/lib/dates";
import { effectiveBase, approvedAddonTotal, productionTotal, type AddonRow } from "@/lib/productions/price";
import {
  resolveProductionDocuments,
  type DocumentRow,
  type ReceiptLink,
  type ConsolidationLink,
} from "@/lib/documents/forProduction";
import AppHeader from "@/components/AppHeader";
import { deriveMilestoneState, MILESTONE_META } from "@/lib/finance/milestone";
import {
  accruedSince,
  emptyReasonFor,
  lastBillingDateByClient,
  stuckFor,
  termsUnconfigured,
  type Cadence as StuckCadence,
  type PaymentTerms as StuckPaymentTerms,
} from "@/lib/projects/stuck";
import {
  buildUnifiedRows,
  compareUnified,
  excludedJobIds,
  jobOnlyCandidates,
  type JobInput,
  type MilestoneInput,
  type MiscInput,
  type ProductionInput,
  type UnifiedRow,
} from "@/lib/projects/unified";
import type { ProjectDoc } from "@/lib/projects/row";
import { classifyProduction, contractNameFor, soleJobAmounts } from "@/lib/projects/classify";
import ProjectsClient, {
  type BillingClass,
  type MilestoneRow,
  type MonthBucket,
  type ProjectRow,
} from "./ProjectsClient";

export const dynamic = "force-dynamic";

/**
 * The screen starts in July 2026 and there is no way to go further back.
 *
 * NOT a performance limit — a truthfulness one. 763 productions exist, and 708
 * of them sit at 'עתיד_להתחיל' having never moved: they were imported from the
 * calendar before the pipeline existed and no one ever walked them through it.
 * Rendering June 2026 would show 39 episodes, every one of them "about to
 * start", all of them long since recorded and delivered. That is not sparse
 * data, it is a false statement, and a money screen must not make it.
 *
 * July 2026 is where the system genuinely took over. From that month the
 * statuses are real (August 2026 carries seven distinct ones across 28
 * episodes). Later months arrive on their own — the picker is built from the
 * data plus the current month, so September appears the day it has an episode,
 * with no code change.
 */
const RANGE_START_MONTH = "2026-07";
const RANGE_START_DATE = `${RANGE_START_MONTH}-01`;

/**
 * record_date IS REQUIRED. There is no created_at fallback, and that is a
 * correction, not an omission.
 *
 * The first version of this screen bucketed by `record_date ?? created_at`,
 * copying the accrued queue. It was wrong here. Twenty rows walked straight
 * through the July floor on the created_at branch, and every one of them
 * carried the same fingerprint (verified 2026-08-27):
 *
 *     record_date NULL · created_at 2026-07-12 · status עתיד_להתחיל
 *     legacy true · external_id set · calendar_uid empty
 *
 * One legacy import batch from a single day — the exact class of row the July
 * floor exists to exclude — entering through the back door and being counted
 * as July work. They made July look like 16 billable episodes with 8 unpriced,
 * when the truth was 8 real episodes, all of them priced. A production with no
 * recording date has not been recorded, and this screen is a record of work
 * that happened.
 *
 * The accrued queue keeps its fallback and should: there the question is "which
 * month does this frozen charge belong to", and a charge with no date still has
 * to land somewhere. Here the question is "what did we record", and the honest
 * answer for a dateless row is: nothing yet.
 *
 * CONSEQUENCE, deliberately accepted: a hand-made production whose date has not
 * been filled in yet will not appear until it is. Zero such rows exist today —
 * all 20 dateless productions are legacy imports — but a new one would be
 * invisible here rather than misdated, which is the right way round for a money
 * screen.
 */

const MONTH_LABEL = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long", year: "numeric" });
const monthLabel = (key: string) => MONTH_LABEL.format(new Date(`${key}-01T00:00:00Z`));

type MonthDoc = {
  id: string;
  type: number;
  amount: number | null;
  document_date: string | null;
  cancelled_at: string | null;
  archived_at: string | null;
  /**
   * For the every_n counter only — see the note at `lastBillingDocByClient`.
   * The two month-card totals never look at it: they sum by type and date.
   */
  client_id: string | null;
};

/**
 * 🔴 classify() AND resolveContractName() LEFT THIS FILE ON 2026-10-06.
 *
 * Both now live in lib/projects/classify.ts, and the move is the fix rather
 * than a tidy-up. They asked `shows.billing_mode` and the show's CURRENT
 * contract — the show as it stands today — about work that happened months ago,
 * so switching a show to contract mode retroactively relabelled every episode
 * ever recorded under it. An EY episode from 2.8.2026 that was billed per
 * episode (order 10302, deal invoice 40306) was shown as "בחוזה: ey 2026 -2027
 * חצי ראשון 041026", a contract created on 4.10. The full account, and the
 * four-reason table that used to sit here, is in that module's header.
 *
 * The row is now classified from `productions.kind` and `productions.contract_id`
 * — the snapshot the production froze about itself at creation. The show is
 * still asked for the price, for `active` and for billing_mode='none', because
 * those three genuinely are questions about the show as it stands now.
 *
 * ONE definition, every consumer: the billing cell, the month cards
 * (expected / contractCount / missingRateCount), the stuck rule and the
 * billing-status filter all read the single `billing` written onto the row
 * below. See the note at the `rows` literal — "classifying twice is how the cell
 * and the rule drift apart".
 */

type ContractRow = {
  id: string;
  name: string;
  client_id: string | null;
  show_id: string | null;
  status: string;
};

type ProdRow = {
  id: string;
  podcast_name: string;
  record_date: string | null;
  created_at: string;
  guest: string | null;
  status: string;
  kind: string;
  client_id: string | null;
  show_id: string | null;
  price_override: number | null;
  cancelled_at: string | null;
  merged_into: string | null;
  episode_no: number | null;
  contract_id: string | null;
};

/**
 * A `jobs` row as this screen reads it.
 *
 * Nine columns, and every one of them is load-bearing since 5.10: five feed the
 * document walk and the billing cell, three feed the row itself, and
 * `external_id` + `legacy` are the only two facts in the table that hint at
 * where a job-only row came from (see `jobOnlySource`, which says plainly that
 * the hint is an inference and not a record).
 */
type JobDbRow = {
  id: string;
  client_id: string | null;
  campaign: string | null;
  date: string | null;
  amount: number | null;
  invoice_biz: string | null;
  invoice_tax: string | null;
  paid: string | null;
  dismissed: boolean;
  external_id: string | null;
  legacy: boolean;
};

/** A `misc_productions` row — "רדיו ושונות". `work_date` is NOT NULL (0074:182). */
type MiscDbRow = {
  id: string;
  client_id: string;
  name: string;
  work_date: string;
  amount: number | null;
  description: string | null;
  status: string;
  job_id: string | null;
};

// Paged for the same reason productions/page.tsx is: PostgREST silently caps an
// unbounded select at 1000 rows and returns no error. 83 rows in range today,
// growing ~30 a month, so the cap is years away — and the day it is crossed is
// the day this screen would start quietly omitting episodes from a total.
// .order("id") is what makes the paging sound: without a stable sort a row can
// repeat on one page and vanish from another.
async function fetchProductionsInRange(admin: ReturnType<typeof createAdminClient>) {
  const page = 1000;
  const out: ProdRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await admin
      .from("productions")
      .select(
        "id,podcast_name,record_date,created_at,guest,status,kind,client_id,show_id,price_override,cancelled_at,merged_into,episode_no,contract_id"
      )
      .gte("record_date", RANGE_START_DATE)
      .order("id")
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as ProdRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

// 🔴 client_id JOINED THE SELECT ON 5.10, AND ITS ABSENCE WAS A LIVE BUG.
//
// `lastBillingDateByClient` read `d.client_id` off these rows. PostgREST returns
// the columns it is asked for and nothing else, so the field was `undefined` on
// every row, the map was ALWAYS EMPTY, and the every_n counter therefore counted
// every undocumented episode a client had in range instead of only those since
// the last bill. See the note above `accruedSince` in lib/projects/stuck.ts for
// the full account.
//
// Checked against every other reader of this constant before adding it: the
// three other files that define a `DOC_SELECT` (milestones/record-billed,
// shows/record-past-productions, documents/reconcile) each declare their OWN
// local copy, so this one is read nowhere else. Within this file the extra
// column is inert everywhere but the counter — `resolveProductionDocuments`
// projects the fields it names and ignores the rest, and the milestone document
// walk reads type/date/number/amount only.
const DOC_SELECT =
  "id,morning_doc_id,morning_doc_number,type,amount,document_date,pdf_url,production_id,job_id,bundle_job_ids,cancelled_at,archived_at,status,client_id";

/**
 * Page any query whose result is not bounded by an id list.
 *
 * The two reads below are the ones that grow without limit: every receipt ever
 * issued, and every document dated since July. ~110 and ~62 rows today, both
 * growing about 80 a month — so the 1000-row silent cap is roughly a year out,
 * and the day it arrives a money total would quietly start under-reporting with
 * no error anywhere. The queries keyed on production/job ids are bounded by
 * those lists and need none of this.
 */
async function fetchAllPages<T>(
  run: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const page = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await run(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

export default async function ProjectsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  // every row carries a price and document amounts, and price_override is
  // REVOKEd from `authenticated` (0032) — this is a service-role read behind a
  // money check, exactly like /finance and the accrued queue
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();

  // ---- wave 1: everything that does not depend on an id list ---------------
  const [
    productions,
    showsRes,
    contractsRes,
    clientsRes,
    jobsRes,
    linksRes,
    receiptQueueRes,
    milestonesRes,
    miscRes,
  ] = await Promise.all([
    fetchProductionsInRange(admin),
    // billing_mode and active are both read, and they are NOT interchangeable:
    // billing_mode is a money field (can_edit_money, shows/update/route.ts:19)
    // while active only needs can_edit_stages — a technician can flip it.
    //
    // 🔴 SINCE 2026-10-06 NEITHER DECIDES WHETHER AN EPISODE IS CONTRACT-BILLED.
    // That question is answered by `productions.kind`, which froze the show's
    // mode at creation. billing_mode is still read for the 'none' case (billing
    // silenced) and active for the "not owed a rate" label — both statements
    // about the show as it stands now. See lib/projects/classify.ts.
    admin.from("shows").select("id,name,default_rate,billing_mode,active,client_id"),
    // named so a contract-billed row can say WHICH contract it belongs to
    admin.from("contracts").select("id,name,client_id,show_id,status"),
    // billing_cadence / billing_every_n / payment_terms joined for the stuck
    // rule and the empty-cell labels (2026-09-17). payment_terms is only ever
    // used to ASK public.due_date_for — never to compute a date here.
    admin.from("clients").select("id,name,billing_cadence,billing_every_n,payment_terms"),
    // ═══ EVERY JOB, AND NOW EVERY COLUMN A ROW NEEDS ═══
    //
    // This read used to be five columns, because a job was only ever a ROUTE to
    // a document here. Since 5.10 a job can BE a row — bundle-from-show and CSV
    // imports write jobs with no production at all, and 47 of the 94 jobs in the
    // database live that way (lib/misc/workOrder.ts:88-89) — so the row's own
    // facts have to come down too: client, campaign, date, amount, and the two
    // provenance columns `jobOnlySource` reads.
    //
    // PAGED, where it was not before. The old five-column read fed a document
    // walk whose misses were invisible; now a missed page is a missing row on a
    // money screen. PostgREST silently caps an unbounded select at 1000 and
    // returns no error (the reason fetchProductionsInRange pages), so the day
    // the 94 becomes 1001 is the day this screen would quietly start omitting
    // work. ~94 rows today, so one round-trip is also the last one.
    fetchAllPages<JobDbRow>((from, to) =>
      admin
        .from("jobs")
        .select(
          "id,client_id,campaign,date,amount,invoice_biz,invoice_tax,paid,dismissed,external_id,legacy"
        )
        .order("id")
        .range(from, to)
    ).then((data) => ({ data })),
    admin.from("job_productions").select("job_id,production_id"),
    // the ONLY record of which tax invoices a receipt was raised on. A pulled
    // receipt has no such row, and Morning's search response carries no
    // linkedDocumentIds field — hence route 5 in forProduction.ts reaching only
    // receipts we issued ourselves.
    admin.from("pending_documents").select("morning_doc_id,payload").eq("doc_type", "receipt"),
    // ---- contract milestones -------------------------------------------------
    // NEW SUBJECT ON THIS SCREEN, and the reason is measured rather than assumed.
    //
    // A milestone's documents reach NO row of the table below. All five routes in
    // resolveProductionDocuments were checked one by one against the live data
    // (2026-09-15, documents 40325 / 60197 / 10330): production_id is null,
    // job_id leads to zero job_productions rows, bundle_job_ids likewise,
    // consolidated_into is null with nothing folded into them, and the only two
    // receipts in the account link a different pair of invoices. All five
    // milestone jobs carry zero job_productions rows, and the five "בלי יריה
    // אחת" productions carry zero documents.
    //
    // Meanwhile the money is already in the month totals: those read EVERY
    // document in range, not the productions' (see the note above monthDocsRes).
    // ₪5,900 of ספטמבר's ₪18,242.80 "נכנס" is one milestone's 320. So the
    // gap was never counting — it was ATTRIBUTION: no way to see whose money it is.
    admin
      .from("contract_milestones")
      .select("id,contract_id,name,amount,expected_date,is_estimated,status,job_id"),
    // ---- רדיו ושונות -------------------------------------------------------
    // The fourth subject on this screen, and the one 0074 explicitly deferred
    // to a later step: "מחוץ להיקף במכוון: … הופעה במעקב הפרויקטים (צעד נפרד
    // אחרי שהמסך עובד)" (0074:402). This is that step.
    //
    // 🔴 SERVICE ROLE, AND THE PERMISSION MISMATCH IS THE REASON. 0074's RLS
    // policy on misc_productions is `can_view_stages`, while this page's gate is
    // `can_view_money` — two INDEPENDENT booleans, both defaulting false
    // (0002:14-16). A bookkeeper with money and no stages would read zero rows
    // through her own session and be shown a projects screen that is silently
    // missing every radio job, which is the exact failure modules/misc.ts:28-53
    // spells out at length for the hub card. The whole page is already a
    // service-role read behind a money check (see the gate above), so this rides
    // the same trade rather than inventing a second one.
    //
    // `amount` is in the select and is NOT readable by `authenticated` — 0074
    // revokes the table and grants column by column, deliberately never naming
    // amount or price. One more reason the service role is not optional here.
    //
    // Paged for the reason every unbounded read in this app is. The table was
    // empty when /misc shipped (misc/page.tsx:74), so this is insurance — and
    // the cheap kind: one page is also the last page.
    fetchAllPages<MiscDbRow>((from, to) =>
      admin
        .from("misc_productions")
        .select("id,client_id,name,work_date,amount,description,status,job_id")
        .order("id")
        .range(from, to)
    ).then((data) => ({ data })),
  ]);

  // merged_into is the one soft-delete mechanism (0019) — a merged duplicate is
  // not a project, it is a row that should never have existed. Dropped outright
  // rather than shown struck through, which is what cancellation is for.
  const live = productions.filter((p) => !p.merged_into);
  const inRange = live.filter((p) => israelMonthKey(p.record_date, p.created_at) >= RANGE_START_MONTH);
  const prodIds = inRange.map((p) => p.id);

  const showById = new Map((showsRes.data ?? []).map((s) => [s.id as string, s]));
  const contracts = (contractsRes.data ?? []) as unknown as ContractRow[];
  const clientName = new Map((clientsRes.data ?? []).map((c) => [c.id as string, c.name as string]));
  // the whole client row — the stuck rule needs cadence, every_n and terms, and
  // reading them off a second map keeps clientName doing the one thing it did
  const clientById = new Map(
    ((clientsRes.data ?? []) as {
      id: string;
      billing_cadence: string | null;
      billing_every_n: number | null;
      payment_terms: string | null;
    }[]).map((c) => [c.id, c])
  );

  const allJobRows = (jobsRes.data ?? []) as unknown as JobDbRow[];
  const miscRows = (miscRes.data ?? []) as unknown as MiscDbRow[];

  // A dismissed job is hidden from every money surface (0041: wrong/duplicate/
  // irrelevant). Its documents must not surface through it either, or a
  // duplicate job would pull a real invoice onto the wrong episode.
  const jobs = allJobRows.filter((j) => !j.dismissed);
  const jobIdSet = new Set(jobs.map((j) => j.id));
  const jobLinks = (linksRes.data ?? []).filter(
    (l) => jobIdSet.has(l.job_id as string) && prodIds.includes(l.production_id as string)
  ) as { job_id: string; production_id: string }[];

  // ═══ THE EXCLUDED SET, ASKED HERE AND ASKED AGAIN BY THE BUILDER ═══
  //
  // It has to be known NOW, one wave before the rows exist, because the
  // documents of a job-only row have to be fetched in wave 2 along with
  // everybody else's — a row rendered with an empty document cell because the
  // server never went looking is the quietest wrong answer this screen could
  // give. `excludedJobIds` and `jobOnlyCandidates` are therefore both imported
  // from lib/projects/unified and NOT re-spelled: buildUnifiedRows calls the
  // same two functions on the same facts, so the set it subtracts and the set
  // whose documents were fetched cannot be different sets.
  //
  // `linkedJobIds` is read off the FULL job_productions table, not the
  // in-range-filtered `jobLinks` above. That difference is load-bearing: a job
  // whose production sits below the July floor is still a linked job, and
  // treating it as unlinked would resurrect it as a "מרוכזת" row — inventing a
  // bundle order out of a production the screen deliberately does not show.
  const allLinks = (linksRes.data ?? []) as { job_id: string; production_id: string }[];
  const excluded = excludedJobIds({
    linkedJobIds: allLinks.map((l) => l.job_id),
    miscJobIds: miscRows.map((w) => w.job_id),
    milestoneJobIds: ((milestonesRes.data ?? []) as { job_id: string | null }[]).map((m) => m.job_id),
  });
  const jobOnly = jobOnlyCandidates(jobs, excluded);

  // Documents are wanted for three populations now, not one: the jobs of the
  // episodes on screen, the jobs of the misc rows, and the job-only rows
  // themselves. One id list, so wave 2 stays the same five queries.
  const relevantJobIds = Array.from(
    new Set([
      ...jobLinks.map((l) => l.job_id),
      ...miscRows.map((w) => w.job_id).filter((v): v is string => !!v),
      ...jobOnly.map((j) => j.id),
    ])
  );
  const relevantJobSet = new Set(relevantJobIds);
  const relevantJobs = jobs.filter((j) => relevantJobSet.has(j.id));
  const docNumbers = Array.from(
    new Set(relevantJobs.flatMap((j) => [j.invoice_biz, j.invoice_tax]).filter((n): n is string => !!n))
  );

  // ---- wave 2: the id-dependent reads ------------------------------------
  // Five narrow queries rather than one `.or()` string. Each is a plain `.in()`
  // returning well under a page, and the alternative — hand-assembling a
  // PostgREST or-filter out of UUID lists and text numbers — is a quoting bug
  // waiting to happen in the one place where a silent miss means a missing
  // invoice. They run in parallel; functions and DB are co-located (both fra1
  // / eu-central-1 since Aug 2026), so the extra round-trips cost about a
  // millisecond each.
  const emptyRes = Promise.resolve({ data: [] as unknown[] });
  const [addonsRes, byProdRes, byJobRes, byBundleRes, byNumberRes, receiptsRes, foldedRes, monthDocsRes] =
    await Promise.all([
      prodIds.length
        ? admin.from("production_addons").select("production_id,status,total").in("production_id", prodIds)
        : emptyRes,
      prodIds.length ? admin.from("documents").select(DOC_SELECT).in("production_id", prodIds) : emptyRes,
      relevantJobIds.length ? admin.from("documents").select(DOC_SELECT).in("job_id", relevantJobIds) : emptyRes,
      relevantJobIds.length
        ? admin.from("documents").select(DOC_SELECT).overlaps("bundle_job_ids", relevantJobIds)
        : emptyRes,
      docNumbers.length ? admin.from("documents").select(DOC_SELECT).in("morning_doc_number", docNumbers) : emptyRes,
      // all receipts plus their parents — the parents are already in the byJob
      // set when they carry a job, which is the only case where the walk can
      // reach an episode at all
      fetchAllPages<DocumentRow>((from, to) =>
        admin.from("documents").select(DOC_SELECT).eq("type", 400).order("id").range(from, to)
      ).then((data) => ({ data })),
      // route 4's first hop: this production's own queue rows that were folded
      // into a consolidated one. The second hop (parent -> morning_doc_id) has
      // to wait for these ids, so it runs just below rather than here.
      prodIds.length
        ? admin
            .from("pending_documents")
            .select("production_id,consolidated_into")
            .in("production_id", prodIds)
            .not("consolidated_into", "is", null)
        : emptyRes,
      // the month totals are document-anchored and deliberately NOT restricted
      // to these productions — see the summary note in ProjectsClient
      //
      // ⚠ BACKLOG, and larger than the milestone rows below it. "כל העסק, לא
      // רק ההפקות שלמטה" is on the cards as a caveat, and the measurement
      // says it is a statement about MOST of the money, not a footnote.
      // Measured 2026-09-15 over documents dated from July, modelling routes 1-3
      // of resolveProductionDocuments (production_id, job_id → job_productions,
      // bundle_job_ids → job_productions) — routes 4 and 5 could rescue some, so
      // read these as an upper bound:
      //
      //   300:  27 of 44 reach no production
      //   305:   3 of  5
      //   320:  24 of 31
      //   400:   7 of  7
      //
      // The milestone rows added below close this for contract work, which is
      // one named slice of it. What remains is every other document with no
      // production anchor — misc/radio work, client-level billing, anything
      // raised by hand in Morning. Attributing those is a separate piece of
      // work and probably a different mechanism; recorded here because the gap
      // is invisible from the screen and the cards read as if it were small.
      fetchAllPages<MonthDoc>((from, to) =>
        admin
          .from("documents")
          .select("id,type,amount,document_date,cancelled_at,archived_at,client_id")
          .gte("document_date", RANGE_START_DATE)
          .order("id")
          .range(from, to)
      ).then((data) => ({ data })),
    ]);

  const docsById = new Map<string, DocumentRow>();
  for (const res of [byProdRes, byJobRes, byBundleRes, byNumberRes, receiptsRes]) {
    for (const d of ((res.data ?? []) as unknown as DocumentRow[])) docsById.set(d.id, d);
  }

  const receiptLinks: ReceiptLink[] = ((receiptQueueRes.data ?? []) as { morning_doc_id: string | null; payload: unknown }[])
    .map((r) => {
      const ids = (r.payload as { linkedDocumentIds?: unknown } | null)?.linkedDocumentIds;
      return {
        morning_doc_id: r.morning_doc_id ?? "",
        linked_document_ids: Array.isArray(ids) ? (ids.filter((x) => typeof x === "string") as string[]) : [],
      };
    })
    .filter((r) => r.morning_doc_id && r.linked_document_ids.length);

  // ---- route 4, second hop: the folded parents and their documents ---------
  // Sequential on purpose: the parent ids only exist once the first hop has
  // returned, and the consolidated document is reachable by NO other query here
  // (production_id, job_id and bundle_job_ids are all null on it), so without
  // this read it would simply be absent from the set the resolver walks.
  const folded = (foldedRes.data ?? []) as unknown as {
    production_id: string;
    consolidated_into: string;
  }[];
  const parentIds = Array.from(new Set(folded.map((f) => f.consolidated_into).filter(Boolean)));
  const consolidationLinks: ConsolidationLink[] = [];
  if (parentIds.length) {
    const [{ data: parents }] = await Promise.all([
      admin.from("pending_documents").select("id,morning_doc_id").in("id", parentIds),
    ]);
    const midByParent = new Map(
      ((parents ?? []) as { id: string; morning_doc_id: string | null }[])
        .filter((p) => p.morning_doc_id)
        .map((p) => [p.id, p.morning_doc_id as string])
    );
    const mids = Array.from(new Set(Array.from(midByParent.values())));
    if (mids.length) {
      const bundleDocs = await fetchAllPages<DocumentRow>((from, to) =>
        admin.from("documents").select(DOC_SELECT).in("morning_doc_id", mids).order("id").range(from, to)
      );
      for (const d of bundleDocs) docsById.set(d.id, d);
      for (const f of folded) {
        const mid = midByParent.get(f.consolidated_into);
        // A folded row whose parent has not been issued yet has no morning_doc_id
        // and therefore no document — an ordinary state, not a gap.
        if (mid) consolidationLinks.push({ production_id: f.production_id, morning_doc_id: mid });
      }
    }
  }

  // ---- milestone rows: their documents, and the one that anchors them -------
  //
  // Read by job_id AND by document number, because the two doors differ. A
  // milestone the app billed carries job_id on its documents; "מכירת ביפו —
  // חלק א" (#60166) was raised by hand in Morning and reached us on the pull,
  // so it is findable only through the number stamped on its job. Bounded by two
  // numbers per milestone.
  const msRows = (milestonesRes.data ?? []) as unknown as {
    id: string;
    contract_id: string;
    name: string;
    amount: number;
    expected_date: string | null;
    is_estimated: boolean;
    status: string;
    job_id: string | null;
  }[];
  // Typed as the full JobDbRow rather than the five columns the milestone
  // document walk needed. `date` joined the readers on 5.10: an anchor-less
  // milestone row falls back to its job's date when the milestone itself carries
  // no expected_date, and a narrower local type here would have hidden a column
  // the select already fetches.
  const allJobsById = new Map(allJobRows.map((j) => [j.id, j]));
  const present = (v: unknown) => v != null && String(v).trim() !== "";
  const msJobIds = Array.from(new Set(msRows.map((m) => m.job_id).filter((v): v is string => !!v)));
  const msDocNumbers = Array.from(
    new Set(
      msJobIds
        .map((id) => allJobsById.get(id))
        .flatMap((j) => [j?.invoice_biz, j?.invoice_tax])
        .filter((n): n is string => present(n))
        .map((n) => String(n).trim())
    )
  );
  const [msByJobRes, msByNumberRes] = await Promise.all([
    msJobIds.length ? admin.from("documents").select(DOC_SELECT).in("job_id", msJobIds) : emptyRes,
    msDocNumbers.length
      ? admin.from("documents").select(DOC_SELECT).in("morning_doc_number", msDocNumbers)
      : emptyRes,
  ]);
  const msDocsById = new Map<string, DocumentRow>();
  for (const res of [msByJobRes, msByNumberRes]) {
    for (const d of ((res.data ?? []) as unknown as DocumentRow[])) {
      if (!d.cancelled_at && !d.archived_at) msDocsById.set(d.id, d);
    }
  }
  const msDocsForJob = new Map<string, DocumentRow[]>();
  for (const d of Array.from(msDocsById.values())) {
    // a document can name its job directly or carry it in a bundle — a tax row
    // built by taxFromParent has job_id null and the job in bundle_job_ids
    const owners = Array.from(
      new Set<string>([...(d.job_id ? [d.job_id] : []), ...(d.bundle_job_ids ?? [])])
    );
    for (const j of owners) {
      if (!msJobIds.includes(j)) continue;
      msDocsForJob.set(j, [...(msDocsForJob.get(j) ?? []), d]);
    }
  }

  // ═══ ONE RESOLUTION FOR ALL THREE ROW KINDS, AND WHY IT IS ONE CALL ═══
  //
  // resolveProductionDocuments' contract is not really "give me productions" —
  // it is "give me a set of KEYS and the jobs attached to each, and I will walk
  // the six routes for every key". Of those six, only route 1 (documents
  // .production_id) and route 4 (the consolidated work order) are keyed on a
  // production id at all; the other four are keyed on the key's JOBS. So a misc
  // row and a job-only row can be resolved by the same function by handing it
  // their own id as the key and a one-element job link — routes 1 and 4 simply
  // miss for them, which is correct, and routes 2/3/5/6 do the work.
  //
  // 🔴 AND IT MUST BE ONE CALL, not three. `shared` — the "מאוגד" tag — is
  // computed from how many keys in the SET hold the same document
  // (forProduction.ts:279-285). Resolving productions separately from job-only
  // rows would mean a bundle covering one linked job and one unlinked job gets
  // no tag on either side, because neither call could see the other holder. One
  // call sees all of them. 0087 wrote bundle_job_ids onto pulled documents by
  // hand, so a bundle spanning both populations is a live shape, not a theory.
  //
  // The key spaces cannot collide: production ids, misc ids and job ids are all
  // distinct uuids from distinct tables.
  const miscJobLinks = miscRows
    .filter((w) => w.job_id)
    .map((w) => ({ job_id: w.job_id as string, production_id: w.id }));
  const jobOnlyLinks = jobOnly.map((j) => ({ job_id: j.id, production_id: j.id }));
  const resolved = resolveProductionDocuments({
    productionIds: [...prodIds, ...miscRows.map((w) => w.id), ...jobOnly.map((j) => j.id)],
    jobLinks: [...jobLinks, ...miscJobLinks, ...jobOnlyLinks],
    jobs: relevantJobs,
    documents: Array.from(docsById.values()),
    receiptLinks,
    consolidationLinks,
  });

  const addonsByProduction = new Map<string, AddonRow[]>();
  for (const a of ((addonsRes.data ?? []) as unknown as AddonRow[])) {
    const arr = addonsByProduction.get(a.production_id) ?? [];
    arr.push(a);
    addonsByProduction.set(a.production_id, arr);
  }

  // ---- the last billing document each client received ---------------------
  //
  // THE RULE IS `lastBillingDateByClient` (lib/projects/stuck.ts). It used to be
  // an inline loop here reading a column that was not in the select, so the map
  // was always empty — the whole account is in the note above that function.
  //
  // ⚠️ IT IS FED FROM TWO SETS, AND THE SECOND IS THE POINT.
  //
  // `docsById` holds only documents reachable from an episode, a job or a
  // bundle on this screen. The old comment here named the exact case that set
  // CANNOT see — "a bundle raised by hand in Morning closes an accrual just as
  // a redeemed one does" — and such a document has no production and no job: 27
  // of 44 of this account's 300s reach no production at all (measured
  // 2026-09-15, recorded above monthDocsRes). Fixing only the select would have
  // moved the counter from "always counts everything" to "counts from the last
  // bill we happen to have fetched", which is a second wrong answer and a harder
  // one to notice.
  //
  // `monthDocs` is already every document dated since the July floor, fetched
  // for the month cards, so the complete set costs ONE extra column and no extra
  // query. Both are passed; the rule takes the max per client either way.
  //
  // RESIDUAL LIMIT, stated rather than hidden: a client whose last bill predates
  // 2026-07 is not in `monthDocs`, and unless that document reached an episode
  // on screen the client's `lastBilled` is "" and every in-range episode counts.
  // That is the same answer as before the fix for those clients — never worse —
  // and it cannot be better without reading documents from outside the screen's
  // own range.
  const lastBillingDocByClient = lastBillingDateByClient([
    ...Array.from(docsById.values()).map((d) => ({
      client_id: (d as unknown as { client_id?: string | null }).client_id ?? null,
      type: d.type,
      document_date: d.document_date,
      cancelled_at: d.cancelled_at,
    })),
    ...((monthDocsRes.data ?? []) as unknown as MonthDoc[]).map((d) => ({
      client_id: d.client_id,
      type: d.type,
      document_date: d.document_date,
      cancelled_at: d.cancelled_at,
    })),
  ]);

  // ════ the stuck chain (owner spec 2026-09-17) ════════════════════════════
  //
  // Three reads and one rule. The rule itself is in lib/projects/stuck.ts; what
  // happens here is gathering the facts it cannot derive — which documents are
  // open, which productions have a queue row, which clients bill on a rhythm,
  // and the ONE thing that must not be computed in TypeScript at all: the due
  // date.

  // Which productions hold a live accrual/queue row. "לא נכנסה לתור הצבירה" is
  // a different failure from "waiting its turn", and this is what separates
  // them — the owner's rule ג.
  const { data: queueRows } = prodIds.length
    ? await admin
        .from("pending_documents")
        .select("production_id,status")
        .in("production_id", prodIds)
        .in("status", ["accrued", "pending"])
    : { data: [] as { production_id: string | null; status: string }[] };
  const inQueueProd = new Set(
    ((queueRows ?? []) as { production_id: string | null }[]).map((r) => r.production_id).filter(Boolean) as string[]
  );

  // Every job of a production, dismissed ones INCLUDED — the opposite of the
  // `jobs` list above, and deliberately so. A production whose only jobs were
  // dismissed is out of the rule (0041: a dismissed job is out of every money
  // surface), and to know that we have to be able to see them.
  const allJobsByProduction = new Map<string, { dismissed: boolean }[]>();
  for (const l of (linksRes.data ?? []) as { job_id: string; production_id: string }[]) {
    const j = allJobsById.get(l.job_id);
    if (!j) continue;
    allJobsByProduction.set(l.production_id, [
      ...(allJobsByProduction.get(l.production_id) ?? []),
      { dismissed: !!j.dismissed },
    ]);
  }

  const todayIL = todayInIsrael();
  const clientOf = (id: string | null) => (id ? clientById.get(id) ?? null : null);

  // ═══ THE PRICE A JOB ALREADY FROZE, PER PRODUCTION ═══
  //
  // 🔴 ADDED 2026-10-06, AND WITHOUT IT THE FIX IS HALF A FIX.
  //
  // The EY episode this change was filed for cannot get its price from its show:
  // moving a show to contract mode CLEARS default_rate (ShowsClient.tsx:705), so
  // the only surviving record of the ₪ that was genuinely charged is
  // jobs.amount on work order 10302 — the number migration 0033 wrote there at
  // client approval and the number that went onto deal invoice 40306.
  // Classifying the row correctly as `priced` while printing "חסר תעריף" beside
  // it would just move the false statement one column to the left.
  //
  // `jobs` and not `allJobRows`: dismissed jobs are out of every money surface
  // (0041), so a dismissed duplicate must not price an episode.
  //
  // THE FULL job_productions TABLE, not `jobLinks` — the bundle test in
  // soleJobAmounts is only sound over every link a job has, including links to
  // productions below the July floor. Same reason `allLinks` exists above.
  const frozenJobAmount = soleJobAmounts(
    allLinks,
    new Map(jobs.map((j) => [j.id, j.amount]))
  );

  // ---- the due dates, from the DATABASE ------------------------------------
  //
  // ⚠️ THE ONE RULE OF THIS BLOCK: no due date is calculated here. Migration
  // 0089 exists so public.due_date_for(base, terms) is the single source
  // (decision יב), and this asks it.
  //
  // One call per DISTINCT (document date, terms) pair, not per document: the
  // candidates are open 300/305 rows belonging to episodes on screen — 27 open
  // billing documents exist in the whole account today — and they collapse to a
  // handful of pairs. Clients with unconfigured terms are skipped entirely;
  // NO_TERMS_DAYS answers for them and there is nothing to ask.
  const duePairs = new Map<string, { base: string; terms: string }>();
  for (const p of inRange) {
    const terms = (clientOf(p.client_id)?.payment_terms as StuckPaymentTerms) ?? null;
    if (termsUnconfigured(terms)) continue;
    for (const r of resolved.get(p.id) ?? []) {
      if (r.type !== 300 && r.type !== 305) continue;
      if (r.cancelled || !r.date) continue;
      if (docsById.get(r.id)?.status !== 0) continue;
      duePairs.set(`${r.date}|${terms}`, { base: r.date, terms: terms as string });
    }
  }
  const dueByPair = new Map<string, string | null>();
  await Promise.all(
    Array.from(duePairs.entries()).map(async ([key, { base, terms }]) => {
      const { data } = await admin.rpc("due_date_for", { base, terms });
      dueByPair.set(key, (data as string | null) ?? null);
    })
  );

  /** The stuck verdict for one production, and why its cells may be blank. */
  function judge(p: ProdRow, billing: BillingClass, hasDocs: boolean) {
    const client = clientOf(p.client_id);
    const terms = (client?.payment_terms as StuckPaymentTerms) ?? null;
    const cadence = (client?.billing_cadence as StuckCadence) ?? null;
    const everyN = (client?.billing_every_n as number | null) ?? null;

    // How many of this client's episodes have accrued since the last billing
    // document. ONE definition, two readers — the "מצטבר · X מתוך N" label and
    // the every_n rule read the same number, so the label can never say the
    // bundle is half full beside a row claiming it overflowed. The rule itself
    // is `accruedSince` in lib/projects/stuck.ts, where a test can reach it.
    const lastBilled = lastBillingDocByClient.get(p.client_id ?? "") ?? "";
    const { count: accruedCount, bundleCompletedOn } = accruedSince({
      clientId: p.client_id,
      lastBilled,
      everyN,
      episodes: inRange.map((x) => ({
        client_id: x.client_id,
        record_date: x.record_date,
        cancelled: !!x.cancelled_at,
        hasDocs: (resolved.get(x.id) ?? []).length > 0,
      })),
    });

    const jobsOfProd = allJobsByProduction.get(p.id) ?? [];
    const stuck = stuckFor({
      billing,
      internal: p.kind === "internal",
      cancelled: !!p.cancelled_at,
      allJobsDismissed: jobsOfProd.length > 0 && jobsOfProd.every((j) => j.dismissed),
      recordDate: p.record_date,
      cadence,
      everyN,
      accruedCount,
      bundleCompletedOn,
      terms,
      inQueue: inQueueProd.has(p.id),
      productionId: p.id,
      today: todayIL,
      docs: (resolved.get(p.id) ?? []).map((r) => ({
        id: r.id,
        type: r.type,
        number: r.number,
        date: r.date,
        status: docsById.get(r.id)?.status ?? null,
        cancelled: r.cancelled,
        dbDueDate: r.date && terms ? dueByPair.get(`${r.date}|${terms}`) ?? null : null,
      })),
    });
    const emptyReason = emptyReasonFor({
      billing,
      internal: p.kind === "internal",
      cadence,
      everyN,
      accruedCount,
      recordMonth: (p.record_date ?? "").slice(0, 7) || null,
      currentMonth: todayIL.slice(0, 7),
      hasDocs,
    });
    return { stuck, empty_reason: emptyReason };
  }

  // ---- rows ---------------------------------------------------------------
  const rows: (ProjectRow & { month: string })[] = inRange.map((p) => {
    const show = showById.get(p.show_id ?? "");
    const base = effectiveBase(p, show ? { default_rate: show.default_rate as number | null } : null);
    const showPrice = productionTotal(base, approvedAddonTotal(addonsByProduction.get(p.id) ?? []));
    // hoisted out of the literal below: `judge` needs the same verdict the row
    // shows, and classifying twice is how the cell and the rule drift apart.
    //
    // The class and the price come back TOGETHER because they are one decision
    // (lib/projects/classify.ts): "priced" is only true if a price was found,
    // and which price counts depends on the class. `price` below is the
    // function's answer, never the show's rate re-read on the side.
    const { billing, price } = classifyProduction({
      production: p,
      show: show as { billing_mode?: string | null; active?: boolean | null } | undefined,
      showPrice,
      jobAmount: frozenJobAmount.get(p.id) ?? null,
    });
    return {
      month: israelMonthKey(p.record_date, p.created_at),
      billing,
      contract_name: contractNameFor(p, show as { client_id?: string | null } | undefined, contracts),
      id: p.id,
      record_date: p.record_date,
      podcast_name: p.podcast_name,
      show_name: (show?.name as string | undefined) ?? null,
      client_name: p.client_id ? clientName.get(p.client_id) ?? null : null,
      guest: p.guest,
      status: p.status,
      episode_no: p.episode_no,
      internal: p.kind === "internal",
      cancelled: !!p.cancelled_at,
      price,
      docs: (resolved.get(p.id) ?? []).map((d) => ({
        type: d.type,
        number: d.number,
        date: d.date,
        shared: d.shared,
        cancelled: d.cancelled,
        path: d.path,
        // the same lookup stuckFor already does on the same ids (:855)
        status: docsById.get(d.id)?.status ?? null,
      })),
      ...judge(p, billing, (resolved.get(p.id) ?? []).length > 0),
    };
  });

  // ---- milestone rows -------------------------------------------------------
  //
  // THE ANCHOR DOCUMENT decides both the month and the amount, and choosing it
  // is the whole of this block.
  //
  //   paid      → the 320/400. That document IS the proof of payment, and its
  //               date is the month the money landed in.
  //   invoiced  → the 300/305. A bill went out; nothing has come in.
  //   otherwise → NO ROW. An open milestone has no document, therefore no date,
  //               therefore no month it could honestly belong to. This screen is
  //               a record of what happened.
  //
  // The amount is the DOCUMENT's, not the milestone's: ₪5,900 and not ₪5,000.
  // The month cards count gross, and a row that attributes a number must show
  // the number it is attributing. The milestone's own net figure lives on
  // /contracts, which is where the contract is read.
  //
  // document_date and not issued_at, matching the cards exactly (docsIn above).
  // The two genuinely differ: three documents in the account carry
  // document_date 31.8 and were issued 2-7.9, #60191 among them — ₪295,000 that
  // moves between two months depending on the field. document_date is what the
  // bookkeeper put on the page, and it is also the only one available:
  // invoices.issued_at exists for 0 of 64 receipts, because a 400 writes no
  // invoices row at all (registryType returns null for it).
  const PAYMENT_TYPES = [320, 400];
  const BILLING_TYPES = [300, 305];
  const msContractById = new Map(contracts.map((c) => [c.id, c]));
  const milestoneRows: (MilestoneRow & { month: string })[] = [];
  for (const m of msRows) {
    const job = m.job_id ? allJobsById.get(m.job_id) ?? null : null;
    // a dismissed job is out of every money surface (0041); its milestone has
    // nothing left to attribute
    if (job?.dismissed) continue;
    const state = deriveMilestoneState({
      status: m.status,
      expected_date: m.expected_date,
      is_estimated: m.is_estimated,
      jobPaid: job?.paid ?? null,
      jobBilled: present(job?.invoice_biz) || present(job?.invoice_tax),
    });
    if (state !== "paid" && state !== "invoiced") continue;

    // Tie-break on an EQUAL date: a document the month cards actually count
    // (300 in `billed`, 320/400 in `incoming`) sorts AFTER a 305, so `.pop()`
    // below picks it. A 300 and the 305 raised on it routinely share a date —
    // בר ביצוע's 40326 and 50070 are both 2026-09-10 — and without this the
    // winner was whichever PostgREST happened to return last, so `counted_in`
    // flipped between "בתוך חויב" and no badge at all between renders.
    const counted = (t: number) => (t === 305 ? 0 : 1);
    const docs = (m.job_id ? msDocsForJob.get(m.job_id) ?? [] : []).slice().sort(
      (a, b) =>
        (a.document_date ?? "").localeCompare(b.document_date ?? "") || counted(a.type) - counted(b.type)
    );
    const wanted = state === "paid" ? PAYMENT_TYPES : BILLING_TYPES;
    // newest of the wanted kind — a milestone re-billed after a credit note
    // should be attributed to the document that actually stands
    const anchor = docs.filter((d) => wanted.includes(d.type)).pop() ?? null;
    if (!anchor?.document_date) continue;
    const month = anchor.document_date.slice(0, 7);
    if (month < RANGE_START_MONTH) continue;

    const contract = msContractById.get(m.contract_id) ?? null;
    milestoneRows.push({
      month,
      id: m.id,
      name: m.name,
      contract_name: contract?.name ?? null,
      client_name: contract?.client_id ? clientName.get(contract.client_id) ?? null : null,
      state,
      amount: anchor.amount ?? null,
      anchor_date: anchor.document_date,
      // WHICH card already holds this money. 305 is the honest null: docsIn
      // counts [300] and [320,400], so a tax invoice sits in neither and a row
      // claiming otherwise would be inventing a total.
      counted_in: PAYMENT_TYPES.includes(anchor.type)
        ? "incoming"
        : anchor.type === 300
          ? "billed"
          : null,
      docs: docs.map((d) => ({
        type: d.type,
        number: d.morning_doc_number,
        date: d.document_date,
        shared: false,
        cancelled: !!d.cancelled_at,
        path: "job",
        status: d.status ?? null,
      })),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // THE UNIFIED ROWS — every piece of work, one row each (owner 5.10)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ THE TWO ARRAYS BELOW ARE NOT A DUPLICATION, THEY ARE THE SUMMARY'S
  // FIREWALL.
  //
  // `rows` (ProjectRow[]) stays exactly as it was and keeps feeding `summary`.
  // The unified rows are a SECOND view, derived from the first — the production
  // entries are built from the already-classified ProjectRow, never from the raw
  // production again, so price and BillingClass are computed once and read
  // twice (the drift the note at the `rows` literal above warns about:
  // "classifying twice is how the cell and the rule drift apart").
  //
  // Keeping the summary on its own array is what preserves the decision
  // standing at the bucket below: "MILESTONES LIVE IN THEIR OWN ARRAY, AND THAT
  // IS THE EXCLUSION … no filter CAN forget it". If every source were poured
  // into one array with a discriminator, each of the eight summary counters
  // would need a `source === "production"` guard added by hand, and the ninth
  // counter somebody writes next year would silently count a radio job as an
  // episode. Owner 5.10 is explicit that the cards' arithmetic does not change;
  // this is the shape that guarantees it rather than promising it.
  const docsOf = (key: string): ProjectDoc[] =>
    (resolved.get(key) ?? []).map((d) => ({
      type: d.type,
      number: d.number,
      date: d.date,
      shared: d.shared,
      cancelled: d.cancelled,
      path: d.path,
      status: docsById.get(d.id)?.status ?? null,
    }));

  // The job facts behind one production — every job linked to it, dismissed ones
  // already gone (`jobs` is filtered at :432). More than one is possible, and
  // billStatusFor shows the least finished of them.
  const jobFactsByProduction = new Map<
    string,
    { id: string; paid: string | null; invoice_biz: string | null; invoice_tax: string | null }[]
  >();
  const jobRowById = new Map(jobs.map((j) => [j.id, j]));
  for (const l of jobLinks) {
    const j = jobRowById.get(l.job_id);
    if (!j) continue;
    const facts = { id: j.id, paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax };
    jobFactsByProduction.set(l.production_id, [
      ...(jobFactsByProduction.get(l.production_id) ?? []),
      facts,
    ]);
  }

  // The client's rhythm, per production — read through the SAME `clientOf`
  // that `judge` uses (:812), so the cadence E10's empty-cell decision sees is
  // the cadence the stuck rule and the "מצטבר" label see. A second lookup here
  // would be a second opinion about one client's billing.
  const cadenceByProduction = new Map<string, StuckCadence>(
    inRange.map((p) => [p.id, (clientOf(p.client_id)?.billing_cadence as StuckCadence) ?? null])
  );

  const productionInputs: ProductionInput[] = rows.map((r) => ({
    month: r.month,
    id: r.id,
    cadence: cadenceByProduction.get(r.id) ?? null,
    record_date: r.record_date,
    podcast_name: r.podcast_name,
    show_name: r.show_name,
    client_name: r.client_name,
    guest: r.guest,
    status: r.status,
    episode_no: r.episode_no,
    internal: r.internal,
    cancelled: r.cancelled,
    price: r.price,
    // read off the already-classified row, never re-derived — classify() runs
    // exactly once per production, at the `rows` literal above
    billing: r.billing,
    contract_name: r.contract_name,
    empty_reason_text: r.empty_reason?.text ?? null,
    docs: r.docs,
    jobs: jobFactsByProduction.get(r.id) ?? [],
    stuckSentences: (r.stuck ?? []).map((s) => s.sentence),
  }));

  // The milestone's own state vocabulary comes from MILESTONE_META here rather
  // than in the client, so the pure builder carries a label and a colour and
  // never has to know what a MilestoneState is. Unknown state → render itself,
  // the same fallback MilestoneTableRow already applies.
  const msMeta = (state: string) =>
    MILESTONE_META[state as keyof typeof MILESTONE_META] ?? {
      label: state ?? "—",
      color: "var(--dim)",
      dot: "var(--dim)",
    };
  const msFactsOf = (jobId: string | null | undefined) => {
    const j = jobId ? allJobsById.get(jobId) ?? null : null;
    return j ? { paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax } : null;
  };

  const anchoredInputs: MilestoneInput[] = milestoneRows.map((m) => {
    const msRow = msRows.find((x) => x.id === m.id) ?? null;
    const meta = msMeta(m.state);
    return {
      month: m.month,
      id: m.id,
      name: m.name,
      contract_id: msRow?.contract_id ?? "",
      contract_name: m.contract_name,
      client_name: m.client_name,
      stateLabel: meta.label,
      stateColor: meta.color,
      amount: m.amount,
      date: m.anchor_date,
      dateMeaning: "document" as const,
      job_id: msRow?.job_id ?? null,
      jobFacts: msFactsOf(msRow?.job_id),
      docs: m.docs,
    };
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 THE MILESTONE THAT HAS A JOB AND NO DOCUMENT (owner decision 5.10)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // The block above emits a row only for a milestone whose state is paid or
  // invoiced AND which has an anchor document — "an open milestone has no
  // document, therefore no date, therefore no month it could honestly belong
  // to", as the note above it has said since 15.9. That reasoning is still right
  // about a milestone with NOTHING behind it.
  //
  // It was wrong about a milestone with a JOB. Such a milestone was enqueued:
  // `contract_milestones.job_id` is set, a billing row exists, and the owner's
  // deduplication rule puts that job id into `excluded` whether or not a row was
  // drawn for it. So the job reached no row at all and came back in
  // `unrepresented` — a live billing row, invisible on the screen whose job is to
  // show every piece of work. 823b9c3 reported that consequence rather than
  // hiding it; this is the owner's answer to it: the milestone gets a row.
  //
  // WHAT THE ROW SAYS, and what it is careful NOT to say:
  //   date     `expected_date`, falling back to the job's date. Both are PLANS,
  //            not records, and `dateMeaning: "milestone_expected"` labels the
  //            cell "תאריך אבן הדרך (אין עדיין מסמך)" so nobody reads it as a
  //            document date. This is the one date on the screen that describes
  //            something that has not happened.
  //   amount   the MILESTONE's own figure — ₪5,000, the net. The anchored rows
  //            show the DOCUMENT's gross because they attribute a number already
  //            inside the month cards; this row attributes nothing (there is no
  //            document to be inside a card), so the milestone's own amount is
  //            the only honest figure and there is nothing to double-count.
  //   bill     `deriveState` of the JOB. It has a job, so it is never
  //            "טרם חויבה" — that label is for work with no billing object at
  //            all, and this work has one.
  //   docs     empty. There are none, and an empty document cell is the correct
  //            output for a document nobody has issued.
  //
  // A milestone with a job and NEITHER date still gets no row — it cannot answer
  // "when", the same bar every other source on this screen has to clear — and it
  // stays in `unrepresented`. Zero such rows exist in the live data (all five
  // milestone jobs carry an expected_date or a job date), so this branch is
  // written for the day one appears.
  const anchoredIds = new Set(milestoneRows.map((m) => m.id));
  const unanchoredInputs: MilestoneInput[] = [];
  for (const m of msRows) {
    if (anchoredIds.has(m.id)) continue;
    if (!m.job_id) continue; // no job, no billing row — the 15.9 reasoning stands
    const job = allJobsById.get(m.job_id) ?? null;
    // 0041: a dismissed job is out of every money surface, and its milestone has
    // nothing left to attribute. Same guard the anchored loop applies.
    if (!job || job.dismissed) continue;
    const date = m.expected_date ?? job.date ?? null;
    if (!date) continue; // cannot say when — stays in `unrepresented`
    const month = date.slice(0, 7);
    if (month < RANGE_START_MONTH) continue;
    const contract = msContractById.get(m.contract_id) ?? null;
    const state = deriveMilestoneState({
      status: m.status,
      expected_date: m.expected_date,
      is_estimated: m.is_estimated,
      jobPaid: job.paid ?? null,
      jobBilled: present(job.invoice_biz) || present(job.invoice_tax),
    });
    const meta = msMeta(state);
    unanchoredInputs.push({
      month,
      id: m.id,
      name: m.name,
      contract_id: m.contract_id,
      contract_name: contract?.name ?? null,
      client_name: contract?.client_id ? clientName.get(contract.client_id) ?? null : null,
      stateLabel: meta.label,
      stateColor: meta.color,
      amount: m.amount ?? null,
      date,
      dateMeaning: "milestone_expected" as const,
      job_id: m.job_id,
      jobFacts: msFactsOf(m.job_id),
      docs: [],
    });
  }

  const milestoneInputs: MilestoneInput[] = [...anchoredInputs, ...unanchoredInputs];

  const miscInputs: MiscInput[] = miscRows.map((w) => {
    const j = w.job_id ? jobRowById.get(w.job_id) ?? null : null;
    return {
      id: w.id,
      name: w.name,
      client_name: clientName.get(w.client_id) ?? null,
      work_date: w.work_date,
      amount: w.amount,
      description: w.description,
      status: w.status,
      job_id: w.job_id,
      jobFacts: j ? { paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax } : null,
      docs: docsOf(w.id),
    };
  });

  // EVERY job goes in, dismissed included. The builder needs to see a dismissed
  // job to know it is withdrawn rather than missing — filtering here would make
  // it indistinguishable from a job that fell through a gap, which is precisely
  // what `unrepresented` exists to tell apart.
  const jobInputs: JobInput[] = allJobRows.map((j) => ({
    id: j.id,
    client_name: j.client_id ? clientName.get(j.client_id) ?? null : null,
    campaign: j.campaign,
    date: j.date,
    amount: j.amount,
    paid: j.paid,
    invoice_biz: j.invoice_biz,
    invoice_tax: j.invoice_tax,
    dismissed: j.dismissed,
    external_id: j.external_id,
    legacy: j.legacy,
    docs: docsOf(j.id),
  }));

  const unified = buildUnifiedRows({
    rangeStartMonth: RANGE_START_MONTH,
    productions: productionInputs,
    milestones: milestoneInputs,
    misc: miscInputs,
    jobs: jobInputs,
    linkedJobIds: allLinks.map((l) => l.job_id),
  });

  // ---- month buckets ------------------------------------------------------
  const monthDocs = ((monthDocsRes.data ?? []) as unknown as MonthDoc[]).filter(
    (d) => !d.archived_at && !d.cancelled_at
  );

  const currentMonth = todayInIsrael().slice(0, 7);
  // The unified rows join the picker. A month that holds nothing but a radio job
  // or a bundle order is a month with work in it, and before 5.10 it would not
  // have appeared at all — the picker was built from productions and milestones
  // only, so the screen could not be navigated to work it did not know about.
  const monthKeys = Array.from(
    new Set(
      [
        ...rows.map((r) => r.month),
        ...milestoneRows.map((r) => r.month),
        ...unified.rows.map((r) => r.month),
        currentMonth,
      ].filter((m) => m >= RANGE_START_MONTH)
    )
  ).sort();

  const unifiedByMonth = new Map<string, UnifiedRow[]>();
  for (const r of unified.rows) {
    unifiedByMonth.set(r.month, [...(unifiedByMonth.get(r.month) ?? []), r]);
  }

  const buckets: MonthBucket[] = monthKeys.map((key) => {
    const all = rows
      .filter((r) => r.month === key)
      .sort((a, b) => (a.record_date ?? "").localeCompare(b.record_date ?? ""));

    // ═══ MILESTONES LIVE IN THEIR OWN ARRAY, AND THAT IS THE EXCLUSION ═══
    //
    // Everything the summary counts is derived from `all` — `billable` drops
    // internal and cancelled, `perEpisode` is the per-episode denominator,
    // `expectedTotalRows` is all.length. A milestone put into `all` with a
    // discriminator would have to be excluded from each of those by hand, and
    // from the next one somebody adds. Keeping it out of the array entirely
    // means no filter CAN forget it: the summary cannot see these rows at all.
    //
    // They also sort by their own key. A production is placed by record_date —
    // "what did we record" — and a milestone has no recording; it is placed by
    // the date of the document that anchors it. One mixed sort over two
    // different meanings of "date" would order neither correctly.
    const msForMonth = milestoneRows
      .filter((r) => r.month === key)
      .sort((a, b) => (a.anchor_date ?? "").localeCompare(b.anchor_date ?? ""));

    // "Expected" counts only work that is actually billable: internal shows are
    // the studio's own podcasts and bill nobody, and a cancelled episode is
    // revenue that is not coming. Both stay visible as rows; neither is money.
    const billable = all.filter((r) => !r.internal && !r.cancelled);
    const of = (c: BillingClass) => billable.filter((r) => r.billing === c);
    const showsOf = (c: BillingClass) =>
      Array.from(new Set(of(c).map((r) => r.show_name ?? r.podcast_name))).sort();

    const priced = of("priced");
    // The per-episode denominator. Contract-billed and billing-silenced
    // episodes are NOT in it — they were never going to carry a per-episode
    // price, so counting them as a shortfall would describe a system that is
    // working correctly as one that is broken.
    const perEpisode = priced.length + of("missing_rate").length + of("inactive").length;
    const docsIn = (types: number[]) => monthDocs.filter((d) => types.includes(d.type) && (d.document_date ?? "").slice(0, 7) === key);
    const sum = (ds: { amount: number | null }[]) => ds.reduce((t, d) => t + Number(d.amount ?? 0), 0);
    const billedDocs = docsIn([300]);
    const inDocs = docsIn([320, 400]);

    return {
      key,
      label: monthLabel(key),
      rows: all,
      milestones: msForMonth,
      // The table's data since 5.10. `rows` and `milestones` stay on the payload
      // because the SUMMARY is derived from them and because a browser holding
      // the previous JS chunk still reads them — the version-skew class
      // safeBucket exists for (ProjectsClient.tsx:313-330). Sorted here, with
      // the one total order compareUnified defines, so the server and any
      // re-render agree on row order.
      work: (unifiedByMonth.get(key) ?? []).slice().sort(compareUnified),
      summary: {
        expected: priced.reduce((t, r) => t + (r.price ?? 0), 0),
        expectedPriced: priced.length,
        expectedPerEpisode: perEpisode,
        expectedTotalRows: all.length,
        // the real defect — an active per-episode show with no rate
        missingRateCount: of("missing_rate").length,
        missingRateShows: showsOf("missing_rate"),
        // declared, not counted as a shortfall
        contractCount: of("contract").length,
        // show + which contract it sits under, deduped. NO amount: the money
        // lives on the contract as a whole (icr spotlight 8,000, מכירת ביפו
        // 400,000) and dividing it by episodes to show a per-episode figure
        // would invent a number nobody agreed to.
        contractItems: Array.from(
          new Map(
            of("contract").map((r) => [
              `${r.show_name ?? r.podcast_name}|${r.contract_name ?? ""}`,
              { show: r.show_name ?? r.podcast_name, contract: r.contract_name },
            ])
          ).values()
        ).sort((a, b) => a.show.localeCompare(b.show)),
        inactiveCount: of("inactive").length,
        inactiveShows: showsOf("inactive"),
        noBillingCount: of("no_billing").length,
        billed: sum(billedDocs),
        billedCount: billedDocs.length,
        incoming: sum(inDocs),
        incomingCount: inDocs.length,
      },
    };
  });

  const initialMonth = monthKeys.includes(currentMonth) ? currentMonth : monthKeys[monthKeys.length - 1];

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <ProjectsClient
        buckets={buckets}
        initialMonth={initialMonth ?? RANGE_START_MONTH}
        userId={user.id}
        today={todayIL}
      />
    </div>
  );
}
