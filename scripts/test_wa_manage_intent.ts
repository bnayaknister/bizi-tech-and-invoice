/**
 * Cancel / move written in free text (owner, 24.10). The trigger: on 22.10
 * "אני רוצה לבטל את ההקלטות של יום א׳ הקרוב בשעה 15:00" was read as "another
 * intent" and answered with the menu. Now a cancel / move message — from the
 * menu, after a finished conversation, on the recordings list, or inside a
 * booking when it names an existing recording — FINDS the recording in "ההקלטות
 * שלי" (team recordings included) and shows it with the usual buttons. One
 * match -> that recording; several -> those; none -> every upcoming one.
 * Nothing is cancelled or moved without a tap; the 24-hour rule and the
 * team-recording rule are the existing ones.
 *
 * In-memory store, no network, nothing real.
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_manage_intent.ts
 */
import { fakeDb } from "./_fake_db";
import { uuidFromUid, type TeamRecording } from "../src/lib/booking/teamCalendar";
import { eventFromMessage, runFlow, type FlowDeps } from "../src/lib/whatsapp/flow/run";
import { FLOW_ID, matchRecordings, type RecordingOption } from "../src/lib/whatsapp/flow/machine";
import { parseManageIntent } from "../src/lib/whatsapp/flow/freetext";
import { shouldCallLlm } from "../src/lib/whatsapp/flow/llm";
import { classifyFreeText } from "../src/lib/whatsapp/freetextMonitor";
import { copy } from "../src/lib/whatsapp/flow/copy";
import type { ContactShow } from "../src/lib/booking/contacts";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002";
process.env.WHATSAPP_BILLING_NOTIFY_NUMBERS = "972500000009";
process.env.WHATSAPP_BOOKING_MANAGE = "true";
process.env.WHATSAPP_BOOKING_FREETEXT = "true";
delete process.env.WHATSAPP_FREETEXT_ALLOWLIST;
delete process.env.WHATSAPP_FREETEXT_LLM;
delete process.env.WHATSAPP_BILINGUAL;

