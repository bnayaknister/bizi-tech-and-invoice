/**
 * Which Morning documents came out of a given production.
 *
 * There is no single column that answers this, and that is not an oversight —
 * it is the shape of the system. A document reaches a production by one of five
 * routes, each created by a different path through the app, and the only honest
 * answer is their union:
 *
 *   1. production  documents.production_id — set by issue.ts when WE issued the
 *                  document against one episode. The strongest link there is.
 *   2. job         documents.job_id — the document is anchored to a job, and
 *                  job_productions ties that job to the episode.
 *   3. bundle      documents.bundle_job_ids @> [job] — ONE document covering
 *                  N episodes (0044). Load-bearing, see the note below.
 *   4. number      jobs.invoice_biz / invoice_tax carry a document NUMBER as
 *                  text; documents.morning_doc_number is that number. Redundant
 *                  with 2 and 3 by design — it survives a document whose job_id
 *                  was never stamped, and it is how a bundle's members are
 *                  reachable even if bundle_job_ids is missing.
 *   5. receipt     a RECEIPT (400) points at no job of its own — by design, see
 *                  issue.ts:510-522. It is reached backwards, through the tax
 *                  invoices it was raised on:
 *                      400 → linkedDocumentIds → parent 305 → its jobs → episode
 *                  This is exactly the walk the 400→paid automation performs
 *                  (jobsBehindReceipt, issue.ts:129), reused here rather than
 *                  reinvented.
 *
 * PRECEDENCE, when a document arrives by more than one route: production > job
 * > bundle > number > receipt — strongest evidence first, longest inference
 * last. The winning route is kept on the row (`path`) because "why does this
 * number appear here" is precisely the question someone will ask the first time
 * one looks wrong, and a resolver that cannot answer it is a resolver nobody
 * can debug.
 *
 * ═══ WHY ROUTE 3 IS THE IMPORTANT ONE, DESPITE MATCHING NOTHING TODAY ═══
 * Measured on live data 2026-08-27: in the visible range (July 2026 onward),
 * every single link comes from route 1 or route 2. Routes 3 and 4 match zero
 * rows. It would be easy to read that as dead code — it is the opposite.
 * A redeemed bundle has NOT HAPPENED YET. When it does, issue.ts:302 computes
 *     primaryJobId = bundleJobs.length === 1 ? bundleJobs[0] : null
 * so a 5-episode bundle is written with job_id NULL and production_id NULL
 * (bundle.ts:176/468/549 build the consolidated row with production_id: null).
 * Route 1 is null, route 2 is null, and route 3 is the ONLY thing that will
 * connect that invoice to its five episodes. Route 4 backs it up via the shared
 * invoice_biz that issue.ts stamps on all five jobs.
 * Both routes are exercised by scripts/simulate_bundle.ts against the exact
 * row shape those two files write, because live data cannot exercise them yet.
 *
 * ═══ WHAT THIS DELIBERATELY DOES NOT DO ═══
 * It does not guess. 60 of the 61 pulled receipts name a document number in
 * their free text, 44 of those resolve to a same-client parent — a strong
 * signal, and useless here: those parents carry no job link (26 of 563 do), so
 * the text route reaches ZERO productions. It would add inference risk to a
 * money screen and change nothing on it. An empty cell is the correct output
 * for a document nobody linked.
 */

export type DocPath = "production" | "job" | "bundle" | "number" | "receipt";

/** Column order on the screen, and the sort order within one production. */
export const DOC_TYPES = [100, 300, 305, 320, 400] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABEL: Record<number, string> = {
  100: "הזמנת עבודה",
  300: "חשבון עסקה",
  305: "חשבונית מס",
  320: "מס-קבלה",
  400: "קבלה",
};

export type DocumentRow = {
  id: string;
  morning_doc_id: string;
  morning_doc_number: string | null;
  type: number;
  amount: number | null;
  document_date: string | null;
  pdf_url: string | null;
  production_id: string | null;
  job_id: string | null;
  bundle_job_ids: string[] | null;
  cancelled_at: string | null;
  archived_at: string | null;
};

export type JobRow = { id: string; invoice_biz: string | null; invoice_tax: string | null };
export type JobLink = { job_id: string; production_id: string };

/**
 * A receipt and the Morning ids of the documents it was raised on, read from
 * pending_documents.payload.linkedDocumentIds — the only place that link is
 * recorded. A receipt that came in from the daily pull has no such row and
 * therefore no parents; Morning's document-search response carries no
 * linkedDocumentIds field at all.
 */
export type ReceiptLink = { morning_doc_id: string; linked_document_ids: string[] };

export type ResolvedDocument = {
  id: string;
  type: number;
  number: string | null;
  date: string | null;
  amount: number | null;
  pdf_url: string | null;
  /** Cancelled in Morning. Shown struck through — a cancelled document is
   *  information, not absence, and there are two of them in the whole table. */
  cancelled: boolean;
  path: DocPath;
  /** This same document also resolved to another production in the set — a
   *  bundle. Tagged on every row it appears on, counted ONCE in any total. */
  shared: boolean;
};

const TYPE_RANK = new Map<number, number>(DOC_TYPES.map((t, i) => [t, i]));

