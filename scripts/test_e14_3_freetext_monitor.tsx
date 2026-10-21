/**
 * E14-3 — free text for everyone: the gate's "unset = everyone", the
 * monitoring trail, the 21:30 owner summary, and the review screen.
 * Pure + runFlow on the in-memory store + render + source reads. No network.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e14_3_freetext_monitor.tsx
 */
import React from "react";
import { readFileSync } from "fs";
import { join } from "path";
import { renderToString } from "react-dom/server";
import { fakeDb } from "./_fake_db";
import { isFreeTextOnFor, parseFreeTextAllowlist, runFlow, type FlowDeps } from "../src/lib/whatsapp/flow/run";
import type { ContactShow } from "../src/lib/booking/contacts";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";
import {
  FREETEXT_BOOKING_EVENT,
  FREETEXT_EVENT,
  classifyFreeText,
  countDay,
  monitorDay,
  replyText,
  summaryParams,
} from "../src/lib/whatsapp/freetextMonitor";
import { FreeTextMissList } from "../src/app/settings/freetext/FreeTextMissList";

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

const ME = "972528933975";
const NOW = new Date("2026-10-26T09:00:00Z"); // Monday 12:00 Israel
const SHOW: ContactShow = { showId: "11111111-1111-1111-1111-111111111111", showName: "תוכנית א", contactName: "בדיקה", defaultStudio: "חשמונאים" };
const text = (body: string): InboundMessage =>
  ({ wamid: `w-${Math.random()}`, waId: ME, rawFrom: ME, type: "text", body, raw: null }) as InboundMessage;
const deps: FlowDeps = {
  ensureBookingLink: (async () => ({ ok: true, token: "tok", linkId: "link-1", created: false })) as unknown as FlowDeps["ensureBookingLink"],
  submitBookingRequest: (async () => {
    throw new Error("nothing submits in this suite");
  }) as unknown as FlowDeps["submitBookingRequest"],
};
const store = () => fakeDb({ wa_conversations: [], events: [] }, { unique: [{ table: "wa_conversations", cols: ["wa_id"] }] });
const run = (db: ReturnType<typeof fakeDb>, message: InboundMessage) =>
  runFlow(db.client, { waId: ME, message, shows: [SHOW], pickedShowId: null, now: NOW, baseUrl: "https://example.test", lang: "he" }, deps);
const trail = (db: ReturnType<typeof fakeDb>) => db.store.events.filter((e) => e.event_type === FREETEXT_EVENT) as { payload: Record<string, unknown> }[];

