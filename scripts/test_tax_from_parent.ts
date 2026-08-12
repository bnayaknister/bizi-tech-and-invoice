/**
 * createTaxFromParents — the parent -> tax-child builder, payload shape + gates.
 *
 * Run:  npx tsx scripts/test_tax_from_parent.ts
 *
 * TOUCHES MORNING: never. The builder only reads pending_documents / documents /
 * clients and enqueues a 'pending' row; the Morning call lives in issue.ts,
 * behind approval, and is not on this path.
 *
 * Why the shape is the whole test: DRY_RUN is not a safety net here. A dry-run
 * issuance mints a `dry-` id, and gate 4 refuses exactly that — so an
 * end-to-end run through Morning is impossible by construction. What CAN be
 * verified without issuing anything is that the payload is right, and that
 * every gate refuses what it must.
 *
 * NOT covered here: the tax_variant flip in /api/documents/pending/review. It
 * is an authenticated HTTP route (cookie auth), not a library call. What this
 * script does verify is the precondition that flip depends on — that
 * linkedDocumentIds always resolves back to parents carrying a doc_type and a
 * morning_doc_number.
 *
 * Every row it creates is deleted in the finally block AND the deletion is
 * verified before the script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createTaxFromParents, childRule, ALLOWED_CHILDREN } from "../src/lib/documents/taxFromParent";
import { MORNING_DOC_CODE, sourceRemark, type MorningDocumentRequest } from "../src/lib/morning/types";

// ---------------------------------------------------------------------------
// env + client
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
const TAG = `ZZ_TEST_TAX_${Date.now()}`;
const made = {
  clients: [] as string[],
  productions: [] as string[],
  jobs: [] as string[],
  links: [] as { job: string; production: string }[],
  pendingParents: [] as string[],
  pendingChildren: [] as string[], // whatever the builder itself enqueued
  documents: [] as string[],
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : ` -> ${detail}`}`);
  if (!ok) failures++;
};

const uuid = () => crypto.randomUUID();

async function insert<T extends Record<string, unknown>>(table: string, row: T): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

function parentPayload(morningClientId: string, code: number, lines: number, price = 100): MorningDocumentRequest {
  return {
    type: code,
    lang: "he",
    currency: "ILS",
    vatType: 0,
    date: "2026-01-01",
    description: "parent (test)",
    client: { id: morningClientId, name: TAG, add: false },
    income: Array.from({ length: lines }, (_, i) => ({
      description: `line ${i + 1} (test)`,
      quantity: 1,
      price,
      currency: "ILS",
      vatType: 0,
    })),
  };
}

const parentNumber: Record<string, string> = {};
const parentMorningId: Record<string, string> = {};

/** An issued parent, plus (optionally) the documents row that carries its ref. */
async function makeParent(opts: {
  docType: "work_order" | "deal_invoice";
  morningClientId: string;
  clientId: string;
  jobId?: string | null;
  lines?: number;
  price?: number;
  amount?: number | null;
  status?: string;
  morningDocId?: string | null;
  morningDocNumber?: string | null;
  /** undefined = create no documents row at all; null = a row whose raw has no ref */
  ref?: number[] | null | undefined;
}): Promise<string> {
  const code = opts.docType === "work_order" ? MORNING_DOC_CODE.order : MORNING_DOC_CODE.deal_invoice;
  const lines = opts.lines ?? 1;
  const price = opts.price ?? 100;
  const morningDocId = opts.morningDocId === undefined ? uuid() : opts.morningDocId;
  const number =
    opts.morningDocNumber === undefined ? String(Math.floor(Math.random() * 100000)) : opts.morningDocNumber;

  const id = await insert("pending_documents", {
    doc_type: opts.docType,
    status: opts.status ?? "issued",
    client_id: opts.clientId,
    amount: opts.amount === undefined ? price * lines : opts.amount,
    payload: parentPayload(opts.morningClientId, code, lines, price),
    job_id: opts.jobId ?? null,
    morning_doc_id: morningDocId,
    morning_doc_number: number,
    issued_at: new Date().toISOString(),
  });
  made.pendingParents.push(id);
  if (number) parentNumber[id] = number;
  if (morningDocId) parentMorningId[id] = morningDocId;

  // the registry row that carries `ref` inside raw — this is where the
  // openness gate reads from (ref is not a column)
  if (morningDocId && opts.ref !== undefined) {
    const docId = await insert("documents", {
      morning_doc_id: morningDocId,
      morning_doc_number: number,
      type: code,
      status: opts.ref && opts.ref.length ? 0 : 1,
      source: "pull",
      amount: price * lines,
      raw: opts.ref === null ? { id: morningDocId, type: code } : { id: morningDocId, type: code, ref: opts.ref },
    });
    made.documents.push(docId);
  }
  return id;
}

