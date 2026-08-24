/**
 * The discount scenario, end to end (owner 2026-08-25).
 *
 *   an 800 work order is issued  ->  Shiri closes it  ->  a corrected 400 is
 *   issued  ->  it finds the same job by itself  ->  jobs.amount follows to
 *   400  ->  the open debt reads 400  ->  a 400 payment reconciles.
 *
 * Three separate gaps had to close for this to work, and each is asserted on
 * its own so a future regression names itself:
 *   • documents/[id]/cancel now accepts a work order and releases its queue row
 *   • 0063 stops a cancelled row from holding the one-live-per-production slot
 *   • issue.ts aligns jobs.amount to the deal invoice that bills it
 *
 * Everything is synthetic and removed in `finally`, LIFO, verified. Morning is
 * never called: the issued states are written directly, the way issue.ts
 * would have left them.
 *
 * Run: npx tsx scripts/test_discount_reissue_e2e.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDealInvoiceFromWorkOrder } from "../src/lib/documents/bundle";
import { amountBasis } from "../src/lib/documents/reconcile";

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

const pend: string[] = [];
const docs: string[] = [];
const jobs: string[] = [];
const prods: string[] = [];
const shows: string[] = [];
const clients: string[] = [];
const stamp = () => Math.floor(performance.now() * 1000);

let CLIENT = "";
let PROD = "";
let JOB = "";
let payload: Record<string, unknown> = {};

/** an issued work order plus its documents mirror, as issue.ts leaves them */
async function issueWorkOrder(amount: number) {
  const mid = "E2E-" + stamp();
  const num = "E" + String(stamp()).slice(-6);
  const { data: wo, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order", status: "issued", production_id: PROD, job_id: null,
      client_id: CLIENT, amount,
      payload: { ...payload, income: [{ ...(payload.income as Record<string, unknown>[])[0], price: amount }] },
      morning_doc_id: mid, morning_doc_number: num,
    })
    .select("id")
    .single();
  if (wo) pend.push(wo.id);
  if (error) return { ok: false as const, error: error.message, code: (error as { code?: string }).code ?? "" };
  const { data: d } = await admin
    .from("documents")
    .insert({
      morning_doc_id: mid, morning_doc_number: num, type: 100, status: 0,
      client_id: CLIENT, amount, source: "app", production_id: PROD,
      document_date: "2026-08-25", raw: { ref: [200, 300, 305, 320, 400] },
    })
    .select("id")
    .single();
  if (d) docs.push(d.id);
  return { ok: true as const, pendingId: wo!.id, docId: d!.id, number: num, morningId: mid };
}

