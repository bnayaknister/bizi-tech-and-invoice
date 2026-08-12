/**
 * The pull -> tax seam: createTaxFromParents fed with documentIds.
 *
 * Run:  npx tsx scripts/test_tax_from_pull.ts
 *
 * ⚠️ THIS SCRIPT WRITES TO THE DATABASE (test rows only — ZZ_TEST-tagged
 * client, job, documents rows, and whatever pending children the builder
 * enqueues). Every row is deleted in the finally block AND the deletion is
 * verified before the script reports success. Per the session's rule 6
 * (Morning live, DRY_RUN=false) it must NOT be run without explicit owner
 * approval — it was written in stage 2 and left unrun on purpose.
 *
 * TOUCHES MORNING: never. The builder only reads documents / pending_documents
 * / clients / jobs and enqueues a 'pending' row; the Morning call lives in
 * issue.ts, behind approval, and is not on this path.
 *
 * What it proves:
 *   A. happy path — a pulled 300 fathers a 305 whose amount and income are the
 *      NET (never documents.amount, which is gross for pull rows), linked and
 *      remarked correctly, jobs carried via bundle_job_ids
 *   B. the gross-as-net defense — income whose price is secretly the gross is
 *      refused by the per-line arithmetic gate (pure, no DB)
 *   C. the net ceiling — policy refusal with the manual-issuance message (pure)
 *   D. no linked job — refused (a tax document must stamp the jobs it closes)
 *   E. invoice_tax gate, BOTH paths — a job already carrying invoice_tax
 *      refuses the build from a documents source AND from a pending source
 *      (the approved behavior change to the proven path)
 *   F. source gate — an 'app' document is sent back to its queue row
 *   G. cross-table dedup — the same Morning document entering once as a
 *      pending source and once as a documents source is refused, not doubled
 *   H. closed parent — ref=[] refuses at the mapper
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createTaxFromParents } from "../src/lib/documents/taxFromParent";
import { mapPullDocToSource, mapPullIncome, PULL_NET_CEILING, type PullDocRow } from "../src/lib/documents/pullSource";
import { MORNING_DOC_CODE, sourceRemark, type MorningDocumentRequest } from "../src/lib/morning/types";

// ---------------------------------------------------------------------------
// env + client (same pattern as test_tax_from_parent.ts)
// ---------------------------------------------------------------------------
for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// bookkeeping
// ---------------------------------------------------------------------------
const TAG = `ZZ_TEST_PULLTAX_${Date.now()}`;
const made = {
  clients: [] as string[],
  jobs: [] as string[],
  documents: [] as string[],
  pendingParents: [] as string[],
  pendingChildren: [] as string[],
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : ` -> ${detail}`}`);
  if (!ok) failures++;
};

const uuid = () => crypto.randomUUID();
let seq = 0;
const nextNumber = () => `9${String(90000 + ++seq)}`; // test-space doc numbers

async function insert<T extends Record<string, unknown>>(table: string, row: T): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A raw shaped exactly like a /documents/search item for an open 300. */
function pulledRaw(opts: {
  morningDocId: string;
  number: string;
  morningClientId: string;
  net?: number;
  ref?: number[] | null; // null = raw without ref (unknown -> refusal on this path)
  lines?: { description: string; quantity: number; price: number }[];
}) {
  const lineDefs = opts.lines ?? [{ description: "שורת בדיקה (test)", quantity: 1, price: opts.net ?? 1000 }];
  const income = lineDefs.map((l) => {
    const amount = l.price * l.quantity;
    const vat = Math.round(amount * 0.18 * 100) / 100;
    return {
      description: l.description,
      quantity: l.quantity,
      price: l.price,
      currency: "ILS",
      vatType: 0,
      vatRate: 0.18,
      vat,
      amount,
      amountTotal: amount + vat,
      currencyRate: 1,
      itemId: "",
      catalogNum: "",
    };
  });
  const net = income.reduce((s, l) => s + l.amount, 0);
  const vat = income.reduce((s, l) => s + l.vat, 0);
  const raw: Record<string, unknown> = {
    id: opts.morningDocId,
    type: MORNING_DOC_CODE.deal_invoice,
    number: opts.number,
    status: 0,
    currency: "ILS",
    vatType: 0,
    amount: net + vat,
    amountExcludeVat: net,
    vat,
    documentDate: "2026-01-01",
    client: { id: opts.morningClientId, name: TAG },
    income,
  };
  if (opts.ref !== null) raw.ref = opts.ref ?? [MORNING_DOC_CODE.tax_invoice, MORNING_DOC_CODE.tax_receipt];
  return raw;
}

