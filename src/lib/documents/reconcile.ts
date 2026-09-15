import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveState } from "@/lib/finance/state";
import { PAYMENT_TYPES } from "@/lib/morning/types";

// The reconciliation engine — the systematic bridge between "what happened"
// (documents that exist in Morning) and "what the system knows" (jobs and
// their finance state). Owner spec 2026-07-26.
//
// One matching engine powers everything so they can never drift apart:
//   - the auto-match on pull (link certain matches, close the job) — step A
//   - the "gaps to handle" screen + the in-context "שייך מסמך קיים" pickers
//   - the offline scan/report (scripts/scan_reconciliation_gaps.py mirrors it)
//
// THE MATCHING PHILOSOPHY (owner decision 2026-07-26, learned from בלאנקו):
// this studio records in one month and bills two+ months later, so the
// document DATE is a weak signal here — it must not be a hard filter.
//   - SUGGESTIONS to the bookkeeper: same mapped client + amount (VAT-aware
//     or pre-VAT). NO date cutoff. The date becomes a confidence/sort signal,
//     shown so she knows how far apart they are (בלאנקו: 80 days, yet a
//     perfect client+amount match — a HIGH-confidence suggestion).
//   - AUTO-LINK on pull: stays strict — client + amount + a UNIQUE 1:1
//     pairing + date within ±45. Anything not certain is only ever a
//     suggestion. A non-unique match (a client+amount that fits more than one
//     job, e.g. נטע צמח's three ₪708 receipts) is NEVER auto-linked.

export const TAX_TYPES = [305, 320]; // חשבונית מס / חשבונית מס קבלה
const DEAL_TYPE = 300; // חשבון עסקה
const RECEIPT_TYPE = 400; // קבלה
// proof of PAYMENT (money received): a קבלה, and a מס/קבלה which is a combined
// tax-invoice + receipt. Linking one to an unpaid job flips paid → כן.
// Defined in lib/morning/types.ts as of 0053 and re-exported here so the
// existing importers of this module keep working: what carries a payment block
// is a fact about Morning's documents, and the issuance path needs it without
// pulling in this whole matching engine.
export { PAYMENT_TYPES };
const BILLING_TYPES = [...TAX_TYPES, DEAL_TYPE, RECEIPT_TYPE];

const AMOUNT_TOL = 2; // shekels
const AMOUNT_TOL_PCT = 0.01; // or 1%
const AUTO_DATE_WINDOW = 45; // days — the ONLY place a date cutoff applies (auto-link)
const VAT = 1.18;
const STALE_DAYS = 30; // "not billed" older than this

export type ReconClient = { id: string; name: string | null; morning_client_id: string | null };
export type ReconJob = {
  id: string;
  client_id: string | null;
  amount: number | null;
  invoice_biz: string | null;
  invoice_tax: string | null;
  paid: string | null;
  date: string | null;
  due_date: string | null;
  legacy: boolean | null;
  campaign: string | null;
};
export type ReconDoc = {
  id: string;
  morning_doc_number: string | null;
  type: number;
  client_id: string | null;
  morning_client_id: string | null;
  morning_client_name: string | null;
  amount: number | null;
  document_date: string | null;
  job_id: string | null;
  production_id: string | null;
  source: string;
};

// high  = same mapped client + amount match + a UNIQUE 1:1 pairing (safe basis
//         for auto-link; only the date decides auto-vs-suggest)
// medium= same mapped client + amount match but the pairing is ambiguous
//         (this client+amount fits more than one job or more than one doc)
// low   = amount matches but the document carries no client mapping, so the
//         client is unconfirmed (only offered in the doc→job direction)
export type Confidence = "high" | "medium" | "low";
export type AmountBasis = "vat" | "pre";

const present = (v: string | null): boolean => v != null && String(v).trim() !== "";

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(String(s).slice(0, 10)).getTime();
  return Number.isNaN(t) ? null : t;
}

// which amount basis matches, if any: the document total may be the job's base
// amount (pre-VAT) or that amount grossed up by VAT (a tax-document total)
/**
 * Exported for tests only (2026-08-25) — the discount e2e asserts that a
 * realigned job really is matchable by a payment of the new amount, and
 * copying the tolerance into the test would let the two drift apart exactly
 * where drift is the bug being guarded against. Behaviour unchanged.
 */
