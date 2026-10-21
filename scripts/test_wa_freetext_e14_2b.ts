/**
 * E14-2b — free text at every choice step. Whole conversations through the
 * REAL driver seam (eventFromMessage) and the REAL machine. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_e14_2b.ts
 * No users, no database, no network (fetch throws), no Meta. Availability is a
 * fixed grid per length; "today" is Wed 21.10.2026, 10:00 Israel.
 *
 * Owner decisions 20.10 under test:
 *   1. natural answers at every choice step ("בחשמונאים", "ביום ראשון", "ב-10",
 *      "בשעה 10", "3", "שלוש") and several fields at once, from any step,
 *      back to the right step with the slot checked
 *   2. "ב-10" = that exact start if free, else that day's hours with a reason;
 *      "ב-4" is asked about, never guessed
 *   3. a bare number at the LENGTH step is hours
 *   4. at the guest/note steps text is the value unless marked ("בעצם",
 *      "תשנה", "אורח:", "הערה:")
 *   5. no text ever confirms; the buttons stay
 *   6. switch off / English: exactly as before
 */
import { FLOW_ID, reduce, start, withAvailability, type FlowReply, type FlowState, type Transition } from "../src/lib/whatsapp/flow/machine";
import { eventFromMessage } from "../src/lib/whatsapp/flow/run";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { InboundMessage } from "../src/lib/whatsapp/webhook";

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("network is forbidden in this test");
}) as unknown as typeof fetch;

const HE = COPY.he;
const NOW = new Date("2026-10-21T10:00:00+03:00"); // Wednesday
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

// Sun 25 .. Thu 29.10, every room, a start every 30 min from 09:00, ending by 21:00
const DAYS = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"];
const ROOMS = ["גבעון גדול", "גבעון", "חשמונאים"];
const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
function grid(duration: number): PublicAvailability {
  const free = DAYS.flatMap((d) =>
    ROOMS.flatMap((room) => {
      const out = [];
      for (let m = 9 * 60; m + duration <= 21 * 60; m += 30) out.push({ room, dateIsrael: d, startIsrael: hhmm(m), endIsrael: hhmm(m + duration) });
      return out;
    })
  );
  return { fromIsrael: "2026-10-22", toIsrael: "2026-12-10", rooms: ROOMS, durationMinutes: duration, free, refusedRooms: [] };
}

class Chat {
  state: FlowState;
  last: FlowReply;
  reads = 0;
  constructor(readonly freeTextOn: boolean, readonly lang: "he" | "en" = "he", defaultStudio: string | null = null) {
    const t = start({ showId: "11111111-1111-1111-1111-111111111111", showName: "בדיקה", defaultStudio, multiShow: false, freeTextOn, lang });
    if (t.kind !== "reply") throw new Error("start");
    this.state = t.state;
    this.last = t.reply;
  }
  private drive(t: Transition) {
    for (let g = 0; g < 6; g++) {
      if (t.kind === "reply") {
        this.state = t.state;
        this.last = t.reply;
        return;
      }
      if (t.kind === "need-availability") {
        this.reads++;
        t = withAvailability(t.state, grid(t.state.duration ?? 90));
        continue;
      }
      throw new Error(`unexpected ${t.kind} (a submit from text would be a bug)`);
    }
    throw new Error("did not settle");
  }
  private send(m: InboundMessage) {
    const e = eventFromMessage(m, { now: NOW, freeTextOn: this.freeTextOn, step: this.state.step, lang: this.lang });
    this.drive(reduce({ ...this.state, freeTextOn: this.freeTextOn }, e, { now: NOW }));
  }
  say(text: string) {
    this.send({ wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "text", body: text, raw: null } as InboundMessage);
    return this;
  }
  tap(id: string) {
    const hit = this.offered().find((o) => o.id === id);
    if (!hit) throw new Error(`${id} not offered: ${this.offered().map((o) => o.id).join(", ")}`);
    this.send({ wamid: "w", waId: "972500000000", rawFrom: "972500000000", type: "interactive", body: hit.title, raw: { interactive: { button_reply: { id, title: hit.title } } } } as InboundMessage);
    return this;
  }
  offered() {
    const r = this.last;
    return r.type === "buttons" ? r.buttons : r.type === "list" ? r.sections.flatMap((s) => s.rows.map((x) => ({ id: x.id, title: x.title }))) : [];
  }
  hours() {
    return this.offered().map((o) => o.id).filter((i) => i.startsWith("f:hr:")).map((i) => i.slice(5));
  }
  body() {
    return this.last.body;
  }
  at() {
    return [this.state.step, this.state.duration, this.state.studio, this.state.date, this.state.start];
  }
}