/** A documents row as the pull writes it: amount GROSS, raw whole. */
async function makePulledDoc(opts: {
  clientId: string | null;
  morningClientId: string;
  jobId?: string | null;
  net?: number;
  source?: string;
  ref?: number[] | null;
  lines?: { description: string; quantity: number; price: number }[];
}): Promise<{ id: string; morningDocId: string; number: string; raw: Record<string, unknown> }> {
  const morningDocId = uuid();
  const number = nextNumber();
  const raw = pulledRaw({ morningDocId, number, morningClientId: opts.morningClientId, net: opts.net, ref: opts.ref, lines: opts.lines });
  const id = await insert("documents", {
    morning_doc_id: morningDocId,
    morning_doc_number: number,
    type: MORNING_DOC_CODE.deal_invoice,
    status: 0,
    source: opts.source ?? "pull",
    client_id: opts.clientId,
    job_id: opts.jobId ?? null,
    amount: raw.amount, // gross — exactly what the pull stores
    document_date: "2026-01-01",
    raw,
  });
  made.documents.push(id);
  return { id, morningDocId, number, raw };
}

async function makeJob(clientId: string, extra?: Record<string, unknown>): Promise<string> {
  const job = await insert("jobs", { client_id: clientId, campaign: TAG, amount: 1000, date: "2026-01-01", ...extra });
  made.jobs.push(job);
  return job;
}

/** An issued pending parent (the proven path) — for tests E2 and G. */
async function makePendingParent(opts: {
  clientId: string;
  morningClientId: string;
  jobId: string | null;
  morningDocId: string;
  number: string;
  net?: number;
}): Promise<string> {
  const net = opts.net ?? 1000;
  const payload: MorningDocumentRequest = {
    type: MORNING_DOC_CODE.deal_invoice,
    lang: "he",
    currency: "ILS",
    vatType: 0,
    date: "2026-01-01",
    description: "parent (test)",
    client: { id: opts.morningClientId, name: TAG, add: false },
    income: [{ description: "שורת בדיקה (test)", quantity: 1, price: net, currency: "ILS", vatType: 0 }],
  };
  const id = await insert("pending_documents", {
    doc_type: "deal_invoice",
    status: "issued",
    client_id: opts.clientId,
    amount: net,
    payload,
    job_id: opts.jobId,
    morning_doc_id: opts.morningDocId,
    morning_doc_number: opts.number,
    issued_at: new Date().toISOString(),
  });
  made.pendingParents.push(id);
  return id;
}