export function amountBasis(jobAmount: number | null, docAmount: number | null): AmountBasis | null {
  if (jobAmount == null || docAmount == null) return null;
  const ja = Number(jobAmount);
  const da = Number(docAmount);
  const bases: [AmountBasis, number][] = [
    ["pre", ja],
    ["vat", ja * VAT],
  ];
  for (const [basis, target] of bases) {
    const tol = Math.max(AMOUNT_TOL, target * AMOUNT_TOL_PCT);
    if (Math.abs(da - target) <= tol) return basis;
  }
  return null;
}

function dateGapDays(jobDateMs: number | null, docDateMs: number | null): number | null {
  if (jobDateMs == null || docDateMs == null) return null;
  return Math.round(Math.abs(docDateMs - jobDateMs) / 86_400_000);
}

// A candidate document for a job (job→doc direction).
export type DocCandidate = {
  doc: ReconDoc;
  confidence: Confidence;
  amountBasis: AmountBasis;
  dateGapDays: number | null;
};
// A candidate job for a document (doc→job direction).
export type JobCandidate = {
  job: ReconJob;
  confidence: Confidence;
  amountBasis: AmountBasis;
  dateGapDays: number | null;
};

export type MatchPair = { job: ReconJob; doc: ReconDoc; dateGapDays: number | null };

export type Reconciliation = {
  gap1: { job: ReconJob; candidates: DocCandidate[] }[]; // 🔴 red job → matching tax docs
  gap2: { doc: ReconDoc; candidates: JobCandidate[] }[]; // 🟡 deal invoice → not-billed jobs
  gap3: ReconJob[]; // 🟡 old not-billed jobs with no candidate at all
  unmatchedDocCount: number;
  certain: MatchPair[]; // the unique 1:1 tax matches within ±45 — safe to auto-link
  counts: { redJobs: number; purpleJobs: number; unlinkedTaxDocs: number };
};

// resolve a job/doc to the client keys it can be matched on (our client_id and
// the Morning client id behind it), so a match joins on either
function makeKeyResolvers(clients: ReconClient[]) {
  const clientById = new Map(clients.map((c) => [c.id, c]));
  const jobKeys = (j: ReconJob): string[] => {
    const keys: string[] = [];
    if (j.client_id) {
      keys.push("cid:" + j.client_id);
      const c = clientById.get(j.client_id);
      if (c?.morning_client_id) keys.push("mid:" + c.morning_client_id);
    }
    return keys;
  };
  const docKeys = (d: ReconDoc): string[] => {
    const keys: string[] = [];
    if (d.client_id) keys.push("cid:" + d.client_id);
    if (d.morning_client_id) keys.push("mid:" + d.morning_client_id);
    return keys;
  };
  return { clientById, jobKeys, docKeys };
}

// Which needy state a document type settles for a given job:
//  - a tax invoice (305/320) answers a RED job (paid, missing tax invoice)
//  - a payment doc (320/400) answers any UNPAID job (proves money came in → paid)
//  - a deal invoice (300) answers a not-billed (purple) job
// 320 (מס/קבלה) is BOTH a tax invoice and a receipt, so it can answer either.
function jobNeedsDocType(job: ReconJob, docType: number): boolean {
  const st = stateOf(job);
  if (TAX_TYPES.includes(docType) && st === "red") return true;
  if (PAYMENT_TYPES.includes(docType) && job.paid === "לא") return true;
  if (docType === DEAL_TYPE && st === "purple") return true;
  return false;
}

const stateOf = (j: ReconJob) =>
  deriveState({ paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax });

// The bipartite matching core: every edge between a needy job and an unlinked
// billing document that shares a client key AND an amount basis. NO date
// filter — the date rides along as a gap. Degrees give us 1:1 uniqueness.
type Edge = { jobId: string; docId: string; basis: AmountBasis; gap: number | null };

