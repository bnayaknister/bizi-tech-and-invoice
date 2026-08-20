/**
 * The printed line, end to end: enqueueDocument -> pending_documents.payload,
 * and its inheritance into the deal invoice (owner spec 2026-08-20).
 *
 * Run:  npx tsx scripts/test_line_item_chain.ts
 *
 * TOUCHES MORNING: never. enqueueDocument only reads shows/clients/addons and
 * writes a queue row; the single Morning call in the system lives in issue.ts,
 * behind human approval, and is not on this path.
 *
 * TOUCHES REAL PRODUCTIONS: yes, and that is the point — the guestless form is
 * the default path today, so a synthetic row would not prove the thing that
 * matters. Two real client productions are used, one with a guest and one
 * without. Nothing about them is modified except `billing_block_reason`, which
 * enqueueDocument clears on success; it is captured first and written back.
 * Every row created is deleted in the finally block AND the deletion is
 * verified before this script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { enqueueDocument, buildLineItemText, type ProductionForBilling } from "../src/lib/documents/enqueue";
import { createDealInvoiceFromWorkOrder } from "../src/lib/documents/bundle";
import type { MorningDocumentRequest } from "../src/lib/morning/types";

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

const TAG = "ZLINEITEM";
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// everything this script creates, so the finally block is exhaustive
const made = { pending: [] as string[], jobs: [] as string[], links: [] as { job: string; production: string }[] };
// productions whose billing_block_reason we may have cleared
const blockRestore = new Map<string, string | null>();

type Prod = {
  id: string; podcast_name: string | null; guest: string | null; record_date: string | null;
  kind: string | null; legacy: boolean | null; show_id: string | null; client_id: string | null;
  price_override: number | null; billing_block_reason: string | null;
};

const forBilling = (p: Prod): ProductionForBilling => ({
  id: p.id, kind: p.kind, legacy: p.legacy, client_id: p.client_id, show_id: p.show_id,
  podcast_name: p.podcast_name, record_date: p.record_date, guest: p.guest,
  price_override: p.price_override,
});

async function payloadOf(id: string): Promise<MorningDocumentRequest> {
  const { data } = await admin.from("pending_documents").select("payload").eq("id", id).single();
  return data!.payload as MorningDocumentRequest;
}

async function main() {
  // ---- pick two real, eligible, unbilled client productions ---------------
  const { data: prods } = await admin
    .from("productions")
    .select("id,podcast_name,guest,record_date,kind,legacy,show_id,client_id,price_override,billing_block_reason")
    .eq("kind", "client")
    .eq("legacy", false);
  const { data: live } = await admin.from("pending_documents").select("production_id,doc_type,status");
  const busy = new Set(
    (live ?? [])
      .filter((r) => ["pending", "approved", "issued", "accrued"].includes(r.status as string))
      .map((r) => `${r.production_id}|${r.doc_type}`)
  );
  const { data: shows } = await admin.from("shows").select("id,client_id,billing_mode,default_rate");
  const { data: clients } = await admin.from("clients").select("id,morning_client_id");
  const showById = new Map((shows ?? []).map((s) => [s.id as string, s]));
  const clientOk = new Set((clients ?? []).filter((c) => c.morning_client_id).map((c) => c.id as string));

  const eligible = (p: Prod) => {
    const s = showById.get(p.show_id ?? "");
    if (!s || s.billing_mode !== "per_episode" || !s.client_id) return false;
    if (!clientOk.has(s.client_id as string)) return false;
    if ((p.price_override ?? s.default_rate) == null) return false;
    return !busy.has(`${p.id}|work_order`);
  };
  const all = (prods ?? []) as Prod[];
  const withGuest = all.find((p) => p.guest && p.guest.trim() && eligible(p));
  const noGuest = all.find((p) => !p.guest && eligible(p));
  check("found a real production WITH a guest", !!withGuest, withGuest ? `${withGuest.podcast_name} · ${withGuest.guest}` : "none");
  check("found a real production WITHOUT a guest", !!noGuest, noGuest ? `${noGuest.podcast_name}` : "none");
  if (!withGuest || !noGuest) return;

  // ---- 1. WITH a guest ----------------------------------------------------
  blockRestore.set(withGuest.id, withGuest.billing_block_reason);
  const eg = await enqueueDocument(admin, "work_order", forBilling(withGuest));
  check("1a. enqueued", eg.status === "queued" || eg.status === "accrued", JSON.stringify(eg));
  if (!("id" in eg)) return;
  made.pending.push(eg.id);

  const pg = await payloadOf(eg.id);
  const lineG = pg.income![0].description;
  const expectG = `הזמנת עבודה — ${buildLineItemText(withGuest)}`;
  console.log(`        line: ${JSON.stringify(lineG)}`);
  check("1b. income line carries the guest", lineG.includes(withGuest.guest!.trim()), lineG);
  check("1c. separated by ' · '", lineG.split(" · ").length === 3, lineG);
  check("1d. date is DD.MM.YY, not ISO", /\d{2}\.\d{2}\.\d{2}$/.test(lineG) && !lineG.includes(withGuest.record_date!), lineG);
  check("1e. document description matches the line (unified)", pg.description === expectG, `${pg.description} vs ${expectG}`);
  check("1f. income[0].description == description", pg.income![0].description === pg.description, "");

  // ---- 2. WITHOUT a guest — the default path ------------------------------
  blockRestore.set(noGuest.id, noGuest.billing_block_reason);
  const en = await enqueueDocument(admin, "work_order", forBilling(noGuest));
  check("2a. enqueued", en.status === "queued" || en.status === "accrued", JSON.stringify(en));
  if (!("id" in en)) return;
  made.pending.push(en.id);

  const pn = await payloadOf(en.id);
  const lineN = pn.income![0].description;
  console.log(`        line: ${JSON.stringify(lineN)}`);
  // the label prefix belongs to the document, not to the line's own shape —
  // strip it before asserting on the part this change actually builds
  const bodyN = lineN.replace(/^הזמנת עבודה — /, "");
  const [y, m, d] = (noGuest.record_date ?? "").split("-");
  const wantDate = `${d}.${m}.${y.slice(2)}`;
  check("2b. no orphan separator", !lineN.includes("·") && !/\s{2,}/.test(lineN) && lineN === lineN.trim(), lineN);
  check("2c. no 'undefined' / 'null' leaked", !/undefined|null/.test(lineN), lineN);
  check("2d. ISO date converted to DD.MM.YY", bodyN.endsWith(wantDate) && !bodyN.includes(noGuest.record_date!), `${bodyN} from ${noGuest.record_date}`);
  check("2e. space-separated, show then date", bodyN === `${noGuest.podcast_name} ${wantDate}`, bodyN);

  // ---- 3. inheritance into the deal invoice (300) -------------------------
  // createDealInvoiceFromWorkOrder requires an ISSUED parent with a real
  // Morning id and a job. Issuing is a Morning call, so the parent is built
  // synthetically here — the same shape and the same code path as
  // test_convert_shapes.ts, whose ids are never sent anywhere.
  // Step 1's queue row must go first: the partial unique index from 0025
  // allows exactly ONE live (pending/approved/issued) work order per
  // production, so the synthetic issued parent below would collide with it.
  // Everything step 1 asserts has already been read out of `pg`.
  await admin.from("events").delete().eq("entity_id", eg.id);
  await admin.from("pending_documents").delete().eq("id", eg.id);

  // the production's own client_id can be null (the show carries it) — jobs
  // needs a real one, so fall back the same way enqueueDocument does
  const billTo = withGuest.client_id ?? (showById.get(withGuest.show_id ?? "")?.client_id as string | undefined) ?? null;
  const jobRes = await admin
    .from("jobs")
    .insert({ client_id: billTo, campaign: TAG, amount: 100, date: "2026-01-01" })
    .select("id")
    .single();
  if (jobRes.error || !jobRes.data) {
    check("3-setup. job created", false, jobRes.error?.message ?? "no row returned");
    return;
  }
  const job = jobRes.data.id as string;
  made.jobs.push(job);
  const linkRes = await admin.from("job_productions").insert({ job_id: job, production_id: withGuest.id });
  if (linkRes.error) {
    check("3-setup. job linked to production", false, linkRes.error.message);
    return;
  }
  made.links.push({ job, production: withGuest.id });

  const parentRes = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: withGuest.id,
      client_id: billTo,
      amount: 100,
      status: "issued",
      morning_doc_id: randomUUID(), // real-looking, never sent
      morning_doc_number: "99999",
      payload: { ...pg, income: pg.income },
    })
    .select("id")
    .single();
  if (parentRes.error || !parentRes.data) {
    check("3-setup. synthetic issued parent created", false, parentRes.error?.message ?? "no row returned");
    return;
  }
  const parent = parentRes.data.id as string;
  made.pending.push(parent);

  const conv = await createDealInvoiceFromWorkOrder(admin, parent, null);
  check("3a. deal invoice built from the order", conv.ok, conv.ok ? "" : conv.error);
  if (conv.ok) {
    made.pending.push(conv.id);
    const pd = await payloadOf(conv.id);
    check("3b. income line INHERITED VERBATIM into the 300", pd.income![0].description === lineG, `${pd.income![0].description}`);
    check("3c. the 300 rebuilds its own title (does not inherit it)", pd.description !== pg.description, `${pd.description}`);
  }
}

main()
  .catch((e) => {
    failed++;
    console.log(`  FAIL  script crashed — ${String(e).slice(0, 300)}`);
  })
  .finally(async () => {
    console.log("\n--- cleanup ---");
    for (const id of made.pending) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("pending_documents").delete().eq("id", id);
    }
    for (const l of made.links) await admin.from("job_productions").delete().eq("job_id", l.job).eq("production_id", l.production);
    if (made.jobs.length) await admin.from("jobs").delete().in("id", made.jobs);
    for (const [pid, reason] of Array.from(blockRestore.entries())) {
      await admin.from("productions").update({ billing_block_reason: reason }).eq("id", pid);
      await admin.from("events").delete().eq("entity_id", pid).in("event_type", ["document_queued", "document_accrued", "document_enqueue_blocked"]);
    }
    // verified, not assumed
    if (made.pending.length) {
      const { data } = await admin.from("pending_documents").select("id").in("id", made.pending);
      check("cleanup: queue rows gone", (data ?? []).length === 0, JSON.stringify(data));
    }
    if (made.jobs.length) {
      const { data } = await admin.from("jobs").select("id").in("id", made.jobs);
      check("cleanup: jobs gone", (data ?? []).length === 0, JSON.stringify(data));
    }
    for (const [pid, reason] of Array.from(blockRestore.entries())) {
      const { data } = await admin.from("productions").select("billing_block_reason").eq("id", pid).single();
      check(`cleanup: ${pid.slice(0, 8)} block reason restored`, (data?.billing_block_reason ?? null) === reason, JSON.stringify(data?.billing_block_reason));
    }
    const { count } = await admin.from("pending_documents").select("id", { count: "exact", head: true });
    check("cleanup: pending_documents back to 35", count === 35, String(count));

    console.log(`\n${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
    process.exit(failed ? 1 : 0);
  });