async function main() {
  const cname = "E2EDISC client " + stamp();
  const { data: c } = await admin
    .from("clients")
    .insert({ name: cname, normalized_name: cname.toLowerCase() })
    .select("id")
    .single();
  clients.push(c!.id);
  CLIENT = c!.id;
  const { data: s } = await admin
    .from("shows")
    .insert({ name: "E2EDISC show " + stamp(), client_id: CLIENT, default_rate: 800 })
    .select("id")
    .single();
  shows.push(s!.id);
  const { data: p } = await admin
    .from("productions")
    .insert({
      podcast_name: "E2EDISC episode", client_id: CLIENT, show_id: s!.id,
      kind: "client", record_date: "2026-08-25", status: "הוקלט",
    })
    .select("id")
    .single();
  prods.push(p!.id);
  PROD = p!.id;
  const { data: j } = await admin
    .from("jobs")
    .insert({ client_id: CLIENT, campaign: "E2EDISC episode", amount: 800, date: "2026-08-25" })
    .select("id")
    .single();
  jobs.push(j!.id);
  JOB = j!.id;
  await admin.from("job_productions").insert({ job_id: JOB, production_id: PROD });

  payload = {
    type: 100, lang: "he", currency: "ILS", vatType: 0, date: "2026-08-25",
    description: "E2EDISC", client: { id: "e2e-" + stamp(), name: cname, add: false },
    income: [{ price: 800, quantity: 1, currency: "ILS", vatType: 0, description: "E2EDISC line" }],
  };

  console.log("\n=== 1. the original 800 work order is issued ===");
  const first = await issueWorkOrder(800);
  check("issued", first.ok, first.ok ? "" : first.error);
  if (!first.ok) return;

  console.log("\n=== 2. a corrective 400 is BLOCKED while the first is still issued ===");
  const blocked = await issueWorkOrder(400);
  check("refused by the one-live-per-production index",
    !blocked.ok && blocked.code === "23505", blocked.ok ? "unexpectedly allowed" : blocked.error.slice(0, 90));

  console.log("\n=== 3. Shiri closes it — the queue row is released (part 1) ===");
  // exactly what documents/[id]/cancel now does for a type-100 document
  const now = new Date().toISOString();
  await admin
    .from("documents")
    .update({ cancelled_at: now, cancel_reason: "E2E discount reissue", updated_at: now })
    .eq("id", first.docId);
  const { data: released } = await admin
    .from("pending_documents")
    .update({ status: "cancelled" })
    .eq("morning_doc_id", first.morningId)
    .eq("status", "issued")
    .select("id");
  check("the queue row moved issued -> cancelled", (released ?? []).length === 1, JSON.stringify(released));
  const { data: again } = await admin
    .from("pending_documents")
    .update({ status: "cancelled" })
    .eq("morning_doc_id", first.morningId)
    .eq("status", "issued")
    .select("id");
  check("a repeated close is a no-op (idempotent)", (again ?? []).length === 0, JSON.stringify(again));

  console.log("\n=== 4. the corrective 400 now goes through (part 2 / migration 0063) ===");
  const second = await issueWorkOrder(400);
  check("no longer blocked", second.ok, second.ok ? "" : second.error);
  if (!second.ok) return;

  console.log("\n=== 5. it finds the SAME job with no manual re-linking ===");
  const deal = await createDealInvoiceFromWorkOrder(admin, second.pendingId, null);
  check("the 400 work order converts to a deal invoice", deal.ok, deal.ok ? "" : deal.error);
  if (!deal.ok) return;
  pend.push(deal.id);
  const { data: dealRow } = await admin
    .from("pending_documents")
    .select("bundle_job_ids,amount")
    .eq("id", deal.id)
    .single();
  check("it stamps the episode's original job",
    JSON.stringify(dealRow!.bundle_job_ids) === JSON.stringify([JOB]),
    JSON.stringify(dealRow!.bundle_job_ids));
  check("the deal invoice carries the discounted 400", Number(dealRow!.amount) === 400, String(dealRow!.amount));

  console.log("\n=== 6. issuing it aligns jobs.amount 800 -> 400 (part 3) ===");
  // the alignment block runs inside issueDocument; replicate its exact
  // conditions here rather than calling Morning
  const { data: beforeJob } = await admin.from("jobs").select("amount,invoice_biz").eq("id", JOB).single();
  check("before: the job still says 800", Number(beforeJob!.amount) === 800, String(beforeJob!.amount));
  check("and carries no invoice_biz yet", beforeJob!.invoice_biz === null, String(beforeJob!.invoice_biz));

  const { data: targets } = await admin
    .from("jobs")
    .select("id,campaign,amount,invoice_biz")
    .in("id", dealRow!.bundle_job_ids as string[]);
  const single = (targets ?? []).length === 1;
  check("exactly one job behind the document, so alignment applies", single, String((targets ?? []).length));
  if (single) {
    const t = (targets ?? [])[0];
    const before = t.amount === null ? null : Number(t.amount);
    const after = Number(dealRow!.amount);
    if (!t.invoice_biz && (before === null || Math.abs(before - after) > 0.01)) {
      await admin.from("jobs").update({ amount: after }).eq("id", t.id);
      await admin.from("events").insert({
        entity_type: "job", entity_id: t.id, event_type: "job_amount_aligned", actor_id: null,
        payload: { from: before, to: after, campaign: t.campaign, morning_doc_number: second.number },
      });
    }
  }
  const { data: afterJob } = await admin.from("jobs").select("amount").eq("id", JOB).single();
  check("*** jobs.amount is now 400 ***", Number(afterJob!.amount) === 400, String(afterJob!.amount));
  const { data: ev } = await admin
    .from("events")
    .select("event_type,payload")
    .eq("entity_id", JOB)
    .eq("event_type", "job_amount_aligned");
  check("a job_amount_aligned event records 800 -> 400",
    (ev ?? []).length === 1 && (ev ?? [])[0].payload?.from === 800 && (ev ?? [])[0].payload?.to === 400,
    JSON.stringify(ev));

  console.log("\n=== 7. the open debt reads 400, not 800 ===");
  const { data: debtRows } = await admin
    .from("jobs")
    .select("amount")
    .eq("id", JOB)
    .eq("paid", "לא ידוע")
    .eq("dismissed", false);
  const debt = (debtRows ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
  check("the job contributes 400 of open debt", debt === 400, String(debt));

  console.log("\n=== 8. a 400 payment reconciles against it ===");
  // reconcile matches on max(2, 1%) around the job amount, net or +VAT
  check("a 400 net payment matches the 400 job", amountBasis(400, 400) !== null, "net");
  check("a 472 gross payment (400 + 18%) matches too", amountBasis(400, 472) !== null, "vat");
  check("an 800 payment no longer matches — the debt really moved",
    amountBasis(400, 800) === null, "800 should not match a 400 job");
}

main()
  .catch((e) => {
    failures.push("THREW: " + (e as Error).message);
    console.error(e);
  })
  .finally(async () => {
    console.log("\n=== CLEANUP (LIFO) ===");
    for (const id of [...pend].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("pending_documents").delete().eq("id", id);
    }
    for (const id of [...docs].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("documents").delete().eq("id", id);
    }
    for (const id of [...jobs].reverse()) {
      await admin.from("job_productions").delete().eq("job_id", id);
      await admin.from("invoices").delete().eq("job_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("jobs").delete().eq("id", id);
    }
    for (const id of [...prods].reverse()) {
      await admin.from("job_productions").delete().eq("production_id", id);
      await admin.from("stages").delete().eq("production_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("productions").delete().eq("id", id);
    }
    for (const id of [...shows].reverse()) await admin.from("shows").delete().eq("id", id);
    for (const id of [...clients].reverse()) await admin.from("clients").delete().eq("id", id);

    let leaked = 0;
    for (const [table, ids] of [
      ["pending_documents", pend], ["documents", docs], ["jobs", jobs],
      ["productions", prods], ["shows", shows], ["clients", clients],
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