function buildEdges(clients: ReconClient[], jobs: ReconJob[], docs: ReconDoc[]) {
  const { jobKeys, docKeys } = makeKeyResolvers(clients);

  const unlinkedDocs = docs.filter((d) => BILLING_TYPES.includes(d.type) && !d.job_id);
  const docsByKey = new Map<string, ReconDoc[]>();
  for (const d of unlinkedDocs) {
    for (const k of docKeys(d)) docsByKey.set(k, [...(docsByKey.get(k) ?? []), d]);
  }

  const edges: Edge[] = [];
  const degJob = new Map<string, number>();
  const degDoc = new Map<string, number>();

  for (const j of jobs) {
    const jd = parseDate(j.date) ?? parseDate(j.due_date);
    const seen = new Set<string>();
    for (const k of jobKeys(j)) {
      for (const d of docsByKey.get(k) ?? []) {
        if (seen.has(d.id) || !jobNeedsDocType(j, d.type)) continue;
        const basis = amountBasis(j.amount, d.amount);
        if (!basis) continue;
        seen.add(d.id);
        edges.push({ jobId: j.id, docId: d.id, basis, gap: dateGapDays(jd, parseDate(d.document_date)) });
        degJob.set(j.id, (degJob.get(j.id) ?? 0) + 1);
        degDoc.set(d.id, (degDoc.get(d.id) ?? 0) + 1);
      }
    }
  }

  const confidenceOf = (e: Edge): Confidence =>
    (degJob.get(e.jobId) ?? 0) === 1 && (degDoc.get(e.docId) ?? 0) === 1 ? "high" : "medium";

  return { edges, confidenceOf, unlinkedDocs };
}

// candidates sorted by confidence then closest date (the best on top)
const CONF_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
function byConfidenceThenGap(a: { confidence: Confidence; dateGapDays: number | null }, b: { confidence: Confidence; dateGapDays: number | null }) {
  if (CONF_RANK[a.confidence] !== CONF_RANK[b.confidence]) return CONF_RANK[a.confidence] - CONF_RANK[b.confidence];
  const ga = a.dateGapDays ?? Number.POSITIVE_INFINITY;
  const gb = b.dateGapDays ?? Number.POSITIVE_INFINITY;
  return ga - gb;
}

// The pure core used by the pull, the gaps screen, and the scan.
export function reconcile(clients: ReconClient[], jobs: ReconJob[], docs: ReconDoc[]): Reconciliation {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const { edges, confidenceOf, unlinkedDocs } = buildEdges(clients, jobs, docs);

  const redJobs = jobs.filter((j) => stateOf(j) === "red");
  const purpleJobs = jobs.filter((j) => stateOf(j) === "purple");

  // ---- Gap 1: red job → candidate tax docs (job-centric) ----
  // strictly red-job/tax-doc edges: a 320 (מס/קבלה) can also match an UNPAID
  // job as a payment (that path is the reconcile-payments endpoint, not gap1),
  // so require the job be red here — and keep the auto-link set red-tax only.
  const taxEdges = edges.filter(
    (e) => TAX_TYPES.includes(docById.get(e.docId)!.type) && stateOf(jobById.get(e.jobId)!) === "red"
  );
  const byJob = new Map<string, DocCandidate[]>();
  for (const e of taxEdges) {
    const doc = docById.get(e.docId)!;
    byJob.set(e.jobId, [
      ...(byJob.get(e.jobId) ?? []),
      { doc, confidence: confidenceOf(e), amountBasis: e.basis, dateGapDays: e.gap },
    ]);
  }
  const gap1 = Array.from(byJob.entries())
    .map(([jobId, candidates]) => ({ job: jobById.get(jobId)!, candidates: candidates.sort(byConfidenceThenGap) }))
    .sort((a, b) => CONF_RANK[a.candidates[0].confidence] - CONF_RANK[b.candidates[0].confidence]);

  // ---- auto-link set: unique 1:1 tax match, date known and within ±45 ----
  const certain: MatchPair[] = taxEdges
    .filter((e) => confidenceOf(e) === "high" && e.gap != null && e.gap <= AUTO_DATE_WINDOW)
    .map((e) => ({ job: jobById.get(e.jobId)!, doc: docById.get(e.docId)!, dateGapDays: e.gap }));

  // ---- Gap 2: deal invoice → candidate not-billed jobs (doc-centric) ----
  const dealEdges = edges.filter((e) => docById.get(e.docId)!.type === DEAL_TYPE);
  const byDoc = new Map<string, JobCandidate[]>();
  for (const e of dealEdges) {
    const job = jobById.get(e.jobId)!;
    byDoc.set(e.docId, [
      ...(byDoc.get(e.docId) ?? []),
      { job, confidence: confidenceOf(e), amountBasis: e.basis, dateGapDays: e.gap },
    ]);
  }
  const gap2 = Array.from(byDoc.entries()).map(([docId, candidates]) => ({
    doc: docById.get(docId)!,
    candidates: candidates.sort(byConfidenceThenGap),
  }));

  // ---- Gap 3: old, non-legacy, not-billed jobs with NO candidate deal doc ----
  const jobsWithDealCandidate = new Set(dealEdges.map((e) => e.jobId));
  const now = Date.now();
  const gap3 = purpleJobs.filter((j) => {
    if (j.legacy || jobsWithDealCandidate.has(j.id)) return false;
    const jd = parseDate(j.date);
    return jd != null && now - jd > STALE_DAYS * 86_400_000;
  });

  const unmatchedDocCount = docs.filter((d) => !d.client_id).length;

  return {
    gap1,
    gap2,
    gap3,
    unmatchedDocCount,
    certain,
    counts: {
      redJobs: redJobs.length,
      purpleJobs: purpleJobs.length,
      unlinkedTaxDocs: unlinkedDocs.filter((d) => TAX_TYPES.includes(d.type)).length,
    },
  };
}

