import type { SupabaseClient } from "@supabase/supabase-js";
import { deriveState } from "@/lib/finance/state";

// The reconciliation engine — the systematic bridge between "what happened"
// (documents that exist in Morning) and "what the system knows" (jobs and
// their finance state). Owner spec 2026-07-26.
//
// One matching engine powers three things so they can never drift apart:
//   - the auto-match on pull (link certain matches, close the job) — step A
//   - the "gaps to handle" screen for the bookkeeper — step B
//   - the offline scan/report — step C (scripts/scan_reconciliation_gaps.py
//     mirrors this logic; keep them in step)
//
// Matching key (owner spec): same client (via morning_client_id, or a
// resolved client_id) + amount match (VAT-aware: a tax-document total is the
// job's base amount * 1.18) + document date within +/- 30 days of the job.

export const TAX_TYPES = [305, 320]; // חשבונית מס / חשבונית מס קבלה
const DEAL_TYPE = 300; // חשבון עסקה
const BILLING_TYPES = [...TAX_TYPES, DEAL_TYPE];

const AMOUNT_TOL = 2; // shekels
const AMOUNT_TOL_PCT = 0.01; // or 1%
const DATE_WINDOW_DAYS = 30;
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

const present = (v: string | null): boolean => v != null && String(v).trim() !== "";

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(String(s).slice(0, 10)).getTime();
  return Number.isNaN(t) ? null : t;
}

function amountMatch(jobAmount: number | null, docAmount: number | null): boolean {
  if (jobAmount == null || docAmount == null) return false;
  const ja = Number(jobAmount);
  const da = Number(docAmount);
  for (const target of [ja, ja * VAT]) {
    const tol = Math.max(AMOUNT_TOL, target * AMOUNT_TOL_PCT);
    if (Math.abs(da - target) <= tol) return true;
  }
  return false;
}

function dateWithin(jobDateMs: number | null, docDateMs: number | null): boolean {
  if (jobDateMs == null || docDateMs == null) return true; // unknown → don't exclude
  return Math.abs(docDateMs - jobDateMs) <= DATE_WINDOW_DAYS * 86_400_000;
}
function bothDatesKnownAndClose(jobDateMs: number | null, docDateMs: number | null): boolean {
  return jobDateMs != null && docDateMs != null && dateWithin(jobDateMs, docDateMs);
}

// A candidate pairing of a job and an unlinked billing document.
export type MatchPair = { job: ReconJob; doc: ReconDoc };

export type Reconciliation = {
  // 🔴 red jobs (paid, no tax invoice) that have >=1 candidate tax document
  gap1: { job: ReconJob; candidates: ReconDoc[] }[];
  // 🟡 billing documents linked to a client but not to a job, with candidate jobs
  gap2: { doc: ReconDoc; candidates: ReconJob[] }[];
  // 🟡 non-legacy jobs stuck "not billed" (purple) over 30 days
  gap3: ReconJob[];
  // documents that carry no client mapping at all (informational — need a client map, not a job)
  unmatchedDocCount: number;
  // the subset of gap1 that is an unambiguous 1:1 tax match — safe to auto-link
  certain: MatchPair[];
  counts: { redJobs: number; purpleJobs: number; unlinkedTaxDocs: number };
};