/** a booking at the day step: 90 min, Hashmonaim — by taps */
const atDay = (on = true) => new Chat(on).tap(FLOW_ID.go).tap(FLOW_ID.duration(90)).tap(FLOW_ID.studio("חשמונאים"));

console.log("\n=== 1. natural answers, one per step ===");
{
  const c = new Chat(true).tap(FLOW_ID.go);
  eq("at the length step", c.state.step, "duration");
  c.say("3");
  eq('"3" at the LENGTH step = 3 hours -> the room question', [c.state.step, c.state.duration], ["studio", 180]);
  const c2 = new Chat(true).tap(FLOW_ID.go).say("שלוש");
  eq('"שלוש" = 3 hours', c2.state.duration, 180);
  const c3 = new Chat(true).tap(FLOW_ID.go).say("שעה וחצי");
  eq('"שעה וחצי" = 90', c3.state.duration, 90);
  c.say("בחשמונאים");
  eq('"בחשמונאים" at the room step -> the day list for it', [c.state.step, c.state.studio], ["day", "חשמונאים"]);
  const c4 = new Chat(true).tap(FLOW_ID.go).tap(FLOW_ID.duration(90)).say("חשמונאים בבקשה");
  eq('"חשמונאים בבקשה" works too', c4.state.studio, "חשמונאים");
  c.say("ביום ראשון");
  eq('"ביום ראשון" at the day step -> straight to Sunday\'s hours', [c.state.step, c.state.date], ["hour", "2026-10-25"]);
  ok("…the list says what was asked", c.body().includes("ביום א׳ 25.10"), c.body());
  c.say("ב-10");
  eq('"ב-10" at the hour step = 10:00 exactly, free -> the guest question', [c.state.step, c.state.start, c.state.end], ["guest", "10:00", "13:00"]);
  ok("…saying what it understood", c.body().includes("בשעה 10:00"), c.body());
  const c5 = atDay().say("ביום ראשון").say("בשעה 10");
  eq('"בשעה 10" = the same', [c5.state.step, c5.state.start], ["guest", "10:00"]);
  const c6 = atDay().say("ביום ראשון").say("10");
  eq('a bare "10" at the HOUR step = 10:00', [c6.state.step, c6.state.start], ["guest", "10:00"]);
}

console.log("\n=== 2. an unsure hour: matched to the hours SHOWN, else asked (owner, 21.10) ===");
{
  // Sunday at 1.5h: hours 09:00..19:30 are listed — 04:00 is not, 16:00 is
  const c = atDay().say("ביום ראשון");
  c.say("ב-4");
  eq('"ב-4" while the hours are shown: only 16:00 is on the list -> taken', [c.state.step, c.state.start, c.state.end], ["guest", "16:00", "17:30"]);
  ok("…and said", c.body().includes("בשעה 16:00"), c.body());
  for (const t of ["ב3", "ב 3", "ב-3", "בשלוש", "בשעה שלוש", "3"]) {
    const d = atDay().say("ביום ראשון").say(t);
    eq(`"${t}" = 15:00 (the only reading on the list)`, [d.state.step, d.state.start], ["guest", "15:00"]);
  }
  // 4h on Sunday: starts 09:00..17:00 — neither 07:00 nor 19:00 is listed
  // (E14-2c: "ב-6" is now 18:00 by the opening-hours rule; 7 has no open reading)
  const n = new Chat(true).tap(FLOW_ID.go).tap(FLOW_ID.duration(240)).tap(FLOW_ID.studio("חשמונאים")).say("ביום ראשון");
  const before = n.at();
  n.say("ב-7");
  eq('"ב-7" with NEITHER reading on the list: nothing changed', n.at(), before);
  ok("…asked: not sure about 7", n.body().includes("לא בטוח שהבנתי") && n.body().includes("7"), n.body());
  // BOTH readings listed (a hand-built list): asked, never guessed
  const both = { ...n.state, hours: [{ start: "03:00", end: "07:00" }, { start: "15:00", end: "19:00" }] };
  const t = reduce(both, { type: "edit", edits: [], dropped: ['השעה "3"'], maybe: [{ label: 'השעה "3"', options: ["03:00", "15:00"] }] }, { now: NOW });
  ok("BOTH readings on the list: asked", t.kind === "reply" && t.state.start === null && t.reply.body.includes("לא בטוח שהבנתי"), t);
  // outside the hour step the old rule stands
  const s = atDay().say("ביום ראשון").say("ב-10").say("דני").say("לא");
  eq("at the summary", s.state.step, "summary");
  s.say("ב-7");
  ok('"ב-7" at the SUMMARY: asked, the slot untouched (no reading inside the opening hours)', s.body().includes("לא בטוח שהבנתי") && s.state.start === "10:00", s.body());
  const u = atDay().say("ביום ראשון").say("סתם משהו");
  ok("an unparsed text: 'choose from the options', as before", u.body().startsWith(HE.NOTICE.pickFromList) && u.state.step === "hour", u.body());
}