async function loadData(admin: SupabaseClient) {
  const DOC_SELECT =
    "id,morning_doc_number,type,client_id,morning_client_id,morning_client_name,amount,document_date,job_id,production_id,source";
  const [{ data: clients }, { data: jobs }, docs] = await Promise.all([
    admin.from("clients").select("id,name,morning_client_id"),
    // dismissed jobs (0041) are out of reconciliation — a hidden record must
    // not get auto-matched or suggested
    admin.from("jobs").select("id,client_id,amount,invoice_biz,invoice_tax,paid,date,due_date,legacy,campaign").eq("dismissed", false),
    // a cancelled document is void — never auto-match or suggest it. The
    // cancelled_at filter needs migration 0043; if that isn't applied yet the
    // query errors, so fall back to the unfiltered read (no cancelled docs can
    // exist before the column does anyway).
    (async () => {
      // a cancelled OR archived document is out of reconciliation. Both columns
      // ship in later migrations (0043/0045); fall back to unfiltered if they
      // aren't applied yet (nothing is cancelled/archived before the column
      // exists anyway).
      const filtered = await admin.from("documents").select(DOC_SELECT).is("cancelled_at", null).is("archived_at", null);
      if (!filtered.error) return filtered.data ?? [];
      const plain = await admin.from("documents").select(DOC_SELECT);
      return plain.data ?? [];
    })(),
  ]);
  return {
    clients: (clients ?? []) as ReconClient[],
    jobs: (jobs ?? []) as ReconJob[],
    docs: (docs ?? []) as ReconDoc[],
  };
}

export async function computeReconciliation(admin: SupabaseClient): Promise<Reconciliation> {
  const { clients, jobs, docs } = await loadData(admin);
  return reconcile(clients, jobs, docs);
}

// ---- in-context suggestion pickers (step 3) ----------------------------
// Candidate documents for one job (finance red tab "שייך מסמך קיים").
export async function suggestDocsForJob(admin: SupabaseClient, jobId: string): Promise<DocCandidate[]> {
  const { clients, jobs, docs } = await loadData(admin);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return [];
  const { edges, confidenceOf } = buildEdges(clients, jobs, docs);
  const docById = new Map(docs.map((d) => [d.id, d]));
  return edges
    .filter((e) => e.jobId === jobId)
    .map((e) => ({ doc: docById.get(e.docId)!, confidence: confidenceOf(e), amountBasis: e.basis, dateGapDays: e.gap }))
    .sort(byConfidenceThenGap);
}

// Candidate jobs for one document (registry "שייך ל-job"). Falls back to an
// amount-only match (confidence "low") when the document has no client mapping
// — assigning it to a job then fills in the client via linkDocumentToJob.
export async function suggestJobsForDoc(admin: SupabaseClient, docId: string): Promise<JobCandidate[]> {
  const { clients, jobs, docs } = await loadData(admin);
  const doc = docs.find((d) => d.id === docId);
  if (!doc || doc.job_id) return [];

  const { edges, confidenceOf } = buildEdges(clients, jobs, docs);
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const client = edges
    .filter((e) => e.docId === docId)
    .map((e) => ({ job: jobById.get(e.jobId)!, confidence: confidenceOf(e), amountBasis: e.basis, dateGapDays: e.gap }));
  if (client.length || doc.client_id) return client.sort(byConfidenceThenGap);

  // client-unmapped document: amount-only fallback across needy jobs
  const dd = parseDate(doc.document_date);
  const out: JobCandidate[] = [];
  for (const j of jobs) {
    if (!jobNeedsDocType(j, doc.type)) continue;
    const basis = amountBasis(j.amount, doc.amount);
    if (!basis) continue;
    out.push({ job: j, confidence: "low", amountBasis: basis, dateGapDays: dateGapDays(parseDate(j.date) ?? parseDate(j.due_date), dd) });
  }
  return out.sort(byConfidenceThenGap);
}