async function main() {
  console.log("\n=== 1. the gate: no variable = everyone, as an empty one ===");
  eq("unset", parseFreeTextAllowlist(undefined).all, true);
  eq("null", parseFreeTextAllowlist(null).all, true);
  eq("empty", parseFreeTextAllowlist("").all, true);
  eq("blanks and commas only", parseFreeTextAllowlist(" , ,").all, true);
  eq("one number -> not everyone", parseFreeTextAllowlist("0528933975").all, false);
  eq("a typo only -> nobody (fail closed, unchanged)", parseFreeTextAllowlist("05289").all, false);
  ok("switch on + no variable -> on for any number", isFreeTextOnFor("972501234567", { flag: "true", allowlist: undefined }));
  ok("switch on + empty -> on for any number", isFreeTextOnFor("972501234567", { flag: "true", allowlist: "" }));
  ok("switch off -> off, whatever the list", !isFreeTextOnFor("972501234567", { flag: "false", allowlist: undefined }));

  console.log("\n=== 2. how much was understood ===");
  const q = (dropped: string[]) => ({ type: "query", q: { dropped } });
  eq("query, nothing dropped -> full", classifyFreeText({ step: "menu", event: q([]), live: false, text: "3 שעות" }), "full");
  eq("query with a dropped word -> partial", classifyFreeText({ step: "menu", event: q(["בלה"]), live: true, text: "3 שעות בלה" }), "partial");
  eq("edit with a 'maybe' -> partial", classifyFreeText({ step: "summary", event: { type: "edit", dropped: [], maybe: [{}] }, live: true, text: "x" }), "partial");
  eq("unread text at the menu, live -> none", classifyFreeText({ step: "menu", event: { type: "text" }, live: true, text: "מה קורה" }), "none");
  eq("unread text at the hour step -> none", classifyFreeText({ step: "hour", event: { type: "text" }, live: true, text: "מתי שנוח" }), "none");
  eq("a guest name at the guest step -> full (it is the value)", classifyFreeText({ step: "guest", event: { type: "text" }, live: true, text: "יהודה לוי" }), "full");
  eq("'שלום' as a first message -> greeting (not a miss)", classifyFreeText({ step: "menu", event: { type: "text" }, live: false, text: "שלום" }), "greeting");
  eq("a long first message nobody read -> none", classifyFreeText({ step: "menu", event: { type: "text" }, live: false, text: "אני רוצה משהו אבל לא בטוח מה" }), "none");
  eq("answering an open question -> full", classifyFreeText({ step: "hour", event: { type: "text" }, live: true, answeringQuestion: true, text: "בערב" }), "full");
  eq("a typed button word -> full", classifyFreeText({ step: "summary", event: { type: "cancel" }, live: true, text: "ביטול" }), "full");
  eq("replyText: one line", replyText({ body: "שורה\nשנייה" }), "שורה שנייה");
  eq("replyText: nothing", replyText(null), null);

  console.log("\n=== 3. the trail from a real conversation ===");
  const saved = { f: process.env.WHATSAPP_BOOKING_FREETEXT, a: process.env.WHATSAPP_FREETEXT_ALLOWLIST, l: process.env.WHATSAPP_FREETEXT_LLM };
  delete process.env.WHATSAPP_FREETEXT_ALLOWLIST; // the state after the owner deletes it
  delete process.env.WHATSAPP_FREETEXT_LLM;
  process.env.WHATSAPP_BOOKING_FREETEXT = "true";
  {
    const db = store();
    await run(db, text("3 שעות"));
    let t = trail(db);
    eq("a read request: one event, full, model not asked", t.map((e) => [e.payload.understood, e.payload.llm_called]), [["full", false]]);
    ok("…and no text kept for an understood message", !("text" in t[0].payload) && !("reply" in t[0].payload));
    await run(db, text("בלה בלה בלה"));
    t = trail(db);
    eq("then an unreadable text at the room question: none", t[1]?.payload.understood, "none");
    ok("…its text and the bot's answer are kept", t[1]?.payload.text === "בלה בלה בלה" && typeof t[1]?.payload.reply === "string" && (t[1].payload.reply as string).length > 0, t[1]);
    ok("no phone number anywhere in the trail", !JSON.stringify(db.store.events).includes(ME) && !JSON.stringify(db.store.events).includes("0528933975"));
  }
  {
    const db = store();
    await run(db, text("שלום"));
    eq("'שלום' -> greeting, no text kept", trail(db).map((e) => [e.payload.understood, "text" in e.payload]), [["greeting", false]]);
  }
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "false";
    const db = store();
    await run(db, text("3 שעות"));
    eq("layer off -> no trail at all", db.store.events.length, 0);
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
  }
  {
    // a store that cannot take events: the reply still goes out
    const db = fakeDb({ wa_conversations: [] }, { unique: [{ table: "wa_conversations", cols: ["wa_id"] }], failOn: { events: ["insert"] } });
    const out = await run(db, text("3 שעות"));
    ok("a failed trail write never fails the reply", out.kind === "send", out);
  }
  for (const [k, v] of [["WHATSAPP_BOOKING_FREETEXT", saved.f], ["WHATSAPP_FREETEXT_ALLOWLIST", saved.a], ["WHATSAPP_FREETEXT_LLM", saved.l]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  console.log("\n=== 4. 14 days, then off ===");
  eq("start day = day 1", monitorDay("2026-10-22", "2026-10-22"), 1);
  eq("day 14", monitorDay("2026-10-22", "2026-11-04"), 14);
  eq("day 15 -> off", monitorDay("2026-10-22", "2026-11-05"), null);
  eq("before the start -> off", monitorDay("2026-10-22", "2026-10-21"), null);
  eq("no start -> off", monitorDay(null, "2026-10-22"), null);

  console.log("\n=== 5. the day's numbers and the WhatsApp ===");
  const ev = (type: string, payload: Record<string, unknown> = {}) => ({ event_type: type, created_at: "2026-10-22T10:00:00Z", payload });
  const c = countDay([
    ev(FREETEXT_EVENT, { understood: "full", llm_called: false }),
    ev(FREETEXT_EVENT, { understood: "partial", llm_called: true }),
    ev(FREETEXT_EVENT, { understood: "none", llm_called: true }),
    ev(FREETEXT_EVENT, { understood: "greeting", llm_called: false }),
    ev(FREETEXT_BOOKING_EVENT),
    ev("something_else"),
  ]);
  eq("4 messages, 2 to the model, 2 not fully understood, 1 booking", c, { messages: 4, llm: 2, notUnderstood: 2, bookings: 1 });
  const p = summaryParams(3, "2026-10-24", c);
  eq("{{1}}", p.title, "סיכום טקסט חופשי 24.10 (יום 3 מתוך 14)");
  eq("{{2}}", p.details, "הודעות חופשיות: 4 · עברו ל-LLM: 2 · לא הובנו במלואן: 2 · הזמנות שנקבעו: 1");
  ok("{{3}} points at the screen (the texts never go by WhatsApp)", p.action.includes("טקסט חופשי") && !p.action.includes("בלה"));
  eq("{{3}} on a clean day", summaryParams(1, "2026-10-22", { messages: 3, llm: 0, notUnderstood: 0, bookings: 0 }).action, "אין צורך לפעול");
  ok("no newline in a parameter (Meta)", [p.title, p.details, p.action].every((x) => !x.includes("\n")));

  console.log("\n=== 6. the review screen ===");
  {
    const html = renderToString(
      <FreeTextMissList rows={[{ at: "22/10/2026 12:00", step: "hour", understood: "none", llm: "invalid", text: "מתי שנוח לכם", reply: "בחרו שעה:" }]} />
    ).replace(/<!-- -->/g, "");
    ok("the client's text and the bot's answer", html.includes("מתי שנוח לכם") && html.includes("בחרו שעה:"));
    ok("the step in Hebrew and the level", html.includes("שעה") && html.includes("לא הובן"));
    ok("empty -> says so", renderToString(<FreeTextMissList rows={null} />).includes("אין הודעות כאלה"));
  }

  console.log("\n=== 7. the wiring (source) ===");
  {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
    const cron = JSON.parse(read("vercel.json")).crons as { path: string; schedule: string }[];
    eq("vercel.json: 18:30 / 19:30 UTC (21:30 Israel in summer and winter)", cron.filter((x) => x.path === "/api/cron/freetext-summary").map((x) => x.schedule), ["30 18 * * *", "30 19 * * *"]);
    const route = read("src/app/api/cron/freetext-summary/route.ts").replace(/\/\/.*$/gm, "");
    ok("cron: secret + the 21:00-hour gate", route.includes("CRON_SECRET") && route.includes("israelHour(now) !== 21"));
    ok("…starts itself only when open to everyone, once", route.includes("parseFreeTextAllowlist(process.env.WHATSAPP_FREETEXT_ALLOWLIST).all") && route.includes("MONITOR_STARTED_EVENT"));
    ok("…stops after 14 days", route.includes('skipped: "monitoring-ended"'));
    ok("…to the owner only", route.includes('audience: "owner"') && !route.includes('"billing"') && !route.includes("WHATSAPP_BILLING_NOTIFY_NUMBERS"));
    ok("…one per day (subject = the date)", route.includes("subjectId: `freetext:${today}`"));
    ok("…an event with the numbers", route.includes("event_type: MONITOR_SUMMARY_EVENT"));
    const page = read("src/app/settings/freetext/page.tsx");
    ok("screen: owner only", page.includes("if (!isStrictOwner(profile)) redirect"));
    const flow = read("src/lib/whatsapp/flow/run.ts");
    ok("flow: the trail never carries the number", /recordFreeText\(admin, \{[\s\S]{0,300}\}\)/.test(flow) && !/recordFreeText\(admin, \{[\s\S]{0,300}waId[\s\S]{0,10}\}\)/.test(flow));
  }

  eq("no network call", fetchCalls, 0);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
