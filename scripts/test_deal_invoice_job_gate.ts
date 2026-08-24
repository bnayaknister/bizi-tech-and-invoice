/**
 * The billable-job gate in createDealInvoiceFromWorkOrder (owner approved
 * 2026-08-24).
 *
 * REVERSIBLE: the builder inserts a 'pending' row and never reaches Morning.
 * Every row created here is deleted in `finally`, LIFO (a folded child holds
 * an FK to its consolidated parent, so children must go first), and the
 * deletion is VERIFIED before the run reports success.
 *
 * NOTHING REAL IS MUTATED. חתונמיות and ברק are read but never written — the
 * paid-job and cancelled-episode scenarios are built from synthetic rows.
 *
 * Run: npx tsx scripts/test_deal_invoice_job_gate.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDealInvoiceFromWorkOrder } from "../src/lib/documents/bundle";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    failures.push(name + (detail ? " -- " + detail : ""));
    console.log("  FAIL  " + name + (detail ? "  -- " + detail : ""));
  }
}

// LIFO teardown: pending children before their consolidated parent
const createdPending: string[] = [];
const createdJobs: string[] = [];
const createdProductions: string[] = [];

let SHOW_ID = "";
let CLIENT_ID = "";
let BASE_PAYLOAD: unknown = null;

/** one synthetic episode: production + job + job_productions, optionally spoiled */
async function makeEpisode(
  label: string,
  opts: { invoice_biz?: string; paid?: string; cancelled?: boolean } = {}
): Promise<{ prodId: string; jobId: string }> {
  const { data: prod } = await admin
    .from("productions")
    .insert({
      podcast_name: "TESTGATE " + label,
      client_id: CLIENT_ID,
      show_id: SHOW_ID,
      kind: "client",
      record_date: "2026-08-24",
      ...(opts.cancelled ? { status: "בוטל", cancelled_at: new Date().toISOString(), cancel_reason: "TESTGATE" } : {}),
    })
    .select("id")
    .single();
  createdProductions.push(prod!.id);

  const { data: job } = await admin
    .from("jobs")
    .insert({
      client_id: CLIENT_ID,
      campaign: "TESTGATE " + label,
      amount: 600,
      date: "2026-08-24",
      ...(opts.invoice_biz ? { invoice_biz: opts.invoice_biz } : {}),
      ...(opts.paid ? { paid: opts.paid } : {}),
    })
    .select("id")
    .single();
  createdJobs.push(job!.id);

  await admin.from("job_productions").insert({ job_id: job!.id, production_id: prod!.id });
  return { prodId: prod!.id, jobId: job!.id };
}

/** a consolidated, ISSUED work order over the given episodes — the redemption shape */
async function makeConsolidatedOrder(prodIds: string[]): Promise<string> {
  const { data: parent } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      status: "issued",
      production_id: null,
      job_id: null,
      client_id: CLIENT_ID,
      amount: 600 * prodIds.length,
      payload: BASE_PAYLOAD,
      morning_doc_id: "TESTGATE-" + Math.floor(performance.now() * 1000) + "-" + prodIds.length,
      morning_doc_number: "TG" + String(Math.floor(performance.now() * 1000)).slice(-6),
    })
    .select("id")
    .single();
  createdPending.push(parent!.id);

  for (const pid of prodIds) {
    const { data: kid } = await admin
      .from("pending_documents")
      .insert({
        doc_type: "work_order",
        status: "consolidated",
        production_id: pid,
        client_id: CLIENT_ID,
        amount: 600,
        payload: {},
        consolidated_into: parent!.id,
      })
      .select("id")
      .single();
    if (kid) createdPending.push(kid.id);
  }
  return parent!.id;
}