/**
 * The seed-era `invoices.morning_doc_id`, and why the uuid alone never found it.
 *
 * 154 of the 203 rows in `invoices` predate the Morning integration: they were
 * loaded from the owner's spreadsheet and carry a SYNTHETIC id in place of a
 * Morning uuid. Measured 2026-09-15, and the shape is perfectly uniform —
 * exactly two families, no third, no variant:
 *
 *   biz-<number>.0    89 rows, type 'עסקה', 2025-02-26 → 2026-07-12
 *   tax-<number>.0    65 rows, type 'מס',   same window
 *
 * All 154 are source='manual', all carry job_id NULL, and in ALL 154
 * `doc_number` holds the same synthetic string rather than the bare number —
 * which is exactly why nothing found them: a lookup on the real document's
 * uuid misses, and so does one on `doc_number = '40272'`.
 *
 * ⚠️ AND THEY ARE NET. 147 of the 152 that match a pulled document equal its
 * gross ÷ 1.18; ZERO equal the gross. `linkDocumentToJob` writes
 * `documents.amount`, which is gross after a pull — so the duplicate it used to
 * create was not merely a second row for the same bill, it was a second row at
 * a DIFFERENT number. ₪295 beside ₪250 for one ₪295 invoice.
 *
 * This runs in the only direction that matters — from the bare number on a
 * pulled document TO the synthetic key a seed row might carry — so the shapes
 * are template literals rather than a parsed regex. Non-numeric input yields no
 * keys, and such a document is still tested against its Morning uuid.
 */
function seedInvoiceKeys(docNumber: string | null): string[] {
  const n = (docNumber ?? "").trim();
  if (!n || !/^\d+$/.test(n)) return [];
  return [`biz-${n}.0`, `tax-${n}.0`];
}

export type LinkRefusal = { ok: false; error: string };
export type LinkPreflight = { ok: true } | LinkRefusal;

/**
 * Everything that must be true BEFORE the first write, decided without making
 * one. Pure in the sense that matters: it reads, it never writes.
 *
 * ═══ WHY THIS IS A SEPARATE FUNCTION AND NOT TWO MORE `if`s ═══
 * The writes in linkDocumentToJob are four statements with no transaction
 * around them — the document, the job, the invoices row, the events. A check
 * that sits between statement one and two cannot refuse; by then
 * `documents.job_id` is already stamped and there is nothing to return to.
 * So every gate moves in front of all four, and the function below is barred
 * from writing so it cannot drift back.
 *
 * ═══ THE TWO HOLES IT CLOSES, both measured on live data 2026-09-15 ═══
 *
 * 1. THE DEDUPE THAT COULD NOT SEE THE SEED. The invoices guard downstream
 *    matches on `morning_doc_id` alone, and the historical rows carry
 *    'biz-40272.0' where the real document carries a uuid. The keys genuinely
 *    differ, so the unique index does not fire either — and the bookkeeper
 *    gets two rows for one invoice, at two different amounts (see above).
 *    Live case: כפיר ארביב, 40272 and 40283.
 *
 * 2. THE COLUMN THAT WAS ALREADY SPOKEN FOR. `if (!present(...))` at the job
 *    patch means a job already carrying a DIFFERENT number silently keeps it,
 *    while the document is stamped, an invoices row is written, and the call
 *    returns ok — so the screen says linked and the job still names the other
 *    document. Live case: 40289 against a job whose invoice_biz is '40283'.
 *    The SAME number is not a refusal: re-linking a document to the job that
 *    already names it is a no-op, not a conflict.
 *
 * Both refuse rather than repair. A wrong `invoices` row is money counted
 * twice and an overwritten `invoice_biz` is a document nobody can find again;
 * neither is something this function can decide correctly on its own, and both
 * are a minute of a human's time. The refusals say which document and which
 * number, because "השיוך נכשל" sends somebody to read the code.
 */