console.log("\n=== 3. several fields at once, from any step ===");
{
  const c = atDay().say("בעצם ביום ראשון ב-10 עם אורח דני");
  eq("from the DAY step: Sunday 10:00 checked and kept", [c.state.date, c.state.start], ["2026-10-25", "10:00"]);
  eq("…the guest is saved, so the next question is the NOTE", [c.state.guest, c.state.step], ["דני", "note"]);
  const d = new Chat(true).tap(FLOW_ID.go).say("3 שעות ביום ראשון בחשמונאים");
  eq("from the LENGTH step: 3h + room + day -> Sunday's 3h hours", [d.state.step, d.state.duration, d.state.studio, d.state.date], ["hour", 180, "חשמונאים", "2026-10-25"]);
  eq("…the hours are 3-hour slots (last start 18:00)", d.hours().slice(-1)[0] === undefined || d.state.hours[d.state.hours.length - 1]?.start, "18:00");
  const e = new Chat(true).tap(FLOW_ID.go).tap(FLOW_ID.duration(90)).say("ביום ראשון");
  eq("a day at the ROOM step: still the room question (the day remembered)", [e.state.step, e.state.studio, e.state.filter?.dateFrom], ["studio", null, "2026-10-25"]);
  e.tap(FLOW_ID.studio("גבעון"));
  eq("…the room tapped -> straight to Sunday's hours", [e.state.step, e.state.date], ["hour", "2026-10-25"]);
  const f = new Chat(true).tap(FLOW_ID.go).say("ביום ראשון בחשמונאים");
  eq("no length written at the length step: the 1.5h default (disclosed at the summary)", [f.state.duration, f.state.durationFromDefault, f.state.step], [90, true, "hour"]);
}

console.log("\n=== 4. the exact start does not fit: a reason, that day's hours ===");
{
  const c = atDay().say("ביום ראשון").say("ב-20");
  ok("20:00 + 1.5h ends after closing: said", c.body().includes("עדכנתי ✔️ אבל") && c.body().includes("20:00"), c.body());
  eq("…the hours of that day are offered", [c.state.step, c.state.date, c.hours()[0]], ["hour", "2026-10-25", "09:00"]);
  const d = atDay().say("ביום שישי");
  ok("a day with nothing free (Friday): said, with the broaden/back buttons", d.body().includes(HE.NOTICE.noMatchDates) && d.offered().some((o) => o.id === FLOW_ID.broaden), d.body());
}