async function makeJob(clientId: string): Promise<string> {
  const job = await insert("jobs", { client_id: clientId, campaign: TAG, amount: 100, date: "2026-01-01" });
  made.jobs.push(job);
  return job;
}

async function build(sourceIds: string[], variant?: "tax_receipt" | "tax_invoice") {
  const res = await createTaxFromParents(admin, sourceIds, null, variant);
  if (res.ok) {
    made.pendingChildren.push(res.id);
    const { data } = await admin
      .from("pending_documents")
      .select("doc_type,status,production_id,job_id,bundle_job_ids,client_id,amount,payload")
      .eq("id", res.id)
      .single();
    return { res, row: data as unknown as {
      doc_type: string;
      status: string;
      production_id: string | null;
      job_id: string | null;
      bundle_job_ids: string[] | null;
      client_id: string | null;
      amount: number;
      payload: MorningDocumentRequest;
    } };
  }
  return { res, row: null };
}

const sameSet = (a: string[] | null | undefined, b: string[]) =>
  !!a && a.length === b.length && [...a].sort().join() === [...b].sort().join();

// The open refs, exactly as verified against the live books (552 documents,
// zero exceptions): status=0 => full ref, any other status => empty ref.
const REF_OPEN_100 = [200, 300, 305, 320, 400];
const REF_OPEN_300 = [200, 305, 320, 400];

// ---------------------------------------------------------------------------
// pure checks — no rows needed
// ---------------------------------------------------------------------------
function checkPolicyTable() {
  console.log("\nthe allow-list — ours, not Morning's");
  check(
    "100 -> 320 allowed",
    !!childRule("work_order", MORNING_DOC_CODE.tax_receipt)?.implemented
  );
  check("100 -> 305 allowed", !!childRule("work_order", MORNING_DOC_CODE.tax_invoice)?.implemented);
  check("300 -> 320 allowed", !!childRule("deal_invoice", MORNING_DOC_CODE.tax_receipt)?.implemented);
  check("300 -> 305 allowed", !!childRule("deal_invoice", MORNING_DOC_CODE.tax_invoice)?.implemented);
  // Morning's ref on an open 100 DOES include 400. We refuse anyway.
  check(
    "100 -> 400 refused although ref allows it",
    childRule("work_order", MORNING_DOC_CODE.receipt) === null && REF_OPEN_100.includes(400)
  );
  check(
    "305 -> 400 is declared but NOT implemented",
    childRule("tax_invoice", MORNING_DOC_CODE.receipt)?.implemented === false
  );
  const anyCreditNote = Object.values(ALLOWED_CHILDREN).some((rules) =>
    (rules ?? []).some((r) => r.code === MORNING_DOC_CODE.credit_invoice)
  );
  check("330 (credit note) is nowhere in the table", !anyCreditNote);
  check("320 is a leaf — it can never be a parent", !ALLOWED_CHILDREN.tax_receipt);
}