export async function linkPreflight(
  admin: SupabaseClient,
  doc: { morning_doc_id: unknown; morning_doc_number: string | null; type: number },
  job: { invoice_biz: string | null; invoice_tax: string | null }
): Promise<LinkPreflight> {
  const type = doc.type;
  const isTax = TAX_TYPES.includes(type);
  const isDeal = type === DEAL_TYPE;
  const docNumber = (doc.morning_doc_number ?? "").trim() || null;

  // ---- gate 1: an invoices row for this document already exists -----------
  // Three keys, because the same bill can be recorded under three different
  // ids: the Morning uuid (what the app writes today), and the two synthetic
  // shapes the seed used. `doc_number` is searched as well as `morning_doc_id`
  // because in all 154 seed rows it holds that same synthetic string.
  //
  // ⚠️ SCOPED TO THE DOCUMENTS THAT ACTUALLY WRITE ONE. The registry mirror
  // downstream is gated on `isTax || isDeal`, so a bare קבלה (400) never
  // creates an invoices row and therefore can never duplicate one. Refusing it
  // here would be a refusal with no harm behind it — and it would bite for
  // real: 80053 and 80054 (ידיעות אחרונות) are 400s whose numbers sit in a
  // seed row, and both would have been blocked for nothing.
  const morningId = typeof doc.morning_doc_id === "string" ? doc.morning_doc_id : null;
  const seedKeys = seedInvoiceKeys(docNumber);
  const keys = isTax || isDeal ? [...(morningId ? [morningId] : []), ...seedKeys] : [];

  if (keys.length) {
    // Two `.in()` reads rather than one `.or()`: the seed ids carry dots and
    // hyphens, and a PostgREST `or=` filter is a string the client does not
    // escape — a value the parser mis-reads comes back as an ERROR, and this
    // call destructures `data` only, so the gate would pass in silence. The
    // whole point of this function is to not be silent.
    const hit = async (column: "morning_doc_id" | "doc_number") =>
      admin.from("invoices").select("id").in(column, keys).limit(1);
    const [byId, byNumber] = await Promise.all([hit("morning_doc_id"), hit("doc_number")]);

    // A lookup that CANNOT ANSWER is not evidence that the answer is no — the
    // principle resolveParentWorkOrderLink states in as many words. Doubt
    // refuses: the cost of a wrong refusal is a minute, the cost of a missed
    // one is money counted twice in a registry nobody re-checks.
    if (byId.error || byNumber.error) {
      return {
        ok: false,
        error: `בדיקת הכפילות מול רישום החיובים נכשלה (${byId.error?.message ?? byNumber.error?.message}) — המסמך לא שויך`,
      };
    }

    if (byId.data?.length || byNumber.data?.length) {
      return {
        ok: false,
        error:
          `למסמך ${docNumber ?? "זה"} כבר קיימת שורת חיוב ישנה, ולכן הוא לא שויך. ` +
          `כדי לא לספור את אותו סכום פעמיים, הקישור דורש טיפול ידני.`,
      };
    }
  }

  // ---- gate 2: the column this document fills is already spoken for -------
  // Only the column this document would actually write. A 300 has nothing to
  // say about invoice_tax, and refusing on it would block a perfectly ordinary
  // deal invoice for a job whose tax document already went out.
  const target = isDeal ? job.invoice_biz : isTax ? job.invoice_tax : null;
  const existing = present(target) ? String(target).trim() : null;
  if (existing && existing !== docNumber) {
    return {
      ok: false,
      error:
        `העבודה כבר רשומה על מסמך ${existing}. המסמך ${docNumber ?? "הזה"} לא שויך, ` +
        `כדי לא להחליף את הרישום הקיים.`,
    };
  }

  return { ok: true };
}