async function main() {
  // ==========================================================================
  console.log("\n=== 0. REGRESSION ON LIVE DATA — is the legitimate path clean TODAY? ===");
  // The claim under test: no job reachable by a real redemption today would be
  // wrongly blocked. If it were, a real September redemption would fail — the
  // exact thing this gate exists to prevent.
  const { data: accrued } = await admin
    .from("pending_documents")
    .select("id,client_id,production_id,amount")
    .eq("doc_type", "work_order")
    .eq("status", "accrued");
  const { data: allClients } = await admin.from("clients").select("id,name");
  const { data: allJp } = await admin.from("job_productions").select("job_id,production_id");
  const { data: allJobs } = await admin.from("jobs").select("id,campaign,invoice_biz,paid");
  const { data: allProds } = await admin.from("productions").select("id,status,cancelled_at,client_id");

  const nameOfClient = new Map((allClients ?? []).map((c) => [c.id, c.name as string]));
  const jobById = new Map((allJobs ?? []).map((j) => [j.id, j]));
  const prodById = new Map((allProds ?? []).map((p) => [p.id, p]));
  const jobsOfProd = new Map<string, string[]>();
  for (const r of allJp ?? []) {
    jobsOfProd.set(r.production_id, [...(jobsOfProd.get(r.production_id) ?? []), r.job_id]);
  }

  // exactly the gate's predicate, applied to what a real redemption resolves
  const verdict = (jobId: string): string | null => {
    const j = jobById.get(jobId);
    if (!j) return "job missing";
    if (j.invoice_biz != null && String(j.invoice_biz).trim() !== "") return "invoice_biz " + j.invoice_biz;
    if (j.paid === "כן") return "paid";
    for (const r of allJp ?? []) {
      if (r.job_id !== jobId) continue;
      const p = prodById.get(r.production_id);
      if (p && (p.cancelled_at || p.status === "בוטל")) return "production cancelled";
    }
    return null;
  };

  const byClient = new Map<string, typeof accrued>();
  for (const a of accrued ?? []) {
    byClient.set(a.client_id!, [...(byClient.get(a.client_id!) ?? []), a] as typeof accrued);
  }
  let wronglyBlocked = 0;
  // forEach, not for..of — this repo's tsconfig target predates downlevelIteration
  byClient.forEach((rows, cid) => {
    const prodIds = (rows ?? []).map((r) => r.production_id).filter(Boolean) as string[];
    const resolved = Array.from(new Set(prodIds.flatMap((p) => jobsOfProd.get(p) ?? [])));
    const blocked = resolved.map((j) => ({ j, why: verdict(j) })).filter((x) => x.why);
    wronglyBlocked += blocked.length;
    console.log(
      "  " + (nameOfClient.get(cid) ?? "?").slice(0, 22).padEnd(23) +
      (rows ?? []).length + " accrued, " + resolved.length + " job(s) resolved, " +
      blocked.length + " would be blocked" +
      (blocked.length ? "  -> " + blocked.map((b) => (jobById.get(b.j)?.campaign ?? b.j) + ": " + b.why).join("; ") : "")
    );
  });
  check(
    "no live accrued client has a resolvable job the gate would wrongly block",
    wronglyBlocked === 0,
    wronglyBlocked + " would be blocked"
  );

  // wider sweep: every production that owns a job, gate verdict across the DB
  let totalLinked = 0;
  const wouldBlock: string[] = [];
  jobsOfProd.forEach((jids, pid) => {
    const p = prodById.get(pid);
    if (!p || p.cancelled_at || p.status === "בוטל") return; // a dead episode is not a legitimate path
    for (const jid of jids) {
      totalLinked++;
      const why = verdict(jid);
      if (why) wouldBlock.push((jobById.get(jid)?.campaign ?? jid) + ": " + why);
    }
  });
  console.log("\n  live linked jobs across the DB: " + totalLinked +
    "  |  would be blocked: " + wouldBlock.length);
  for (const w of wouldBlock.slice(0, 12)) console.log("     " + w);
  console.log("  (a blocked job here is CORRECT when it is already billed or paid —" +
    " it only matters that none of them sits on an accrued, redeemable episode, asserted above)");

  // ==========================================================================
  // synthetic fixtures reuse a real client's show/payload shape, but every row
  // below is new and deleted at the end
  const { data: donor } = await admin
    .from("pending_documents")
    .select("client_id,payload,production_id")
    .eq("morning_doc_number", "10307")
    .single();
  CLIENT_ID = donor!.client_id as string;
  BASE_PAYLOAD = donor!.payload;
  const { data: donorProd } = await admin
    .from("productions")
    .select("show_id")
    .eq("id", donor!.production_id as string)
    .single();
  SHOW_ID = donorProd!.show_id as string;

  console.log("\n=== 1. HAPPY PATH — 4 clean episodes bundle into one invoice ===");
  const clean = [];
  for (let i = 1; i <= 4; i++) clean.push(await makeEpisode("clean " + i));
  const okOrder = await makeConsolidatedOrder(clean.map((c) => c.prodId));
  const okRes = await createDealInvoiceFromWorkOrder(admin, okOrder, null);
  if (okRes.ok) createdPending.push(okRes.id);
  check("4-episode redemption builds", okRes.ok, okRes.ok ? "" : okRes.error);
  if (okRes.ok) {
    const { data: built } = await admin
      .from("pending_documents")
      .select("bundle_job_ids,amount")
      .eq("id", okRes.id)
      .single();
    const got = ((built!.bundle_job_ids as string[]) ?? []).slice().sort();
    check(
      "bundles ALL 4 jobs, no duplicates",
      JSON.stringify(got) === JSON.stringify(clean.map((c) => c.jobId).sort()),
      JSON.stringify(got)
    );
    check("amount inherited from the frozen order, not recomputed", Number(built!.amount) === 2400,
      String(built!.amount));
  }

  console.log("\n=== 2. a job already carrying invoice_biz -> 409, named ===");
  const billed = [await makeEpisode("billed", { invoice_biz: "40999" }), await makeEpisode("with-billed")];
  const billedOrder = await makeConsolidatedOrder(billed.map((b) => b.prodId));
  const rBilled = await createDealInvoiceFromWorkOrder(admin, billedOrder, null);
  if (rBilled.ok) createdPending.push(rBilled.id);
  check("refused", !rBilled.ok, rBilled.ok ? "built unexpectedly" : "");
  if (!rBilled.ok) {
    check("409", rBilled.status === 409, String(rBilled.status));
    check("names the job and the invoice number",
      rBilled.error.includes("TESTGATE billed") && rBilled.error.includes("40999"), rBilled.error);
  }

  console.log("\n=== 3. an already-paid job -> 409 ===");
  const paid = [await makeEpisode("paid", { paid: "כן" }), await makeEpisode("with-paid")];
  const paidOrder = await makeConsolidatedOrder(paid.map((p) => p.prodId));
  const rPaid = await createDealInvoiceFromWorkOrder(admin, paidOrder, null);
  if (rPaid.ok) createdPending.push(rPaid.id);
  check("refused", !rPaid.ok, rPaid.ok ? "built unexpectedly" : "");
  if (!rPaid.ok) {
    check("says already paid", rPaid.error.includes("כבר שולמה"), rPaid.error);
    check("names the job", rPaid.error.includes("TESTGATE paid"), rPaid.error);
  }

  console.log("\n=== 4. a job whose episode was cancelled -> 409 (only reachable since 0060) ===");
  const dead = [await makeEpisode("cancelled", { cancelled: true }), await makeEpisode("with-cancelled")];
  const deadOrder = await makeConsolidatedOrder(dead.map((d) => d.prodId));
  const rDead = await createDealInvoiceFromWorkOrder(admin, deadOrder, null);
  if (rDead.ok) createdPending.push(rDead.id);
  check("refused", !rDead.ok, rDead.ok ? "built unexpectedly" : "");
  if (!rDead.ok) {
    check("says the episode was cancelled", rDead.error.includes("ההפקה שלה בוטלה"), rDead.error);
  }

  console.log("\n=== 5. several offenders -> ONE message listing them all ===");
  const many = [
    await makeEpisode("multi-billed", { invoice_biz: "40998" }),
    await makeEpisode("multi-paid", { paid: "כן" }),
    await makeEpisode("multi-clean"),
  ];
  const manyOrder = await makeConsolidatedOrder(many.map((m) => m.prodId));
  const rMany = await createDealInvoiceFromWorkOrder(admin, manyOrder, null);
  if (rMany.ok) createdPending.push(rMany.id);
  check("refused", !rMany.ok, rMany.ok ? "built unexpectedly" : "");
  if (!rMany.ok) {
    check("counts both offenders", rMany.error.startsWith("2 מהעבודות"), rMany.error);
    check("names both, in one run",
      rMany.error.includes("multi-billed") && rMany.error.includes("multi-paid"), rMany.error);
    check("does not name the clean one", !rMany.error.includes("multi-clean"), rMany.error);
  }

  console.log("\n=== 6. no job at all -> the ORIGINAL diagnosis, not the new gate ===");
  const { data: bareProd } = await admin
    .from("productions")
    .insert({
      podcast_name: "TESTGATE nojob",
      client_id: CLIENT_ID,
      show_id: SHOW_ID,
      kind: "client",
      record_date: "2026-08-24",
    })
    .select("id")
    .single();
  createdProductions.push(bareProd!.id);
  const bareOrder = await makeConsolidatedOrder([bareProd!.id]);
  const rBare = await createDealInvoiceFromWorkOrder(admin, bareOrder, null);
  if (rBare.ok) createdPending.push(rBare.id);
  check("refused", !rBare.ok, rBare.ok ? "built unexpectedly" : "");
  if (!rBare.ok) {
    check("keeps the 'no approved jobs' diagnosis distinct from the new gate",
      rBare.error.includes("לא נמצאו עבודות מאושרות") && !rBare.error.includes("אינן ניתנות לחיוב"),
      rBare.error);
  }
}