async function buildFromDocs(documentIds: string[]) {
  const res = await createTaxFromParents(admin, [], null, undefined, { documentIds });
  if (res.ok) {
    made.pendingChildren.push(res.id);
    const { data } = await admin
      .from("pending_documents")
      .select("doc_type,status,client_id,amount,bundle_job_ids,payload")
      .eq("id", res.id)
      .single();
    return { res, row: data as unknown as {
      doc_type: string;
      status: string;
      client_id: string | null;
      amount: number;
      bundle_job_ids: string[] | null;
      payload: MorningDocumentRequest;
    } };
  }
  return { res, row: null };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
async function main() {
  const morningClientId = uuid();
  const clientId = await insert("clients", {
    name: TAG,
    normalized_name: TAG.toLowerCase(),
    morning_client_id: morningClientId,
  });
  made.clients.push(clientId);

  // -- A: happy path — pulled 300 with a job fathers a 305 in NET -----------
  console.log("\nA — pulled 300 (net 1000, gross 1180) -> 305");
  {
    const job = await makeJob(clientId);
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: job, net: 1000 });
    const { res, row } = await buildFromDocs([doc.id]);
    check("builds", res.ok, res.ok ? "" : res.error);
    if (res.ok && row) {
      check("child is tax_invoice, pending", row.doc_type === "tax_invoice" && row.status === "pending");
      check("amount is the NET, not documents.amount", row.amount === 1000, `amount=${row.amount} (gross would be 1180)`);
      check("income price is the NET per unit", row.payload.income?.[0]?.price === 1000, JSON.stringify(row.payload.income));
      check("linked to the parent", (row.payload.linkedDocumentIds ?? []).join() === doc.morningDocId);
      check("remark names the parent in Morning's words",
        row.payload.remarks === sourceRemark("tax_invoice", MORNING_DOC_CODE.deal_invoice, [doc.number]),
        row.payload.remarks ?? "(none)");
      check("bundle_job_ids carries the documents.job_id", (row.bundle_job_ids ?? []).join() === job);
      check("client attributed", row.client_id === clientId);
      check("openness known (pull raw always has ref)", res.parentOpennessUnknown === false);
    }
  }

  // -- B: the gross-as-net defense (pure — no rows) -------------------------
  console.log("\nB — income whose price is secretly the gross is refused");
  {
    const raw = pulledRaw({ morningDocId: uuid(), number: nextNumber(), morningClientId, net: 1000 });
    const line = (raw.income as Record<string, unknown>[])[0];
    line.price = line.amountTotal; // the exact mistake this project exists to prevent
    const res = mapPullIncome(raw, raw.amount as number);
    check("refused by the per-line gate", !res.ok && res.error.includes("amountTotal"), res.ok ? "passed?!" : res.error);
  }

  // -- C: the net ceiling (pure) --------------------------------------------
  console.log("\nC — net above the policy ceiling is sent to manual issuance");
  {
    const morningDocId = uuid();
    const doc: PullDocRow = {
      id: uuid(), morning_doc_id: morningDocId, morning_doc_number: nextNumber(),
      type: MORNING_DOC_CODE.deal_invoice, source: "pull", client_id: clientId, job_id: null,
      amount: (PULL_NET_CEILING + 5000) * 1.18, cancelled_at: null, archived_at: null,
      raw: pulledRaw({ morningDocId, number: "99999", morningClientId, net: PULL_NET_CEILING + 5000 }),
    };
    const res = mapPullDocToSource(doc);
    check("refused with the manual-issuance message", !res.ok && res.error.includes("להנפיק ידנית במורנינג"), res.ok ? "passed?!" : res.error);
  }

  // -- D: no linked job -----------------------------------------------------
  console.log("\nD — a pulled 300 without a job is refused");
  {
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: null, net: 700 });
    const { res } = await buildFromDocs([doc.id]);
    check("refused for missing jobs", !res.ok && res.error.includes("לא נמצאו עבודות"), res.ok ? "built?!" : res.error);
  }

  // -- E: the invoice_tax gate, both paths ----------------------------------
  console.log("\nE — a job already carrying invoice_tax refuses the build");
  {
    // E1: documents source
    const taxedJob = await makeJob(clientId, { invoice_tax: "50099" });
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: taxedJob, net: 800 });
    const { res } = await buildFromDocs([doc.id]);
    check("documents source refused", !res.ok && res.error.includes("כבר נושאת חשבונית מס"), res.ok ? "built?!" : res.error);

    // E2: pending source — the approved behavior change to the proven path
    const taxedJob2 = await makeJob(clientId, { invoice_tax: "50100" });
    const morningDocId = uuid();
    const number = nextNumber();
    const parent = await makePendingParent({ clientId, morningClientId, jobId: taxedJob2, morningDocId, number });
    // the documents row that carries the parent's ref, as the pull writes it
    const regId = await insert("documents", {
      morning_doc_id: morningDocId, morning_doc_number: number, type: MORNING_DOC_CODE.deal_invoice,
      status: 0, source: "pull", client_id: clientId, amount: 1180,
      raw: { id: morningDocId, type: MORNING_DOC_CODE.deal_invoice, ref: [305, 320] },
    });
    made.documents.push(regId);
    const res2 = await createTaxFromParents(admin, [parent], null);
    if (res2.ok) made.pendingChildren.push(res2.id);
    check("pending source refused too", !res2.ok && res2.error.includes("כבר נושאת חשבונית מס"), res2.ok ? "built?!" : res2.error);
  }

  // -- F: the source gate ---------------------------------------------------
  console.log("\nF — an app-issued document is sent back to its queue row");
  {
    const job = await makeJob(clientId);
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: job, net: 900, source: "app" });
    const { res } = await buildFromDocs([doc.id]);
    check("refused toward the pending path", !res.ok && res.error.includes("משורת התור"), res.ok ? "built?!" : res.error);
  }

  // -- G: cross-table dedup -------------------------------------------------
  console.log("\nG — the same Morning document via both tables is refused, not doubled");
  {
    const job = await makeJob(clientId);
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: job, net: 1100 });
    // a pending row for the SAME Morning document — the write-through scenario
    const parent = await makePendingParent({
      clientId, morningClientId, jobId: job, morningDocId: doc.morningDocId, number: doc.number, net: 1100,
    });
    const res = await createTaxFromParents(admin, [parent], null, undefined, { documentIds: [doc.id] });
    if (res.ok) made.pendingChildren.push(res.id);
    check("refused by the one-morning-doc gate", !res.ok && res.error.includes("יותר מפעם אחת"), res.ok ? "built?!" : res.error);
  }

  // -- H: closed parent -----------------------------------------------------
  console.log("\nH — ref=[] (closed in Morning) refuses at the mapper");
  {
    const job = await makeJob(clientId);
    const doc = await makePulledDoc({ clientId, morningClientId, jobId: job, net: 600, ref: [] });
    const { res } = await buildFromDocs([doc.id]);
    check("refused as closed", !res.ok && res.error.includes("סגור במורנינג"), res.ok ? "built?!" : res.error);
  }
}