// ---- the single assignment primitive -----------------------------------
// Links one billing document to one job, in lockstep: the document gets the
// job (and the job's client, which also lifts it out of the "unmatched" tab),
// the job's invoice flag moves so its finance state advances (tax → סגור,
// deal → ממתין לתשלום), and a matching invoices row is written so the finance
// registry stays complete — mirrors issue.ts. Every link is evented.
//
// actorId null = the automatic pull (service role); a uuid = the bookkeeper.
export async function linkDocumentToJob(
  admin: SupabaseClient,
  opts: { docId: string; jobId: string; actorId: string | null; auto: boolean }
): Promise<{ ok: true; state: "red-closed" | "linked" | "paid" } | { ok: false; error: string }> {
  const { docId, jobId, actorId, auto } = opts;

  const { data: doc } = await admin
    .from("documents")
    .select("id,morning_doc_id,morning_doc_number,type,amount,document_date,client_id,job_id,pdf_url,currency")
    .eq("id", docId)
    .maybeSingle();
  if (!doc) return { ok: false, error: "המסמך לא נמצא" };
  if (doc.job_id) return { ok: false, error: "המסמך כבר משויך ל-job" };
  if (!BILLING_TYPES.includes(doc.type as number)) return { ok: false, error: "רק חשבונית עסקה או מס ניתנות לשיוך ל-job" };

  const { data: job } = await admin
    .from("jobs")
    .select("id,client_id,invoice_biz,invoice_tax,paid")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "ה-job לא נמצא" };

  const type = doc.type as number;
  const isTax = TAX_TYPES.includes(type); // 305/320 — carries a tax invoice number
  const isDeal = type === DEAL_TYPE; // 300 — carries a deal invoice number
  const isPayment = PAYMENT_TYPES.includes(type); // 320/400 — proves payment
  const docNumber = (doc.morning_doc_number as string | null) ?? null;

  // ---- EVERY REFUSAL HAPPENS HERE, before the first write ------------------
  // The four writes below are not in a transaction, so a check placed between
  // any two of them cannot refuse — it can only leave half a link behind.
  const pre = await linkPreflight(
    admin,
    { morning_doc_id: doc.morning_doc_id, morning_doc_number: docNumber, type },
    { invoice_biz: job.invoice_biz as string | null, invoice_tax: job.invoice_tax as string | null }
  );
  if (!pre.ok) return pre;

  // 1. the document gets the job + the job's client
  await admin
    .from("documents")
    .update({ job_id: jobId, client_id: (doc.client_id as string | null) ?? job.client_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", docId);

  // 2. move the job's finance state by the document's kind (each independent;
  //    a מס/קבלה is both a tax invoice AND a receipt, so it can do two at once)
  const jobPatch: Record<string, unknown> = {};
  if (isTax && !present(job.invoice_tax as string | null)) jobPatch.invoice_tax = docNumber;
  if (isDeal && !present(job.invoice_biz as string | null)) jobPatch.invoice_biz = docNumber;
  const flippedPaid = isPayment && job.paid === "לא";
  if (flippedPaid) jobPatch.paid = "כן";
  if (Object.keys(jobPatch).length) await admin.from("jobs").update(jobPatch).eq("id", jobId);

  // 3. mirror to the finance registry (invoices) if not already there — only
  //    for actual invoices (deal/tax); a bare קבלה (400) is not an invoice row
  if (job.client_id && (isTax || isDeal)) {
    // ⚠️ THE SKIP BELOW IS UNREACHABLE TODAY, AND IT IS THE SHAPE THAT CAUSED
    // THE ONE MISMATCH THE TABLE HAS EVER HELD. Read before removing gate 1.
    //
    // When a row already exists for this document, this branch stamps
    // `documents.job_id` with the NEW job (above, step 1) and leaves the
    // existing invoices row pointing at the OLD one. The document and its
    // registry row then name different jobs, and nothing says so.
    //
    // That is exactly what happened to 60167 (מכון דווידסון): linked by hand
    // 2026-07-26, corrected 2026-07-30 by a manual SQL block that moved
    // `documents` and `jobs` and did not touch `invoices`, and finally
    // straightened by migration 0085. The symptom was never money — both jobs
    // were paid and correctly marked — it was `docs.find(d => d.type === "מס")`
    // at finance/page.tsx:62 returning a foreign document's PDF, because one
    // job carried two tax rows and the other carried none.
    //
    // It cannot happen through this function any more: linkPreflight's gate 1
    // (see above) looks up the SAME `morning_doc_id`, under the same
    // `isTax || isDeal` condition, and refuses before the first write — so by
    // the time control arrives here `existingInv` is always null. The lookup
    // stays as a belt: it is cheap, and it is the only thing standing between
    // a future removal of gate 1 and a silently re-opened hole. If gate 1 ever
    // goes, this skip must become a refusal or an event — never a silence.
    const { data: existingInv } = await admin
      .from("invoices")
      .select("id")
      .eq("morning_doc_id", doc.morning_doc_id as string)
      .maybeSingle();
    if (!existingInv) {
      await admin.from("invoices").insert({
        client_id: job.client_id,
        job_id: jobId,
        type: isTax ? "מס" : "עסקה",
        doc_number: docNumber,
        morning_doc_id: doc.morning_doc_id as string,
        amount: (doc.amount as number | null) ?? 0,
        issued_at: (doc.document_date as string | null) ?? new Date().toISOString(),
        source: "morning_api",
        issued_by: actorId,
        pdf_url: (doc.pdf_url as string | null) ?? null,
      });
    }
  }

  const movedState = flippedPaid
    ? (jobPatch.invoice_tax ? "unpaid→closed" : "unpaid→paid")
    : isTax && jobPatch.invoice_tax
      ? "red→closed"
      : "linked";

  // 4. event(s) on the job — a money-state change
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: jobId,
    event_type: "document_reconciled",
    actor_id: actorId,
    payload: { auto, doc_id: docId, morning_doc_id: doc.morning_doc_id, morning_doc_number: docNumber, doc_type: type, amount: doc.amount, moved_state: movedState },
  });
  // the radar reads job_marked_paid for payment timing — keep it consistent
  if (flippedPaid) {
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: jobId,
      event_type: "job_marked_paid",
      actor_id: actorId,
      payload: { via: "reconcile", auto, morning_doc_number: docNumber, doc_type: type },
    });
  }

  const state = flippedPaid ? "paid" : isTax && jobPatch.invoice_tax ? "red-closed" : "linked";
  return { ok: true, state };
}