console.log("\n=== 5. guest / note: the value, unless MARKED ===");
{
  const c = atDay().say("ביום ראשון").say("ב-10");
  eq("at the guest step", c.state.step, "guest");
  // owner, 21.10: at the GUEST step a day/time PHRASE is a change even unmarked;
  // a single word or a bare number is the guest
  const g = atDay().say("ביום ראשון").say("ב-10").say("ביום שני");
  eq("UNMARKED 'ביום שני' at the guest step = a change of day (same 10:00)", [g.state.step, g.state.date, g.state.start, g.state.guest], ["guest", "2026-10-26", "10:00", null]);
  const g2 = atDay().say("ביום ראשון").say("ב-10").say("יום שני");
  eq("'יום שני' too", [g2.state.date, g2.state.guest], ["2026-10-26", null]);
  const g3 = atDay().say("ביום ראשון").say("ב-10").say("26.10");
  eq("an explicit date too", [g3.state.date, g3.state.guest], ["2026-10-26", null]);
  const g4 = atDay().say("ביום ראשון").say("ב-10").say("בשעה 11");
  eq("'בשעה 11' = a change of time", [g4.state.step, g4.state.start, g4.state.guest], ["guest", "11:00", null]);
  const g5 = atDay().say("ביום ראשון").say("ב-10").say("שני");
  eq("a single word 'שני' = the guest's name", [g5.state.guest, g5.state.step, g5.state.date], ["שני", "note", "2026-10-25"]);
  const g6 = atDay().say("ביום ראשון").say("ב-10").say("10");
  eq("a bare '10' = the value", [g6.state.guest, g6.state.step, g6.state.start], ["10", "note", "10:00"]);
  const g7 = atDay().say("ביום ראשון").say("ב-10").say("דני").say("ביום שני נגיע מוקדם");
  eq("at the NOTE step an unmarked day phrase stays the note (marker-only there)", [g7.state.note, g7.state.step, g7.state.date], ["ביום שני נגיע מוקדם", "summary", "2026-10-25"]);
  c.say("בעצם ביום שני");
  eq("MARKED 'בעצם ביום שני': Monday at the same 10:00, back to the guest question", [c.state.step, c.state.date, c.state.start, c.state.guest], ["guest", "2026-10-26", "10:00", null]);
  c.say("אורח: רון");
  eq("'אורח: רון' -> the guest, then the note", [c.state.guest, c.state.step], ["רון", "note"]);
  c.say("תשנה ל-3 שעות");
  eq("'תשנה ל-3 שעות' at the note step: 10:00–13:00 kept, still the note question", [c.state.step, c.state.duration, c.state.start, c.state.end], ["note", 180, "10:00", "13:00"]);
  c.say("שתי מצלמות");
  eq("an unmarked note is the note -> the summary", [c.state.note, c.state.step], ["שתי מצלמות", "summary"]);

  const h = atDay().say("ביום ראשון").say("ב-10").say("הערה: תאורה רכה");
  eq("'הערה: …' at the GUEST step saves the note and still asks the guest", [h.state.note, h.state.step], ["תאורה רכה", "guest"]);
  h.say("דני");
  eq("…then the guest -> straight to the summary (the note was given)", [h.state.guest, h.state.step], ["דני", "summary"]);
  const k = atDay().say("ביום ראשון").say("ב-10").say("לא");
  eq("'לא' at the guest step still skips it", [k.state.guest, k.state.step], [null, "note"]);
}

console.log("\n=== 6. no text ever confirms; the buttons stay ===");
{
  const c = atDay().say("ביום ראשון").say("ב-10").say("דני").say("לא");
  eq("at the summary", c.state.step, "summary");
  for (const t of ["כן", "מאשר", "מאשר, ביום שני"]) {
    c.say(t);
    ok(`'${t}' does not submit (still the summary or a re-check)`, c.state.step === "summary" || c.state.step === "hour", c.state.step);
  }
  const d = atDay();
  d.say("מאשר");
  eq("'מאשר' at a choice step: the step again", [d.state.step, d.body().startsWith(HE.NOTICE.pickFromList)], ["day", true]);
  const e = atDay().say("ביום ראשון");
  ok("the hour list still has the back/restart buttons", e.offered().some((o) => o.id === FLOW_ID.back), e.offered());
}

console.log("\n=== 7. switch OFF / English: exactly as before ===");
for (const v of [{ label: "off", on: false, lang: "he" as const }, { label: "English", on: true, lang: "en" as const }]) {
  const c = new Chat(v.on, v.lang).tap(FLOW_ID.go);
  c.say("3");
  ok(`[${v.label}] '3' at the length step: choose from the options`, c.state.step === "duration" && c.body().startsWith(COPY[v.lang].NOTICE.pickFromList), c.body());
  c.tap(FLOW_ID.duration(90)).say("בחשמונאים");
  eq(`[${v.label}] 'בחשמונאים' at the room step: the room step again`, c.state.step, "studio");
  c.tap(FLOW_ID.studio("חשמונאים")).say("ביום ראשון");
  eq(`[${v.label}] 'ביום ראשון' at the day step: the day step again`, c.state.step, "day");
  c.tap(FLOW_ID.day("2026-10-25")).say("ב-10");
  eq(`[${v.label}] 'ב-10' at the hour step: the hour step again`, [c.state.step, c.state.start], ["hour", null]);
  c.tap(FLOW_ID.hour("10:00")).say("בעצם ביום שני");
  eq(`[${v.label}] at the guest step any text is the guest, marker or not`, [c.state.guest, c.state.step], ["בעצם ביום שני", "note"]);
}

eq("no network call was attempted", fetchCalls, 0);
console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
