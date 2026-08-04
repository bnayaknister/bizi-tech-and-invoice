/**
 * createDealInvoiceFromWorkOrder — the three episode-source shapes.
 *
 * Run:  npx tsx scripts/test_convert_shapes.ts
 *
 * Why this exists: neither existing shape has a clean live row to verify
 * against (consolidated bundles: zero rows in production; per-episode orders:
 * none reachable from the redemption screen, which filters production_id IS
 * NULL). Reading the code was the only check, and that is what let the
 * single-order bug ship in the first place. This exercises the real function.
 *
 * TOUCHES MORNING: never. createDealInvoiceFromWorkOrder only reads
 * pending_documents / job_productions / clients and enqueues a 'pending' row —
 * the Morning call lives in issue.ts, behind approval, and is not on this path.
 *
 * Every row it creates is deleted in the finally block AND the deletion is
 * verified before the script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createDealInvoiceBundle, createDealInvoiceFromWorkOrder } from "../src/lib/documents/bundle";
import { sourceRemark, type MorningDocumentRequest } from "../src/lib/morning/types";

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
// bookkeeping: everything created, so finally can undo it exactly
// ---------------------------------------------------------------------------
const TAG = `ZZ_TEST_CONVERT_${Date.now()}`;
const made = {
  clients: [] as string[],
  productions: [] as string[],
  jobs: [] as string[],
  links: [] as { job: string; production: string }[],
  pendingChildren: [] as string[], // rows whose consolidated_into points at a parent
  pendingParents: [] as string[],
  pendingInvoices: [] as string[], // whatever the function itself enqueued
};

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${ok || !detail ? "" : ` -> ${detail}`}`);
  if (!ok) failures++;
};

const uuid = () => crypto.randomUUID();

function orderPayload(clientId: string, lines: number): MorningDocumentRequest {
  return {
    type: 100,
    lang: "he",
    currency: "ILS",
    vatType: 0,
    date: "2026-01-01",
    description: "work order (test)",
    client: { id: clientId, name: TAG, add: false },
    income: Array.from({ length: lines }, (_, i) => ({
      description: `line ${i + 1} (test)`,
      quantity: 1,
      price: 100,
      currency: "ILS",
      vatType: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// seed helpers
// ---------------------------------------------------------------------------
async function insert<T extends Record<string, unknown>>(table: string, row: T): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function makeJobWithProduction(clientId: string): Promise<{ job: string; production: string }> {
  const production = await insert("productions", { podcast_name: TAG, client_id: clientId, record_date: "2026-01-01" });
  made.productions.push(production);
  const job = await insert("jobs", { client_id: clientId, campaign: TAG, amount: 100, date: "2026-01-01" });
  made.jobs.push(job);
  const { error } = await admin.from("job_productions").insert({ job_id: job, production_id: production });
  if (error) throw new Error(`insert job_productions: ${error.message}`);
  made.links.push({ job, production });
  return { job, production };
}

/** An ISSUED work order — the only status convert accepts. */
/** order id -> the Morning number it carries, so the remark can be asserted */
const orderNumber: Record<string, string> = {};

async function makeIssuedOrder(
  clientId: string,
  extra: { production_id?: string | null; job_id?: string | null; lines?: number }
): Promise<string> {
  const number = String(Math.floor(Math.random() * 100000));
  const id = await insert("pending_documents", {
    doc_type: "work_order",
    status: "issued",
    client_id: clientId,
    amount: 100 * (extra.lines ?? 1),
    payload: orderPayload(clientId, extra.lines ?? 1),
    production_id: extra.production_id ?? null,
    job_id: extra.job_id ?? null,
    morning_doc_id: uuid(), // a real-looking id; never sent anywhere
    morning_doc_number: number,
    issued_at: new Date().toISOString(),
  });
  made.pendingParents.push(id);
  orderNumber[id] = number;
  return id;
}

async function attachChild(parentId: string, clientId: string, productionId: string) {
  const id = await insert("pending_documents", {
    doc_type: "work_order",
    status: "consolidated",
    client_id: clientId,
    amount: 100,
    payload: orderPayload(clientId, 1),
    production_id: productionId,
    consolidated_into: parentId,
  });
  made.pendingChildren.push(id);
}

/** Run convert and hand back the row it created (if any). */
async function convert(orderId: string) {
  const res = await createDealInvoiceFromWorkOrder(admin, orderId, null);
  if (res.ok) {
    made.pendingInvoices.push(res.id);
    const { data } = await admin
      .from("pending_documents")
      .select("bundle_job_ids,payload,amount,status,doc_type")
      .eq("id", res.id)
      .single();
    return { res, row: data as { bundle_job_ids: string[]; payload: MorningDocumentRequest; amount: number; status: string; doc_type: string } };
  }
  return { res, row: null };
}