global.fetch = (async (url: string) => {
  throw new Error("this suite must not perform any fetch: " + url);
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

const C = copy("he");
// Thursday 22.10.2026, 17:31 Israel (UTC+3) — the minute the real message came in
const NOW = new Date("2026-10-22T14:31:00Z");
const TODAY = "2026-10-22";
const ME = "972528933975";

const SHOW: ContactShow = { showId: "s-dor", showName: "דור הZ", contactName: "בניה", defaultStudio: "חשמונאים" };
const SHOW2: ContactShow = { showId: "s-two", showName: "פודקאסט שני", contactName: "בניה", defaultStudio: null };

// From 25.10 Israel is UTC+2.
const SUN_15 = { id: "11111111-1111-4111-8111-000000000001", show_id: "s-dor", status: "approved", studio: "חשמונאים", start_at: "2026-10-25T13:00:00Z", end_at: "2026-10-25T14:30:00Z", guest: "דנה", note: null, calendar_event_uid: "u1", shows: { name: "דור הZ" } };
const TUE_10 = { id: "11111111-1111-4111-8111-000000000002", show_id: "s-dor", status: "approved", studio: "גבעון", start_at: "2026-10-27T08:00:00Z", end_at: "2026-10-27T09:30:00Z", guest: null, note: null, calendar_event_uid: "u2", shows: { name: "דור הZ" } };
const TUE_15 = { id: "11111111-1111-4111-8111-000000000003", show_id: "s-dor", status: "approved", studio: "גבעון", start_at: "2026-10-27T13:00:00Z", end_at: "2026-10-27T14:30:00Z", guest: null, note: null, calendar_event_uid: "u3", shows: { name: "דור הZ" } };
// tomorrow 10:00 Israel (UTC+3) — inside 24 hours
const FRI_10 = { id: "11111111-1111-4111-8111-000000000004", show_id: "s-dor", status: "approved", studio: "חשמונאים", start_at: "2026-10-23T07:00:00Z", end_at: "2026-10-23T08:30:00Z", guest: null, note: null, calendar_event_uid: "u4", shows: { name: "דור הZ" } };
const OTHER_SHOW = { id: "11111111-1111-4111-8111-000000000005", show_id: "s-two", status: "approved", studio: "גבעון", start_at: "2026-11-02T10:00:00Z", end_at: "2026-11-02T11:30:00Z", guest: null, note: null, calendar_event_uid: "u5", shows: { name: "פודקאסט שני" } };
// a recording the team wrote in the calendar: Thursday 29.10 12:00-14:00
const TEAM: TeamRecording = { uid: "manual-29", showId: "s-dor", start: new Date("2026-10-29T10:00:00Z"), end: new Date("2026-10-29T12:00:00Z"), room: "גבעון" };

function setup(opts: { shows?: ContactShow[] } = {}) {
  const db = fakeDb(
    {
      wa_conversations: [],
      booking_requests: [SUN_15, TUE_10, TUE_15, FRI_10, OTHER_SHOW].map((r) => ({ ...r })),
      booking_links: [],
      wa_messages: [],
      events: [],
    },
    { unique: [{ table: "wa_conversations", cols: ["wa_id"] }, { table: "wa_messages", cols: ["wamid"] }] }
  );
  const deps: FlowDeps = {
    ensureBookingLink: (async () => ({ ok: true, token: "tok", linkId: "link-1", created: false })) as unknown as FlowDeps["ensureBookingLink"],
    submitBookingRequest: (async () => {
      throw new Error("nothing submits in this suite");
    }) as unknown as FlowDeps["submitBookingRequest"],
    teamRecordings: async (ids) => [TEAM].filter((t) => ids.includes(t.showId)),
  };
  const shows = opts.shows ?? [SHOW];
  const run = (m: InboundMessage) =>
    runFlow(db.client, { waId: ME, message: m, shows, pickedShowId: null, now: NOW, baseUrl: "https://example.test", lang: "he" }, deps);
  return { db, run };
}
const msg = (o: Partial<InboundMessage>): InboundMessage => ({ wamid: `w-${Math.random()}`, waId: ME, rawFrom: ME, type: "text", body: "", raw: null, ...o }) as InboundMessage;
const text = (body: string) => msg({ type: "text", body });
const tap = (id: string) => msg({ type: "interactive", body: "x", raw: { interactive: { button_reply: { id } } } });
type Reply = { type: string; body: string; sections?: { rows: { id: string; title: string; description?: string }[] }[]; buttons?: { id: string; title: string }[] } | null;
const replyOf = (o: { kind: string; reply?: unknown }) => (o.kind === "send" ? o.reply : null) as Reply;
const statuses = (db: ReturnType<typeof setup>["db"]) => (db.store.booking_requests as { status: string }[]).map((r) => r.status);

async function main() {
  console.log("\n=== 1. the parser ===");
  const REAL = "אני רוצה לבטל את ההקלטות של יום א׳ הקרוב בשעה 15:00";
  eq("the 22.10 message: cancel, Sunday 25.10, 15:00", parseManageIntent(REAL, TODAY), { intent: "cancel", date: "2026-10-25", times: ["15:00"] });
  eq("move + 'מחר ב-3' (the opening-hours reading)", parseManageIntent("רוצה להזיז את ההקלטה של מחר ב-3", TODAY), { intent: "move", date: "2026-10-23", times: ["15:00"] });
  eq("'יום ה'' with a plain apostrophe + 'בעשר'", parseManageIntent("אפשר לדחות את ההקלטה של יום ה' בעשר?", TODAY), { intent: "move", date: "2026-10-29", times: ["10:00"] });
  eq("a date written as 28.10", parseManageIntent("תבטל לי את ההקלטה של 28.10", TODAY), { intent: "cancel", date: "2026-10-28", times: [] });
  eq("nothing named: the intent alone", parseManageIntent("אני צריכה לבטל", TODAY), { intent: "cancel", date: null, times: [] });
  eq("negated -> not an intent", parseManageIntent("לא רוצה לבטל את ההקלטה", TODAY), null);
  eq("no verb -> not an intent", parseManageIntent("יום ראשון הקרוב ב-10", TODAY), null);
  console.log("  — inside a booking the recording must be named as an existing one —");
  eq("'ביטול' alone", parseManageIntent("ביטול", TODAY, { inBooking: true }), null);
  eq("'תזיז ל-12' (an edit of this booking)", parseManageIntent("תזיז ל-12", TODAY, { inBooking: true }), null);
  eq("'להעביר לגבעון גדול' (an edit of this booking)", parseManageIntent("להעביר לגבעון גדול", TODAY, { inBooking: true }), null);
  eq("'תבטל את ההקלטה' (could be this one) -> not read", parseManageIntent("תבטל את ההקלטה", TODAY, { inBooking: true }), null);
  eq("'ההקלטה שקבעתי' -> read", parseManageIntent("אפשר להעביר את ההקלטה שקבעתי?", TODAY, { inBooking: true }), { intent: "move", date: null, times: [] });
  eq("'ההקלטה של יום שלישי' -> read", parseManageIntent("לבטל את ההקלטה ביום שלישי", TODAY, { inBooking: true }), { intent: "cancel", date: "2026-10-27", times: [] });

  console.log("\n=== 2. matching ===");
  const opt = (date: string, start: string): RecordingOption => ({ id: `${date}-${start}`, showId: "s", showName: "x", studio: "גבעון", date, start, end: "", startIso: "", durationMinutes: 90, guest: null, note: null });
  const recs = [opt("2026-10-25", "15:00"), opt("2026-10-27", "10:00"), opt("2026-10-27", "15:00")];
  eq("day + start -> one", matchRecordings(recs, { intent: "cancel", date: "2026-10-25", times: ["15:00"] }).map((r) => r.id), ["2026-10-25-15:00"]);
  eq("day only -> both of that day", matchRecordings(recs, { intent: "cancel", date: "2026-10-27", times: [] }).length, 2);
  eq("start only -> both at 15:00", matchRecordings(recs, { intent: "cancel", date: null, times: ["15:00"] }).length, 2);
  eq("an unsure hour matches either reading", matchRecordings(recs, { intent: "move", date: "2026-10-27", times: ["03:00", "15:00"] }).map((r) => r.id), ["2026-10-27-15:00"]);
  eq("nothing named -> all", matchRecordings(recs, { intent: "move", date: null, times: [] }).length, 3);
  eq("a day with none -> none", matchRecordings(recs, { intent: "move", date: "2026-10-30", times: [] }).length, 0);

  console.log("\n=== 3. the 22.10 message, end to end ===");
  {
    const { db, run } = setup();
    const r = replyOf(await run(text(REAL)));
    eq("the recording itself, with the usual buttons: move / cancel / back", r?.buttons?.map((b) => b.id), [FLOW_ID.move, FLOW_ID.cancelBooking, FLOW_ID.back]);
    ok("…says it found it and that nothing was done", !!r?.body.startsWith(C.NOTICE.manageFound), r?.body);
    ok("…and names Sunday 25.10, 15:00–16:30, חשמונאים", !!r?.body.includes("15:00–16:30") && r.body.includes("חשמונאים"), r?.body);
    eq("nothing was cancelled", statuses(db), ["approved", "approved", "approved", "approved", "approved"]);
    const c = replyOf(await run(tap(FLOW_ID.cancelBooking)));
    eq("tap 'לבטל' (more than 24 hours ahead) -> the usual confirmation", c?.buttons?.map((b) => b.id), [FLOW_ID.confirmCancel, FLOW_ID.back]);
    eq("…still nothing cancelled before the second tap", statuses(db), ["approved", "approved", "approved", "approved", "approved"]);
    const b = replyOf(await run(tap(FLOW_ID.back)));
    eq("back -> the recording again", b?.buttons?.map((x) => x.id), [FLOW_ID.move, FLOW_ID.cancelBooking, FLOW_ID.back]);
    const l = replyOf(await run(tap(FLOW_ID.back)));
    ok("back again -> the full recordings list", (l?.sections?.[0]?.rows.length ?? 0) === 5, l);
    const ev = (db.store.events as { event_type: string; payload: { understood?: string } }[]).filter((e) => e.event_type === "wa_freetext_message");
    eq("the monitoring counts it as understood", ev.map((e) => e.payload.understood), ["full"]);
  }

  console.log("\n=== 4. inside 24 hours: the existing rule — a request to the team ===");
  {
    const { db, run } = setup();
    const r = replyOf(await run(text("תבטלו לי את ההקלטה של מחר")));
    ok("Friday 23.10 10:00 is found", !!r?.body.includes("10:00–11:30"), r?.body);
    const f = replyOf(await run(tap(FLOW_ID.cancelBooking)));
    eq("the tap forwards (inside 24 hours)", f?.body, C.OUTCOME.forwardedCancel);
    eq("…the booking stays approved", statuses(db)[3], "approved");
    const sent = db.store.wa_messages as { wa_id: string; status: string }[];
    eq("…the owner + Eli are told (dry run), never the bookkeeper", sent.map((x) => x.wa_id).sort(), ["972500000001", "972500000002"]);
  }

  console.log("\n=== 5. a team recording: requests only ===");
  {
    const { db, run } = setup();
    const r = replyOf(await run(text("רוצה להזיז את ההקלטה של יום חמישי הבא")));
    // "יום חמישי הבא" from Thursday 22.10 = 29.10
    eq("found, with the team buttons: ask to cancel / ask to move / back", r?.buttons?.map((b) => b.id), [FLOW_ID.cancelBooking, FLOW_ID.move, FLOW_ID.back]);
    ok("…the team's wording", !!r?.body.includes("נקבעה ע\"י הצוות"), r?.body);
    const m = replyOf(await run(tap(FLOW_ID.move)));
    eq("ask to move -> 'to when?'", m?.body, C.MANAGE.teamMoveAsk);
    eq("nothing changed", statuses(db), ["approved", "approved", "approved", "approved", "approved"]);
    void uuidFromUid;
  }

  console.log("\n=== 6. several / none / nothing named ===");
  {
    const { run } = setup();
    const r = replyOf(await run(text("אני רוצה להזיז את ההקלטה ביום שלישי")));
    ok("two on Tuesday 27.10 -> those two, saying so", r?.type === "list" && r.body.startsWith(C.NOTICE.manageSeveral) && r.sections?.[0]?.rows.length === 2, r);
  }
  {
    const { run } = setup();
    const r = replyOf(await run(text("לבטל את ההקלטה של 30.10")));
    ok("none on 30.10 -> every upcoming one, saying so", r?.type === "list" && r.body.startsWith(C.NOTICE.manageNoMatch) && r.sections?.[0]?.rows.length === 5, r);
  }
  {
    const { run } = setup();
    const r = replyOf(await run(text("אני צריכה לבטל הקלטה")));
    ok("nothing named -> the plain list (no 'several match' line)", r?.type === "list" && r.body === C.MINE.body && r.sections?.[0]?.rows.length === 5, r);
  }

  console.log("\n=== 7. inside a booking ===");
  {
    const { db, run } = setup();
    await run(text("שלום"));
    await run(tap(FLOW_ID.go));
    const d = replyOf(await run(text("תזיז ל-12")));
    ok("at the length step 'תזיז ל-12' is NOT a cancel/move of a recording", !(d?.buttons ?? []).some((b) => b.id === FLOW_ID.cancelBooking), d);
    const r = replyOf(await run(text("רגע, אני רוצה לבטל את ההקלטה שקבעתי ליום ראשון")));
    eq("an existing recording named -> found, the booking in progress left", r?.buttons?.map((b) => b.id), [FLOW_ID.move, FLOW_ID.cancelBooking, FLOW_ID.back]);
    eq("nothing changed", statuses(db), ["approved", "approved", "approved", "approved", "approved"]);
  }
  {
    const ev = eventFromMessage(text("ביטול"), { now: NOW, freeTextOn: true, step: "summary", lang: "he" });
    ok("'ביטול' typed at the summary stays what it was (not a recording)", ev.type !== "manage-intent", ev);
    const ev2 = eventFromMessage(text("לבטל את ההקלטה של יום ראשון"), { now: NOW, freeTextOn: true, step: "move-request", lang: "he" });
    ok("at 'to when?' (move-request) the text stays the wanted time", ev2.type === "text", ev2);
    const ev3 = eventFromMessage(text(REAL), { now: NOW, freeTextOn: true, step: "done", lang: "he" });
    ok("after a finished conversation it is read", ev3.type === "manage-intent", ev3);
  }

  console.log("\n=== 8. switches ===");
  {
    process.env.WHATSAPP_BOOKING_FREETEXT = "false";
    const { run } = setup();
    const r = replyOf(await run(text(REAL)));
    ok("free text off -> the menu exactly as before", !!r?.buttons?.some((b) => b.id === FLOW_ID.go) && !r.body.includes(C.NOTICE.manageFound), r);
    process.env.WHATSAPP_BOOKING_FREETEXT = "true";
  }
  {
    process.env.WHATSAPP_BOOKING_MANAGE = "false";
    const { run } = setup();
    const r = replyOf(await run(text(REAL)));
    ok("cancel/move off -> the menu, no recording shown", !!r?.buttons?.some((b) => b.id === FLOW_ID.go) && !(r.buttons ?? []).some((b) => b.id === FLOW_ID.cancelBooking), r);
    process.env.WHATSAPP_BOOKING_MANAGE = "true";
  }
  {
    const ev = eventFromMessage(text(REAL), { now: NOW, freeTextOn: true, step: "menu", lang: "en" });
    ok("English conversation: not parsed (the layer is Hebrew only)", ev.type === "text", ev);
  }

  console.log("\n=== 9. a number with two podcasts ===");
  {
    const { run } = setup({ shows: [SHOW, SHOW2] });
    const r = replyOf(await run(text("אני רוצה לבטל את ההקלטה של 2.11")));
    eq("no podcast question first: the other podcast's 2.11 recording is found", r?.buttons?.map((b) => b.id), [FLOW_ID.move, FLOW_ID.cancelBooking, FLOW_ID.back]);
    ok("…it is the other podcast's", !!r?.body.includes("פודקאסט שני"), r?.body);
  }

  console.log("\n=== 10. the model and the monitoring ===");
  const ev = eventFromMessage(text(REAL), { now: NOW, freeTextOn: true, step: "menu", lang: "he" });
  eq("the rule parser reads it", ev.type, "manage-intent");
  ok("…so the model is not asked (it called this 'other')", !shouldCallLlm(REAL, "menu", ev));
  eq("…and the monitoring says 'full'", classifyFreeText({ step: "menu", event: ev, live: false, text: REAL }), "full");

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
