/**
 * B38-2 / B38-3 / B38-4 — the 21:00 safety net, the orphan-document alert and
 * card, and the cut-over plan. Pure: an in-memory store, no Supabase, no
 * Morning, no Meta (WhatsApp in DRY_RUN — rows are recorded, nothing is sent).
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_b38_safety_net.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { fakeDb } from "./_fake_db";
import { isBillableProduction, minusDays, planUnrecordedCheck, unrecordedLine, type UnrecordedRow } from "../src/lib/productions/unrecorded";
import { findOrphans, orphanLine } from "../src/lib/documents/orphanDocs";
import { notifyOrphanDoc } from "../src/lib/documents/orphanDocs.server";
import { planCutover } from "../src/lib/documents/b38Cutover";
import {
  TEMPLATE_OPS_ALERT,
  TEMPLATE_OPS_ALERT_TEXT,
  isTemplateApproved,
  opsAlertParam,
  recordBookingNotification,
  templatePlaceholders,
} from "../src/lib/whatsapp/notify";

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

const TODAY = "2026-10-21";
const modes = new Map<string, string | null>([["s-ep", "per_episode"], ["s-none", "none"], ["s-contract", "contract"]]);
const row = (id: string, o: Partial<UnrecordedRow> = {}): UnrecordedRow => ({
  id, kind: "client", legacy: false, status: "עתיד_להתחיל", record_date: TODAY, record_time: "16:00",
  podcast_name: "פודקאסט אילון לוי", guest: "Benny Gantz", show_id: "s-ep", cancelled_at: null, merged_into: null, ...o,
});

async function main() {
  console.log("\n=== 1. B38-2: who is on the 21:00 list, who is swept ===");
  eq("minusDays: 21.10 - 13 = 8.10", minusDays(TODAY, 13), "2026-10-08");
  eq("minusDays across a month", minusDays("2026-11-02", 3), "2026-10-30");
  {
    const rows = [
      row("a"),                                                   // today, not recorded -> list
      row("b", { record_date: "2026-10-08", status: "בהקלטה" }),   // 13 days ago, started only -> list
      row("c", { record_date: "2026-10-07" }),                    // 14 days ago -> out of the window
      row("d", { record_date: "2026-10-22" }),                    // tomorrow -> not yet
      row("e", { status: "הוקלט" }),                              // recorded -> swept
      row("f", { kind: "internal" }),                             // internal -> no
      row("g", { show_id: "s-none" }),                            // billing none -> no
      row("h", { show_id: "s-contract" }),                        // contract -> no
      row("i", { cancelled_at: "2026-10-21T09:00:00Z", status: "בוטל" }), // cancelled -> no
      row("j", { merged_into: "x" }),                             // merged -> no
      row("k", { legacy: true }),                                 // legacy -> no
      row("l", { status: "נשלח_ללקוח", record_date: "2026-10-15" }), // performed earlier -> swept
    ];
    const plan = planUnrecordedCheck(rows, modes, TODAY);
    eq("the list: a + b (billable clients only, owner decision 5)", plan.unrecorded.map((r) => r.id).sort(), ["a", "b"]);
    eq("…sorted by date", plan.unrecorded.map((r) => r.id), ["b", "a"]);
    eq("the sweep: the performed billable ones (e, l)", plan.toSweep.map((r) => r.id).sort(), ["e", "l"]);
    ok("isBillableProduction: a per_episode client production", isBillableProduction(row("z"), modes));
    eq("the WhatsApp line", unrecordedLine([row("a"), row("b", { podcast_name: "שומעת רגע?!", guest: null, record_date: "2026-10-08", record_time: "11:30" })]), "פודקאסט אילון לוי 21.10 16:00 (Benny Gantz) · שומעת רגע?! 8.10 11:30");
  }

  console.log("\n=== 2. the ops-alert template (to submit to Meta) ===");
  eq("three placeholders, in order", templatePlaceholders(TEMPLATE_OPS_ALERT_TEXT), [1, 2, 3]);
  ok("the text does not start or end with a placeholder (Meta's rule)", !TEMPLATE_OPS_ALERT_TEXT.trim().startsWith("{{") && !TEMPLATE_OPS_ALERT_TEXT.trim().endsWith("}}"));
  ok("no two placeholders side by side", !/\}\}\s*\{\{/.test(TEMPLATE_OPS_ALERT_TEXT));
  eq("a parameter is one line", opsAlertParam("שורה\nשנייה\t ושלישית"), "שורה שנייה ושלישית");
  eq("…and bounded (300)", Array.from(opsAlertParam("א".repeat(400))).length, 300);
  {
    const saved = process.env.WHATSAPP_TEMPLATES_APPROVED;
    delete process.env.WHATSAPP_TEMPLATES_APPROVED;
    ok("not approved until Meta approves it", !isTemplateApproved(TEMPLATE_OPS_ALERT));
    process.env.WHATSAPP_TEMPLATES_APPROVED = "bizi_other, bizi_ops_alert";
    ok("…turned on from the environment, no code change", isTemplateApproved(TEMPLATE_OPS_ALERT));
    process.env.WHATSAPP_TEMPLATES_APPROVED = "bizi_made_up";
    ok("…an unknown name in the list approves nothing", !isTemplateApproved("bizi_made_up"));
    if (saved === undefined) delete process.env.WHATSAPP_TEMPLATES_APPROVED;
    else process.env.WHATSAPP_TEMPLATES_APPROVED = saved;
  }

  console.log("\n=== 3. B38-3: the orphan document ===");
  {
    const pending = [
      { id: "pd1", doc_type: "work_order", status: "issued", morning_doc_id: "m1", morning_doc_number: "10357", production_id: "p1" },
      { id: "pd2", doc_type: "work_order", status: "issued", morning_doc_id: "m2", morning_doc_number: "10354", production_id: "p2" },
      { id: "pd3", doc_type: "deal_invoice", status: "issued", morning_doc_id: "m3", morning_doc_number: "40400", production_id: "p3" },
      { id: "pd4", doc_type: "work_order", status: "pending", morning_doc_id: null, morning_doc_number: null, production_id: "p1" },
      { id: "pd5", doc_type: "work_order", status: "issued", morning_doc_id: "m5", morning_doc_number: "10360", production_id: "p5" },
      { id: "pd6", doc_type: "work_order", status: "issued", morning_doc_id: "m6", morning_doc_number: "10361", production_id: "p6" },
    ];
    const prods = [
      { id: "p1", podcast_name: "פודקאסט אילון לוי", record_date: "2026-10-21", guest: "Benny Gantz", status: "בוטל", cancelled_at: "2026-10-21T09:30:05Z", calendar_removed: true, merged_into: null },
      { id: "p2", podcast_name: "פודקאסט אילון לוי", record_date: "2026-10-18", guest: "עמיחי שיקלי", status: "בוטל", cancelled_at: "2026-10-18T19:48:29Z", calendar_removed: false, merged_into: null },
      { id: "p3", podcast_name: "נדל״ן", record_date: "2026-10-20", guest: null, status: "הופץ", cancelled_at: null, calendar_removed: true, merged_into: null },
      { id: "p5", podcast_name: "חי", record_date: "2026-10-20", guest: null, status: "בעריכה", cancelled_at: null, calendar_removed: false, merged_into: null },
      { id: "p6", podcast_name: "ממוזג", record_date: "2026-10-20", guest: null, status: "בוטל", cancelled_at: "2026-10-20T10:00:00Z", calendar_removed: false, merged_into: "p1" },
    ];
    const registry = [
      { id: "r1", morning_doc_id: "m1", status: 0, cancelled_at: null, source: "app" },   // 10357 open
      { id: "r2", morning_doc_id: "m2", status: 2, cancelled_at: null, source: "app" },   // 10354 closed manually
    ];
    const o = findOrphans(pending, prods, registry);
    eq("10357 (open) and 40400 (not pulled yet) — 10354 is closed, the live / merged / pending ones are not orphans", o.map((x) => x.number), ["10357", "40400"]);
    eq("…10357 carries its registry row for 'בטל ב-Morning'", [o[0].registryId, o[0].reason, o[0].morningStatus], ["r1", "cancelled", 0]);
    eq("…40400: gone from the calendar, not pulled yet (no button)", [o[1].registryId, o[1].reason], [null, "calendar_removed"]);
    eq("the line", orphanLine(o[0]), "הזמנת עבודה 10357 · פודקאסט אילון לוי · 21.10 · Benny Gantz");
  }
  {
    // the WhatsApp, DRY_RUN: owner + bookkeeper, once per document
    const env = { n: process.env.WHATSAPP_NOTIFY_NUMBERS, b: process.env.WHATSAPP_BILLING_NOTIFY_NUMBERS, a: process.env.WHATSAPP_TEMPLATES_APPROVED, d: process.env.WHATSAPP_DRY_RUN };
    process.env.WHATSAPP_NOTIFY_NUMBERS = "972528933975,972541112222";
    process.env.WHATSAPP_BILLING_NOTIFY_NUMBERS = "0507654321";
    process.env.WHATSAPP_TEMPLATES_APPROVED = "bizi_ops_alert";
    delete process.env.WHATSAPP_DRY_RUN;
    const db = fakeDb({ wa_messages: [], events: [] }, { unique: [{ table: "wa_messages", cols: ["wamid"] }] });
    const o = { pendingId: "pd1", docType: "work_order", number: "10357", showName: "פודקאסט אילון לוי", recordDate: "2026-10-21", guest: "Benny Gantz", reason: "cancelled" as const };
    await notifyOrphanDoc(db.client as never, o);
    await notifyOrphanDoc(db.client as never, o);
    const rows = db.store.wa_messages as { wa_id: string; template_name: string; status: string; body: string }[];
    eq("billing audience = the owner (first) + the bookkeeper (WHATSAPP_BILLING_NOTIFY_NUMBERS) — not the second notify number", rows.map((r) => r.wa_id).sort(), ["972507654321", "972528933975"]);
    ok("…template bizi_ops_alert, dry_run (nothing sent)", rows.every((r) => r.template_name === "bizi_ops_alert" && r.status === "dry_run"), rows);
    ok("…the body names the document and what to do", rows[0]?.body.includes("10357") && rows[0]?.body.includes("בטל ב-Morning"), rows[0]?.body);
    eq("…a second call for the same document sends nothing new", rows.length, 2);
    // not approved yet -> nothing recorded, no throw
    delete process.env.WHATSAPP_TEMPLATES_APPROVED;
    const db2 = fakeDb({ wa_messages: [], events: [] }, { unique: [{ table: "wa_messages", cols: ["wamid"] }] });
    const r2 = await recordBookingNotification(db2.client as never, { kind: "ops-alert", subjectId: "x", audience: "owner", title: "t", details: "d", action: "a" });
    ok("template not approved: skipped (unapproved), nothing recorded", (r2 as { unapproved?: boolean }).unapproved === true && db2.store.wa_messages.length === 0, r2);
    for (const [k, v] of [["WHATSAPP_NOTIFY_NUMBERS", env.n], ["WHATSAPP_BILLING_NOTIFY_NUMBERS", env.b], ["WHATSAPP_TEMPLATES_APPROVED", env.a], ["WHATSAPP_DRY_RUN", env.d]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  console.log("\n=== 4. B38-4: the cut-over plan ===");
  {
    const rows = [
      { id: "q1", doc_type: "work_order", status: "pending", production_id: "x1", amount: 800 },  // not recorded -> cancel
      { id: "q2", doc_type: "work_order", status: "pending", production_id: "x2", amount: 800 },  // recorded -> keep
      { id: "q3", doc_type: "work_order", status: "approved", production_id: "x1", amount: 800 }, // mid-issue -> keep
      { id: "q4", doc_type: "work_order", status: "accrued", production_id: "x1", amount: 800 },  // monthly -> keep
      { id: "q5", doc_type: "deal_invoice", status: "pending", production_id: "x1", amount: 800 }, // not a work order -> keep
      { id: "q6", doc_type: "work_order", status: "pending", production_id: "x3", amount: 800 },  // internal -> keep
      { id: "q7", doc_type: "work_order", status: "pending", production_id: "x4", amount: 800 },  // started (בהקלטה) -> cancel
      { id: "q8", doc_type: "work_order", status: "pending", production_id: null, amount: 800 },  // no production (misc) -> keep
    ];
    const prods = [
      { id: "x1", kind: "client", status: "עתיד_להתחיל", cancelled_at: null, merged_into: null, podcast_name: "א", record_date: "2026-10-22" },
      { id: "x2", kind: "client", status: "הוקלט", cancelled_at: null, merged_into: null, podcast_name: "ב", record_date: "2026-10-21" },
      { id: "x3", kind: "internal", status: "עתיד_להתחיל", cancelled_at: null, merged_into: null, podcast_name: "ג", record_date: "2026-10-22" },
      { id: "x4", kind: "client", status: "בהקלטה", cancelled_at: null, merged_into: null, podcast_name: "ד", record_date: "2026-10-22" },
    ];
    const plan = planCutover(rows, prods);
    eq("cancel only pending work orders of client productions not yet recorded", plan.toCancel.map((r) => r.id), ["q1", "q7"]);
    eq("…everything else kept", plan.kept, 6);
  }

  console.log("\n=== 5. the wiring (source) ===");
  {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
    const cron = JSON.parse(read("vercel.json")).crons as { path: string; schedule: string }[];
    eq("vercel.json: two triggers at 18:00 / 19:00 UTC", cron.filter((c) => c.path === "/api/cron/unrecorded-check").map((c) => c.schedule), ["0 18 * * *", "0 19 * * *"]);
    const route = read("src/app/api/cron/unrecorded-check/route.ts");
    ok("the route: CRON_SECRET, the 21:00 Israel gate, the sweep, the owner alert", route.includes("CRON_SECRET") && route.includes("hour !== 21") && route.includes("enqueueWorkOrderWhenPerformed") && route.includes('audience: "owner"'));
    const radar = read("src/modules/radar/alerts.ts");
    ok("the radar card for past days", radar.includes('key: "not_marked_recorded"'));
    const cancel = read("src/app/api/productions/[id]/cancel/route.ts");
    ok("the cancel route alerts on an orphaned document", cancel.includes("notifyOrphanDoc(admin"));
    const sync = read("src/app/api/calendar/sync/route.ts");
    ok("the sync's 'removed' flag alerts on an issued document", sync.includes('reason: "calendar_removed"'));
    const page = read("src/app/documents/page.tsx");
    ok("the queue shows the orphan card", page.includes("<OrphanDocsCard"));
    const card = read("src/app/documents/OrphanDocsCard.tsx");
    ok("…its button is the existing E11 route", card.includes("/cancel-in-morning"));
    ok("…the client card imports only the pure half", !card.includes("orphanDocs.server"));
    const script = read("scripts/b38_cutover.ts");
    ok("the cut-over script is dry by default and guards 'pending' in the UPDATE", script.includes('process.argv.includes("--apply")') && /\.update\(\{ status: "cancelled" \}\)[\s\S]{0,80}\.eq\("status", "pending"\)/.test(script));
  }

  eq("no network call", fetchCalls, 0);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