function checkRemarkWording() {
  console.log("\nsourceRemark — both variants, Morning's own words");
  check(
    "320 on a deal invoice",
    sourceRemark("tax_receipt", MORNING_DOC_CODE.deal_invoice, ["40277"]) === "חשבונית מס / קבלה עבור חשבון עסקה 40277",
    sourceRemark("tax_receipt", MORNING_DOC_CODE.deal_invoice, ["40277"])
  );
  check(
    "305 on the same parent reads differently — this is why the flip must rebuild it",
    sourceRemark("tax_invoice", MORNING_DOC_CODE.deal_invoice, ["40277"]) === "חשבונית מס עבור חשבון עסקה 40277",
    sourceRemark("tax_invoice", MORNING_DOC_CODE.deal_invoice, ["40277"])
  );
  check(
    "several parents: type named once, numbers comma-joined",
    sourceRemark("tax_receipt", MORNING_DOC_CODE.deal_invoice, ["40277", "40275"]) ===
      "חשבונית מס / קבלה עבור חשבון עסקה 40277, 40275"
  );
  check(
    "on a work order Morning says הזמנה, not הזמנת עבודה",
    sourceRemark("tax_receipt", MORNING_DOC_CODE.order, ["10306"]) === "חשבונית מס / קבלה עבור הזמנה 10306"
  );
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
async function main() {
  checkPolicyTable();
  checkRemarkWording();

  const morningClientId = uuid();
  const clientId = await insert("clients", {
    name: TAG,
    normalized_name: TAG.toLowerCase(),
    morning_client_id: morningClientId,
  });
  made.clients.push(clientId);

  // -- A: the happy path on an open work order ------------------------------
  console.log("\nA — open work order (ref full) -> 305, the default");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, lines: 2, ref: REF_OPEN_100 });
    const { res, row } = await build([p]);
    check("builds", res.ok, res.ok ? "" : res.error);
    // 305 is the default on purpose: a 320 declares to the tax authority that
    // the money arrived, and cannot be undone. See DEFAULT_TAX_VARIANT.
    check("doc_type is tax_invoice (the default)", row?.doc_type === "tax_invoice", row?.doc_type);
    check("payload type is 305, never 320 by omission", row?.payload.type === 305, String(row?.payload.type));
    check("status pending — nothing was issued", row?.status === "pending", row?.status);
    check("production_id null", row?.production_id === null);
    check("job_id null — the jobs live in bundle_job_ids", row?.job_id === null);
    check("bundle_job_ids = the parent's job", sameSet(row?.bundle_job_ids, [job]), JSON.stringify(row?.bundle_job_ids));
    check(
      "linkedDocumentIds = the parent's Morning id",
      sameSet(row?.payload.linkedDocumentIds, [parentMorningId[p]]),
      JSON.stringify(row?.payload.linkedDocumentIds)
    );
    check(
      "remarks names the parent",
      row?.payload.remarks === `חשבונית מס עבור הזמנה ${parentNumber[p]}`,
      row?.payload.remarks
    );
    check("income inherited verbatim (2 lines)", (row?.payload.income ?? []).length === 2, String(row?.payload.income?.length));
    check("amount = the parent's amount, not recomputed", Number(row?.amount) === 200, String(row?.amount));
    check("linkType is absent — unverified for this rung, so not sent", !("linkType" in (row?.payload ?? {})));
    check("openness known -> no warning flag", res.ok && res.parentOpennessUnknown === false);
  }

  // -- B: a deal invoice parent --------------------------------------------
  console.log("\nB — open deal invoice (ref full) -> 305");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: job, ref: REF_OPEN_300 });
    const { res, row } = await build([p]);
    check("builds", res.ok, res.ok ? "" : res.error);
    check(
      "remarks names it as a deal invoice",
      row?.payload.remarks === `חשבונית מס עבור חשבון עסקה ${parentNumber[p]}`,
      row?.payload.remarks
    );
  }

  // -- C: THE CLOSED PARENT — the case the owner asked to see explicitly ----
  // 4 of the 8 app-issued work orders in the live books are already closed.
  // The gate must refuse them, and must say which document it refused.
  console.log("\nC — closed parent (ref empty): must refuse, and name the document");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, ref: [] });
    const { res } = await build([p]);
    check("refuses with 409", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
    check(
      "the message names the parent's number",
      !res.ok && res.error.includes(parentNumber[p]),
      res.ok ? "" : res.error
    );
    check("and says it is closed", !res.ok && res.error.includes("סגור"), res.ok ? "" : res.error);
  }

  // -- D/E: openness unknown — allowed, but flagged -------------------------
  console.log("\nD — documents row exists but raw has no ref: allow + warn");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, ref: null });
    const { res } = await build([p]);
    check("builds", res.ok, res.ok ? "" : res.error);
    check("flags openness as unknown", res.ok && res.parentOpennessUnknown === true);
  }
  console.log("E — no documents row at all (freshly issued, never pulled): allow + warn");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job });
    const { res } = await build([p]);
    check("builds", res.ok, res.ok ? "" : res.error);
    check("flags openness as unknown", res.ok && res.parentOpennessUnknown === true);
  }

  // -- F: ref present but does not allow this child -------------------------
  console.log("F — ref open but without 305: refuse, and blame Morning honestly");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, ref: [200, 400] });
    const { res } = await build([p]);
    check("refuses", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
    check("message mentions Morning, not our policy", !res.ok && res.error.includes("מורנינג"), res.ok ? "" : res.error);
  }

  // -- G..K: the per-source gates -------------------------------------------
  console.log("\nG — dry-run parent: refuse");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({
      docType: "work_order", morningClientId, clientId, jobId: job,
      morningDocId: `dry-${uuid()}`, ref: REF_OPEN_100,
    });
    const { res } = await build([p]);
    check("refuses", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
    check("message says dry run", !res.ok && res.error.includes("יבשה"), res.ok ? "" : res.error);
  }

  console.log("H — parent not issued: refuse");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, status: "pending", ref: REF_OPEN_100 });
    const { res } = await build([p]);
    check("refuses", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
  }

  console.log("I — parent with no morning_doc_number: refuse, never omit the remark");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({
      docType: "work_order", morningClientId, clientId, jobId: job,
      morningDocNumber: null, ref: REF_OPEN_100,
    });
    const { res } = await build([p]);
    check("refuses", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
    check("names the document by its Morning id", !res.ok && res.error.includes(parentMorningId[p]), res.ok ? "" : res.error);
  }

  console.log("J — parent with no amount: refuse (a null would silently sum as 0)");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, amount: null, ref: REF_OPEN_100 });
    const { res } = await build([p]);
    check("refuses", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
  }

  console.log("K — parent with no job at all: refuse (nothing to stamp invoice_tax on)");
  {
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, ref: REF_OPEN_100 });
    const { res } = await build([p]);
    check("refuses with 409", !res.ok && res.status === 409, res.ok ? "built!" : String(res.status));
  }

  // -- L: multi-source is the default shape, not an edge case ---------------
  console.log("\nL — two parents, one client: one child that covers both");
  {
    const j1 = await makeJob(clientId);
    const j2 = await makeJob(clientId);
    const p1 = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j1, lines: 1, price: 150, ref: REF_OPEN_300 });
    const p2 = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j2, lines: 2, price: 100, ref: REF_OPEN_300 });
    const { res, row } = await build([p1, p2]);
    check("builds", res.ok, res.ok ? "" : res.error);
    check("income is the concatenation (1 + 2 = 3 lines)", (row?.payload.income ?? []).length === 3, String(row?.payload.income?.length));
    check("amount = 150 + 200, summed not recomputed", Number(row?.amount) === 350, String(row?.amount));
    check(
      "linkedDocumentIds closes BOTH parents",
      sameSet(row?.payload.linkedDocumentIds, [parentMorningId[p1], parentMorningId[p2]]),
      JSON.stringify(row?.payload.linkedDocumentIds)
    );
    check(
      "remarks lists both numbers after one type name",
      row?.payload.remarks === `חשבונית מס עבור חשבון עסקה ${parentNumber[p1]}, ${parentNumber[p2]}`,
      row?.payload.remarks
    );
    check("bundle_job_ids = both jobs", sameSet(row?.bundle_job_ids, [j1, j2]), JSON.stringify(row?.bundle_job_ids));
    check("title says מאוגד for >1 source", !!row?.payload.description?.includes("מאוגד"), row?.payload.description);
  }

  console.log("M — mixing a work order and a deal invoice: refuse");
  {
    const j1 = await makeJob(clientId);
    const j2 = await makeJob(clientId);
    const p1 = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: j1, ref: REF_OPEN_100 });
    const p2 = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j2, ref: REF_OPEN_300 });
    const { res } = await build([p1, p2]);
    check("refuses", !res.ok && res.status === 400, res.ok ? "built!" : String(res.status));
    check("message says no mixing", !res.ok && res.error.includes("לערבב"), res.ok ? "" : res.error);
  }

  console.log("N — two different Morning clients: refuse");
  {
    const otherClientId = await insert("clients", {
      name: `${TAG}_B`,
      normalized_name: `${TAG}_b`.toLowerCase(),
      morning_client_id: uuid(),
    });
    made.clients.push(otherClientId);
    const j1 = await makeJob(clientId);
    const j2 = await makeJob(otherClientId);
    const p1 = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j1, ref: REF_OPEN_300 });
    const p2 = await makeParent({
      docType: "deal_invoice", morningClientId: uuid(), clientId: otherClientId, jobId: j2, ref: REF_OPEN_300,
    });
    const { res } = await build([p1, p2]);
    check("refuses", !res.ok && res.status === 400, res.ok ? "built!" : String(res.status));
  }

  // -- O: one bad source poisons the whole request --------------------------
  console.log("O — one good parent + one closed parent: the WHOLE request fails");
  {
    const j1 = await makeJob(clientId);
    const j2 = await makeJob(clientId);
    const good = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j1, ref: REF_OPEN_300 });
    const closed = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: j2, ref: [] });
    const { res } = await build([good, closed]);
    check("refuses — never builds from 'the valid ones'", !res.ok, res.ok ? "built!" : "");
    check("names the closed one", !res.ok && res.error.includes(parentNumber[closed]), res.ok ? "" : res.error);
    const { count } = await admin
      .from("pending_documents")
      .select("id", { count: "exact", head: true })
      .in("doc_type", ["tax_invoice", "tax_receipt"])
      .contains("payload", { linkedDocumentIds: [parentMorningId[good]] });
    check("and wrote nothing for the good one either", (count ?? 0) === 0, String(count));
  }

  // -- P: idempotency -------------------------------------------------------
  console.log("\nP — building twice on the same parent: the second must refuse");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: job, ref: REF_OPEN_300 });
    const first = await build([p]);
    check("first builds", first.res.ok, first.res.ok ? "" : first.res.error);
    const second = await build([p]);
    check("second refuses with 409", !second.res.ok && second.res.status === 409, second.res.ok ? "built twice!" : "");
    check("message says one already exists", !second.res.ok && second.res.error.includes("כבר קיים"), second.res.ok ? "" : second.res.error);
  }

  // -- Q: the variant argument is fenced ------------------------------------
  console.log("Q — asking for a non-tax child: refuse");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "work_order", morningClientId, clientId, jobId: job, ref: REF_OPEN_100 });
    const res = await createTaxFromParents(admin, [p], null, "deal_invoice");
    check("refuses", !res.ok && res.status === 400, res.ok ? "built!" : String(res.status));
  }

  // -- R: 320 is reachable, but only when ASKED for --------------------------
  // The mirror of A: the receipt variant still works end to end, it just never
  // happens by leaving the selector alone.
  console.log("R — building a 320 explicitly: type and remark agree");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: job, ref: REF_OPEN_300 });
    const { res, row } = await build([p], "tax_receipt");
    check("builds", res.ok, res.ok ? "" : res.error);
    check("payload type is 320", row?.payload.type === 320, String(row?.payload.type));
    check(
      "remark says מס / קבלה, not חשבונית מס",
      row?.payload.remarks === `חשבונית מס / קבלה עבור חשבון עסקה ${parentNumber[p]}`,
      row?.payload.remarks
    );
  }

  // -- S: what the review-route flip depends on -----------------------------
  console.log("S — every linked id resolves back to a typed, numbered parent");
  {
    const job = await makeJob(clientId);
    const p = await makeParent({ docType: "deal_invoice", morningClientId, clientId, jobId: job, ref: REF_OPEN_300 });
    const { res, row } = await build([p]);
    check("builds", res.ok, res.ok ? "" : res.error);
    const linked = row?.payload.linkedDocumentIds ?? [];
    const { data: parents } = await admin
      .from("pending_documents")
      .select("doc_type,morning_doc_id,morning_doc_number")
      .in("morning_doc_id", linked);
    const rows = (parents ?? []) as { doc_type: string; morning_doc_number: string | null }[];
    check("all resolved", rows.length === linked.length, `${rows.length}/${linked.length}`);
    check("all carry a number", rows.every((x) => !!x.morning_doc_number));
    check("all one type", new Set(rows.map((x) => x.doc_type)).size === 1);
  }
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log("\ncleanup");
  const pendingAll = [...made.pendingChildren, ...made.pendingParents];

  if (pendingAll.length) await admin.from("events").delete().in("entity_id", pendingAll);
  if (made.pendingChildren.length) await admin.from("pending_documents").delete().in("id", made.pendingChildren);
  if (made.pendingParents.length) await admin.from("pending_documents").delete().in("id", made.pendingParents);
  if (made.documents.length) await admin.from("documents").delete().in("id", made.documents);

  for (const l of made.links) {
    await admin.from("job_productions").delete().eq("job_id", l.job).eq("production_id", l.production);
  }
  if (made.jobs.length) await admin.from("jobs").delete().in("id", made.jobs);
  if (made.productions.length) await admin.from("productions").delete().in("id", made.productions);
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
  await stillThere("productions", made.productions);
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
    console.log("  verified: every test row removed");
  }
}

main()
  .catch((e) => {
    console.error("\nERROR:", e instanceof Error ? e.message : e);
    failures++;
  })
  .finally(async () => {
    await cleanup();
    console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  });
