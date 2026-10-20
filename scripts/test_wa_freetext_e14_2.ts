/**
 * E14-2א — skip answered steps, lists that say what was asked, and a summary
 * edit that KEEPS the chosen time when it still fits. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_wa_freetext_e14_2.ts
 * No users, no database, no network, no Meta. Availability is hand-built per
 * length (the driver reads it per length too); "today" is Tue 20.10.2026.
 *
 * Owner, 20.10: (1) a day (and time) already known and free -> the next step,
 * not a one-day list; (2) the list echoes the request; (4) a length / room /
 * day change keeps the date and time if they fit, says "עדכנתי ✔️" and returns
 * to the summary — otherwise asks for another time with a short reason.
 * All of it ONLY with the layer on (switch + Hebrew); off, nothing changes.
 */
import {
  FLOW_ID,
  initialState,
  reduce,
  start,
  withAvailability,
  type FlowReply,
  type FlowState,
  type Transition,
} from "../src/lib/whatsapp/flow/machine";
import { COPY } from "../src/lib/whatsapp/flow/copy";
import type { PublicAvailability } from "../src/lib/booking/publicView";
import type { BookingDuration } from "../src/lib/booking/duration";
import type { BookableRoom } from "../src/lib/booking/request";

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
const ok = (name: string, cond: boolean, detail?: unknown) => check(name, cond ? true : { failed: detail }, true);

const HE = COPY.he;
const NOW = new Date("2026-10-20T10:00:00+03:00");
const SHOW = { showId: "11111111-1111-1111-1111-111111111111", showName: "בדיקה", defaultStudio: "גבעון", multiShow: false, freeTextOn: true };
const ROOMS = ["גבעון גדול", "גבעון", "חשמונאים"];
const WEEK = ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29"]; // Sun..Thu

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
/** Free slots for ONE length: every room, every day, starts every 30 min from `open` while the slot ends by `close`. */
function avail(duration: BookingDuration, opts: { days?: string[]; rooms?: string[]; open?: number; close?: Record<string, number> } = {}): PublicAvailability {
  const days = opts.days ?? WEEK;
  const rooms = opts.rooms ?? ROOMS;
  const free = days.flatMap((d) =>
    rooms.flatMap((room) => {
      const out = [];
      const close = opts.close?.[d] ?? 21 * 60;
      for (let m = opts.open ?? 9 * 60; m + duration <= close; m += 30) out.push({ room, dateIsrael: d, startIsrael: hhmm(m), endIsrael: hhmm(m + duration) });
      return out;
    })
  );
  return { fromIsrael: "2026-10-21", toIsrael: "2026-12-10", rooms: ROOMS, durationMinutes: duration, free, refusedRooms: [] };
}
const reply = (t: Transition): FlowReply => {
  if (t.kind !== "reply") throw new Error(`expected a reply, got ${t.kind}`);
  return t.reply;
};
const ids = (t: Transition, prefix: string) => {
  const r = reply(t);
  const all = r.type === "buttons" ? r.buttons : r.type === "list" ? r.sections.flatMap((s) => s.rows) : [];
  return all.map((x) => x.id).filter((i) => i.startsWith(prefix)).map((i) => i.slice(prefix.length));
};
/** need-availability -> withAvailability with the pub for the state's length */
function feed(t: Transition, pubFor: (d: BookingDuration) => PublicAvailability = (d) => avail(d)): Transition {
  for (let g = 0; g < 5 && t.kind === "need-availability"; g++) t = withAvailability(t.state, pubFor((t.state.duration ?? 90) as BookingDuration));
  return t;
}
const q = (over: Partial<{ studio: BookableRoom | null; duration: BookingDuration | null; dateFrom: string | null; dateTo: string | null; timeFrom: string | null; timeTo: string | null }>) => ({
  type: "query" as const,
  q: { studio: null, duration: null, dateFrom: null, dateTo: null, timeFrom: null, timeTo: null, dropped: [] as string[], ...over },
});

