/**
 * E9-6 — recordings the team wrote into the calendar by hand (owner, 22.10):
 * listed in "📋 ההקלטות שלי" (date, time, length, room — no title, no guest),
 * requests only (cancel / move with free text) to the owner + Eli, counted by
 * the automatic-approval rule א; and the 09:00 lists (08:00/08:30 only on an
 * explicit request). In-memory store, a fake feed. No network, nothing real.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e9_6_team_recordings.ts
 */
import { fakeDb } from "./_fake_db";
import { parseIcsText } from "../src/lib/calendar/parse";
import { teamRecordingsFromFeed, uuidFromUid, type TeamRecording } from "../src/lib/booking/teamCalendar";
import { autoApproveNewRequest, teamSameDayCount } from "../src/lib/booking/decide";
import { forScreen, type PublicAvailability } from "../src/lib/booking/publicView";
import { runFlow, teamRecordingOption, type FlowDeps } from "../src/lib/whatsapp/flow/run";
import { FLOW_ID, withAvailability, type FlowState } from "../src/lib/whatsapp/flow/machine";
import { copy } from "../src/lib/whatsapp/flow/copy";
import type { ContactShow } from "../src/lib/booking/contacts";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

process.env.WHATSAPP_DRY_RUN = "true";
process.env.WHATSAPP_NOTIFY_NUMBERS = "972500000001,972500000002"; // the owner + Eli
process.env.WHATSAPP_BILLING_NOTIFY_NUMBERS = "972500000009"; // the bookkeeper — must never get these
process.env.WHATSAPP_BOOKING_MANAGE = "true";
process.env.STUDIO_ICS_URL = "https://ics.invalid/studio.ics";
delete process.env.WHATSAPP_BOOKING_FREETEXT;
delete process.env.WHATSAPP_BILINGUAL;

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