main()
  .catch((e) => {
    failures.push("THREW: " + (e as Error).message);
    console.error(e);
  })
  .finally(async () => {
    console.log("\n=== CLEANUP (LIFO) ===");
    for (const id of [...createdPending].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      const { error } = await admin.from("pending_documents").delete().eq("id", id);
      if (error) console.log("  pending " + id + ": " + error.message);
    }
    for (const id of [...createdProductions].reverse()) {
      await admin.from("job_productions").delete().eq("production_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      const { error } = await admin.from("productions").delete().eq("id", id);
      if (error) console.log("  production " + id + ": " + error.message);
    }
    for (const id of [...createdJobs].reverse()) {
      await admin.from("job_productions").delete().eq("job_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      const { error } = await admin.from("jobs").delete().eq("id", id);
      if (error) console.log("  job " + id + ": " + error.message);
    }
    let leaked = 0;
    for (const [table, ids] of [
      ["pending_documents", createdPending],
      ["productions", createdProductions],
      ["jobs", createdJobs],
    ] as [string, string[]][]) {
      if (!ids.length) continue;
      const { data } = await admin.from(table).select("id").in("id", ids);
      if ((data ?? []).length) {
        leaked += (data ?? []).length;
        console.log("  LEAKED in " + table + ": " + JSON.stringify((data ?? []).map((r) => r.id)));
      }
    }
    console.log(leaked === 0 ? "  all test rows deleted, verified" : "  *** " + leaked + " ROWS LEAKED ***");

    console.log("\n=== RESULT ===");
    console.log("passed: " + pass + ", failed: " + failures.length);
    for (const f of failures) console.log("  - " + f);
    process.exit(failures.length || leaked ? 1 : 0);
  });