/** A booking at the summary: Tue 27.10 16:00, Givon, 90, guest/note as given. */
function summary(over: Partial<FlowState> = {}): FlowState {
  return {
    ...initialState({ ...SHOW, lang: "he" }),
    step: "summary",
    duration: 90,
    studio: "גבעון",
    date: "2026-10-27",
    start: "16:00",
    end: "17:30",
    guest: "דני",
    note: "שתי מצלמות",
    ...over,
  };
}
const edit = (s: FlowState, edits: Array<Record<string, unknown>>, dropped: string[] = []) =>
  reduce(s, { type: "edit", edits: edits.map((e) => ({ alsoConfirm: false, ...e })) as never, dropped }, { now: NOW });

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. one day asked and free -> its hours, not a one-day list ===");
{
  const t = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-29", dateTo: "2026-10-29", timeFrom: "14:00" }), { now: NOW }));
  check("straight to the hour step for that day", [t.state.step, t.state.date], ["hour", "2026-10-29"]);
  check("only hours from 14:00", ids(t, "f:hr:").slice(0, 2), ["14:00", "14:30"]);
  check("the stored days are that one day (for 'back')", t.state.days, ["2026-10-29"]);
  const back = reduce(t.state, { type: "back" }, { now: NOW });
  check("back -> the day list, not an empty screen", [back.state.step, ids(back, "f:day:")], ["day", ["2026-10-29"]]);

  // no room named: the room question first, then — the hours (owner's own test, 20.10)
  let u = reduce(start(SHOW).state, q({ dateFrom: "2026-10-29", dateTo: "2026-10-29", timeFrom: "14:00" }), { now: NOW });
  check("no room named: the room question", u.state.step, "studio-default");
  u = feed(reduce(u.state, { type: "studio", studio: "חשמונאים" }, { now: NOW }));
  check("a room picked -> that day's hours", [u.state.step, u.state.date, u.state.studio], ["hour", "2026-10-29", "חשמונאים"]);
  u = feed(reduce(reduce(start(SHOW).state, q({ dateFrom: "2026-10-29", dateTo: "2026-10-29" }), { now: NOW }).state, { type: "studio-yes" }, { now: NOW }));
  check("'as usual' room -> that day's hours, all of them", [u.state.step, ids(u, "f:hr:")[0]], ["hour", "09:00"]);

  const range = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-25", dateTo: "2026-10-28" }), { now: NOW }));
  check("a RANGE of days: still the day list", [range.state.step, ids(range, "f:day:")], ["day", ["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]]);
  const busy = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-30", dateTo: "2026-10-30" }), { now: NOW }));
  check("the one day is NOT free: the zero-match screen, unchanged", [busy.state.step, ids(busy, "f:")], ["day", ["broaden", "back"]]);
  const late = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-29", dateTo: "2026-10-29", timeFrom: "20:00" }), { now: NOW }));
  check("the day is free but not after 20:00: the hours zero-match screen", [late.state.step, ids(late, "f:")], ["hour", ["broaden", "back"]]);
}

console.log("\n=== 2. the lists say what was asked ===");
{
  const t = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-29", dateTo: "2026-10-29", timeFrom: "14:00" }), { now: NOW }));
  ok("hours: 'ביום ה׳ 29.10 אחרי 14:00 פנוי לשעה וחצי באולפן חשמונאים:'", reply(t).body.includes("ביום ה׳ 29.10 אחרי 14:00 פנוי לשעה וחצי באולפן חשמונאים:"), reply(t).body);
  const r = feed(reduce(start(SHOW).state, q({ studio: "חשמונאים", dateFrom: "2026-10-25", dateTo: "2026-10-28", timeFrom: "13:00" }), { now: NOW }));
  ok("days: 'בין יום א׳ 25.10 ליום ד׳ 28.10 אחרי 13:00 יש מקום…'", reply(r).body.includes("בין יום א׳ 25.10 ליום ד׳ 28.10 אחרי 13:00 יש מקום לשעה וחצי באולפן חשמונאים בימים האלה:"), reply(r).body);
  ok("…not the generic line", !reply(r).body.includes("אלה הימים הקרובים"), reply(r).body);
  const plain = feed(reduce(reduce(reduce(start(SHOW).state, { type: "go" }, { now: NOW }).state, { type: "duration", minutes: 90 }, { now: NOW }).state, { type: "studio-yes" }, { now: NOW }));
  ok("no written filter (buttons only): the generic line, layer on or not", reply(plain).body.includes(HE.DAY.body("גבעון", 90)), reply(plain).body);
}

console.log("\n=== 3. a summary edit keeps the chosen time when it fits ===");
{
  let t = edit(summary(), [{ field: "duration", minutes: 180 }]);
  check("length: re-checks THAT day's hours", [t.kind, t.state.step, t.state.date, t.state.keep?.start], ["need-availability", "hour", "2026-10-27", "16:00"]);
  t = feed(t);
  check("16:00 fits 3h: summary, 16:00–19:00, guest/note kept", [t.state.step, t.state.start, t.state.end, t.state.duration, t.state.guest, t.state.note], ["summary", "16:00", "19:00", 180, "דני", "שתי מצלמות"]);
  ok("…'עדכנתי ✔️', no re-choose", reply(t).body.startsWith(HE.NOTICE.changed) && !reply(t).body.includes(HE.NOTICE.changedRechoose), reply(t).body);
  check("…nothing left over in the state", [t.state.keep ?? null, t.state.fromSummary ?? false], [null, false]);

  t = feed(edit(summary(), [{ field: "studio", studio: "חשמונאים" }]));
  check("room: same day and time in the new room", [t.state.step, t.state.studio, t.state.date, t.state.start], ["summary", "חשמונאים", "2026-10-27", "16:00"]);
  t = feed(edit(summary(), [{ field: "day", date: "2026-10-29" }]));
  check("day: same time on the new day", [t.state.step, t.state.date, t.state.start, t.state.end], ["summary", "2026-10-29", "16:00", "17:30"]);
  t = feed(edit(summary(), [{ field: "guest", value: "רון" }, { field: "duration", minutes: 240 }]));
  check("two fields at once: guest + 4h, kept", [t.state.step, t.state.guest, t.state.start, t.state.end], ["summary", "רון", "16:00", "20:00"]);
  t = feed(edit(summary(), [{ field: "duration", minutes: 180 }], ['השעה "4"']));
  ok("a dropped fragment: 'updated what I understood' + the reason", reply(t).body.startsWith(HE.NOTICE.changedPartial) && reply(t).body.includes("לא בטוח שהבנתי"), reply(t).body);
}

console.log("\n=== 4. …and when it does NOT fit: a short reason, another time ===");
{
  // 19:30 + 3h ends 22:30 — past closing
  let t = feed(edit(summary({ start: "19:30", end: "21:00" }), [{ field: "duration", minutes: 180 }]));
  check("the hours of THAT day, at the new length", [t.state.step, t.state.date, t.state.hours[0]?.start, t.state.hours[t.state.hours.length - 1]?.start], ["hour", "2026-10-27", "09:00", "18:00"]);
  ok("…said: 'עדכנתי ✔️ אבל ביום ג׳ 27.10 ב-19:30 אין מקום ל3 שעות באולפן גבעון'", reply(t).body.includes(HE.NOTICE.keepNoHour("2026-10-27", "19:30", "גבעון", 180)), reply(t).body);
  check("…the slot cleared, guest/note kept, keep consumed", [t.state.start, t.state.guest, t.state.note, t.state.keep ?? null], [null, "דני", "שתי מצלמות", null]);
  const back = reduce(t.state, { type: "back" }, { now: NOW });
  check("back -> every free day (the stored list is full)", ids(back, "f:day:"), WEEK);
  const picked = reduce(t.state, { type: "hour", start: "12:00" }, { now: NOW });
  check("a new hour -> straight back to the summary", [picked.state.step, picked.state.start, picked.state.end], ["summary", "12:00", "15:00"]);

  // a guest and note BOTH skipped: still answered — back to the summary, not the guest question
  t = feed(edit(summary({ start: "19:30", end: "21:00", guest: null, note: null }), [{ field: "duration", minutes: 180 }]));
  const p2 = reduce(t.state, { type: "hour", start: "12:00" }, { now: NOW });
  check("guest and note skipped earlier: a new hour -> the summary (not the guest step)", [p2.state.step, p2.state.guest, p2.state.note, p2.state.fromSummary], ["summary", null, null, false]);

  // the whole day has no 3-hour room: other days
  t = feed(edit(summary(), [{ field: "duration", minutes: 180 }]), (d) => avail(d, { close: d === 180 ? { "2026-10-27": 11 * 60 } : {} }));
  check("that day has no 3h slot at all: the day list", [t.state.step, t.state.date], ["day", null]);
  ok("…said: 'עדכנתי ✔️ אבל ביום ג׳ 27.10 אין מקום ל3 שעות…בחרו יום אחר'", reply(t).body.includes(HE.NOTICE.keepNoDay("2026-10-27", "גבעון", 180)), reply(t).body);
  check("…every OTHER free day offered", ids(t, "f:day:"), WEEK.filter((d) => d !== "2026-10-27"));

  // the room has no 3-hour room anywhere: the room question, guest/note kept
  t = feed(edit(summary(), [{ field: "duration", minutes: 180 }]), (d) => avail(d, { rooms: d === 180 ? ["חשמונאים"] : ROOMS }));
  check("no 3h slot in that room at all: the room question", t.state.step, "studio");
  check("…guest and note survive", [t.state.guest, t.state.note], ["דני", "שתי מצלמות"]);

  // a NAMED time is a different request: re-offer from it, one day -> its hours
  t = feed(edit(summary(), [{ field: "day", date: "2026-10-29" }, { field: "time-from", hhmm: "18:00" }]));
  check("day + 'from 18:00': that day's hours from 18:00", [t.state.step, t.state.date, ids(t, "f:hr:")[0]], ["hour", "2026-10-29", "18:00"]);
}

console.log("\n=== 5. the layer OFF (or English): nothing of this ===");
{
  for (const v of [{ label: "switch off", freeTextOn: false, lang: "he" as const }, { label: "English", freeTextOn: true, lang: "en" as const }]) {
    // the same one-day filter, forced into the state: no skip, generic body
    const base = { ...initialState({ ...SHOW, freeTextOn: v.freeTextOn, lang: v.lang }), step: "day" as const, duration: 90 as const, studio: "גבעון" as BookableRoom, filter: { dateFrom: "2026-10-29", dateTo: "2026-10-29", timeFrom: null, timeTo: null } };
    const t = withAvailability(base, avail(90));
    check(`${v.label}: a one-day filter does NOT skip the day list`, [t.state.step, ids(t, "f:day:")], ["day", ["2026-10-29"]]);
    ok(`${v.label}: the generic day line`, reply(t).body.includes(COPY[v.lang].DAY.body("גבעון", 90)), reply(t).body);
  }
  // the whole button path, switch off: no new field ever appears in the state
  let t: Transition = start({ ...SHOW, freeTextOn: false });
  t = reduce(t.state, { type: "go" }, { now: NOW });
  t = reduce(t.state, { type: "duration", minutes: 90 }, { now: NOW });
  t = feed(reduce(t.state, { type: "studio-yes" }, { now: NOW }));
  ok("off: the generic day line", reply(t).body.includes(HE.DAY.body("גבעון", 90)), reply(t).body);
  t = feed(reduce(t.state, { type: "day", date: "2026-10-27" }, { now: NOW }));
  ok("off: the generic hour line", reply(t).body.includes(HE.HOUR.body("2026-10-27")), reply(t).body);
  t = reduce(t.state, { type: "hour", start: "16:00" }, { now: NOW });
  t = reduce(t.state, { type: "no-guest" }, { now: NOW });
  t = reduce(t.state, { type: "no-note" }, { now: NOW });
  check("off: at the summary", t.state.step, "summary");
  check("off: no 'keep' / 'fromSummary' key anywhere in the state", ["keep", "fromSummary"].filter((k) => k in t.state), []);
  const typed = reduce(t.state, { type: "edit", edits: [{ field: "duration", minutes: 180, alsoConfirm: false }], dropped: [] }, { now: NOW });
  ok("off: an edit event at the summary is refused ('choose from the options')", typed.kind === "reply" && typed.reply.body.startsWith(HE.NOTICE.pickFromList), typed);
  // taken at submission, then a new hour: the guest step, exactly as before E14
  check("off: the buttons still drive it (confirm submits)", reduce(t.state, { type: "confirm" }, { now: NOW }).kind, "submit");
  check("FLOW_ID unchanged", FLOW_ID.confirm.length > 0, true);
}

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
