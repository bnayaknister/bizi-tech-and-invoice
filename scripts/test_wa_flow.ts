/**
 * E9-4 — the booking conversation's pure state machine. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_flow.ts
 * No users, no database, no network, no Meta — F19 is open and nothing here
 * goes near it. Availability is a hand-built PublicAvailability; submissions
 * are hand-built SubmitResults.
 *
 * Covers what the owner listed (11.10): every step transition, skipping the
 * guest and the note, free text in the guest step, default studio vs none,
 * day and hour paging, back and restart, an expired conversation, a double
 * tap on "לקבוע", and a slot taken at the moment of submission. Plus Meta's
 * size limits on every message the machine can render.
 */
import {
  FLOW_ID,
  FLOW_TTL_MS,
  PAGE_SIZE,
  afterSubmit,
  expiresAtFor,
  initialState,
  isLive,
  parseFlowId,
  parseFlowState,
  reduce,
  start,
  textEvent,
  withAvailability,
  type FlowEvent,
  type FlowReply,
  type FlowState,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import * as C from "../src/lib/whatsapp/flow/copy";
import { eventFromMessage, isFlowOn } from "../src/lib/whatsapp/flow/run";
import { flowPayload } from "../src/lib/whatsapp/reply";
import { BUTTON_LIMITS, LIST_LIMITS, SECTION_TITLE_MAX } from "../src/lib/whatsapp/client";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";
import { approvedWhatsappText } from "../src/lib/booking/title";

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

const SHOW = { showId: "11111111-1111-1111-1111-111111111111", showName: "דעה לא פופולרית", defaultStudio: "גבעון", multiShow: false };
const NO_DEFAULT = { ...SHOW, defaultStudio: null };

const reply = (t: Transition): FlowReply => {
  if (t.kind !== "reply") throw new Error(`expected a reply, got ${t.kind}`);
  return t.reply;
};
const stateOf = (t: Transition): FlowState => t.state;
const ids = (r: FlowReply): string[] =>
  r.type === "buttons" ? r.buttons.map((b) => b.id) : r.type === "list" ? r.sections.flatMap((s) => s.rows.map((x) => x.id)) : [];
const step = (s: FlowState, ...events: FlowEvent[]): Transition => {
  let t: Transition = { kind: "reply", state: s, reply: { type: "text", body: "" } };
  for (const e of events) t = reduce(t.state, e);
  return t;
};

// ── a hand-built availability: גבעון has slots on 20 open days, 18 starts each
// on the first day; חשמונאים has nothing at all.
const OPEN_DAYS: string[] = [];
{
  const d = new Date(Date.UTC(2026, 9, 12)); // Mon 12.10.2026
  while (OPEN_DAYS.length < 20) {
    const dow = d.getUTCDay();
    if (dow <= 4) OPEN_DAYS.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const STARTS_DAY0 = Array.from({ length: 18 }, (_, i) => 9 * 60 + i * 30); // 09:00..17:30
function availability(over: Partial<{ days: string[]; day0Starts: number[] }> = {}): PublicAvailability {
  const days = over.days ?? OPEN_DAYS;
  const free = days.flatMap((d, i) =>
    (i === 0 ? over.day0Starts ?? STARTS_DAY0 : [9 * 60, 13 * 60]).map((m) => ({
      room: "גבעון",
      dateIsrael: d,
      startIsrael: hhmm(m),
      endIsrael: hhmm(m + 90),
    }))
  );
  return { fromIsrael: "2026-10-12", toIsrael: "2026-12-06", rooms: ["גבעון גדול", "גבעון", "חשמונאים"], durationMinutes: 90, free, refusedRooms: [] };
}

/** Walk to the summary with a fixed path. */
function toSummary(show = SHOW): FlowState {
  let t = start(show);
  t = reduce(t.state, { type: "go" });
  t = reduce(t.state, { type: "duration", minutes: 90 });
  t = reduce(t.state, { type: "studio-yes" });
  t = withAvailability(t.state, availability());
  t = reduce(t.state, { type: "day", date: OPEN_DAYS[0] });
  t = withAvailability(t.state, availability());
  t = reduce(t.state, { type: "hour", start: "09:30" });
  t = reduce(t.state, { type: "text", text: "דנה לוי" });
  t = reduce(t.state, { type: "no-note" });
  return t.state;
}

console.log("\n=== 1. ids -> structured events ===");
check("go", parseFlowId("f:go"), { type: "go" });
check("duration", parseFlowId("f:dur:180"), { type: "duration", minutes: 180 });
check("studio (Hebrew, with a space)", parseFlowId("f:st:גבעון גדול"), { type: "studio", studio: "גבעון גדול" });
check("day", parseFlowId("f:day:2026-10-14"), { type: "day", date: "2026-10-14" });
check("hour (the colon inside the value survives)", parseFlowId("f:hr:09:30"), { type: "hour", start: "09:30" });
check("more-days / more-hours are distinct", [parseFlowId("f:more-days"), parseFlowId("f:more-hours")], [{ type: "more-days" }, { type: "more-hours" }]);
check("a malformed day is not ours", parseFlowId("f:day:14.10"), null);
check("a malformed hour is not ours", parseFlowId("f:hr:9:30"), null);
check("the E9-3 show row is not a flow id", parseFlowId("show:11111111-1111-1111-1111-111111111111"), null);
check("garbage", [parseFlowId(""), parseFlowId(null), parseFlowId(42), parseFlowId("f:nope")], [null, null, null, null]);
check("every id the machine emits parses back", [
  FLOW_ID.go, FLOW_ID.link, FLOW_ID.switchShow, FLOW_ID.duration(240), FLOW_ID.studioYes, FLOW_ID.studioOther,
  FLOW_ID.studio("חשמונאים"), FLOW_ID.day("2026-10-14"), FLOW_ID.moreDays, FLOW_ID.hour("17:30"), FLOW_ID.moreHours,
  FLOW_ID.noGuest, FLOW_ID.noNote, FLOW_ID.confirm, FLOW_ID.cancel, FLOW_ID.back, FLOW_ID.restart,
].every((id) => parseFlowId(id) !== null), true);
check("typed 'חזרה' is back", textEvent(" חזרה "), { type: "back" });
check("typed 'התחלה מחדש' is restart", textEvent("התחלה  מחדש"), { type: "restart" });
check("anything else stays text", textEvent("יש מקום מחר?"), { type: "text", text: "יש מקום מחר?" });

console.log("\n=== 2. the menu (step 1) ===");
{
  const t = start(SHOW);
  const r = reply(t);
  check("the menu is buttons", r.type, "buttons");
  check("two buttons: check availability, see on screen", ids(r), [FLOW_ID.go, FLOW_ID.link]);
  check("the body names the show", r.type !== "text" && r.body.includes(SHOW.showName), true);
  check("several podcasts -> a third button, 'פודקאסט אחר'", ids(reply(start({ ...SHOW, multiShow: true }))), [FLOW_ID.go, FLOW_ID.link, FLOW_ID.switchShow]);
  check("'לראות במסך' asks the driver for the link", reduce(t.state, { type: "link" }).kind, "link");
  check("'פודקאסט אחר' asks for the list — only for several podcasts", [
    reduce(start({ ...SHOW, multiShow: true }).state, { type: "switch-show" }).kind,
    reduce(t.state, { type: "switch-show" }).kind,
  ], ["switch-show", "reply"]);
  check("free text at the menu re-sends the menu", ids(reply(reduce(t.state, { type: "text", text: "היי" }))), [FLOW_ID.go, FLOW_ID.link]);
}

console.log("\n=== 3. duration (step 2) ===");
{
  const t = step(start(SHOW).state, { type: "go" });
  const r = reply(t);
  check("a list", r.type, "list");
  check("three lengths + back + restart", ids(r), [FLOW_ID.duration(90), FLOW_ID.duration(180), FLOW_ID.duration(240), FLOW_ID.back, FLOW_ID.restart]);
  check("titles are the owner's short forms", r.type === "list" ? r.sections[0].rows.map((x) => x.title) : [], ["שעה וחצי", "3 שעות", "4 שעות"]);
  check("🔴 a length that is not one of the three is refused (stale)", stateOf(reduce(t.state, { type: "duration", minutes: 120 })).duration, null);
  check("…and the step stays duration", stateOf(reduce(t.state, { type: "duration", minutes: 120 })).step, "duration");
  check("free text -> 'pick from the list' + the same list", (() => {
    const x = reply(reduce(t.state, { type: "text", text: "שעתיים" }));
    return [x.type !== "text" && x.body.startsWith(C.NOTICE.pickFromList), ids(x).length];
  })(), [true, 5]);
}

console.log("\n=== 4. studio (step 3): default vs none ===");
{
  // with a default
  const a = step(start(SHOW).state, { type: "go" }, { type: "duration", minutes: 180 });
  check("with a default -> 'as usual?'", stateOf(a).step, "studio-default");
  check("buttons: yes-default, another studio, back", ids(reply(a)), [FLOW_ID.studioYes, FLOW_ID.studioOther, FLOW_ID.back]);
  check("the yes button names the room", reply(a).type === "buttons" && (reply(a) as { buttons: { title: string }[] }).buttons[0].title, "כן, גבעון");
  const yes = reduce(a.state, { type: "studio-yes" });
  check("yes -> needs availability for the day list", [yes.kind, yes.state.step, yes.state.studio], ["need-availability", "day", "גבעון"]);
  const other = reduce(a.state, { type: "studio-other" });
  check("another studio -> the studio list", stateOf(other).step, "studio");

  // without a default
  const b = step(start(NO_DEFAULT).state, { type: "go" }, { type: "duration", minutes: 90 });
  check("no default -> straight to the studio list", stateOf(b).step, "studio");
  const rb = reply(b);
  check("three studios + back + restart", ids(rb), [FLOW_ID.studio("גבעון"), FLOW_ID.studio("גבעון גדול"), FLOW_ID.studio("חשמונאים"), FLOW_ID.back, FLOW_ID.restart]);
  check("🔴 the body links to the studio photos", rb.type !== "text" && rb.body.includes("https://www.bi-zi.co.il"), true);
  check("a studio that is not bookable (TLV) is refused", stateOf(reduce(b.state, { type: "studio", studio: "TLV" })).step, "studio");
  check("a real one -> availability", reduce(b.state, { type: "studio", studio: "חשמונאים" }).kind, "need-availability");

  // the default_studio column as it is
  const def = (v: string | null) => initialState({ ...SHOW, defaultStudio: v }).defaultStudio;
  check("default_studio 'גבעון' -> גבעון", def("גבעון"), "גבעון");
  check("a variant ('גבעון בחוץ') resolves like the screen does -> גבעון גדול", def("גבעון בחוץ"), "גבעון גדול");
  check("🔴 TLV (real, NOT bookable) -> no default, so the bot ASKS", def("TLV"), null);
  check("an unknown value -> no default", def("אולפן הירח"), null);
  check("empty / null -> no default", [def(""), def(null)], [null, null]);
}

console.log("\n=== 5. days (step 4): availability + paging ===");
{
  const need = step(start(SHOW).state, { type: "go" }, { type: "duration", minutes: 90 }, { type: "studio-yes" });
  const t = withAvailability(need.state, availability());
  const r = reply(t);
  check("the days are exactly the open days with a free slot", stateOf(t).days, OPEN_DAYS);
  check(`page 1: ${PAGE_SIZE} days + 'more' + back + restart = 10 rows`, ids(r).length, 10);
  check("first row is the first day", ids(r)[0], FLOW_ID.day(OPEN_DAYS[0]));
  check("'ימים נוספים' is the last choice row", ids(r)[PAGE_SIZE], FLOW_ID.moreDays);
  check("day row title", r.type === "list" ? r.sections[0].rows[0].title : "", "יום ב׳ 12.10");

  const p2 = reduce(t.state, { type: "more-days" });
  check("more -> page 2 starts at day 8", ids(reply(p2))[0], FLOW_ID.day(OPEN_DAYS[PAGE_SIZE]));
  const p3 = reduce(p2.state, { type: "more-days" });
  check("page 3 holds the remaining 6 and NO 'more'", [ids(reply(p3)).filter((x) => x.startsWith("f:day:")).length, ids(reply(p3)).includes(FLOW_ID.moreDays)], [6, false]);
  check("'more' on the last page is stale, not a crash", stateOf(reduce(p3.state, { type: "more-days" })).dayPage, 2);
  check("back on page 3 -> page 2", stateOf(reduce(p3.state, { type: "back" })).dayPage, 1);
  check("back on page 1 -> the studio question", stateOf(reduce(t.state, { type: "back" })).step, "studio-default");

  check("🔴 a day that was NOT offered is refused", stateOf(reduce(t.state, { type: "day", date: "2026-10-17" })).step, "day");
  const stale = reply(reduce(t.state, { type: "day", date: "2026-10-17" }));
  check("…with the 'no longer active' notice", stale.type !== "text" && stale.body.startsWith(C.NOTICE.stale), true);

  // nothing at all for this room/length
  const none = step(start(NO_DEFAULT).state, { type: "go" }, { type: "duration", minutes: 240 }, { type: "studio", studio: "חשמונאים" });
  const nt = withAvailability(none.state, availability());
  check("no days for חשמונאים -> back to the studio list", stateOf(nt).step, "studio");
  check("…saying why", reply(nt).type !== "text" && (reply(nt) as { body: string }).body.startsWith(C.NOTICE.noDays("חשמונאים", 240)), true);
}

console.log("\n=== 6. hours (step 5): availability + paging ===");
{
  const atDay = withAvailability(step(start(SHOW).state, { type: "go" }, { type: "duration", minutes: 90 }, { type: "studio-yes" }).state, availability());
  const pick = reduce(atDay.state, { type: "day", date: OPEN_DAYS[0] });
  check("a day pick reads hours FRESH (needs availability)", [pick.kind, pick.state.step], ["need-availability", "hour"]);
  const t = withAvailability(pick.state, availability());
  const r = reply(t);
  check("18 starts on that day", stateOf(t).hours.length, 18);
  check("first row 09:00–10:30", r.type === "list" ? r.sections[0].rows[0].title : "", "09:00–10:30");
  check(`page 1: ${PAGE_SIZE} hours + 'more' + nav`, [ids(r).filter((x) => x.startsWith("f:hr:")).length, ids(r).includes(FLOW_ID.moreHours)], [PAGE_SIZE, true]);
  const p2 = reduce(t.state, { type: "more-hours" });
  check("page 2 starts at 12:30", ids(reply(p2))[0], FLOW_ID.hour("12:30"));
  const p3 = reduce(p2.state, { type: "more-hours" });
  check("page 3: the last 4, no 'more'", [ids(reply(p3)).filter((x) => x.startsWith("f:hr:")).length, ids(reply(p3)).includes(FLOW_ID.moreHours)], [4, false]);
  check("back on page 2 -> page 1", stateOf(reduce(p2.state, { type: "back" })).hourPage, 0);
  check("back on page 1 -> the day list, days kept", [stateOf(reduce(t.state, { type: "back" })).step, stateOf(reduce(t.state, { type: "back" })).days.length], ["day", 20]);
  check("🔴 an hour not offered is refused", stateOf(reduce(t.state, { type: "hour", start: "18:00" })).step, "hour");
  const h = reduce(t.state, { type: "hour", start: "09:30" });
  check("a real hour -> guest, with the slot's OWN end", [stateOf(h).step, stateOf(h).start, stateOf(h).end], ["guest", "09:30", "11:00"]);

  // the day filled up between the day list and the hour list
  const fullT = withAvailability(pick.state, availability({ days: OPEN_DAYS.slice(1) }));
  check("a day that filled up -> the fresh day list", [stateOf(fullT).step, stateOf(fullT).days[0]], ["day", OPEN_DAYS[1]]);
  check("…with the 'day full' notice", (reply(fullT) as { body: string }).body.startsWith(C.NOTICE.dayFull), true);
}

console.log("\n=== 7. guest and note (steps 6-7): ask, never block ===");
{
  const atGuest = (() => {
    const s = toSummary();
    return { ...s, step: "guest" as const, guest: null, note: null };
  })();
  const r = reply(reduce(atGuest, { type: "back" }));
  check("(sanity) back from guest is the hour list", r.type, "list");
  const g = reply(step(atGuest, { type: "text", text: "x" }, { type: "back" }));
  check("guest step buttons: skip, back, restart", ids(g), [FLOW_ID.noGuest, FLOW_ID.back, FLOW_ID.restart]);
  check("'אין אורח עדיין' -> note, guest null", [stateOf(reduce(atGuest, { type: "no-guest" })).step, stateOf(reduce(atGuest, { type: "no-guest" })).guest], ["note", null]);
  check("🔴 free text IS the guest", stateOf(reduce(atGuest, { type: "text", text: "  יובל   EY " })).guest, "יובל EY");
  check("free text 'עוד אין' is also just taken as the value (owner rule 3)", stateOf(reduce(atGuest, { type: "text", text: "עוד אין" })).guest, "עוד אין");
  check("a guest longer than 120 -> asked again, not stored", [stateOf(reduce(atGuest, { type: "text", text: "א".repeat(121) })).step, stateOf(reduce(atGuest, { type: "text", text: "א".repeat(121) })).guest], ["guest", null]);
  const atNote = stateOf(reduce(atGuest, { type: "no-guest" }));
  check("note step buttons: skip, back, restart", ids(reply(reduce(atGuest, { type: "no-guest" }))), [FLOW_ID.noNote, FLOW_ID.back, FLOW_ID.restart]);
  check("'בלי הערות' -> summary", stateOf(reduce(atNote, { type: "no-note" })).step, "summary");
  check("free text is the note, two lines kept", stateOf(reduce(atNote, { type: "text", text: "שורה אחת\nשורה שתיים" })).note, "שורה אחת\nשורה שתיים");
  check("a note over 500 -> asked again", stateOf(reduce(atNote, { type: "text", text: "א".repeat(501) })).step, "note");
  check("a stale hour tap in the guest step does nothing", stateOf(reduce(atGuest, { type: "hour", start: "13:00" })).start, "09:30");
}

console.log("\n=== 8. summary (step 8) ===");
{
  const s = toSummary();
  const r = reply(reduce({ ...s, step: "note" }, { type: "no-note" }));
  check("buttons: confirm, cancel, back", ids(r), [FLOW_ID.confirm, FLOW_ID.cancel, FLOW_ID.back]);
  check("the summary, exactly", r.type !== "text" ? r.body : "", [
    "רגע לפני שקובעים:",
    "🎙️ דעה לא פופולרית",
    "📅 יום ב׳ 12.10, 09:30–11:00",
    "📍 אולפן גבעון",
    "⏱️ שעה וחצי",
    "👤 אורח/ת: דנה לוי",
    "📝 הערה: אין",
  ].join("\n"));
  check("cancel -> done, 'cancelled'", [stateOf(reduce(s, { type: "cancel" })).step, (reply(reduce(s, { type: "cancel" })) as { body: string }).body], ["done", C.OUTCOME.cancelled]);
  check("back -> note", stateOf(reduce(s, { type: "back" })).step, "note");
}

console.log("\n=== 9. confirm, and the double tap ===");
{
  const s = toSummary();
  const c = reduce(s, { type: "confirm" });
  check("confirm -> submit, state 'submitting'", [c.kind, c.state.step], ["submit", "submitting"]);
  check("🔴 a second 'לקבוע' while submitting submits NOTHING", reduce(c.state, { type: "confirm" }).kind, "reply");
  check("…and says it is in progress", (reply(reduce(c.state, { type: "confirm" })) as { body: string }).body, C.OUTCOME.submitting);
  check("restart while submitting is refused too", stateOf(reduce(c.state, { type: "restart" })).step, "submitting");

  const ok = afterSubmit(c.state, { ok: true, duplicate: false, request: { id: "r-1", studio: "גבעון", dateIsrael: OPEN_DAYS[0], startIsrael: "09:30", endIsrael: "11:00", guest: "דנה לוי", status: "approved" } });
  check("approved -> done, requestId kept", [stateOf(ok).step, stateOf(ok).requestId], ["done", "r-1"]);
  check("🔴 approved -> the EXISTING approvedWhatsappText", (reply(ok) as { body: string }).body, approvedWhatsappText({ showName: SHOW.showName, dateIsrael: OPEN_DAYS[0], startIsrael: "09:30", studio: "גבעון" }));
  check("🔴 a 'לקבוע' tapped again after done submits NOTHING", reduce(ok.state, { type: "confirm" }).kind, "reply");
  check("…and says it was already sent", (reply(reduce(ok.state, { type: "confirm" })) as { body: string }).body, C.OUTCOME.alreadySent);
  check("any other message after done starts a new booking", stateOf(reduce(ok.state, { type: "text", text: "היי" })).step, "menu");

  const pend = afterSubmit(c.state, { ok: true, duplicate: false, request: { id: "r-2", studio: "גבעון", dateIsrael: OPEN_DAYS[0], startIsrael: "09:30", endIsrael: "11:00", guest: null, status: "pending" } });
  check("pending -> done, 'received, will be approved'", (reply(pend) as { body: string }).body, C.OUTCOME.pending(SHOW.showName, OPEN_DAYS[0], "09:30"));
  const dup = afterSubmit(c.state, { ok: true, duplicate: true, request: { id: "r-2", studio: "גבעון", dateIsrael: OPEN_DAYS[0], startIsrael: "09:30", endIsrael: "11:00", guest: null, status: "pending" } });
  check("a duplicate (the shared guard caught it) reads as pending, no error", [stateOf(dup).step, stateOf(dup).requestId], ["done", "r-2"]);
}

console.log("\n=== 10. the slot is taken at the moment of submission ===");
{
  const c = reduce(toSummary(), { type: "confirm" });
  const taken = afterSubmit(c.state, { ok: false, code: "taken" });
  check("taken -> fresh hours of the SAME day", [taken.kind, taken.state.step, taken.state.date], ["need-availability", "hour", OPEN_DAYS[0]]);
  check("…the chosen hour is cleared", [taken.state.start, taken.state.end], [null, null]);
  const rendered = withAvailability(taken.state, availability({ day0Starts: STARTS_DAY0.filter((m) => m !== 9 * 60 + 30) }));
  check("…the hour list says it was taken", (reply(rendered) as { body: string }).body.startsWith(C.NOTICE.slotTaken), true);
  check("…and 09:30 is no longer offered", stateOf(rendered).hours.some((h) => h.start === "09:30"), false);
  check("…guest and note survive the detour", [stateOf(rendered).guest], ["דנה לוי"]);
  check("the notice is said once (consumed)", stateOf(rendered).notice, null);

  check("too many pending -> done, the route's own sentence", [stateOf(afterSubmit(c.state, { ok: false, code: "too-many" })).step, (reply(afterSubmit(c.state, { ok: false, code: "too-many" })) as { body: string }).body], ["done", C.OUTCOME.tooMany]);
  const err = afterSubmit(c.state, { ok: false, code: "error" });
  check("an error -> back to the summary to retry", [stateOf(err).step, (reply(err) as { body: string }).body.startsWith(C.NOTICE.submitFailed)], ["summary", true]);
  check("a feed failure -> the same", stateOf(afterSubmit(c.state, { ok: false, code: "feed-failed" })).step, "summary");
}

console.log("\n=== 11. back and restart, from every step ===");
{
  const s = toSummary();
  const chain = [s];
  let cur = s;
  for (let i = 0; i < 9; i++) {
    cur = reduce(cur, { type: "back" }).state;
    chain.push(cur);
  }
  check("back walks summary -> note -> guest -> hour -> day -> studio-default -> duration -> menu", chain.slice(0, 8).map((x) => x.step), ["summary", "note", "guest", "hour", "day", "studio-default", "duration", "menu"]);
  check("back at the menu stays at the menu", chain[8].step, "menu");
  check("going back clears what was chosen after", [chain[7].duration, chain[7].studio, chain[7].date, chain[7].start, chain[7].guest], [null, null, null, null, null]);
  const fromList = step(start(NO_DEFAULT).state, { type: "go" }, { type: "duration", minutes: 90 });
  check("without a default, back from the studio list -> duration", stateOf(reduce(fromList.state, { type: "back" })).step, "duration");
  const viaOther = step(start(SHOW).state, { type: "go" }, { type: "duration", minutes: 90 }, { type: "studio-other" });
  check("with a default, back from the studio list -> 'as usual?'", stateOf(reduce(viaOther.state, { type: "back" })).step, "studio-default");

  for (const st of ["duration", "studio-default", "day", "hour", "guest", "note", "summary"] as const) {
    const r = reduce({ ...s, step: st }, { type: "restart" });
    check(`restart from ${st} -> a clean menu`, [r.state.step, r.state.duration, r.state.studio, r.state.guest], ["menu", null, null, null]);
  }
  check("typed 'מחדש' restarts too", stateOf(reduce(s, textEvent("מחדש"))).step, "menu");
}

console.log("\n=== 12. an expired conversation ===");
{
  const now = new Date("2026-10-11T10:00:00Z");
  check("the TTL is 30 minutes", FLOW_TTL_MS, 30 * 60 * 1000);
  check("expires 30 minutes after a save", expiresAtFor(now), "2026-10-11T10:30:00.000Z");
  check("alive 29 minutes later", isLive(expiresAtFor(now), new Date(now.getTime() + 29 * 60_000)), true);
  check("🔴 dead 30 minutes later", isLive(expiresAtFor(now), new Date(now.getTime() + 30 * 60_000)), false);
  check("no expiry / garbage -> dead", [isLive(null, now), isLive("nope", now)], [false, false]);
  const fresh = start(SHOW, C.NOTICE.expired);
  check("the restart after expiry says so once", (reply(fresh) as { body: string }).body.startsWith(C.NOTICE.expired), true);
  check("…and is a clean menu", [fresh.state.step, fresh.state.notice], ["menu", null]);
}

console.log("\n=== 13. the stored jsonb ===");
{
  const s = toSummary();
  check("a real state round-trips", parseFlowState(JSON.parse(JSON.stringify(s))), s);
  check("garbage -> null (start fresh)", [parseFlowState(null), parseFlowState([]), parseFlowState({ v: 2 }), parseFlowState({ ...s, step: "paying" })], [null, null, null, null]);
}

console.log("\n=== 14. inbound messages -> events ===");
{
  const msg = (over: Partial<InboundMessage>): InboundMessage => ({ wamid: "w", waId: "972501234567", rawFrom: "972501234567", type: "text", body: null, raw: {}, ...over });
  check("a button tap", eventFromMessage(msg({ type: "interactive", raw: { interactive: { type: "button_reply", button_reply: { id: "f:confirm", title: "✅ לקבוע" } } } })), { type: "confirm" });
  check("a list pick", eventFromMessage(msg({ type: "interactive", raw: { interactive: { type: "list_reply", list_reply: { id: "f:day:2026-10-14", title: "x" } } } })), { type: "day", date: "2026-10-14" });
  check("typed text", eventFromMessage(msg({ body: "דנה" })), { type: "text", text: "דנה" });
  check("typed nav word", eventFromMessage(msg({ body: "חזרה" })), { type: "back" });
  check("an image -> empty text (the step re-sends itself)", eventFromMessage(msg({ type: "image", body: null })), { type: "text", text: "" });
  const prev = process.env.WHATSAPP_BOOKING_FLOW;
  delete process.env.WHATSAPP_BOOKING_FLOW;
  const off = isFlowOn();
  process.env.WHATSAPP_BOOKING_FLOW = "1";
  const one = isFlowOn();
  process.env.WHATSAPP_BOOKING_FLOW = "true";
  const on = isFlowOn();
  if (prev === undefined) delete process.env.WHATSAPP_BOOKING_FLOW;
  else process.env.WHATSAPP_BOOKING_FLOW = prev;
  check("🔴 the switch is OFF unless exactly 'true' (rule 40)", [off, one, on], [false, false, true]);
}

console.log("\n=== 15. Meta's limits, on every message the machine renders ===");
{
  const renders: FlowReply[] = [];
  const collect = (t: Transition) => {
    if (t.kind === "reply") renders.push(t.reply);
  };
  for (const show of [SHOW, NO_DEFAULT, { ...SHOW, multiShow: true, showName: "שם ארוך מאוד של פודקאסט שממשיך וממשיך" }, { ...SHOW, defaultStudio: "גבעון גדול" }]) {
    let t = start(show);
    collect(t);
    t = reduce(t.state, { type: "go" });
    collect(t);
    t = reduce(t.state, { type: "duration", minutes: 180 });
    collect(t);
    collect(reduce(t.state, { type: "studio-other" }));
    t = show.defaultStudio ? reduce(t.state, { type: "studio-yes" }) : reduce(t.state, { type: "studio", studio: "גבעון" });
    t = withAvailability(t.state, availability());
    collect(t);
    collect(reduce(t.state, { type: "more-days" }));
    t = reduce(t.state, { type: "day", date: OPEN_DAYS[0] });
    t = withAvailability(t.state, availability());
    collect(t);
    collect(reduce(t.state, { type: "more-hours" }));
    t = reduce(t.state, { type: "hour", start: "09:00" });
    collect(t);
    t = reduce(t.state, { type: "text", text: "א".repeat(120) });
    collect(t);
    t = reduce(t.state, { type: "text", text: "ב".repeat(500) });
    collect(t);
  }
  const len = (s: string) => Array.from(s).length;
  const buttons = renders.filter((r): r is Extract<FlowReply, { type: "buttons" }> => r.type === "buttons");
  const lists = renders.filter((r): r is Extract<FlowReply, { type: "list" }> => r.type === "list");
  check("rendered enough to mean something", [buttons.length > 10, lists.length > 10], [true, true]);
  check("≤ 3 buttons per message", buttons.every((b) => b.buttons.length <= BUTTON_LIMITS.buttons), true);
  check("every button title ≤ 20 (so nothing is truncated)", buttons.flatMap((b) => b.buttons).filter((b) => len(b.title) > BUTTON_LIMITS.title).map((b) => b.title), []);
  check("≤ 10 rows per list, across sections", lists.every((l) => l.sections.reduce((n, s) => n + s.rows.length, 0) <= LIST_LIMITS.rows), true);
  check("every row title ≤ 24", lists.flatMap((l) => l.sections.flatMap((s) => s.rows)).filter((r) => len(r.title) > LIST_LIMITS.rowTitle).map((r) => r.title), []);
  check("every section title ≤ 24", lists.flatMap((l) => l.sections).every((s) => len(s.title) <= SECTION_TITLE_MAX), true);
  check("every list button ≤ 20", lists.every((l) => len(l.button) <= LIST_LIMITS.button), true);
  check("every body ≤ 1024 (summary with a 120-char guest and a 500-char note)", renders.every((r) => len(r.body) <= 1024), true);
  check("no empty section is ever rendered", lists.every((l) => l.sections.every((s) => s.rows.length > 0)), true);
  check("every id ≤ 200 (Meta's row-id limit)", [...buttons.flatMap((b) => b.buttons.map((x) => x.id)), ...lists.flatMap((l) => l.sections.flatMap((s) => s.rows.map((x) => x.id)))].every((id) => len(id) <= 200), true);

  // the Graph payloads
  const bp = flowPayload("972501234567", buttons[0]) as { type: string; interactive: { type: string; action: { buttons: { type: string; reply: { id: string } }[] } } };
  check("buttons -> interactive/button with reply buttons", [bp.type, bp.interactive.type, bp.interactive.action.buttons[0].type], ["interactive", "button", "reply"]);
  const lp = flowPayload("972501234567", lists[0]) as { interactive: { type: string; action: { sections: { title: string; rows: unknown[] }[] } } };
  check("list -> interactive/list with titled sections", [lp.interactive.type, lp.interactive.action.sections.every((s) => s.title.length > 0)], ["list", true]);
  const tp = flowPayload("972501234567", { type: "text", body: "היי" }) as { type: string; text: { body: string; preview_url: boolean } };
  check("text -> text, no link preview", [tp.type, tp.text.body, tp.text.preview_url], ["text", "היי", false]);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
if (failed > 0) process.exit(1);