// Auto-match run at the end of every pull (step A): link only the certain 1:1
// tax matches; anything ambiguous is left for the bookkeeper's gaps screen —
// "לא ודאי → אל תנחש". Returns how many were linked.
export async function autoReconcile(admin: SupabaseClient): Promise<{ linked: number }> {
  const recon = await computeReconciliation(admin);
  let linked = 0;
  for (const { job, doc } of recon.certain) {
    const res = await linkDocumentToJob(admin, { docId: doc.id, jobId: job.id, actorId: null, auto: true });
    if (res.ok) linked++;
  }
  return { linked };
}

// The unique 1:1 payment matches: an unpaid job and an unlinked payment
// document (מס/קבלה / קבלה) that share a client and amount, where NEITHER side
// has any other candidate. Proof of payment is strong, and this business bills
// months after recording, so date is NOT gated here — only strict uniqueness
// (a client+amount that fits >1 job/doc, like גל אורן's twin ₪1,200 jobs, is
// excluded and left for the bookkeeper to pick). Marking paid is money, so this
// is never run unattended on a cron — only via the manual reconcile-payments
// endpoint (can_edit_money).
export type PaymentMatch = { job: ReconJob; doc: ReconDoc; amountBasis: AmountBasis; dateGapDays: number | null };
export function certainPaymentMatches(clients: ReconClient[], jobs: ReconJob[], docs: ReconDoc[]): PaymentMatch[] {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const docById = new Map(docs.map((d) => [d.id, d]));
  const { edges, confidenceOf } = buildEdges(clients, jobs, docs);
  return edges
    .filter((e) => PAYMENT_TYPES.includes(docById.get(e.docId)!.type) && confidenceOf(e) === "high")
    .map((e) => ({ job: jobById.get(e.jobId)!, doc: docById.get(e.docId)!, amountBasis: e.basis, dateGapDays: e.gap }));
}

export async function reconcileCertainPayments(
  admin: SupabaseClient,
  actorId: string
): Promise<{ paid: number; items: { jobId: string; docNumber: string | null; amount: number | null }[] }> {
  const { clients, jobs, docs } = await loadData(admin);
  const matches = certainPaymentMatches(clients, jobs, docs);
  const items: { jobId: string; docNumber: string | null; amount: number | null }[] = [];
  for (const m of matches) {
    const res = await linkDocumentToJob(admin, { docId: m.doc.id, jobId: m.job.id, actorId, auto: false });
    if (res.ok) items.push({ jobId: m.job.id, docNumber: m.doc.morning_doc_number, amount: m.doc.amount });
  }
  return { paid: items.length, items };
}