const sameSet = (a: string[] | null, b: string[]) =>
  !!a && a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ---------------------------------------------------------------------------
// the provenance line — a pure function, so it is checked without any rows
// ---------------------------------------------------------------------------
function checkRemarkWording() {
  console.log("\nsourceRemark — the provenance line");
  check(
    "one source",
    sourceRemark("deal_invoice", "work_order", ["10306"]) === "חשבון עסקה עבור הזמנה 10306",
    sourceRemark("deal_invoice", "work_order", ["10306"])
  );
  check(
    "two sources: type named once, numbers comma-joined",
    sourceRemark("tax_receipt", "deal_invoice", ["40277", "40275"]) ===
      "חשבונית מס / קבלה עבור חשבון עסקה 40277, 40275",
    sourceRemark("tax_receipt", "deal_invoice", ["40277", "40275"])
  );
  check(
    "Morning's names, not ours (הזמנה, not הזמנת עבודה)",
    sourceRemark("tax_invoice", "work_order", ["10226"]) === "חשבונית מס עבור הזמנה 10226",
    sourceRemark("tax_invoice", "work_order", ["10226"])
  );
  check("no source at all -> undefined", sourceRemark("deal_invoice", "work_order", []) === undefined);
  check(
    "blank / null numbers are not a source",
    sourceRemark("deal_invoice", "work_order", [null, undefined, "", "  "]) === undefined
  );
  check(
    "duplicate numbers collapse",
    sourceRemark("deal_invoice", "work_order", ["10306", "10306"]) === "חשבון עסקה עבור הזמנה 10306"
  );
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------
async function main() {
  checkRemarkWording();

  const clientId = await insert("clients", {
    name: TAG,
    normalized_name: TAG.toLowerCase(),
    morning_client_id: uuid(),
  });
  made.clients.push(clientId);

  // -- shape A: consolidated bundle (children via consolidated_into) --------
  console.log("\nshape A — consolidated bundle");
  const a1 = await makeJobWithProduction(clientId);
  const a2 = await makeJobWithProduction(clientId);
  const orderA = await makeIssuedOrder(clientId, { lines: 2 });
  await attachChild(orderA, clientId, a1.production);
  await attachChild(orderA, clientId, a2.production);
  {
    const { res, row } = await convert(orderA);
    check("converts", res.ok, res.ok ? "" : res.error);
    check("bundle_job_ids = both children's jobs", sameSet(row?.bundle_job_ids ?? null, [a1.job, a2.job]), JSON.stringify(row?.bundle_job_ids));
    check("plural title reads '2 פרקים'", !!row?.payload.description?.includes("(2 פרקים)"), row?.payload.description);
    check("title says מאוגד for >1", !!row?.payload.description?.includes("מאוגד"), row?.payload.description);
    check(
      "remarks names the order it was raised on",
      row?.payload.remarks === `חשבון עסקה עבור הזמנה ${orderNumber[orderA]}`,
      row?.payload.remarks
    );
  }

  // -- shape B: single per-episode order (row's own production_id) ----------
  console.log("\nshape B — single per-episode order");
  const b = await makeJobWithProduction(clientId);
  const orderB = await makeIssuedOrder(clientId, { production_id: b.production });
  {
    const { res, row } = await convert(orderB);
    check("converts", res.ok, res.ok ? "" : res.error);
    check("bundle_job_ids = the production's job", sameSet(row?.bundle_job_ids ?? null, [b.job]), JSON.stringify(row?.bundle_job_ids));
  }

  // -- shape C: registry-raised order (job_id only) — THE NEW BRANCH --------
  console.log("\nshape C — registry-raised order (job_id, no production)");
  const cJob = await insert("jobs", { client_id: clientId, campaign: TAG, amount: 100, date: "2026-01-01" });
  made.jobs.push(cJob);
  const orderC = await makeIssuedOrder(clientId, { job_id: cJob });
  {
    const { res, row } = await convert(orderC);
    check("converts (was 409 before the fix)", res.ok, res.ok ? "" : res.error);
    check("bundle_job_ids = the order's own job", sameSet(row?.bundle_job_ids ?? null, [cJob]), JSON.stringify(row?.bundle_job_ids));
    check("singular title reads 'פרק אחד'", !!row?.payload.description?.includes("(פרק אחד)"), row?.payload.description);
    check("title drops מאוגד for exactly 1", !row?.payload.description?.includes("מאוגד"), row?.payload.description);
    check("income inherited verbatim (1 line)", row?.payload.income.length === 1, JSON.stringify(row?.payload.income?.length));
    check("links back to the order in Morning", !!row?.payload.linkedDocumentIds?.length, JSON.stringify(row?.payload.linkedDocumentIds));
    check(
      "remarks names the order it was raised on",
      row?.payload.remarks === `חשבון עסקה עבור הזמנה ${orderNumber[orderC]}`,
      row?.payload.remarks
    );
  }

  // -- shape D: priority — production wins, job_id is last ------------------
  console.log("\nshape D — production_id AND job_id both set: production must win");
  const d = await makeJobWithProduction(clientId);
  const orderD = await makeIssuedOrder(clientId, { production_id: d.production, job_id: cJob });
  {
    const { res, row } = await convert(orderD);
    check("converts", res.ok, res.ok ? "" : res.error);
    check("resolves to the PRODUCTION's job, not job_id", sameSet(row?.bundle_job_ids ?? null, [d.job]), JSON.stringify(row?.bundle_job_ids));
  }

  // -- shape E: nothing to bill — the refusal must still fire ---------------
  console.log("\nshape E — no production, no job: must still refuse");
  const orderE = await makeIssuedOrder(clientId, {});
  {
    const { res } = await convert(orderE);
    check("still refuses with 409", !res.ok && res.status === 409, res.ok ? "converted!" : `${res.status}`);
  }

  // -- shape G: a PARENTLESS invoice must carry no remark at all ------------
  // The manual bundle is the declared emergency path: it is raised from jobs,
  // not from a document, so there is nothing to name. A remark here would be
  // a claim of provenance that does not exist.
  console.log("\nshape G — parentless bundle: no source, so no remark");
  const gJob = await insert("jobs", { client_id: clientId, campaign: TAG, amount: 100, date: "2026-01-01" });
  made.jobs.push(gJob);
  {
    const res = await createDealInvoiceBundle(admin, [gJob], null);
    check("builds", res.ok, res.ok ? "" : res.error);
    if (res.ok) {
      made.pendingInvoices.push(res.id);
      const { data } = await admin.from("pending_documents").select("payload").eq("id", res.id).single();
      const p = (data as { payload: MorningDocumentRequest }).payload;
      check("no remarks key on the payload at all", !("remarks" in p), JSON.stringify(p.remarks));
      check("and no link either", !("linkedDocumentIds" in p), JSON.stringify(p.linkedDocumentIds));
    }
  }

  // -- shape F: a pending order is not convertible at all -------------------
  console.log("\nshape F — order not yet issued: must refuse");
  const orderF = await insert("pending_documents", {
    doc_type: "work_order",
    status: "pending",
    client_id: clientId,
    amount: 100,
    payload: orderPayload(clientId, 1),
    job_id: cJob,
  });
  made.pendingParents.push(orderF);
  {
    const { res } = await convert(orderF);
    check("refuses a pending order", !res.ok && res.status === 409, res.ok ? "converted!" : `${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// cleanup — runs whatever happened, and proves it worked
// ---------------------------------------------------------------------------
async function cleanup() {
  console.log("\ncleanup");
  const pendingAll = [...made.pendingInvoices, ...made.pendingChildren, ...made.pendingParents];

  // events first: they reference the queue rows by entity_id (no FK, but they
  // are ours and must not outlive the rows they describe)
  if (pendingAll.length) await admin.from("events").delete().in("entity_id", pendingAll);

  // children before parents — consolidated_into is a self-FK with no cascade
  if (made.pendingInvoices.length) await admin.from("pending_documents").delete().in("id", made.pendingInvoices);
  if (made.pendingChildren.length) await admin.from("pending_documents").delete().in("id", made.pendingChildren);
  if (made.pendingParents.length) await admin.from("pending_documents").delete().in("id", made.pendingParents);

  for (const l of made.links) {
    await admin.from("job_productions").delete().eq("job_id", l.job).eq("production_id", l.production);
  }
  if (made.jobs.length) await admin.from("jobs").delete().in("id", made.jobs);
  if (made.productions.length) await admin.from("productions").delete().in("id", made.productions); // stages cascade
  if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);

  // verify, don't assume
  const leftovers: string[] = [];
  const stillThere = async (table: string, ids: string[]) => {
    if (!ids.length) return;
    const { data } = await admin.from(table).select("id").in("id", ids);
    if (data?.length) leftovers.push(`${table}: ${data.map((r) => (r as { id: string }).id).join(", ")}`);
  };
  await stillThere("pending_documents", pendingAll);
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
