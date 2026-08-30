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
import ProjectsClient, { type BillingClass, type MonthBucket, type ProjectRow } from "./ProjectsClient";

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
};

/**
 * WHY a production carries no per-episode price. "Missing a rate" was the only
 * answer this screen could give, and it was wrong in 9 cases out of 9 (measured
 * 2026-08-27) — there are four different reasons and only one of them is a
 * defect somebody should go and fix.
 *
 * Order matters, and billing_mode is checked FIRST — before the price:
 *
 *   contract      the show is billed through contract milestones, not per
 *                 episode (מאצ׳ אפ, אפרת וכטל → the ביפו umbrella contract).
 *                 Checked ahead of the price on purpose: even if somebody typed
 *                 a default_rate on a contract show, that money still arrives
 *                 through contract_milestones.job_id, and adding it to the
 *                 per-episode total would count the same shekel twice. Verified
 *                 there is no double count today — 313 productions sit on
 *                 contract-mode shows and NONE of them has a job.
 *   no_billing    billing_mode='none' — billing deliberately silenced.
 *   priced        has a price. This is the money.
 *   inactive      the show is switched off; it is not owed a rate.
 *   missing_rate  an ACTIVE, per-episode, recorded show with no rate. The real
 *                 defect, and the only case worth calling "חסר תעריף". Zero of
 *                 them exist in range today.
 *
 * `active` is used ONLY here, as a late tiebreak, and never to decide whether
 * money is expected: it is editable with can_edit_stages (shows/update
 * route.ts:48) while billing_mode needs can_edit_money (route.ts:19). A
 * technician must not be able to move a number on a finance screen.
 */
function classify(
  show: { billing_mode?: string | null; active?: boolean | null } | undefined,
  price: number | null
): BillingClass {
  if (show?.billing_mode === "contract") return "contract";
  if (show?.billing_mode === "none") return "no_billing";
  if (price != null) return "priced";
  if (show && show.active === false) return "inactive";
  return "missing_rate";
}

type ContractRow = {
  id: string;
  name: string;
  client_id: string | null;
  show_id: string | null;
  status: string;
};

/**
 * WHICH contract a contract-billed episode belongs to.
 *
 * There is no single reliable pointer, so this walks from strongest evidence to
 * weakest and stops at the first UNAMBIGUOUS answer. Measured 2026-08-27:
 *
 *   1. productions.contract_id — exact, and set on exactly 1 of 765 rows.
 *   2. contracts.show_id — exact, and set on 1 of 3 contracts (icr spotlight).
 *      NULL is the CORRECT state for an umbrella contract like מכירת ביפו that
 *      covers a whole catalogue rather than one show (0056 says so explicitly),
 *      so its absence is not a defect to route around.
 *   3. the client's sole ACTIVE contract — how the 27 ביפו-era shows resolve.
 *      Only when there is exactly one; two would make the answer a guess.
 *
 * Today every one of the 28 contract-mode shows resolves to a name: 1 via
 * show_id, 27 via a sole active client contract. The unnamed branch is
 * unreachable with current data and exists for the day a client signs a second
 * contract — at which point saying "מחויב בחוזה" without naming one is the only
 * honest output, and inventing the wrong contract name on a finance screen is
 * the failure this guards against.
 */