// ---------------------------------------------------------------------------
// cleanup — every row, verified
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log("\ncleanup");
  const pendingAll = [...made.pendingChildren, ...made.pendingParents];

  if (pendingAll.length) await admin.from("events").delete().in("entity_id", pendingAll);
  if (made.pendingChildren.length) await admin.from("pending_documents").delete().in("id", made.pendingChildren);
  if (made.pendingParents.length) await admin.from("pending_documents").delete().in("id", made.pendingParents);
  if (made.documents.length) await admin.from("documents").delete().in("id", made.documents);
  if (made.jobs.length) await admin.from("jobs").delete().in("id", made.jobs);
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);

  const leftovers: string[] = [];
  const stillThere = async (table: string, ids: string[]) => {
    if (!ids.length) return;
    const { data } = await admin.from(table).select("id").in("id", ids);
    if (data?.length) leftovers.push(`${table}: ${data.map((r) => (r as { id: string }).id).join(", ")}`);
  };
  await stillThere("pending_documents", pendingAll);
  await stillThere("documents", made.documents);
  await stillThere("jobs", made.jobs);
  await stillThere("clients", made.clients);
  if (pendingAll.length) {
    const { data } = await admin.from("events").select("id").in("entity_id", pendingAll);
    if (data?.length) leftovers.push(`events: ${data.length} rows`);
  }

  if (leftovers.length) {
    console.log("  LEFTOVER ROWS — DELETE BY HAND:");
    for (const l of leftovers) console.log(`    ${l}`);
    failures++;
  } else {
    console.log("  clean — every test row deleted and verified");
  }
}

main()
  .catch((e) => {
    console.error("test run crashed:", e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
