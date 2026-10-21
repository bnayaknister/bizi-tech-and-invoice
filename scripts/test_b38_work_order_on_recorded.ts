/**
 * B38-1 — the work order is born when the recording is done, with the job
 * (owner decisions 21.10). Pure: an in-memory store (scripts/_fake_db.ts), no
 * Supabase, no Morning, no network.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_b38_work_order_on_recorded.ts
 *
 * Under test: enqueueDocument's deferPerEpisode (the creation paths, switch
 * on), enqueueWorkOrderWhenPerformed (the moment of recording), becamePerformed
 * (the transition test), the switch, and the wiring of every call site.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { fakeDb } from "./_fake_db";
import { enqueueDocument, type ProductionForBilling } from "../src/lib/documents/enqueue";
import {
  becamePerformed,
  enqueueWorkOrderWhenPerformed,
  isWorkOrderOnRecordedOn,
} from "../src/lib/documents/workOrderOnRecorded";

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const C_EP = "c0000000-0000-4000-8000-000000000001"; // per_episode, mapped
const C_MONTH = "c0000000-0000-4000-8000-000000000002"; // monthly, mapped
const C_UNMAPPED = "c0000000-0000-4000-8000-000000000003";
const S_EP = "50000000-0000-4000-8000-000000000001";
const S_HOUR = "50000000-0000-4000-8000-000000000002";
const S_MONTH = "50000000-0000-4000-8000-000000000003";
const S_UNMAPPED = "50000000-0000-4000-8000-000000000004";
const JOB = "10000000-0000-4000-8000-000000000001";

const base = () => ({
  clients: [
    { id: C_EP, name: "לקוח פרק", morning_client_id: "m-1", billing_cadence: "per_episode", status: "active" },
    { id: C_MONTH, name: "לקוח חודשי", morning_client_id: "m-2", billing_cadence: "monthly", status: "active" },
    { id: C_UNMAPPED, name: "לא ממופה", morning_client_id: null, billing_cadence: "per_episode", status: "active" },
  ],
  shows: [
    { id: S_EP, client_id: C_EP, billing_mode: "per_episode", default_rate: 800, pricing_model: "per_episode", hourly_rate: null },
    { id: S_HOUR, client_id: C_EP, billing_mode: "per_episode", default_rate: null, pricing_model: "per_hour", hourly_rate: 300 },
    { id: S_MONTH, client_id: C_MONTH, billing_mode: "per_episode", default_rate: 500, pricing_model: "per_episode", hourly_rate: null },
    { id: S_UNMAPPED, client_id: C_UNMAPPED, billing_mode: "per_episode", default_rate: 500, pricing_model: "per_episode", hourly_rate: null },
  ],
  productions: [] as Record<string, unknown>[],
  pending_documents: [] as Record<string, unknown>[],
  job_productions: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  contracts: [] as Record<string, unknown>[],
});
const prod = (id: string, o: Record<string, unknown> = {}) => ({
  id, kind: "client", legacy: false, client_id: C_EP, show_id: S_EP, podcast_name: "תוכנית", record_date: "2026-10-22",
  guest: null, price_override: null, status: "עתיד_להתחיל", studio_hours: null, cancelled_at: null, merged_into: null,
  billing_block_reason: null, ...o,
});
const P = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function main() {
  console.log("\n=== 1. becamePerformed: a move INTO a performed status ===");
  eq("עתיד_להתחיל → הוקלט", becamePerformed("עתיד_להתחיל", "הוקלט"), true);
  eq("בהקלטה → בעריכה", becamePerformed("בהקלטה", "בעריכה"), true);
  eq("עתיד_להתחיל → נשלח_ללקוח (a manual jump)", becamePerformed("עתיד_להתחיל", "נשלח_ללקוח"), true);
  eq("עתיד_להתחיל → בהקלטה (started, not done)", becamePerformed("עתיד_להתחיל", "בהקלטה"), false);
  eq("בעריכה → נערך (already performed)", becamePerformed("בעריכה", "נערך"), false);
  eq("הוקלט → בוטל", becamePerformed("הוקלט", "בוטל"), false);

  console.log("\n=== 2. creation (sync / manual) with the switch ON: per_episode waits ===");
  {
    const db = fakeDb({ ...base(), productions: [prod(P(1))] });
    const r = await enqueueDocument(db.client, "work_order", prod(P(1)) as ProductionForBilling, { deferPerEpisode: true });
    eq("per_episode -> deferred", r, { status: "deferred" });
    eq("…no queue row", db.store.pending_documents.length, 0);
    ok("…an event says so", db.store.events.some((e) => e.event_type === "work_order_deferred_until_recorded" && e.entity_id === P(1)));
  }
  {
    const p = prod(P(2), { client_id: C_MONTH, show_id: S_MONTH });
    const db = fakeDb({ ...base(), productions: [p] });
    const r = await enqueueDocument(db.client, "work_order", p as ProductionForBilling, { deferPerEpisode: true });
    eq("monthly client -> still accrued at creation (owner decision 2)", r.status, "accrued");
    eq("…one accrued row", db.store.pending_documents.map((d) => d.status), ["accrued"]);
  }
  {
    const p = prod(P(3), { client_id: C_UNMAPPED, show_id: S_UNMAPPED });
    const db = fakeDb({ ...base(), productions: [p] });
    const r = await enqueueDocument(db.client, "work_order", p as ProductionForBilling, { deferPerEpisode: true });
    ok("an unmapped client -> still blocked with the 🟡, the same morning", r.status === "blocked" && !!(db.store.productions[0].billing_block_reason as string | null), { r, row: db.store.productions[0] });
  }
  {
    const db = fakeDb({ ...base(), productions: [prod(P(4))] });
    const r = await enqueueDocument(db.client, "work_order", prod(P(4)) as ProductionForBilling);
    eq("switch OFF (no option) -> queued at creation, exactly as before", r.status, "queued");
  }

  console.log("\n=== 3. the moment of recording ===");
  {
    const p = prod(P(10), { status: "הוקלט" });
    const db = fakeDb({ ...base(), productions: [p], job_productions: [{ job_id: JOB, production_id: P(10) }] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(10));
    eq("performed per_episode -> queued", r.status, "queued");
    eq("…one pending row, 800, carrying the job from birth", db.store.pending_documents.map((d) => [d.status, d.amount, d.job_id]), [["pending", 800, JOB]]);
    const again = await enqueueWorkOrderWhenPerformed(db.client, P(10));
    eq("a second call (a double tap) -> has-order, no second row", [again, db.store.pending_documents.length], [{ status: "skipped", reason: "has-order" }, 1]);
  }
  for (const [label, o, want] of [
    ["not performed (בהקלטה)", { status: "בהקלטה" }, "not-performed"],
    ["not performed (עתיד_להתחיל)", { status: "עתיד_להתחיל" }, "not-performed"],
    ["cancelled", { status: "בוטל", cancelled_at: "2026-10-21T10:00:00Z" }, "not-performed"],
    ["merged away", { status: "הוקלט", merged_into: P(99) }, "not-performed"],
    ["internal", { status: "הוקלט", kind: "internal" }, "not-billable"],
    ["legacy", { status: "הוקלט", legacy: true }, "not-billable"],
    ["hourly with no hours (the hours route queues it)", { status: "הוקלט", show_id: S_HOUR }, "hours-pending"],
  ] as [string, Record<string, unknown>, string][]) {
    const db = fakeDb({ ...base(), productions: [prod(P(20), o)] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(20));
    eq(`${label} -> skipped (${want}), nothing written`, [r, db.store.pending_documents.length], [{ status: "skipped", reason: want }, 0]);
  }
  {
    const db = fakeDb({ ...base(), productions: [prod(P(21), { status: "הוקלט", show_id: S_HOUR, studio_hours: 2 })] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(21));
    eq("hourly WITH hours -> queued (2 × 300)", [r.status, db.store.pending_documents[0]?.amount], ["queued", 600]);
  }
  for (const st of ["pending", "approved", "issued", "accrued", "consolidated", "rejected", "failed"]) {
    const db = fakeDb({ ...base(), productions: [prod(P(30), { status: "הוקלט" })], pending_documents: [{ id: P(31), production_id: P(30), doc_type: "work_order", status: st }] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(30));
    eq(`an existing '${st}' order -> has-order`, r, { status: "skipped", reason: "has-order" });
  }
  {
    const db = fakeDb({ ...base(), productions: [prod(P(40), { status: "בעריכה" })], pending_documents: [{ id: P(41), production_id: P(40), doc_type: "work_order", status: "cancelled" }] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(40));
    eq("a CANCELLED order (the cut-over) -> a new one is queued", [r.status, db.store.pending_documents.length], ["queued", 2]);
  }
  {
    const db = fakeDb({ ...base(), productions: [prod(P(50), { status: "נשלח_ללקוח", client_id: C_MONTH, show_id: S_MONTH })] });
    const r = await enqueueWorkOrderWhenPerformed(db.client, P(50));
    eq("monthly client recorded with no accrued row yet -> accrued", r.status, "accrued");
  }

  console.log("\n=== 4. the switch ===");
  {
    const saved = process.env.WORK_ORDER_ON_RECORDED;
    delete process.env.WORK_ORDER_ON_RECORDED;
    ok("unset -> off", !isWorkOrderOnRecordedOn());
    process.env.WORK_ORDER_ON_RECORDED = "TRUE";
    ok("'TRUE' -> off (exactly 'true' only)", !isWorkOrderOnRecordedOn());
    process.env.WORK_ORDER_ON_RECORDED = "true";
    ok("'true' -> on", isWorkOrderOnRecordedOn());
    if (saved === undefined) delete process.env.WORK_ORDER_ON_RECORDED;
    else process.env.WORK_ORDER_ON_RECORDED = saved;
  }

  console.log("\n=== 5. the wiring (source) ===");
  {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
    const sync = read("src/lib/calendar/createProductionFromEvent.ts");
    ok("calendar sync: deferPerEpisode from the switch", sync.includes("{ deferPerEpisode: isWorkOrderOnRecordedOn() }"));
    const manual = read("src/app/api/productions/route.ts");
    ok("manual new production: deferPerEpisode from the switch", manual.includes("{ deferPerEpisode: isWorkOrderOnRecordedOn() }"));
    const stage = read("src/app/api/entity/[type]/[id]/route.ts");
    ok("stage update: status before + after, then the helper", stage.includes("becamePerformed(before?.status") && stage.includes("enqueueWorkOrderWhenPerformed(admin, params.id)"));
    const status = read("src/app/api/productions/[id]/route.ts");
    ok("manual status / board drag: the helper, BEFORE the deal invoice", status.indexOf("enqueueWorkOrderWhenPerformed(admin, id)") > 0 && status.indexOf("enqueueWorkOrderWhenPerformed(admin, id)") < status.indexOf('if (body.status === \'אושר_ע"י_לקוח\') {'));
    const review = read("src/lib/review/links.ts");
    ok("client approval through a link: the helper before the deal invoice", review.indexOf("enqueueWorkOrderWhenPerformed(admin, productionId)") > 0 && review.indexOf("enqueueWorkOrderWhenPerformed(admin, productionId)") < review.indexOf('enqueueDocument(admin, "deal_invoice"'));
  }

  eq("no network call", fetchCalls, 0);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