function resolveContractName(
  production: { contract_id?: string | null; show_id: string | null; client_id: string | null },
  show: { client_id?: string | null } | undefined,
  contracts: ContractRow[]
): string | null {
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

const DOC_SELECT =
  "id,morning_doc_id,morning_doc_number,type,amount,document_date,pdf_url,production_id,job_id,bundle_job_ids,cancelled_at,archived_at";

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
  const [productions, showsRes, contractsRes, clientsRes, jobsRes, linksRes, receiptQueueRes] = await Promise.all([
    fetchProductionsInRange(admin),
    // billing_mode and active are both read, and they are NOT interchangeable:
    // billing_mode is a money field (can_edit_money, shows/update/route.ts:19)
    // while active only needs can_edit_stages — a technician can flip it. So
    // billing_mode decides whether money is expected at all, and active is only
    // ever a secondary label. See classify() below.
    admin.from("shows").select("id,name,default_rate,billing_mode,active,client_id"),
    // named so a contract-billed row can say WHICH contract it belongs to
    admin.from("contracts").select("id,name,client_id,show_id,status"),
    admin.from("clients").select("id,name"),
    admin.from("jobs").select("id,invoice_biz,invoice_tax,dismissed"),
    admin.from("job_productions").select("job_id,production_id"),
    // the ONLY record of which tax invoices a receipt was raised on. A pulled
    // receipt has no such row, and Morning's search response carries no
    // linkedDocumentIds field — hence route 5 in forProduction.ts reaching only
    // receipts we issued ourselves.
    admin.from("pending_documents").select("morning_doc_id,payload").eq("doc_type", "receipt"),
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

  // A dismissed job is hidden from every money surface (0041: wrong/duplicate/
  // irrelevant). Its documents must not surface through it either, or a
  // duplicate job would pull a real invoice onto the wrong episode.
  const jobs = (jobsRes.data ?? []).filter((j) => !j.dismissed) as {
    id: string;
    invoice_biz: string | null;
    invoice_tax: string | null;
  }[];
  const jobIdSet = new Set(jobs.map((j) => j.id));
  const jobLinks = (linksRes.data ?? []).filter(
    (l) => jobIdSet.has(l.job_id as string) && prodIds.includes(l.production_id as string)
  ) as { job_id: string; production_id: string }[];

  const relevantJobIds = Array.from(new Set(jobLinks.map((l) => l.job_id)));
  const relevantJobs = jobs.filter((j) => relevantJobIds.includes(j.id));
  const docNumbers = Array.from(
    new Set(relevantJobs.flatMap((j) => [j.invoice_biz, j.invoice_tax]).filter((n): n is string => !!n))
  );

  // ---- wave 2: the id-dependent reads ------------------------------------
  // Five narrow queries rather than one `.or()` string. Each is a plain `.in()`
  // returning well under a page, and the alternative — hand-assembling a
  // PostgREST or-filter out of UUID lists and text numbers — is a quoting bug
  // waiting to happen in the one place where a silent miss means a missing
  // invoice. They run in parallel; the region is co-located (sin1), so the
  // extra round-trips cost about a millisecond each.
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
      fetchAllPages<MonthDoc>((from, to) =>
        admin
          .from("documents")
          .select("id,type,amount,document_date,cancelled_at,archived_at")
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

  const resolved = resolveProductionDocuments({
    productionIds: prodIds,
    jobLinks,
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

  // ---- rows ---------------------------------------------------------------
  const rows: (ProjectRow & { month: string })[] = inRange.map((p) => {
    const show = showById.get(p.show_id ?? "");
    const base = effectiveBase(p, show ? { default_rate: show.default_rate as number | null } : null);
    const price = productionTotal(base, approvedAddonTotal(addonsByProduction.get(p.id) ?? []));
    return {
      month: israelMonthKey(p.record_date, p.created_at),
      billing: classify(
        show as { billing_mode?: string | null; active?: boolean | null } | undefined,
        price
      ),
      contract_name: resolveContractName(p, show as { client_id?: string | null } | undefined, contracts),
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
      })),
    };
  });

  // ---- month buckets ------------------------------------------------------
  const monthDocs = ((monthDocsRes.data ?? []) as unknown as MonthDoc[]).filter(
    (d) => !d.archived_at && !d.cancelled_at
  );

  const currentMonth = todayInIsrael().slice(0, 7);
  const monthKeys = Array.from(
    new Set([...rows.map((r) => r.month), currentMonth].filter((m) => m >= RANGE_START_MONTH))
  ).sort();

  const buckets: MonthBucket[] = monthKeys.map((key) => {
    const all = rows
      .filter((r) => r.month === key)
      .sort((a, b) => (a.record_date ?? "").localeCompare(b.record_date ?? ""));

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
      <ProjectsClient buckets={buckets} initialMonth={initialMonth ?? RANGE_START_MONTH} />
    </div>
  );
}
