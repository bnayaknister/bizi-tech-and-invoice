/**
 * E14 — whole conversations through the REAL parser and the REAL machine,
 * printed as client/bot transcripts.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_conversation.ts
 *
 * Every message goes through `eventFromMessage` (run.ts) and `reduce` /
 * `withAvailability` / `afterSubmit` (machine.ts), the way runFlow drives
 * them. What runFlow does against live services is replaced, not called:
 *   · availability  -> a fixed grid (FIXTURE below), recorded per request
 *   · submission    -> a recorded MOCK request; no submitBookingRequest
 *   · the version lock (saveConversation) -> NOT simulated — see scenario 6
 * No network (fetch throws and is counted), no database, no Meta, no
 * calendar, no .env.local. The switch is set inside this process only, and
 * the clock is fixed: "today" is Friday 16.10.2026, 10:00 Israel.
 */
import {
  afterSubmit,
  FLOW_ID,
  reduce,
  start,
  withAvailability,
  type FlowReply,
  type FlowState,
  type ShowInfo,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { eventFromMessage, isFreeTextOn } from "../src/lib/whatsapp/flow/run";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { SubmitResult } from "../src/lib/booking/submit";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

// ── no network, ever ────────────────────────────────────────────────────────
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

const HE = COPY.he;
const EN = COPY.en;
const NOW = new Date("2026-10-16T10:00:00+03:00"); // Friday

let passed = 0;
let failed = 0;
const results: { scenario: string; pass: number; fail: number }[] = [];
let cur = { scenario: "", pass: 0, fail: 0 };
function scenario(name: string) {
  if (cur.scenario) results.push(cur);
  cur = { scenario: name, pass: 0, fail: 0 };
  console.log(`\n${"═".repeat(70)}\n${name}\n${"═".repeat(70)}`);
}
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    cur.pass++;
    console.log(`   ✅ ${name}`);
  } else {
    failed++;
    cur.fail++;
    console.log(`   ❌ ${name}${detail !== undefined ? `\n        ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── the fixed availability grid ─────────────────────────────────────────────
// Sun 18.10 – Thu 22.10, all three rooms, a start every 30 min from 09:00
// while the recording ends by 21:00 — so the grid really depends on length.
const DAYS = ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22"];
const ROOMS = ["גבעון גדול", "גבעון", "חשמונאים"];
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function FIXTURE(duration: number): PublicAvailability {
  const free = DAYS.flatMap((d) =>
    ROOMS.flatMap((room) => {
      const out = [];
      for (let m = 9 * 60; m + duration <= 21 * 60; m += 30) {
        out.push({ room, dateIsrael: d, startIsrael: hhmm(m), endIsrael: hhmm(m + duration) });
      }
      return out;
    })
  );
  return { fromIsrael: "2026-10-17", toIsrael: "2026-12-10", rooms: ROOMS, durationMinutes: duration, free, refusedRooms: [] };
}

// ── the driver: runFlow's loop, with the live parts replaced ────────────────
type Submitted = { showId: string; studio: string | null; startIsrael: string; endIsrael: string | null; guest: string | null; note: string | null; durationMinutes: number | null };

class Conversation {
  state: FlowState;
  last: FlowReply;
  availCalls: { step: string; duration: number | null; studio: string | null }[] = [];
  submits: Submitted[] = [];
  nextSubmit: "approved" | "taken" = "approved";

  constructor(readonly label: string, show: ShowInfo) {
    const t = start(show);
    if (t.kind !== "reply") throw new Error("start must reply");
    this.state = t.state;
    this.last = t.reply;
    this.printBot(t.reply);
  }

  private drive(t: Transition): void {
    for (let guard = 0; guard < 10; guard++) {
      if (t.kind === "reply") {
        this.state = t.state;
        this.last = t.reply;
        this.printBot(t.reply);
        return;
      }
      if (t.kind === "need-availability") {
        this.availCalls.push({ step: t.state.step, duration: t.state.duration, studio: t.state.studio });
        t = withAvailability(t.state, FIXTURE(t.state.duration ?? 90));
        continue;
      }
      if (t.kind === "submit") {
        const s = t.state;
        // the same mapping runFlow hands submitBookingRequest — recorded only
        this.submits.push({
          showId: s.showId, studio: s.studio, startIsrael: `${s.date} ${s.start}`, endIsrael: s.end,
          guest: s.guest, note: s.note, durationMinutes: s.duration,
        });
        console.log(`   📝 [mock] בקשת הזמנה נרשמה: ${s.studio} · ${s.date} ${s.start}–${s.end} · ${s.duration} דק׳ · אורח=${s.guest ?? "—"} · הערה=${s.note ?? "—"}`);
        const r: SubmitResult =
          this.nextSubmit === "taken"
            ? { ok: false, code: "taken" }
            : { ok: true, duplicate: false, request: { id: `00000000-0000-4000-8000-${pad(this.submits.length).padStart(12, "0")}`, studio: s.studio!, dateIsrael: s.date!, startIsrael: s.start!, endIsrael: s.end!, guest: s.guest, status: "approved" } };
        this.nextSubmit = "approved";
        t = afterSubmit(s, r);
        continue;
      }
      throw new Error(`unexpected transition ${t.kind}`);
    }
    throw new Error("driver loop did not settle");
  }

  /** what runFlow does per message: switches re-read, then parse + reduce */
  private step(message: InboundMessage) {
    const freeTextOn = isFreeTextOn();
    const event = eventFromMessage(message, { now: NOW, freeTextOn, step: this.state.step, lang: this.state.lang });
    this.drive(reduce({ ...this.state, freeTextOn }, event, { now: NOW }));
  }

  say(text: string) {
    console.log(`\n👤 לקוח: ${text}`);
    this.step({ wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "text", body: text, raw: null } as InboundMessage);
  }

  /** a tap — only on something the LAST reply actually offered */
  tap(id: string) {
    const offered = this.offered();
    const hit = offered.find((o) => o.id === id);
    if (!hit) throw new Error(`[${this.label}] tap ${id} was not offered; offered: ${offered.map((o) => o.id).join(", ")}`);
    console.log(`\n👆 לחיצה: [${hit.title}]`);
    this.step({ wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "interactive", body: hit.title, raw: { interactive: { button_reply: { id, title: hit.title } } } } as InboundMessage);
  }

  /** a tap on a button of an EARLIER message — WhatsApp keeps those tappable */
  tapEarlier(reply: FlowReply, id: string) {
    const all = reply.type === "buttons" ? reply.buttons : reply.type === "list" ? reply.sections.flatMap((x) => x.rows) : [];
    const hit = all.find((o) => o.id === id);
    if (!hit) throw new Error(`[${this.label}] ${id} was not in that earlier message`);
    console.log(`\n👆 לחיצה על הודעה קודמת: [${hit.title}]`);
    this.step({ wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "interactive", body: hit.title, raw: { interactive: { button_reply: { id, title: hit.title } } } } as InboundMessage);
  }

  offered(): { id: string; title: string }[] {
    const r = this.last;
    if (r.type === "buttons") return r.buttons;
    if (r.type === "list") return r.sections.flatMap((s) => s.rows.map((x) => ({ id: x.id, title: x.title })));
    return [];
  }
  offeredIds(prefix: string) {
    return this.offered().map((o) => o.id).filter((i) => i.startsWith(prefix));
  }
  body() {
    return this.last.body;
  }

  private printBot(r: FlowReply) {
    console.log(`🤖 בוט: ${r.body.split("\n").join("\n         ")}`);
    if (r.type === "buttons") console.log(`         ${r.buttons.map((b) => `[${b.title}]`).join(" ")}`);
    if (r.type === "list") {
      const rows = r.sections.flatMap((s) => s.rows);
      console.log(`         ☰ ${r.button}: ${rows.map((x) => x.title).join(" · ")}`);
    }
  }
}

const SHOW: ShowInfo = {
  showId: "11111111-1111-1111-1111-111111111111",
  showName: "דעה לא פופולרית",
  defaultStudio: "גבעון",
  multiShow: false,
  manageOn: false,
  linkUrl: "https://example.test/b/token",
};
const daysOf = (ids: string[]) => ids.map((i) => i.slice(FLOW_ID.day("").length));
const hoursOf = (ids: string[]) => ids.map((i) => i.slice(FLOW_ID.hour("").length));

function main() {
  process.env.WHATSAPP_BOOKING_FREETEXT = "true"; // this process only
  eq("the switch is read as ON inside this process", isFreeTextOn(), true);

  // ════════════════════════════════════════════════════════════════════════
  scenario("1. בקשת זמינות בטקסט חופשי — חדר, ימים ושעות");
  const c = new Conversation("main", SHOW);
  c.say("תגיד לי מה פנוי שבוע הבא בין יום ראשון לרביעי אחרי השעה אחת בצהריים, חדר החשמונאים");
  eq("the room the client wrote is set", c.state.studio, "חשמונאים");
  eq("availability was read once, for חשמונאים at 90", c.availCalls, [{ step: "day", duration: 90, studio: "חשמונאים" }]);
  eq("only Sun–Wed of next week are offered", daysOf(c.offeredIds("f:day:")), ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"]);
  ok("the bot says what it understood (room, days, after 13:00)", c.body().includes("רשמתי לי") && c.body().includes("חשמונאים") && c.body().includes("אחרי 13:00"), c.body());
  c.tap(FLOW_ID.day("2026-10-20"));
  const hrs1 = hoursOf(c.offeredIds("f:hr:"));
  ok("every offered hour starts at/after 13:00", hrs1.length > 0 && hrs1.every((h) => h >= "13:00"), hrs1);
  eq("the first offered hour is 13:00", hrs1[0], "13:00");
  ok("every STORED hour (the validation list) is ≥ 13:00 too", c.state.hours.every((h) => h.start >= "13:00"), c.state.hours);
  ok("the stored hours are all in חשמונאים on 20.10 (90 min)", c.state.hours.every((h) => toMin(h.end) - toMin(h.start) === 90) && c.state.date === "2026-10-20" && c.state.studio === "חשמונאים");

  // ════════════════════════════════════════════════════════════════════════
  scenario("2. עד הסיכום — משך שלא צוין = שעה וחצי, מוצג במפורש לפני האישור");
  c.tap(FLOW_ID.hour("13:00"));
  eq("next step asks for the guest", c.state.step, "guest");
  c.say("יהודה לוי");
  c.tap(FLOW_ID.noNote);
  eq("at the summary", c.state.step, "summary");
  eq("duration 90, flagged as the default", [c.state.duration, c.state.durationFromDefault], [90, true]);
  ok("the summary DISCLOSES the 1.5h default", c.body().includes(HE.SUMMARY.durationDefault), c.body());
  ok("…before the confirm button (the button is still there, nothing submitted)", c.offered().some((b) => b.id === FLOW_ID.confirm) && c.submits.length === 0);

  // ════════════════════════════════════════════════════════════════════════
  scenario("3. עריכה בהודעה אחת: אורח + הערה עם פסיק + חדר; יום אחר; 3 שעות — המועד נשמר כשהוא מתאים (E14-2)");
  c.say("אורח: דנה כהן, הערה: שתי מצלמות, תאורה רכה, אולפן: גבעון גדול");
  eq("a room change re-checked THE CHOSEN TIME for גבעון גדול", c.availCalls[c.availCalls.length - 1], { step: "hour", duration: 90, studio: "גבעון גדול" });
  eq("13:00 is free there: kept, straight back to the summary", [c.state.step, c.state.guest, c.state.note, c.state.studio, c.state.date, c.state.start, c.state.end], ["summary", "דנה כהן", "שתי מצלמות, תאורה רכה", "גבעון גדול", "2026-10-20", "13:00", "14:30"]);
  ok("…saying 'updated'", c.body().includes(HE.NOTICE.changed), c.body());
  ok("the summary shows the note whole, comma included", c.body().includes("שתי מצלמות, תאורה רכה"), c.body());
  ok("still 90 by default — still disclosed", c.body().includes(HE.SUMMARY.durationDefault));

  c.say("יום רביעי");
  eq("a day change keeps the time too (13:00 on Wednesday)", [c.state.step, c.state.date, c.state.start, c.state.end], ["summary", "2026-10-21", "13:00", "14:30"]);

  const callsBefore = c.availCalls.length;
  c.say("3 שעות");
  eq("a length change re-checked 13:00 AT 180", c.availCalls.slice(callsBefore), [{ step: "hour", duration: 180, studio: "גבעון גדול" }]);
  eq("summary: 180 min, 13:00–16:00, guest + note kept", [c.state.step, c.state.duration, c.state.start, c.state.end, c.state.guest, c.state.note], ["summary", 180, "13:00", "16:00", "דנה כהן", "שתי מצלמות, תאורה רכה"]);
  ok("…'updated', no 're-choose'", c.body().includes(HE.NOTICE.changed) && !c.body().includes(HE.NOTICE.changedRechoose), c.body());
  ok("no default disclosure once the client chose the length", !c.body().includes(HE.SUMMARY.durationDefault), c.body());
  eq("nothing was submitted by any of this", c.submits.length, 0);

  // ── the time does NOT fit the new length: say why, offer that day's hours ──
  const k = new Conversation("keep-fails", SHOW);
  k.say("מה פנוי ביום שלישי אחרי 19:00 בחשמונאים?");
  eq("one day asked + room named: straight to that day's hours (no one-day list)", [k.state.step, k.state.date, k.availCalls.length], ["hour", "2026-10-20", 1]);
  ok("…the list says what was asked", k.body().includes("ביום ג׳ 20.10 אחרי 19:00 פנוי לשעה וחצי באולפן חשמונאים:"), k.body());
  eq("…only hours from 19:00", hoursOf(k.offeredIds("f:hr:")), ["19:00", "19:30"]);
  k.tap(FLOW_ID.hour("19:30"));
  k.tap(FLOW_ID.noGuest);
  k.tap(FLOW_ID.noNote);
  eq("at the summary, 19:30–21:00", [k.state.step, k.state.start, k.state.end], ["summary", "19:30", "21:00"]);
  k.say("3 שעות");
  ok("19:30 + 3h does not fit: said, with the reason", k.body().includes("עדכנתי ✔️ אבל") && k.body().includes("19:30") && k.body().includes("3 שעות"), k.body());
  eq("…the hours of THAT day at 180, all of them", [k.state.step, k.state.date, hoursOf(k.offeredIds("f:hr:"))[0]], ["hour", "2026-10-20", "09:00"]);
  ok("…every stored hour is a 3-hour slot", k.state.hours.every((h) => toMin(h.end) - toMin(h.start) === 180), k.state.hours);
  k.tap(FLOW_ID.hour("11:00"));
  eq("a new hour -> straight back to the summary (guest and note were already answered, both skipped)", [k.state.step, k.state.start, k.state.end, k.state.duration, k.state.guest, k.state.note], ["summary", "11:00", "14:00", 180, null, null]);
  eq("nothing submitted", k.submits.length, 0);

  // ════════════════════════════════════════════════════════════════════════
  scenario("4. בקשות לא ברורות — הבוט אומר מה לא הבין, לא מנחש ולא מתעלם");
  const u = new Conversation("unclear", SHOW);
  u.say("יש מקום ביום שלישי אחרי 4?");
  ok("the bare '4' is named as not understood", u.body().includes("לא בטוח שהבנתי") && u.body().includes("4"), u.body());
  eq("…and NOT used as a time filter", u.state.filter?.timeFrom ?? null, null);
  eq("the certain part (Tuesday) is used", u.state.filter?.dateFrom, "2026-10-20");
  u.tap(FLOW_ID.studioYes);
  eq("one day asked, and it is free: its hours straight away (E14-2)", [u.state.step, u.state.date], ["hour", "2026-10-20"]);
  ok("hours are NOT narrowed by the unclear 4 (09:00 is offered)", u.state.hours[0]?.start === "09:00", u.state.hours[0]);
  u.tap(FLOW_ID.hour("09:00"));
  u.tap(FLOW_ID.noGuest);
  u.tap(FLOW_ID.noNote);
  const before4 = { ...u.state };
  u.say("אורח: רון, אחרי 4");
  eq("the guest is applied", u.state.guest, "רון");
  ok("…and the vague time is SAID", u.body().includes("לא בטוח שהבנתי") && u.body().includes(HE.NOTICE.changedPartial), u.body());
  eq("…the slot is untouched", [u.state.date, u.state.start], [before4.date, before4.start]);
  u.say("זה נראה לי ממש טוב");
  ok("an unparsed text asks what to change", u.body().includes(HE.NOTICE.editUnclear), u.body());
  const before4b = { date: u.state.date, start: u.state.start, guest: u.state.guest };
  u.say("יום רביעי או יום חמישי");
  ok("two different days: the day is named as unclear", u.body().includes("לא בטוח שהבנתי") && u.body().includes("היום"), u.body());
  ok("…and the bot does NOT claim it updated anything", !u.body().includes("עדכנתי") && u.body().includes(HE.NOTICE.unchanged), u.body());
  eq("…nothing changed", { date: u.state.date, start: u.state.start, guest: u.state.guest }, before4b);
  eq("nothing submitted", u.submits.length, 0);

  // ════════════════════════════════════════════════════════════════════════
  scenario("5. אין זמינות בטווח — נאמר במפורש, הרחבה רק בבחירת הלקוח");
  const n = new Conversation("nomatch", SHOW);
  n.say("מה פנוי ב-28.10 בחשמונאים?");
  ok("the bot says nothing is free in those days", n.body().includes(HE.NOTICE.noMatchDates), n.body());
  eq("no day is offered as if it matched", n.offeredIds("f:day:"), []);
  eq("the only ways on: broaden or back", n.offered().map((o) => o.id), [FLOW_ID.broaden, FLOW_ID.back]);
  const noMatchReply = n.last;
  n.say("כן");
  eq("typing 'כן' does NOT broaden", [n.state.days.length, n.offeredIds("f:day:").length], [0, 0]);
  ok("…and the broaden choice is still offered after a typed text", n.offered().some((o) => o.id === FLOW_ID.broaden), n.offered());
  ok("…and the bot does not claim there ARE free days while listing none", !n.body().includes("שיש בהם מקום"), n.body());
  ok("the zero-match message does not invite typing other days (owner, 16.10: buttons only)", !noMatchReply.body.includes("לכתוב"), noMatchReply.body);
  n.tapEarlier(noMatchReply, FLOW_ID.broaden);
  eq("after the explicit tap: all free days", daysOf(n.offeredIds("f:day:")), DAYS);
  eq("…for the room the client asked for", n.state.studio, "חשמונאים");
  // E14-2b (owner, 20.10: free text at every step): ANOTHER day typed at the
  // zero-match screen is a new, narrow request — not a broadening
  const n2 = new Conversation("nomatch-retype", SHOW);
  n2.say("מה פנוי ב-28.10 בחשמונאים?");
  n2.say("אז אולי ביום שני?");
  eq("another day typed on the zero-match screen: THAT day's hours", [n2.state.step, n2.state.date], ["hour", "2026-10-19"]);
  eq("…the filter is that one day, not 'all days'", [n2.state.filter?.dateFrom, n2.state.filter?.dateTo], ["2026-10-19", "2026-10-19"]);
  const h = new Conversation("nomatch-hours", SHOW);
  h.say("מה פנוי ביום שלישי אחרי 20:00 בחשמונאים?");
  eq("one day asked: straight to its hours (E14-2)", h.state.step, "hour");
  ok("hours: nothing after 20:00 is said", h.body().includes(HE.NOTICE.noMatchHours), h.body());
  eq("hours: no hour offered as if it matched", h.offeredIds("f:hr:"), []);
  const noHourReply = h.last;
  h.say("כן");
  ok("hours: the broaden choice survives a typed text", h.offered().some((o) => o.id === FLOW_ID.broaden), h.offered());
  h.tapEarlier(noHourReply, FLOW_ID.broaden);
  ok("hours: after the explicit tap, all hours of that day (09:00 first)", h.offeredIds("f:hr:")[0] === FLOW_ID.hour("09:00"), h.offered());

  // ════════════════════════════════════════════════════════════════════════
  scenario("6. 'כן' / 'מאשר' בטקסט אינם אישור; הכפתור מגיש בקשה מדומה אחת");
  c.say("כן");
  ok("'כן' -> pointed at the button, still the summary", c.state.step === "summary" && c.body().includes(HE.NOTICE.confirmByButton), c.body());
  ok("…without claiming an update", !c.body().includes("עדכנתי"), c.body());
  c.say("מאשר");
  ok("'מאשר' -> same", c.state.step === "summary" && c.body().includes(HE.NOTICE.confirmByButton), c.body());
  c.say("מאשר, ותוסיף אורח רון");
  eq("a mixed message only edits", [c.state.step, c.state.guest], ["summary", "רון"]);
  eq("…with exactly one 'updated' line", c.body().split("עדכנתי").length - 1, 1);
  eq("no text submitted anything", c.submits.length, 0);
  const summaryState = c.state;
  c.tap(FLOW_ID.confirm);
  eq("the button submits exactly one MOCK request", c.submits.length, 1);
  eq("…with the summary's values", c.submits[0], {
    showId: SHOW.showId, studio: "גבעון גדול", startIsrael: "2026-10-21 13:00", endIsrael: "16:00",
    guest: "רון", note: "שתי מצלמות, תאורה רכה", durationMinutes: 180,
  });
  eq("conversation done", c.state.step, "done");
  // a late re-tap of the old summary's button, after done
  const doneState = c.state;
  const reTap = reduce({ ...doneState, freeTextOn: true }, { type: "confirm" }, { now: NOW });
  eq("a confirm after 'done' submits nothing", reTap.kind, "reply");
  // a second delivery that finds the conversation already 'submitting'
  const inFlight = reduce({ ...summaryState, step: "submitting", freeTextOn: true }, { type: "confirm" }, { now: NOW });
  eq("a confirm while 'submitting' submits nothing", inFlight.kind, "reply");
  // two deliveries that both read the SAME pre-submit summary (a race):
  // the machine alone answers 'submit' to both — the guard is the version
  // lock in saveConversation, which this test does not run
  const raceA = reduce({ ...summaryState, freeTextOn: true }, { type: "confirm" }, { now: NOW });
  const raceB = reduce({ ...summaryState, freeTextOn: true }, { type: "confirm" }, { now: NOW });
  eq("(documented) a race on the same summary is NOT stopped by the machine — that is the store's version lock, not covered here", [raceA.kind, raceB.kind], ["submit", "submit"]);

  // ════════════════════════════════════════════════════════════════════════
  scenario("7. מתג כבוי, ושיחה באנגלית עם מתג מופעל — התנהגות קיימת");
  const legacyRun = (label: string, show: ShowInfo, C: typeof HE | typeof EN) => {
    const x = new Conversation(label, show);
    x.say("מה פנוי מחר בחשמונאים?");
    eq(`[${label}] a free-text query at the menu is NOT parsed — the menu again`, [x.state.step, x.state.studio, x.availCalls.length], ["menu", null, 0]);
    x.tap(FLOW_ID.go);
    x.tap(FLOW_ID.duration(90));
    x.tap(FLOW_ID.studioYes);
    x.tap(FLOW_ID.day("2026-10-18"));
    x.tap(FLOW_ID.hour("09:30"));
    x.say("Yehuda Levi");
    x.say("three cameras");
    eq(`[${label}] at the summary`, x.state.step, "summary");
    ok(`[${label}] no default disclosure / edit invitation`, !x.body().includes(C.SUMMARY.durationDefault) && !x.body().includes(C.SUMMARY.editHint), x.body());
    x.say("אורח: דנה");
    ok(`[${label}] summary text -> 'choose from the options', guest unchanged`, x.body().includes(C.NOTICE.pickFromList) && x.state.guest === "Yehuda Levi", x.body());
    x.say("כן");
    eq(`[${label}] 'כן' submits nothing`, x.submits.length, 0);
    x.nextSubmit = "taken";
    x.tap(FLOW_ID.confirm);
    eq(`[${label}] one submission, answered 'taken'`, [x.submits.length, x.state.step], [1, "hour"]);
    x.tap(FLOW_ID.hour("10:00"));
    eq(`[${label}] after the taken slot, a new hour -> the GUEST step (as on main)`, x.state.step, "guest");
    eq(`[${label}] …the new hour is kept`, [x.state.start, x.state.end], ["10:00", "11:30"]);
  };
  delete process.env.WHATSAPP_BOOKING_FREETEXT;
  eq("switch OFF in this process", isFreeTextOn(), false);
  legacyRun("off-he", SHOW, HE);
  process.env.WHATSAPP_BOOKING_FREETEXT = "true";
  legacyRun("on-en", { ...SHOW, lang: "en" }, EN);
  delete process.env.WHATSAPP_BOOKING_FREETEXT;

  results.push(cur);
  console.log(`\n${"═".repeat(70)}`);
  for (const r of results) console.log(`${r.fail === 0 ? "✅" : "❌"} ${r.scenario} — ${r.pass} עברו${r.fail ? `, ${r.fail} נכשלו` : ""}`);
  ok("zero network calls in the whole run", fetchCalls === 0, fetchCalls);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function toMin(h: string) {
  const [a, b] = h.split(":").map(Number);
  return a * 60 + b;
}

try {
  main();
} catch (e) {
  console.error("❌ crashed:", e);
  process.exit(1);
}
