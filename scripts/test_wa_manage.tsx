/**
 * E9-5 — cancelling and moving a recording, and the guarded calendar delete. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_wa_manage.tsx
 * No users, no database, no network: `global.fetch` is a test double wherever
 * the delete function is driven (the same harness as test_calendar_write.ts),
 * and nothing here can reach Google, Meta or Supabase — F19 is open.
 *
 * Covers what the owner listed (11.10): the delete guard (matching id, other
 * id, status not 'created'), the single-DELETE scan (in test_calendar_write.ts
 * §9 — referenced, not duplicated), the 24-hour boundary (exactly 24, just
 * over, just under), cancel above and below it, a move that succeeds, a move
 * whose new slot is taken or stays pending (the original kept), a move on the
 * same day (not blocked by "one a day"), "ההקלטות שלי" empty, and a double tap.
 */
import React from "react";
import { renderToString } from "react-dom/server";
import { generateKeyPairSync } from "node:crypto";
import { calendarDeletionAllowed, calendarEventIdFor, deleteSystemCalendarEvent } from "../src/lib/calendar/write";
import {
  DELETE_DETAILS,
  SELF_SERVE_MIN_MS,
  deletePlan,
  deleteStatusFor,
  forwardedDetails,
  movedDetails,
  selfServeAllowed,
  shouldDeleteReplacedEvent,
} from "../src/lib/booking/manage";
import { approvedSameDayCount } from "../src/lib/booking/decide";
import { ignoreEvent } from "../src/lib/booking/availabilityServer";
import {
  BOOKING_CHANGE_LABEL,
  TEMPLATE_BOOKING_CHANGE_TEXT,
  TEMPLATE_BOOKING_CHANGE_VARS,
  changeNoticeBody,
  templatePlaceholders,
  type BookingChange,
} from "../src/lib/whatsapp/notify";
import {
  FLOW_ID,
  MINE_MAX,
  afterCancel,
  afterForward,
  afterSubmit,
  parseFlowId,
  reduce,
  start,
  withAvailability,
  withRecordings,
  type FlowReply,
  type FlowState,
  type RecordingOption,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { COPY as BOT_COPY } from "../src/lib/whatsapp/flow/copy";
import { toRecordingOption } from "../src/lib/whatsapp/flow/run";
import { splitQueue, type QueueRow } from "../src/lib/booking/queue";
import BookingsBody, { COPY, calendarDeleteFailedText, cancelWarning, moveTagText } from "../src/app/bookings/BookingsBody";
import { BUTTON_LIMITS, LIST_LIMITS } from "../src/lib/whatsapp/client";
import type { PublicAvailability } from "../src/lib/booking/publicView";

/** The Hebrew dictionary — the approved copy every assertion below is about. */
const C = BOT_COPY.he;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}
const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;

