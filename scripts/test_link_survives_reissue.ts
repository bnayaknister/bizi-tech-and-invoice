/**
 * Does closing a work order and issuing a new one break the job link?
 * (owner question 2026-08-25 — read-only diagnosis, no product change.)
 *
 * The claim under test: job↔production (job_productions) is the durable link,
 * and a re-issued work order finds the same job by itself — so there is no
 * "orphaned production" to re-link, and the only real gap is the amount.
 *
 * Everything here is synthetic and removed in `finally`, LIFO, verified.
 * No real production, job or document is touched.
 *
 * Run: npx tsx scripts/test_link_survives_reissue.ts
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

const createdPending: string[] = [];
const createdDocs: string[] = [];
const createdJobs: string[] = [];
const createdProductions: string[] = [];
const createdShows: string[] = [];
const createdClients: string[] = [];

const stamp = () => Math.floor(performance.now() * 1000);

async function main() {
  // ---- the world: one client, one show, one recorded episode, one job -----
  const cname = "ZTESTRL client " + stamp();
  const { data: c } = await admin
    .from("clients")
    .insert({ name: cname, normalized_name: cname.toLowerCase(), morning_client_id: "ztest-" + stamp() })
    .select("id")
    .single();
  createdClients.push(c!.id);
  const { data: s } = await admin
    .from("shows")
    .insert({ name: "ZTESTRL show " + stamp(), client_id: c!.id, default_rate: 600 })
    .select("id")
    .single();
  createdShows.push(s!.id);
  const { data: p } = await admin
    .from("productions")
    .insert({
      podcast_name: "ZTESTRL episode", client_id: c!.id, show_id: s!.id,
      kind: "client", record_date: "2026-08-25", status: "הוקלט",
    })
    .select("id")
    .single();
  createdProductions.push(p!.id);
  const { data: j } = await admin
    .from("jobs")
    .insert({ client_id: c!.id, campaign: "ZTESTRL episode", amount: 600, date: "2026-08-25" })
    .select("id")
    .single();
  createdJobs.push(j!.id);
  await admin.from("job_productions").insert({ job_id: j!.id, production_id: p!.id });

  const payload = {
    type: 100, lang: "he", currency: "ILS", vatType: 0, date: "2026-08-25",
    description: "ZTESTRL work order",
    client: { id: "ztest-morning-" + stamp(), name: cname, add: false },
    income: [{ price: 600, quantity: 1, currency: "ILS", vatType: 0, description: "ZTESTRL line" }],
  };

  /** an ISSUED work order on that episode, mirrored into documents like issue.ts does */
  async function issueWorkOrder(amount: number, label: string) {
    const mid = "ZTESTRL-" + label + "-" + stamp();
    const num = "WO" + String(stamp()).slice(-6);
    const { data: wo } = await admin
      .from("pending_documents")
      .insert({
        doc_type: "work_order", status: "issued", production_id: p!.id, job_id: null,
        client_id: c!.id, amount,
        payload: { ...payload, income: [{ ...payload.income[0], price: amount }] },
        morning_doc_id: mid, morning_doc_number: num,
      })
      .select("id")
      .single();
    createdPending.push(wo!.id);
    const { data: d } = await admin
      .from("documents")
      .insert({
        morning_doc_id: mid, morning_doc_number: num, type: 100, status: 0,
        client_id: c!.id, amount, source: "app", production_id: p!.id,
        document_date: "2026-08-25", raw: { ref: [200, 300, 305, 320, 400] },
      })
      .select("id")
      .single();
    createdDocs.push(d!.id);
    return { pendingId: wo!.id, docId: d!.id, number: num };
  }

  console.log("\n=== 1. the ORIGINAL work order finds the job ===");
  const first = await issueWorkOrder(600, "first");
  const r1 = await createDealInvoiceFromWorkOrder(admin, first.pendingId, null);
  check("original 600 work order converts", r1.ok, r1.ok ? "" : r1.error);
  let firstDealId: string | null = null;
  if (r1.ok) {
    createdPending.push(r1.id);
    firstDealId = r1.id;
    const { data: built } = await admin
      .from("pending_documents")
      .select("bundle_job_ids,amount")
      .eq("id", r1.id)
      .single();
    check("it stamps the episode's job",
      JSON.stringify(built!.bundle_job_ids) === JSON.stringify([j!.id]),
      JSON.stringify(built!.bundle_job_ids));
    check("its amount is the ORIGINAL 600", Number(built!.amount) === 600, String(built!.amount));
  }

  console.log("\n=== 2. close it — does job_productions survive? ===");
  // mirror what documents/[id]/cancel does: flag the doc, clear invoice_biz.
  // Also simulate the issued state first, so there is something to clear.
  await admin.from("jobs").update({ invoice_biz: first.number }).eq("id", j!.id);
  await admin
    .from("documents")
    .update({ cancelled_at: new Date().toISOString(), cancel_reason: "ZTESTRL discount reissue" })
    .eq("id", first.docId);
  await admin.from("jobs").update({ invoice_biz: null }).eq("id", j!.id);
  if (firstDealId) {
    await admin.from("pending_documents").update({ status: "cancelled" }).eq("id", firstDealId);
  }

  const { data: linkAfter } = await admin
    .from("job_productions")
    .select("job_id")
    .eq("production_id", p!.id);
  check("job_productions SURVIVES the cancellation",
    (linkAfter ?? []).length === 1 && (linkAfter ?? [])[0].job_id === j!.id,
    JSON.stringify(linkAfter));
  const { data: jobAfter } = await admin
    .from("jobs")
    .select("id,amount,invoice_biz,dismissed")
    .eq("id", j!.id)
    .single();
  check("the job is back to 'not billed' (invoice_biz cleared)",
    jobAfter!.invoice_biz === null, String(jobAfter!.invoice_biz));
  check("the job still exists and is not dismissed",
    jobAfter!.dismissed === false, JSON.stringify(jobAfter));

  console.log("\n=== 2b. THE BLOCKER: can a second work order even exist on this episode? ===");
  // pending_documents_one_live_per_production is UNIQUE on
  // (doc_type, production_id) WHERE status NOT IN ('rejected','failed').
  // 'cancelled' is NOT in that exclusion list, so the old row keeps the slot.
  let secondBlocked = false;
  let blockErr = "";
  {
    const mid = "ZTESTRL-blocked-" + stamp();
    const { error } = await admin.from("pending_documents").insert({
      doc_type: "work_order", status: "issued", production_id: p!.id, job_id: null,
      client_id: c!.id, amount: 400, payload,
      morning_doc_id: mid, morning_doc_number: "WOX" + String(stamp()).slice(-5),
    });
    secondBlocked = !!error;
    blockErr = error?.message ?? "";
  }
  check("a second live work order on the same episode is REFUSED by the unique index",
    secondBlocked, blockErr || "insert unexpectedly succeeded");
  console.log("     " + blockErr.slice(0, 140));

  // release the slot the way the index actually allows — 'rejected'/'failed'
  // are the ONLY statuses it ignores; 'cancelled' is not one of them
  await admin.from("pending_documents").update({ status: "rejected", reject_reason: "ZTESTRL reissue with discount" })
    .eq("id", first.pendingId);
  const { data: freed } = await admin
    .from("pending_documents")
    .select("status")
    .eq("id", first.pendingId)
    .single();
  check("moving the old order to 'rejected' frees the slot", freed!.status === "rejected", String(freed!.status));

  console.log("\n=== 3. a NEW discounted work order — does it find the SAME job on its own? ===");
  const second = await issueWorkOrder(400, "second");
  const r2 = await createDealInvoiceFromWorkOrder(admin, second.pendingId, null);
  check("new 400 work order converts", r2.ok, r2.ok ? "" : r2.error);
  if (r2.ok) {
    createdPending.push(r2.id);
    const { data: built2 } = await admin
      .from("pending_documents")
      .select("bundle_job_ids,amount")
      .eq("id", r2.id)
      .single();
    check("it found the SAME job with NO manual re-linking",
      JSON.stringify(built2!.bundle_job_ids) === JSON.stringify([j!.id]),
      JSON.stringify(built2!.bundle_job_ids));
    check("the new document carries the DISCOUNTED 400",
      Number(built2!.amount) === 400, String(built2!.amount));

    // ---- THE GAP ----------------------------------------------------------
    const { data: jobNow } = await admin.from("jobs").select("amount").eq("id", j!.id).single();
    console.log("\n     document amount : 400");
    console.log("     job amount      : " + jobNow!.amount);
    check("*** THE ONLY GAP: the job still says 600, not 400 ***",
      Number(jobNow!.amount) === 600, "job=" + jobNow!.amount);
    console.log("     -> /finance and the radar sum jobs.amount, so 200 of ghost debt remains");
  }

  console.log("\n=== 4. how could a production ever LOSE its job? ===");
  console.log("     writers of job_productions, whole codebase:");
  console.log("       • the DB trigger (ensure_job_for_production) — INSERT only");
  console.log("       • /api/jobs/link  action='unlink' — the linking screen, deliberate");
  console.log("       • FK ON DELETE CASCADE from jobs or productions");
  console.log("     nothing in the document paths writes it (verified by grep)");
  const { data: allProds } = await admin
    .from("productions")
    .select("id,status,cancelled_at,kind,podcast_name");
  const { data: allJp } = await admin.from("job_productions").select("production_id");
  const linked = new Set((allJp ?? []).map((r) => r.production_id));
  const AT_OR_AFTER = ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח", 'אושר_ע"י_לקוח', "הופץ"];
  const orphans = (allProds ?? []).filter(
    (x) => AT_OR_AFTER.includes(x.status as string) && x.kind === "client" &&
      !x.cancelled_at && !linked.has(x.id) && !createdProductions.includes(x.id)
  );
  console.log("\n     REAL recorded episodes with NO job today: " + orphans.length);
  for (const o of orphans.slice(0, 10)) {
    console.log("       " + (o.podcast_name ?? "").slice(0, 30).padEnd(31) + o.status);
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
      await admin.from("pending_documents").delete().eq("id", id);
    }
    for (const id of [...createdDocs].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("documents").delete().eq("id", id);
    }
    for (const id of [...createdJobs].reverse()) {
      await admin.from("job_productions").delete().eq("job_id", id);
      await admin.from("invoices").delete().eq("job_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("jobs").delete().eq("id", id);
    }
    for (const id of [...createdProductions].reverse()) {
      await admin.from("job_productions").delete().eq("production_id", id);
      await admin.from("stages").delete().eq("production_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("productions").delete().eq("id", id);
    }
    for (const id of [...createdShows].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("shows").delete().eq("id", id);
    }
    for (const id of [...createdClients].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("clients").delete().eq("id", id);
    }
    let leaked = 0;
    for (const [table, ids] of [
      ["pending_documents", createdPending], ["documents", createdDocs],
      ["jobs", createdJobs], ["productions", createdProductions],
      ["shows", createdShows], ["clients", createdClients],
    ] as [string, string[]][]) {
      if (!ids.length) continue;
      const { data } = await admin.from(table).select("id").in("id", ids);
      if ((data ?? []).length) {
        leaked += (data ?? []).length;
        console.log("  LEAKED in " + table + ": " + (data ?? []).length);
      }
    }
    console.log(leaked === 0 ? "  all test rows deleted, verified" : "  *** " + leaked + " ROWS LEAKED ***");
    console.log("\n=== RESULT ===");
    console.log("passed: " + pass + ", failed: " + failures.length);
    for (const f of failures) console.log("  - " + f);
    process.exit(failures.length || leaked ? 1 : 0);
  });