async function loadData(admin: SupabaseClient) {
  const [{ data: clients }, { data: jobs }, { data: docs }] = await Promise.all([
    admin.from("clients").select("id,name,morning_client_id"),
    admin
      .from("jobs")
      .select("id,client_id,amount,invoice_biz,invoice_tax,paid,date,due_date,legacy,campaign"),
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

// The pure core: given the three tables, produce the reconciliation.
export function reconcile(clients: ReconClient[], jobs: ReconJob[], docs: ReconDoc[]): Reconciliation {
  const clientById = new Map(clients.map((c) => [c.id, c]));

  // resolve every job/doc to a set of client keys so a match can join on either
  // our client_id or the raw Morning client id (covers docs not yet mapped to
  // one of ours but sharing the same Morning entity as the job's client)
  const jobKeys = (j: ReconJob): string[] => {
    const keys: string[] = [];
    if (j.client_id) {
      keys.push("cid:" + j.client_id);
      const c = clientById.get(j.client_id);
      if (c?.morning_client_id) keys.push("mid:" + c.morning_client_id);
    }
    return keys;
  };
  const docKey = (d: ReconDoc): string | null => {
    if (d.client_id) return "cid:" + d.client_id;
    if (d.morning_client_id) return "mid:" + d.morning_client_id;
    return null;
  };

  const unlinkedBillingDocs = docs.filter((d) => BILLING_TYPES.includes(d.type) && !d.job_id);
  const docsByKey = new Map<string, ReconDoc[]>();
  for (const d of unlinkedBillingDocs) {
    const k = docKey(d);
    if (k) docsByKey.set(k, [...(docsByKey.get(k) ?? []), d]);
  }

  // candidate docs for a job (of a given type set)
  const candidatesFor = (j: ReconJob, types: number[]): ReconDoc[] => {
    const jd = parseDate(j.date) ?? parseDate(j.due_date);
    const seen = new Set<string>();
    const out: ReconDoc[] = [];
    for (const k of jobKeys(j)) {
      for (const d of docsByKey.get(k) ?? []) {
        if (!types.includes(d.type) || seen.has(d.id)) continue;
        if (!amountMatch(j.amount, d.amount)) continue;
        if (!dateWithin(jd, parseDate(d.document_date))) continue;
        seen.add(d.id);
        out.push(d);
      }
    }
    return out;
  };

  const stateOf = (j: ReconJob) =>
    deriveState({ paid: j.paid, invoice_biz: j.invoice_biz, invoice_tax: j.invoice_tax });

  const redJobs = jobs.filter((j) => stateOf(j) === "red");
  const purpleJobs = jobs.filter((j) => stateOf(j) === "purple");

  // ---- Gap 1: red job -> candidate tax docs ----
  const gap1: { job: ReconJob; candidates: ReconDoc[] }[] = [];
  const jobCandidates = new Map<string, ReconDoc[]>();
  const docClaimedBy = new Map<string, string[]>(); // doc id -> job ids (tax only)
  for (const j of redJobs) {
    const cands = candidatesFor(j, TAX_TYPES);
    jobCandidates.set(j.id, cands);
    for (const d of cands) docClaimedBy.set(d.id, [...(docClaimedBy.get(d.id) ?? []), j.id]);
    if (cands.length) gap1.push({ job: j, candidates: cands });
  }

  // certain = exactly one candidate doc for the job, that doc claimed by only
  // this job, and both dates known and within the window (strict, because a
  // certain match auto-closes the job unattended)
  const certain: MatchPair[] = [];
  for (const j of redJobs) {
    const cands = jobCandidates.get(j.id) ?? [];
    if (cands.length !== 1) continue;
    const d = cands[0];
    if ((docClaimedBy.get(d.id) ?? []).length !== 1) continue;
    if (!bothDatesKnownAndClose(parseDate(j.date) ?? parseDate(j.due_date), parseDate(d.document_date))) continue;
    certain.push({ job: j, doc: d });
  }
  const certainDocIds = new Set(certain.map((m) => m.doc.id));

  // ---- Gap 2: unlinked billing docs (with a client) -> candidate jobs ----
  // Skip docs that are a certain match already (those get auto-linked on pull).
  // Reverse-index: for each such doc, which jobs would it settle?
  const gap2: { doc: ReconDoc; candidates: ReconJob[] }[] = [];
  for (const d of unlinkedBillingDocs) {
    if (!d.client_id) continue; // truly unmapped-client docs need a client map, not a job
    if (certainDocIds.has(d.id)) continue;
    const dd = parseDate(d.document_date);
    const cands = jobs.filter((j) => {
      if (present(TAX_TYPES.includes(d.type) ? j.invoice_tax : j.invoice_biz)) return false; // already has that doc kind
      if (!jobKeys(j).includes("cid:" + d.client_id)) {
        const c = j.client_id ? clientById.get(j.client_id) : null;
        if (!c || "cid:" + c.id !== "cid:" + d.client_id) return false;
      }
      if (!amountMatch(j.amount, d.amount)) return false;
      if (!dateWithin(parseDate(j.date) ?? parseDate(j.due_date), dd)) return false;
      return true;
    });
    if (cands.length) gap2.push({ doc: d, candidates: cands });
  }

  // ---- Gap 3: old, non-legacy, not-billed jobs ----
  const now = Date.now();
  const gap3 = purpleJobs.filter((j) => {
    if (j.legacy) return false;
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
      unlinkedTaxDocs: unlinkedBillingDocs.filter((d) => TAX_TYPES.includes(d.type)).length,
    },
  };
}

export async function computeReconciliation(admin: SupabaseClient): Promise<Reconciliation> {
  const { clients, jobs, docs } = await loadData(admin);
  return reconcile(clients, jobs, docs);
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
