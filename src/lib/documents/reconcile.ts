import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveState } from "@/lib/finance/state";

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
const BILLING_TYPES = [...TAX_TYPES, DEAL_TYPE];

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
function amountBasis(jobAmount: number | null, docAmount: number | null): AmountBasis | null {
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

// The needy state a document type settles: a tax document answers a RED job
// (paid, no tax invoice); a deal invoice answers a not-billed (purple) job.
function jobNeedsDocType(state: string, docType: number): boolean {
  if (TAX_TYPES.includes(docType)) return state === "red";
  if (docType === DEAL_TYPE) return state === "purple";
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
    const st = stateOf(j);
    if (st !== "red" && st !== "purple") continue; // only needy jobs
    const jd = parseDate(j.date) ?? parseDate(j.due_date);
    const seen = new Set<string>();
    for (const k of jobKeys(j)) {
      for (const d of docsByKey.get(k) ?? []) {
        if (seen.has(d.id) || !jobNeedsDocType(st, d.type)) continue;
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
  const taxEdges = edges.filter((e) => TAX_TYPES.includes(docById.get(e.docId)!.type));
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
  const [{ data: clients }, { data: jobs }, { data: docs }] = await Promise.all([
    admin.from("clients").select("id,name,morning_client_id"),
    admin.from("jobs").select("id,client_id,amount,invoice_biz,invoice_tax,paid,date,due_date,legacy,campaign"),
    admin
      .from("documents")
      .select(
        "id,morning_doc_number,type,client_id,morning_client_id,morning_client_name,amount,document_date,job_id,production_id,source"
      ),
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
    const st = stateOf(j);
    if (!jobNeedsDocType(st, doc.type)) continue;
    const basis = amountBasis(j.amount, doc.amount);
    if (!basis) continue;
    out.push({ job: j, confidence: "low", amountBasis: basis, dateGapDays: dateGapDays(parseDate(j.date) ?? parseDate(j.due_date), dd) });
  }
  return out.sort(byConfidenceThenGap);
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
): Promise<{ ok: true; state: "red-closed" | "linked" } | { ok: false; error: string }> {
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
    .select("id,client_id,invoice_biz,invoice_tax")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "ה-job לא נמצא" };

  const isTax = TAX_TYPES.includes(doc.type as number);
  const docNumber = (doc.morning_doc_number as string | null) ?? null;

  // 1. the document gets the job + the job's client
  await admin
    .from("documents")
    .update({ job_id: jobId, client_id: (doc.client_id as string | null) ?? job.client_id ?? null, updated_at: new Date().toISOString() })
    .eq("id", docId);

  // 2. the job's invoice flag moves its finance state
  const jobPatch: Record<string, unknown> = {};
  if (isTax && !present(job.invoice_tax as string | null)) jobPatch.invoice_tax = docNumber;
  if (!isTax && !present(job.invoice_biz as string | null)) jobPatch.invoice_biz = docNumber;
  if (Object.keys(jobPatch).length) await admin.from("jobs").update(jobPatch).eq("id", jobId);

  // 3. mirror to the finance registry (invoices) if not already there
  if (job.client_id) {
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

  // 4. event on the job (this is a change to its money state)
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: jobId,
    event_type: "document_reconciled",
    actor_id: actorId,
    payload: {
      auto,
      doc_id: docId,
      morning_doc_id: doc.morning_doc_id,
      morning_doc_number: docNumber,
      doc_type: doc.type,
      amount: doc.amount,
      moved_state: isTax && jobPatch.invoice_tax ? "red→closed" : "linked",
    },
  });

  return { ok: true, state: isTax && jobPatch.invoice_tax ? "red-closed" : "linked" };
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