export function resolveProductionDocuments(input: {
  productionIds: string[];
  jobLinks: JobLink[];
  jobs: JobRow[];
  documents: DocumentRow[];
  receiptLinks?: ReceiptLink[];
}): Map<string, ResolvedDocument[]> {
  // Archived documents are gone from every surface (0045); they must not
  // reappear here. Filtered defensively even though the queries exclude them —
  // this function is also called by the simulation with hand-built rows.
  const live = input.documents.filter((d) => !d.archived_at);

  const byMorningId = new Map<string, DocumentRow>();
  for (const d of live) byMorningId.set(d.morning_doc_id, d);

  // ---- the five indexes, each built once ---------------------------------
  const byProduction = new Map<string, DocumentRow[]>();
  const byJob = new Map<string, DocumentRow[]>();
  const byBundleJob = new Map<string, DocumentRow[]>();
  const byNumber = new Map<string, DocumentRow[]>();
  const byReceiptJob = new Map<string, DocumentRow[]>();

  const push = <T,>(m: Map<string, T[]>, k: string, v: T) => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };

  const byId = new Map(live.map((d) => [d.id, d]));

  for (const d of live) {
    if (d.production_id) push(byProduction, d.production_id, d);
    if (d.job_id) push(byJob, d.job_id, d);
    for (const j of d.bundle_job_ids ?? []) if (j) push(byBundleJob, j, d);
    if (d.morning_doc_number) push(byNumber, String(d.morning_doc_number), d);
  }

  // route 5: walk each receipt back through its parents to the parents' jobs.
  for (const link of input.receiptLinks ?? []) {
    const receipt = byMorningId.get(link.morning_doc_id);
    if (!receipt) continue;
    for (const parentId of link.linked_document_ids ?? []) {
      const parent = byMorningId.get(parentId);
      if (!parent) continue;
      const parentJobs = [parent.job_id, ...(parent.bundle_job_ids ?? [])].filter(
        (j): j is string => !!j
      );
      for (const j of parentJobs) push(byReceiptJob, j, receipt);
    }
  }

  const jobsByProduction = new Map<string, string[]>();
  for (const l of input.jobLinks) {
    if (!l.job_id || !l.production_id) continue;
    push(jobsByProduction, l.production_id, l.job_id);
  }

  const jobById = new Map(input.jobs.map((j) => [j.id, j]));

  // ---- resolve, in precedence order --------------------------------------
  const out = new Map<string, ResolvedDocument[]>();
  const holdersPerDoc = new Map<string, number>();

  for (const productionId of input.productionIds) {
    const claimed = new Map<string, DocPath>();
    const claim = (docs: DocumentRow[] | undefined, path: DocPath) => {
      for (const d of docs ?? []) if (!claimed.has(d.id)) claimed.set(d.id, path);
    };

    claim(byProduction.get(productionId), "production");

    const jobIds = jobsByProduction.get(productionId) ?? [];
    for (const jobId of jobIds) claim(byJob.get(jobId), "job");
    for (const jobId of jobIds) claim(byBundleJob.get(jobId), "bundle");
    for (const jobId of jobIds) {
      const job = jobById.get(jobId);
      if (!job) continue;
      for (const num of [job.invoice_biz, job.invoice_tax]) {
        if (num) claim(byNumber.get(String(num)), "number");
      }
    }
    for (const jobId of jobIds) claim(byReceiptJob.get(jobId), "receipt");

    // .forEach, not for..of: tsconfig sets no `target`, so it defaults to ES5
    // and iterating a Map directly needs downlevelIteration. Same reason the
    // Array.from calls below are not spreads.
    const rows: ResolvedDocument[] = [];
    claimed.forEach((path, docId) => {
      const d = byId.get(docId);
      if (!d) return;
      rows.push({
        id: d.id,
        type: d.type,
        number: d.morning_doc_number,
        date: d.document_date,
        amount: d.amount,
        pdf_url: d.pdf_url,
        cancelled: !!d.cancelled_at,
        path,
        shared: false, // filled in below, once every production has been walked
      });
      holdersPerDoc.set(docId, (holdersPerDoc.get(docId) ?? 0) + 1);
    });

    rows.sort(
      (a, b) =>
        (TYPE_RANK.get(a.type) ?? 99) - (TYPE_RANK.get(b.type) ?? 99) ||
        (a.date ?? "").localeCompare(b.date ?? "") ||
        (a.number ?? "").localeCompare(b.number ?? "")
    );
    if (rows.length) out.set(productionId, rows);
  }

  // A document held by more than one production in this set IS the bundle —
  // this is the only place "bundled" is decided, and it is decided from the
  // resolved result rather than from bundle_job_ids, so a bundle reached by the
  // number route is tagged just the same.
  out.forEach((rows) => {
    for (const r of rows) r.shared = (holdersPerDoc.get(r.id) ?? 0) > 1;
  });

  return out;
}

/**
 * Distinct documents across a resolved map — a bundle counts ONCE however many
 * production rows display it. Any total built by walking the rows instead of
 * this would multiply a bundled invoice by its episode count.
 */
export function distinctDocuments(
  resolved: Map<string, ResolvedDocument[]>
): Map<string, ResolvedDocument> {
  const seen = new Map<string, ResolvedDocument>();
  resolved.forEach((rows) => {
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
  });
  return seen;
}