// ── fetch / env harness (as in test_calendar_write.ts) ──────────────────────
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const SA_JSON = JSON.stringify({ client_email: "sa@test.iam.gserviceaccount.com", private_key: privateKey });
type FetchCall = { url: string; init: RequestInit | undefined };
async function withMockedFetch(
  handler: (url: string, init: RequestInit | undefined) => Response,
  run: (calls: FetchCall[]) => Promise<void>
) {
  const calls: FetchCall[] = [];
  const original = global.fetch;
  // @ts-expect-error — test double
  global.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  try {
    await run(calls);
  } finally {
    global.fetch = original;
  }
}
async function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const LIVE = { CALENDAR_WRITE_DRY_RUN: "false", GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON, GOOGLE_CALENDAR_ID: "cal@group.calendar.google.com" };
const res = (status: number, body: unknown = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const BOOKING = "3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const OTHER = "9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4";
const OUR_ID = calendarEventIdFor(BOOKING);

const reply = (t: Transition): FlowReply => {
  if (t.kind !== "reply") throw new Error(`expected a reply, got ${t.kind}`);
  return t.reply;
};
const bodyOf = (t: Transition) => {
  const r = reply(t);
  return r.body;
};
const ids = (r: FlowReply): string[] =>
  r.type === "buttons" ? r.buttons.map((b) => b.id) : r.type === "list" ? r.sections.flatMap((s) => s.rows.map((x) => x.id)) : [];

async function run() {
  console.log("\n=== 1. the delete guard (owner rule 1) ===");
  check("our id + created -> allowed", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: "created" }), { ok: true, eventId: OUR_ID });
  check("🔴 ANOTHER booking's id -> refused", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: calendarEventIdFor(OTHER), calendarWriteStatus: "created" }), { ok: false, reason: "id-mismatch" });
  check("🔴 a valid-looking foreign id -> refused", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: "abcdefghij0123456789abcdef", calendarWriteStatus: "created" }), { ok: false, reason: "id-mismatch" });
  check("status 'failed' -> refused", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: "failed" }), { ok: false, reason: "not-created" });
  check("status null (pre-E8) -> refused", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: null }), { ok: false, reason: "not-created" });
  check("no stored id -> refused", calendarDeletionAllowed({ bookingId: BOOKING, calendarEventId: null, calendarWriteStatus: "created" }), { ok: false, reason: "no-id" });
  check("a booking id that is not a uuid -> refused", calendarDeletionAllowed({ bookingId: "nope", calendarEventId: OUR_ID, calendarWriteStatus: "created" }), { ok: false, reason: "bad-booking-id" });

  console.log("\n=== 2. the delete itself (fetch is a test double) ===");
  await withEnv(LIVE, async () => {
    await withMockedFetch(() => {
      throw new Error("a refused delete must not reach the network");
    }, async (calls) => {
      const r = await deleteSystemCalendarEvent({ bookingId: BOOKING, calendarEventId: calendarEventIdFor(OTHER), calendarWriteStatus: "created" });
      check("🔴 refused: no token, no DELETE — zero network calls", [r.ok, calls.length], [false, 0]);
    });
  });
  await withEnv({ ...LIVE, CALENDAR_WRITE_DRY_RUN: undefined }, async () => {
    await withMockedFetch(() => {
      throw new Error("a dry run must not reach the network");
    }, async (calls) => {
      const r = await deleteSystemCalendarEvent({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: "created" });
      check("dry run (switch unset = ON): recorded, nothing deleted, zero calls", [r, calls.length], [{ ok: true, dryRun: true, alreadyGone: false }, 0]);
    });
  });
  for (const [status, want] of [
    [204, { ok: true, dryRun: false, alreadyGone: false }],
    [410, { ok: true, dryRun: false, alreadyGone: true }],
    [404, { ok: true, dryRun: false, alreadyGone: true }],
  ] as const) {
    await withEnv(LIVE, async () => {
      await withMockedFetch((url, init) => {
        if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "tok" });
        if (init?.method === "DELETE") return res(status);
        throw new Error(`unexpected ${url}`);
      }, async (calls) => {
        const r = await deleteSystemCalendarEvent({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: "created" });
        check(`Google ${status} -> ${status === 204 ? "deleted" : "already gone = success"}`, r, want);
        // B26: and tells any invited client (sendUpdates=all)
        check(`…the DELETE targets OUR derived id, with sendUpdates=all (${status})`, calls[1]?.url.endsWith(`/events/${OUR_ID}?sendUpdates=all`), true);
      });
    });
  }
  await withEnv(LIVE, async () => {
    await withMockedFetch((url, init) => {
      if (url.includes("oauth2.googleapis.com/token")) return res(200, { access_token: "tok" });
      if (init?.method === "DELETE") return res(500, { error: "boom" });
      throw new Error(`unexpected ${url}`);
    }, async () => {
      const r = await deleteSystemCalendarEvent({ bookingId: BOOKING, calendarEventId: OUR_ID, calendarWriteStatus: "created" });
      check("Google 500 -> failed (not refused), with the status", [r.ok, r.ok ? null : r.refused, r.ok || r.refused ? null : r.status], [false, false, 500]);
    });
  });
  console.log("  (the single-DELETE source scan is test_calendar_write.ts §9)");

  console.log("\n=== 3. what a cancellation does about the event ===");
  check("created -> attempt the guarded delete", deletePlan("created"), "attempt");
  check("null (pre-E8) -> not ours: the manual reminder", deletePlan(null), "not-ours");
  check("failed -> nothing was ever written", deletePlan("failed"), "none");
  check("persisted forms", ["deleted", "already-gone", "dry-run", "not-ours", "failed", "none"].map((o) => deleteStatusFor(o as never)), ["deleted", "deleted", "dry_run", "not_ours", "failed", null]);
  check("every outcome has an owner-facing detail line", Object.values(DELETE_DETAILS).every((d) => d.length > 0 && !d.includes("\n")), true);

  console.log("\n=== 4. the 24-hour boundary (owner rule 3) ===");
  const NOW = new Date("2026-10-12T09:00:00.000Z");
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  check("the boundary is 24 hours", SELF_SERVE_MIN_MS, 86_400_000);
  check("🔴 EXACTLY 24h -> the team decides", selfServeAllowed(at(SELF_SERVE_MIN_MS), NOW), false);
  check("24h + 1 minute -> the bot acts", selfServeAllowed(at(SELF_SERVE_MIN_MS + 60_000), NOW), true);
  check("24h + 1 ms -> the bot acts", selfServeAllowed(at(SELF_SERVE_MIN_MS + 1), NOW), true);
  check("24h − 1 minute -> the team decides", selfServeAllowed(at(SELF_SERVE_MIN_MS - 60_000), NOW), false);
  check("already started -> the team", selfServeAllowed(at(-60_000), NOW), false);
  check("an unparseable start -> the team (the safe direction)", selfServeAllowed("nope", NOW), false);
  check("absolute time: the same instant written in +03:00 gives the same answer", selfServeAllowed("2026-10-13T12:00:01+03:00", NOW), true);

  console.log("\n=== 5. the shared path's move rules ===");
  const DAY = "2026-10-20";
  const rows = [
    { id: "orig", start_at: "2026-10-20T06:00:00.000Z", status: "approved" },
    { id: "else", start_at: "2026-10-21T06:00:00.000Z", status: "approved" },
  ];
  check("without a move, the original counts as the day's recording", approvedSameDayCount(rows, DAY), 1);
  check("🔴 a move on the SAME day: the original does not count (not blocked)", approvedSameDayCount(rows, DAY, "orig"), 0);
  check("…but ANOTHER approved recording that day still counts", approvedSameDayCount([...rows, { id: "x", start_at: "2026-10-20T11:00:00.000Z", status: "approved" }], DAY, "orig"), 1);
  const feed = [{ uid: "a@google.com" }, { uid: "orig@google.com" }, { uid: "b@google.com" }];
  check("the moved recording's own event is left out of the feed", ignoreEvent(feed, "orig@google.com").map((e) => e.uid), ["a@google.com", "b@google.com"]);
  check("no uid -> nothing is guessed away", ignoreEvent(feed, null).length, 3);
  check("delete the original's event: swapped and approved", shouldDeleteReplacedEvent({ swap: "swapped", outcome: "approved" }), true);
  check("…swapped, new event failed but the approval stands (manual)", shouldDeleteReplacedEvent({ swap: "swapped", outcome: "approved-calendar-failed" }), true);
  check("🔴 …a REVERTED move keeps the original's event", shouldDeleteReplacedEvent({ swap: "swapped", outcome: "reverted-to-pending" }), false);
  check("…nothing swapped (original already gone) deletes nothing", shouldDeleteReplacedEvent({ swap: "approved-only", outcome: "approved" }), false);

  console.log("\n=== 6. the change template (to submit to Meta) ===");
  check("{{1}}..{{5}} in order = the VARS list", templatePlaceholders(TEMPLATE_BOOKING_CHANGE_TEXT), [1, 2, 3, 4, 5]);
  check("five vars", TEMPLATE_BOOKING_CHANGE_VARS.length, 5);
  check("🔴 does not START with a variable (Meta)", /^\{\{/.test(TEMPLATE_BOOKING_CHANGE_TEXT), false);
  check("🔴 does not END with a variable (Meta)", /\}\}\.?$/.test(TEMPLATE_BOOKING_CHANGE_TEXT), false);
  const textLen = TEMPLATE_BOOKING_CHANGE_TEXT.replace(/\{\{\d+\}\}/g, "").length;
  check("text-to-variable ratio: ≥ 20 characters of text per variable", textLen / 5 >= 20, true);
  const FACTS = { showName: "דעה לא פופולרית", dateIsrael: "2026-10-13", startIsrael: "09:30", endIsrael: "11:00", studio: "גבעון", durationTag: null, guest: null };
  check("the body as the owner reads it", changeNoticeBody(FACTS, "client-cancelled", DELETE_DETAILS.deleted), [
    "עדכון על הקלטה במערכת ביזי: הלקוח ביטל הקלטה דרך הבוט.",
    "פודקאסט: דעה לא פופולרית",
    "המועד: יום ג׳ 13.10, 09:30–11:00",
    "אולפן: גבעון",
    "פרטים: האירוע נמחק מהיומן אוטומטית",
    "את כל הפרטים אפשר לראות במסך הבקשות במערכת.",
  ].join("\n"));
  // E9-6 added the two team-recording requests
  check("seven change labels, none empty", (Object.keys(BOOKING_CHANGE_LABEL) as BookingChange[]).map((k) => BOOKING_CHANGE_LABEL[k].length > 0), [true, true, true, true, true, true, true]);
  check("forwarded details carry the client's number", forwardedDetails("972501234567", "cancel").includes("972501234567"), true);
  check("moved details name the new slot", movedDetails({ dateIsrael: "2026-10-15", startIsrael: "13:00", endIsrael: "14:30", studio: "חשמונאים" }), "המועד החדש: יום ה׳ 15.10, 13:00–14:30, אולפן חשמונאים");

  console.log("\n=== 7. the bot: menu and 'ההקלטות שלי' ===");
  const SHOW = { showId: "11111111-1111-1111-1111-111111111111", showName: "דעה לא פופולרית", defaultStudio: "גבעון", multiShow: false, manageOn: true, linkUrl: "https://bizi.example/b/TOKEN" };
  const menu = start(SHOW);
  check("menu with cancel/move on: go, my recordings", ids(reply(menu)), [FLOW_ID.go, FLOW_ID.mine]);
  check("…and the link moved into the body", bodyOf(menu).includes("https://bizi.example/b/TOKEN"), true);
  check("several podcasts: go, mine, other podcast (3 = Meta's max)", ids(reply(start({ ...SHOW, multiShow: true }))), [FLOW_ID.go, FLOW_ID.mine, FLOW_ID.switchShow]);
  check("with the switch OFF the menu is E9-4's", ids(reply(start({ ...SHOW, manageOn: false }))), [FLOW_ID.go, FLOW_ID.link]);
  check("'mine' with the switch off is stale", reduce(start({ ...SHOW, manageOn: false }).state, { type: "mine" }).kind, "reply");
  const needRecs = reduce(menu.state, { type: "mine" });
  check("'ההקלטות שלי' asks the driver for the recordings", [needRecs.kind, needRecs.state.step], ["need-recordings", "mine"]);
  const empty = withRecordings(needRecs.state, []);
  check("🔴 none -> back to the menu, saying so", [empty.state.step, bodyOf(empty).startsWith(C.NOTICE.noRecordings)], ["menu", true]);

  const REC = (over: Partial<RecordingOption> = {}): RecordingOption => ({
    id: BOOKING, showId: SHOW.showId, showName: SHOW.showName, studio: "גבעון",
    date: "2026-10-20", start: "09:00", end: "10:30", startIso: "2026-10-20T06:00:00.000Z",
    durationMinutes: 90, guest: "דנה לוי", note: null, ...over,
  });
  const many = Array.from({ length: 12 }, (_, i) => REC({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const list = withRecordings(needRecs.state, many);
  check(`at most ${MINE_MAX} recordings + back + restart = 10 rows`, ids(reply(list)).length, 10);
  check("row title", reply(list).type === "list" && (reply(list) as { sections: { rows: { title: string }[] }[] }).sections[0].rows[0].title, "יום ג׳ 20.10 · 09:00");
  const mine = withRecordings(needRecs.state, [REC()]);
  check("🔴 a recording that was NOT offered is refused", reduce(mine.state, { type: "recording", id: OTHER }).state.step, "mine");
  const manage = reduce(mine.state, { type: "recording", id: BOOKING });
  check("a recording -> move / cancel / back", ids(reply(manage)), [FLOW_ID.move, FLOW_ID.cancelBooking, FLOW_ID.back]);
  check("rec ids parse back", parseFlowId(FLOW_ID.recording(BOOKING)), { type: "recording", id: BOOKING });

  console.log("\n=== 8. cancel: above and below 24 hours ===");
  const FAR = new Date("2026-10-15T09:00:00.000Z"); // 5 days before the 20th
  const NEAR = new Date("2026-10-19T10:00:00.000Z"); // 20 hours before
  const ask = reduce(manage.state, { type: "cancel-booking" }, { now: FAR });
  check("> 24h: 'בטוח?'", [ask.state.step, ids(reply(ask))], ["cancel-confirm", [FLOW_ID.confirmCancel, FLOW_ID.back]]);
  check("…the question names the recording", bodyOf(ask).includes("יום ג׳ 20.10, 09:00–10:30"), true);
  const go = reduce(ask.state, { type: "confirm-cancel" });
  check("confirm -> cancel, claimed as 'submitting'", [go.kind, go.state.step], ["cancel", "submitting"]);
  check("🔴 a double tap on 'כן, לבטל' while submitting cancels NOTHING more", reduce(go.state, { type: "confirm-cancel" }).kind, "reply");
  const cancelled = afterCancel(go.state, "cancelled");
  check("cancelled -> done, the client is told", [cancelled.state.step, bodyOf(cancelled)], ["done", C.OUTCOME.bookingCancelled(SHOW.showName, "2026-10-20", "09:00")]);
  check("…and a stale 'כן, לבטל' after done does nothing", reduce(cancelled.state, { type: "confirm-cancel" }).state.step, "menu");
  check("already cancelled meanwhile -> 'no longer active'", bodyOf(afterCancel(go.state, "not-active")), C.OUTCOME.notActive);
  check("an error -> back to the recording, with a retry", [afterCancel(go.state, "error").state.step, bodyOf(afterCancel(go.state, "error")).startsWith(C.NOTICE.manageFailed)], ["manage", true]);
  const late = reduce(manage.state, { type: "cancel-booking" }, { now: NEAR });
  check("🔴 ≤ 24h: the bot does not cancel — it forwards", [late.kind, late.kind === "forward" ? late.change : null], ["forward", "cancel-request"]);
  const fwd = afterForward(late.state, "cancel-request");
  check("…and tells the client it was forwarded", [fwd.state.step, bodyOf(fwd)], ["done", C.OUTCOME.forwardedCancel]);

  console.log("\n=== 9. move ===");
  const mv = reduce(manage.state, { type: "move" }, { now: FAR });
  check("> 24h: the room question, offering the ORIGINAL's room", [mv.state.mode, mv.state.step, mv.state.duration], ["move", "studio-default", 90]);
  check("…'להשאיר באולפן גבעון?'", bodyOf(mv), C.STUDIO_DEFAULT.moveBody("גבעון"));
  check("back from the room question -> the recording, move dropped", [reduce(mv.state, { type: "back" }).state.step, reduce(mv.state, { type: "back" }).state.mode], ["manage", "book"]);
  const other = reduce(mv.state, { type: "studio-other" });
  check("the room can be changed", other.state.step, "studio");
  const keep = reduce(mv.state, { type: "studio-yes" });
  check("keep the room -> availability for the day list", [keep.kind, keep.state.studio], ["need-availability", "גבעון"]);
  const avail: PublicAvailability = {
    fromIsrael: "2026-10-13", toIsrael: "2026-12-06", rooms: ["גבעון גדול", "גבעון", "חשמונאים"], durationMinutes: 90, refusedRooms: [],
    free: [
      { room: "גבעון", dateIsrael: "2026-10-20", startIsrael: "09:30", endIsrael: "11:00" },
      { room: "גבעון", dateIsrael: "2026-10-22", startIsrael: "13:00", endIsrael: "14:30" },
    ],
  };
  const days = withAvailability(keep.state, avail);
  check("🔴 the SAME day is offered (the original does not block it)", days.state.days.includes("2026-10-20"), true);
  const hours = withAvailability(reduce(days.state, { type: "day", date: "2026-10-20" }).state, avail);
  const picked = reduce(hours.state, { type: "hour", start: "09:30" });
  check("an hour -> straight to the summary (guest and note carried over)", [picked.state.step, picked.state.guest], ["summary", "דנה לוי"]);
  check("the summary shows 'מ־… ל־…'", bodyOf(picked), C.MOVE_SUMMARY.body({
    showName: SHOW.showName,
    from: { dateIsrael: "2026-10-20", start: "09:00", end: "10:30", studio: "גבעון" },
    to: { dateIsrael: "2026-10-20", start: "09:30", end: "11:00", studio: "גבעון" },
  }));
  check("buttons: move / cancel / back", ids(reply(picked)), [FLOW_ID.confirm, FLOW_ID.cancel, FLOW_ID.back]);
  check("back from the move summary -> the hours", reduce(picked.state, { type: "back" }).state.step, "hour");
  check("cancel on the move summary changes nothing", bodyOf(reduce(picked.state, { type: "cancel" })), C.OUTCOME.moveAbandoned);
  const sub = reduce(picked.state, { type: "confirm" });
  check("confirm -> submit, mode move", [sub.kind, sub.state.mode, sub.state.step], ["submit", "move", "submitting"]);
  check("🔴 a double tap on 'להזיז' while submitting submits NOTHING", reduce(sub.state, { type: "confirm" }).kind, "reply");

  const ok = (status: "approved" | "pending") => ({
    ok: true as const, duplicate: false,
    request: { id: "new-1", studio: "גבעון", dateIsrael: "2026-10-20", startIsrael: "09:30", endIsrael: "11:00", guest: "דנה לוי", status },
  });
  check("new slot approved -> 'moved' ✔️", bodyOf(afterSubmit(sub.state, ok("approved"))), C.OUTCOME.moved(SHOW.showName, "2026-10-20", "09:30", "גבעון"));
  const pend = afterSubmit(sub.state, ok("pending"));
  check("🔴 new slot PENDING -> the client is told the ORIGINAL stays", bodyOf(pend), C.OUTCOME.movePending("2026-10-20", "09:30"));
  check("…the stored target is the untouched original", pend.state.target?.id, BOOKING);
  const taken = afterSubmit(sub.state, { ok: false, code: "taken" });
  check("🔴 new slot TAKEN -> fresh hours of the same day, still a move", [taken.kind, taken.state.step, taken.state.mode], ["need-availability", "hour", "move"]);
  check("original cancelled meanwhile -> 'no longer active'", bodyOf(afterSubmit(sub.state, { ok: false, code: "original-gone" })), C.OUTCOME.notActive);
  check("an error -> the move summary again", afterSubmit(sub.state, { ok: false, code: "error" }).state.step, "summary");

  const lateMove = reduce(manage.state, { type: "move" }, { now: NEAR });
  check("🔴 ≤ 24h: the bot does not move — it forwards", [lateMove.kind, lateMove.kind === "forward" ? lateMove.change : null], ["forward", "move-request"]);
  check("…and says so", bodyOf(afterForward(lateMove.state, "move-request")), C.OUTCOME.forwardedMove);
  const odd = reduce({ ...manage.state, target: REC({ durationMinutes: 120 }) }, { type: "move" }, { now: FAR });
  check("a length that is not one of the three -> forwarded to a human", odd.kind, "forward");

  console.log("\n=== 10. Meta's limits on the new messages ===");
  const renders = [menu, list, manage, ask, mv, picked, cancelled, fwd].map(reply);
  const len = (s: string) => Array.from(s).length;
  check("≤ 3 buttons, titles ≤ 20", renders.filter((r) => r.type === "buttons").every((r) => r.type === "buttons" && r.buttons.length <= BUTTON_LIMITS.buttons && r.buttons.every((b) => len(b.title) <= BUTTON_LIMITS.title)), true);
  check("≤ 10 rows, titles ≤ 24", renders.filter((r) => r.type === "list").every((r) => r.type === "list" && r.sections.reduce((n, s) => n + s.rows.length, 0) <= LIST_LIMITS.rows && r.sections.every((s) => s.rows.every((x) => len(x.title) <= LIST_LIMITS.rowTitle))), true);

  console.log("\n=== 11. rows -> recordings, and the /bookings screen ===");
  check("a row becomes an option in Israeli wall-clock terms", toRecordingOption({ id: BOOKING, show_id: "s", studio: "גבעון", start_at: "2026-10-20T06:00:00.000Z", end_at: "2026-10-20T09:00:00.000Z", guest: null, note: null, showName: "x" }), {
    id: BOOKING, showId: "s", showName: "x", studio: "גבעון", date: "2026-10-20", start: "09:00", end: "12:00",
    startIso: "2026-10-20T06:00:00.000Z", durationMinutes: 180, guest: null, note: null,
  });
  const qNow = new Date("2026-10-12T09:00:00.000Z");
  const base: QueueRow = {
    id: "old", show_id: "s", showName: "דעה לא פופולרית", studio: "גבעון", start_at: "2026-10-20T06:00:00.000Z", end_at: "2026-10-20T07:30:00.000Z",
    guest: null, note: null, status: "approved", created_at: "2026-10-01T09:00:00.000Z", alias: "דעה", calendarWriteStatus: "created", calendarWriteError: null, decidedBy: null,
  };
  const pendMove: QueueRow = { ...base, id: "new", status: "pending", start_at: "2026-10-22T10:00:00.000Z", end_at: "2026-10-22T11:30:00.000Z", replacesId: "old" };
  const split = splitQueue([base, pendMove], qNow);
  const pv = split.waiting.find((v) => v.id === "new")!;
  check("a pending MOVE says which recording it replaces", pv.replacesWhen, "יום ג׳ 20.10 · 09:00–10:30 · אולפן גבעון");
  check("…and only while that recording is still approved", splitQueue([{ ...base, status: "cancelled" }, pendMove], qNow).waiting[0].replacesWhen, null);
  const failedRow: QueueRow = { ...base, status: "cancelled", calendarDeleteStatus: "failed", calendarDeleteError: "500 boom" };
  const fv = splitQueue([failedRow], qNow).history[0];
  check("a cancelled row whose delete failed is flagged", [fv.calendarDeleteFailed, fv.calendarDeleteError], [true, "500 boom"]);
  check("cancel warning: our event -> deleted automatically", cancelWarning({ ...fv, calendarWriteStatus: "created" }), COPY.willDeleteEvent);
  check("cancel warning: pre-E8 -> the manual reminder", cancelWarning({ ...fv, calendarWriteStatus: null }), COPY.deleteEventReminder);
  check("cancel warning: nothing written -> no warning", cancelWarning({ ...fv, calendarWriteStatus: "failed" }), null);

  const BODY = {
    waiting: [pv], history: [fv], approveFor: null, declineFor: null, approved: null, declined: null, busy: false, error: null,
    copiedTitleId: null, onAskApprove: () => {}, onAskDecline: () => {}, onConfirmApprove: () => {}, onConfirmDecline: () => {},
    onCancelDialog: () => {}, onCopyTitle: () => {}, onRetryCalendar: () => {}, retryingId: null, cancelFor: null, cancelled: null,
    onAskCancel: () => {}, onConfirmCancel: () => {}, onRetryDelete: () => {}, deletingId: null,
  };
  const page = renderToString(<BookingsBody {...BODY} />);
  check("the move tag renders once", countOf(page, moveTagText(pv.replacesWhen as string)), 1);
  check("the failed-delete line + retry render on the history row", [countOf(page, calendarDeleteFailedText("500 boom")), countOf(page, COPY.retryDelete)], [1, 1]);
  const card = (o: "deleted" | "already-gone" | "dry-run" | "not-ours" | "none" | "failed") =>
    renderToString(<BookingsBody {...BODY} waiting={[]} history={[]} cancelled={{ view: fv, calendarDelete: o, calendarDeleteError: o === "failed" ? "500 boom" : null, calendarDayUrl: "https://cal/day" }} />);
  check("card: deleted", [countOf(card("deleted"), COPY.calendarDeleted), countOf(card("deleted"), COPY.deleteEventReminder)], [1, 0]);
  check("card: already gone reads as deleted", countOf(card("already-gone"), COPY.calendarDeleted), 1);
  check("card: dry run", countOf(card("dry-run"), COPY.calendarDeleteDryRun), 1);
  check("🔴 card: not ours (pre-E8) -> the EXISTING manual reminder + day link", [countOf(card("not-ours"), COPY.deleteEventReminder), countOf(card("not-ours"), COPY.openCalendarDay)], [1, 1]);
  check("card: nothing to delete", countOf(card("none"), COPY.noEventToDelete), 1);
  check("🔴 card: failed -> the cancellation stands + 'נכשלה' + retry", [countOf(card("failed"), COPY.cancelled), countOf(card("failed"), calendarDeleteFailedText("500 boom")), countOf(card("failed"), COPY.retryDelete)], [1, 1, 1]);

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void run();

// keep the import used even if a section is trimmed
export type _S = FlowState;