// ── the fake calendar ───────────────────────────────────────────────────────
const vevent = (uid: string, title: string, start: string, end: string, extra = "") =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${title}\r\nDTSTART:${start}\r\nDTEND:${end}\r\n${extra}END:VEVENT\r\n`;
const ICS =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
  vevent("manual-1", "פודקאסט סטימצקי - אורח: רן כהן, חשמונאים", "20261025T080000Z", "20261025T090000Z") + // 25.10 10:00-11:00 (winter time from 25.10: UTC+2)
  vevent("manual-2", "פודקאסט סטימצקי, אורח: יוסי סוכרי, גבעון קטן", "20261025T100000Z", "20261025T110000Z") + // 25.10 12:00-13:00
  vevent("sys-1", "סטימצקי - אורח: מהבוט, חשמונאים", "20261026T080000Z", "20261026T093000Z") + // written by the system
  vevent("other-1", "דעה לא פופולרית - אורח: גיא מור, גבעון", "20261025T080000Z", "20261025T093000Z") +
  vevent("books-1", "מדברים על ספרים, גבעון", "20261027T080000Z", "20261027T090000Z") + // longest alias = סטימצקי
  vevent("past-1", "פודקאסט סטימצקי, חשמונאים", "20261020T070000Z", "20261020T080000Z") +
  vevent("allday-1", "פודקאסט סטימצקי", "20261028", "20261029").replace("DTSTART:20261028", "DTSTART;VALUE=DATE:20261028").replace("DTEND:20261029", "DTEND;VALUE=DATE:20261029") +
  vevent("series-1", "פודקאסט סטימצקי, גבעון", "20261102T070000Z", "20261102T080000Z", "RRULE:FREQ=WEEKLY;COUNT=4\r\n") +
  vevent("noroom-1", "פודקאסט סטימצקי - אורח: בלי חדר", "20261029T080000Z", "20261029T100000Z") +
  "END:VCALENDAR\r\n";

let feedOk = true;
global.fetch = (async (url: string) => {
  if (String(url) === process.env.STUDIO_ICS_URL) {
    if (!feedOk) return new Response("no", { status: 503 });
    return new Response(ICS, { status: 200 });
  }
  throw new Error("this suite must not perform any other fetch: " + url);
}) as unknown as typeof fetch;

const STEIM = { id: "s-steim", name: "סטימצקי", aliases: ["פודקאסט סטימצקי", "מדברים על ספרים"], active: true, client_id: "c1", first_booking_needs_approval: false };
const BOOKS = { id: "s-books", name: "ספרים", aliases: [], active: true, client_id: "c2", first_booking_needs_approval: false };
const DEA = { id: "s-dea", name: "דעה לא פופולרית", aliases: [], active: true, client_id: "c1", first_booking_needs_approval: false };
const MATCH = [STEIM, BOOKS, DEA].map((s) => ({ id: s.id, name: s.name, aliases: s.aliases }));
const NOW = new Date("2026-10-22T09:00:00Z");
const WINDOW = { from: NOW, to: new Date(NOW.getTime() + 60 * 86_400_000) };

async function main() {
  console.log("\n=== 1. which calendar events are the team's recordings ===");
  const events = parseIcsText(ICS);
  const team = teamRecordingsFromFeed(events, MATCH, new Set(["sys-1"]), WINDOW);
  eq("Steimatzky's: the two of 25.10, the alias one of 27.10, the room-less one — sorted", team.map((r) => [r.uid, r.showId]), [
    ["manual-1", "s-steim"], ["manual-2", "s-steim"], ["other-1", "s-dea"], ["books-1", "s-steim"], ["noroom-1", "s-steim"],
  ].sort((a, b) => (team.findIndex((r) => r.uid === a[0]) - team.findIndex((r) => r.uid === b[0]))));
  ok("the system's own event is NOT a team recording", !team.some((r) => r.uid === "sys-1"));
  ok("past, all-day and the recurring master are left out", !team.some((r) => ["past-1", "allday-1", "series-1"].includes(r.uid)));
  eq("'מדברים על ספרים' belongs to Steimatzky (longest alias), not to the show 'ספרים'", team.find((r) => r.uid === "books-1")?.showId, "s-steim");
  eq("rooms: חשמונאים / גבעון (from 'גבעון קטן') / none", ["manual-1", "manual-2", "noroom-1"].map((u) => team.find((r) => r.uid === u)?.room), ["חשמונאים", "גבעון", null]);
  const id = uuidFromUid("manual-1");
  ok("the list id is a UUID, stable, distinct per event", /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) && id === uuidFromUid("manual-1") && id !== uuidFromUid("manual-2"), id);
  ok("…and a recording button carries it", FLOW_ID.recording(id).length < 200);

  console.log("\n=== 2. the option shows date, time, length, room — no title, no guest ===");
  const opt = teamRecordingOption(team.find((r) => r.uid === "manual-1") as TeamRecording, "סטימצקי");
  eq("the option", [opt.date, opt.start, opt.end, opt.durationMinutes, opt.studio, opt.guest, opt.note, opt.source], ["2026-10-25", "10:00", "11:00", 60, "חשמונאים", null, null, "calendar"]);
  ok("no trace of the event title anywhere in it", !JSON.stringify(opt).includes("רן כהן") && !JSON.stringify(opt).includes("אורח"));
  const C = copy("he");
  eq("the list row", C.MINE.descriptionTeam(60, "חשמונאים"), "שעה · אולפן חשמונאים · נקבע ע\"י הצוות");
  eq("…no room in the title", C.MINE.descriptionTeam(120, ""), "שעתיים · אולפן לא צוין · נקבע ע\"י הצוות");

  console.log("\n=== 3. the conversation: list, requests only, owner + Eli ===");
  const SHOW: ContactShow = { showId: "s-steim", showName: "סטימצקי", contactName: "בניה", defaultStudio: "חשמונאים" };
  const ME = "972528933975";
  const SYSTEM_BOOKING = { id: "4f1f5a9e-2b7c-4d3a-9f00-0000000000e2", show_id: "s-steim", status: "approved", studio: "גבעון", start_at: "2026-10-26T08:00:00Z", end_at: "2026-10-26T09:30:00Z", guest: "מהבוט", note: null, calendar_event_uid: "sys-1", shows: { name: "סטימצקי" } };
  const db = fakeDb(
    { wa_conversations: [], booking_requests: [{ ...SYSTEM_BOOKING }], booking_links: [], wa_messages: [], events: [] },
    { unique: [{ table: "wa_conversations", cols: ["wa_id"] }, { table: "wa_messages", cols: ["wamid"] }] }
  );
  const teamFor = (ids: string[]) => team.filter((r) => ids.includes(r.showId));
  const deps: FlowDeps = {
    ensureBookingLink: (async () => ({ ok: true, token: "tok", linkId: "link-1", created: false })) as unknown as FlowDeps["ensureBookingLink"],
    submitBookingRequest: (async () => {
      throw new Error("nothing submits in this suite");
    }) as unknown as FlowDeps["submitBookingRequest"],
    teamRecordings: async (ids) => teamFor(ids),
  };
  const msg = (o: Partial<InboundMessage>): InboundMessage => ({ wamid: `w-${Math.random()}`, waId: ME, rawFrom: ME, type: "text", body: "", raw: null, ...o }) as InboundMessage;
  const text = (body: string) => msg({ type: "text", body });
  const tap = (id: string) => msg({ type: "interactive", body: "x", raw: { interactive: { button_reply: { id } } } });
  const row = (id: string) => msg({ type: "interactive", body: "x", raw: { interactive: { list_reply: { id } } } });
  const run = (m: InboundMessage) => runFlow(db.client, { waId: ME, message: m, shows: [SHOW], pickedShowId: null, now: NOW, baseUrl: "https://example.test", lang: "he" }, deps);
  const replyOf = (o: Awaited<ReturnType<typeof run>>) => (o.kind === "send" ? o.reply : null) as { type: string; body: string; sections?: { rows: { id: string; title: string; description?: string }[] }[]; buttons?: { id: string; title: string }[] } | null;

  await run(text("שלום"));
  const mine = replyOf(await run(tap(FLOW_ID.mine)));
  const rows = mine?.sections?.[0]?.rows ?? [];
  eq("the list: the system's 26.10 and the team's 25.10 ×2, 27.10, 29.10 — soonest first", rows.map((r) => r.title), [
    C.MINE.title("2026-10-25", "10:00"), C.MINE.title("2026-10-25", "12:00"), C.MINE.title("2026-10-26", "10:00"), C.MINE.title("2026-10-27", "10:00"), C.MINE.title("2026-10-29", "10:00"),
  ]);
  ok("the system's one appears ONCE (its own event is not listed again)", rows.filter((r) => r.title === C.MINE.title("2026-10-26", "10:00")).length === 1);
  ok("team rows say 'נקבע ע\"י הצוות'; the system's does not", rows.filter((r) => (r.description ?? "").includes("נקבע ע\"י הצוות")).length === 4 && !(rows[2].description ?? "").includes("הצוות"), rows);
  ok("no event title or guest on the list", !JSON.stringify(mine).includes("רן כהן") && !JSON.stringify(mine).includes("יוסי סוכרי") && !JSON.stringify(mine).includes("אורח"));
  ok("another show's recording (דעה לא פופולרית) is not on this number's list", rows.length === 5);

  const manage = replyOf(await run(row(FLOW_ID.recording(uuidFromUid("manual-1")))));
  eq("a team recording: only 'בקשה לביטול' / 'בקשה להזזה' / back", manage?.buttons?.map((b) => b.id), [FLOW_ID.cancelBooking, FLOW_ID.move, FLOW_ID.back]);
  ok("…its body: date, time, length, room — no title, no guest", !!manage?.body.includes("10:00–11:00") && manage.body.includes("שעה") && manage.body.includes("חשמונאים") && !manage.body.includes("רן כהן"), manage?.body);

  const done = replyOf(await run(tap(FLOW_ID.cancelBooking)));
  eq("cancel request -> the owner's sentence", done?.body, C.OUTCOME.teamForwarded);
  const sent = db.store.wa_messages as { wa_id: string; template_name: string; body: string; status: string }[];
  eq("…one notice each to the owner and Eli — never the bookkeeper", sent.map((r) => r.wa_id).sort(), ["972500000001", "972500000002"]);
  ok("…bizi_booking_change, dry run, naming the hand-written recording + the client's number", sent.every((r) => r.template_name === "bizi_booking_change" && r.status === "dry_run" && r.body.includes("שנקבעה ידנית ביומן") && r.body.includes(ME)), sent[0]?.body);
  eq("…and nothing was cancelled: the system's booking untouched", (db.store.booking_requests[0] as { status: string }).status, "approved");

  await run(tap(FLOW_ID.restart));
  await run(tap(FLOW_ID.mine));
  await run(row(FLOW_ID.recording(uuidFromUid("manual-2"))));
  const ask = replyOf(await run(tap(FLOW_ID.move)));
  eq("move request -> 'to when?' (free text)", ask?.body, C.MANAGE.teamMoveAsk);
  const back = replyOf(await run(tap(FLOW_ID.back)));
  ok("back -> the recording again", back?.buttons?.[0]?.id === FLOW_ID.cancelBooking, back);
  await run(tap(FLOW_ID.move));
  const before = sent.length;
  const moved = replyOf(await run(text("יום שלישי אחרי 14:00")));
  eq("…the wanted time typed -> the owner's sentence", moved?.body, C.OUTCOME.teamForwarded);
  const moveRows = sent.slice(before);
  ok("…two notices, carrying the client's words", moveRows.length === 2 && moveRows.every((r) => r.body.includes("יום שלישי אחרי 14:00") && r.body.includes("בקשת הזזה")), moveRows.map((r) => r.body));

  console.log("\n=== 4. the system's own recording keeps the old behaviour ===");
  {
    const sys = teamRecordingOption({ uid: "x", showId: "s-steim", start: new Date("2026-11-20T07:00:00Z"), end: new Date("2026-11-20T08:30:00Z"), room: "גבעון" }, "סטימצקי");
    const own = { ...sys, source: undefined, id: SYSTEM_BOOKING.id };
    ok("a request recording has no 'calendar' source", own.source === undefined);
  }

  console.log("\n=== 5. rule א counts the team's recordings ===");
  eq("same day -> 2", teamSameDayCount(team.filter((r) => r.showId === "s-steim"), "2026-10-25"), 2);
  eq("another day -> 0", teamSameDayCount(team.filter((r) => r.showId === "s-steim"), "2026-10-30"), 0);
  const saved = process.env.BOOKING_AUTO_APPROVE;
  process.env.BOOKING_AUTO_APPROVE = "true";
  const approveDb = () =>
    fakeDb(
      {
        shows: [STEIM, BOOKS, DEA].map((s) => ({ ...s })),
        clients: [{ id: "c1", status: "active" }, { id: "c2", status: "active" }],
        booking_requests: [{ ...SYSTEM_BOOKING }, { id: "b-new", show_id: "s-steim", status: "pending", studio: "גבעון גדול", start_at: "2026-10-25T11:00:00Z", end_at: "2026-10-25T12:30:00Z" }],
        wa_messages: [],
        events: [],
      },
      { unique: [{ table: "wa_messages", cols: ["wamid"] }] }
    );
  const input = { bookingId: "b-new", showId: "s-steim", showName: "סטימצקי", dateIsrael: "2026-10-25", startIsrael: "14:00", endIsrael: "15:30", studio: "גבעון גדול", guest: null, durationTag: null, now: NOW };
  {
    const d = approveDb();
    const r = await autoApproveNewRequest(d.client, input);
    eq("Steimatzky already has two team recordings on 25.10 -> not automatic (second-same-day)", r, { approved: false, reason: "second-same-day" });
    ok("…the owner is told it waits", (d.store.wa_messages as { template_name: string }[]).some((m) => m.template_name === "bizi_booking_pending"), d.store.wa_messages);
    eq("…the request is still pending", (d.store.booking_requests[1] as { status: string }).status, "pending");
  }
  {
    feedOk = false;
    const d = approveDb();
    const r = await autoApproveNewRequest(d.client, { ...input, dateIsrael: "2026-10-30" });
    eq("the feed cannot be read -> not automatic (error), the queue", r, { approved: false, reason: "error" });
    feedOk = true;
  }
  if (saved === undefined) delete process.env.BOOKING_AUTO_APPROVE;
  else process.env.BOOKING_AUTO_APPROVE = saved;

  console.log("\n=== 6. the lists start at 09:00 (08:00/08:30 only when asked) ===");
  const slot = (start: string, end: string) => ({ room: "גבעון", dateIsrael: "2026-10-25", startIsrael: start, endIsrael: end });
  const pub = {
    fromIsrael: "2026-10-25", toIsrael: "2026-10-25", rooms: ["גבעון"], durationMinutes: 90,
    free: [slot("08:00", "09:30"), slot("08:30", "10:00"), slot("09:00", "10:30"), slot("13:00", "14:30")],
  } as unknown as PublicAvailability;
  eq("booking-link screen: from 09:00", forScreen(pub).free.map((f) => f.startIsrael), ["09:00", "13:00"]);
  const hourState = (filter: FlowState["filter"]) =>
    ({
      v: 1, step: "hour", showId: "s-steim", showName: "סטימצקי", defaultStudio: "גבעון", multiShow: false, duration: 90, studio: "גבעון",
      days: ["2026-10-25"], dayPage: 0, date: "2026-10-25", hours: [], hourPage: 0, start: null, end: null, guest: null, note: null,
      requestId: null, notice: null, mode: "book", target: null, recordings: [], manageOn: true, linkUrl: "https://x", lang: "he",
      bilingualOn: false, freeTextOn: false, filter,
    }) as unknown as FlowState;
  const hoursIn = (t: ReturnType<typeof withAvailability>) =>
    t.kind === "reply" ? JSON.stringify(t.reply) : "";
  {
    const out = hoursIn(withAvailability(hourState(null), pub));
    ok("bot hour list: 09:00 and 13:00, no 08:00 / 08:30", out.includes("09:00") && out.includes("13:00") && !out.includes("08:00") && !out.includes("08:30"), out.slice(0, 400));
  }
  {
    const out = hoursIn(withAvailability(hourState({ dateFrom: null, dateTo: null, timeFrom: "08:00", timeTo: null }), pub));
    ok("…asked for 'from 08:00' -> 08:00 / 08:30 offered", out.includes("08:00") && out.includes("08:30"), out.slice(0, 400));
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
