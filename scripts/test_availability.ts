/**
 * Pure availability suite — stage 2 of client-booked recordings.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_availability.ts
 *
 * SYNTHETIC FIXTURES ONLY. The live feed carries client names and never enters
 * the repository; the one report run against it is a separate script that
 * takes its path as an argument.
 *
 * Every assertion COUNTS (rule 56, 2026-09-22). "There is a slot at 09:00" is
 * not an assertion — "this room has exactly 18 slots and the first is 09:00"
 * is. A suite that only locates text stays green while the thing it is
 * watching happens twice, which is how a whole paragraph rendered twice
 * through two green suites in F14.
 */
import { parseIcsText } from "../src/lib/calendar/parse";
import { roomsInTitle } from "../src/lib/calendar/rooms";
import { findLiveSeriesInWindow } from "../src/lib/calendar/series";
import { STUDIOS } from "../src/lib/calendar/studios";
import {
  computeAvailability,
  israelInstant,
  israelWeekday,
  type AvailabilityWindow,
} from "../src/lib/calendar/availability";

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";

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
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.log(`  ❌ ${name} — expected a throw, got a value`);
  } catch {
    passed++;
    console.log(`  ✅ ${name}`);
  }
}

// ── fixture builders ───────────────────────────────────────────────────────
let uidSeq = 0;
function vevent(lines: string[]): string {
  return `BEGIN:VEVENT\r\nUID:fixture-${++uidSeq}\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
}
function cal(...events: string[]): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//fixture//EN\r\n${events.join("\r\n")}\r\nEND:VCALENDAR\r\n`;
}
/** A timed event given in Israel wall-clock, emitted as UTC like the real feed. */
function timed(date: string, from: [number, number], to: [number, number], summary: string, extra: string[] = []) {
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return vevent([
    `SUMMARY:${summary}`,
    `DTSTART:${z(israelInstant(date, from[0], from[1]))}`,
    `DTEND:${z(israelInstant(date, to[0], to[1]))}`,
    ...extra,
  ]);
}
function allDay(startDate: string, endDateExclusive: string, summary: string, extra: string[] = []) {
  const c = (s: string) => s.replace(/-/g, "");
  return vevent([
    `SUMMARY:${summary}`,
    `DTSTART;VALUE=DATE:${c(startDate)}`,
    `DTEND;VALUE=DATE:${c(endDateExclusive)}`,
    ...extra,
  ]);
}

const BASE_WIN = (from: string, to: string, step = 30): AvailabilityWindow => ({
  fromIsrael: from,
  toIsrael: to,
  openDays: [0, 1, 2, 3, 4], // Sun-Thu
  openHour: 9,
  closeHour: 19,
  slotMinutes: 90,
  slotStepMinutes: step,
});

function run(ics: string, win: AvailabilityWindow) {
  const events = parseIcsText(ics);
  const from = israelInstant(win.fromIsrael, 0, 0);
  const to = new Date(israelInstant(win.toIsrael, 0, 0).getTime() + 86_400_000);
  const series = findLiveSeriesInWindow(ics, from, to, STUDIOS);
  return computeAvailability(events, series, STUDIOS, win);
}
const inRoom = (r: { free: { room: string }[] }, room: string) => r.free.filter((s) => s.room === room).length;
const slotsOf = (r: { free: { room: string; startIsrael: string }[] }, room: string) =>
  r.free.filter((s) => s.room === room).map((s) => s.startIsrael);

// dates, verified rather than assumed
const SUNDAY = "2026-09-27";
const FRIDAY = "2026-09-25";
const SATURDAY = "2026-09-26";
const THU_BEFORE_DST = "2026-10-22";
const SUN_AFTER_DST = "2026-10-25";

console.log("\n=== 0. calendar assumptions the rest of the suite rests on ===");
check("2026-09-27 is Sunday (0)", israelWeekday(SUNDAY), 0);
check("2026-09-25 is Friday (5)", israelWeekday(FRIDAY), 5);
check("2026-09-26 is Saturday (6)", israelWeekday(SATURDAY), 6);
check("2026-10-22 is Thursday (4)", israelWeekday(THU_BEFORE_DST), 4);
check("2026-10-25 is Sunday (0)", israelWeekday(SUN_AFTER_DST), 0);
check("three bookable rooms", STUDIOS.filter((s) => s.bookable).map((s) => s.canonical), [GIVON_BIG, GIVON, HASH]);
check("TLV is not bookable", STUDIOS.filter((s) => !s.bookable).map((s) => s.canonical), ["TLV"]);

console.log("\n=== rooms: every room in a title, not the longest one ===");
check("two rooms both returned", roomsInTitle(`הקלטה ב${GIVON} וב${HASH}`, STUDIOS), [HASH, GIVON]);
check("גבעון גדול is not also גבעון", roomsInTitle(GIVON_BIG, STUDIOS), [GIVON_BIG]);
check("גבעון בחוץ resolves to גבעון גדול only", roomsInTitle("גבעון בחוץ", STUDIOS), [GIVON_BIG]);
check("bare גבעון is only גבעון", roomsInTitle(`פודקאסט ${GIVON}`, STUDIOS), [GIVON]);
check("no room named", roomsInTitle("פלואו משרד הפנים", STUDIOS), []);
check("TLV is recognised as a room", roomsInTitle("הקלטה TLV", STUDIOS), ["TLV"]);

console.log("\n=== 1. an empty Sunday, both steps ===");
{
  const r30 = run(cal(), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("step=30 · גבעון slot count", inRoom(r30, GIVON), 18);
  check("step=30 · גבעון גדול slot count", inRoom(r30, GIVON_BIG), 18);
  check("step=30 · חשמונאים slot count", inRoom(r30, HASH), 18);
  check("step=30 · total across 3 rooms", r30.free.length, 54);
  const g = slotsOf(r30, GIVON);
  check("step=30 · first slot", g[0], "09:00");
  check("step=30 · last slot", g[g.length - 1], "17:30");
  check("step=30 · last slot ends 19:00", r30.free.filter((s) => s.room === GIVON).slice(-1)[0].endIsrael, "19:00");
  check("step=30 · no slot repeats", new Set(g).size, g.length);

  const r90 = run(cal(), BASE_WIN(SUNDAY, SUNDAY, 90));
  check("step=90 · גבעון slot count", inRoom(r90, GIVON), 6);
  check("step=90 · total across 3 rooms", r90.free.length, 18);
  const g90 = slotsOf(r90, GIVON);
  check("step=90 · first slot", g90[0], "09:00");
  check("step=90 · last slot", g90[g90.length - 1], "16:30");
  check("step=90 · exact grid", g90, ["09:00", "10:30", "12:00", "13:30", "15:00", "16:30"]);
  check("step defaults to 30 when omitted", run(cal(), { ...BASE_WIN(SUNDAY, SUNDAY), slotStepMinutes: undefined }).free.length, 54);
}

console.log("\n=== 2. Friday and Saturday are closed ===");
check("Friday alone", run(cal(), BASE_WIN(FRIDAY, FRIDAY, 30)).free.length, 0);
check("Saturday alone", run(cal(), BASE_WIN(SATURDAY, SATURDAY, 30)).free.length, 0);
check("Fri+Sat together", run(cal(), BASE_WIN(FRIDAY, SATURDAY, 30)).free.length, 0);
check("Fri..Sun = only Sunday's 54", run(cal(), BASE_WIN(FRIDAY, SUNDAY, 30)).free.length, 54);

console.log("\n=== 3. DST — 09:00 Israel on both sides, one hour apart in UTC ===");
{
  const before = run(cal(), BASE_WIN(THU_BEFORE_DST, THU_BEFORE_DST, 30));
  const after = run(cal(), BASE_WIN(SUN_AFTER_DST, SUN_AFTER_DST, 30));
  check("22.10 (Thu, +03) slot count", inRoom(before, GIVON), 18);
  check("25.10 (Sun, +02) slot count", inRoom(after, GIVON), 18);
  const b0 = before.free.filter((s) => s.room === GIVON)[0];
  const a0 = after.free.filter((s) => s.room === GIVON)[0];
  check("22.10 first slot is 09:00 Israel", b0.startIsrael, "09:00");
  check("25.10 first slot is 09:00 Israel", a0.startIsrael, "09:00");
  check("22.10 09:00 Israel == 06:00Z", b0.start.toISOString(), "2026-10-22T06:00:00.000Z");
  check("25.10 09:00 Israel == 07:00Z", a0.start.toISOString(), "2026-10-25T07:00:00.000Z");
  check("the two differ by exactly one hour of UTC clock time", a0.start.toISOString().slice(11, 16), "07:00");
  const bLast = before.free.filter((s) => s.room === GIVON).slice(-1)[0];
  const aLast = after.free.filter((s) => s.room === GIVON).slice(-1)[0];
  check("22.10 closes at 19:00 Israel == 16:00Z", bLast.end.toISOString(), "2026-10-22T16:00:00.000Z");
  check("25.10 closes at 19:00 Israel == 17:00Z", aLast.end.toISOString(), "2026-10-25T17:00:00.000Z");
  // the trap this replaces: one offset read once and pasted onto every date
  const span = run(cal(), BASE_WIN(THU_BEFORE_DST, SUN_AFTER_DST, 30));
  check("Thu+Sun over the transition, Fri/Sat closed", span.free.length, 108);
  check("every slot in the span starts at :00 or :30", Array.from(new Set(span.free.map((s) => s.startIsrael.slice(-2)))).sort(), ["00", "30"]);
}

console.log("\n=== 4. a timed event blocks its own room only ===");
{
  const r = run(cal(timed(SUNDAY, [10, 0], [11, 0], `פודקאסט ${HASH}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("חשמונאים loses exactly 4 slots", inRoom(r, HASH), 14);
  check("the 4 lost are 09:00/09:30/10:00/10:30", slotsOf(r, HASH), ["11:00", "11:30", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30"]);
  check("גבעון untouched", inRoom(r, GIVON), 18);
  check("גבעון גדול untouched", inRoom(r, GIVON_BIG), 18);
  check("nothing warned", r.unknownRoomBlocks.length, 0);
  check("nothing skipped", r.skipped.length, 0);
  check("nothing refused", r.roomsRefused.length, 0);
}

console.log("\n=== 5. half-open intervals — an event ending 10:30 frees 10:30 ===");
{
  const r = run(cal(timed(SUNDAY, [9, 0], [10, 30], `פודקאסט ${HASH}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("חשמונאים loses exactly 3", inRoom(r, HASH), 15);
  check("10:30 is offered", slotsOf(r, HASH)[0], "10:30");
  // and the mirror: a slot ending at 10:30 is not blocked by an event starting 10:30
  const r2 = run(cal(timed(SUNDAY, [10, 30], [12, 0], `פודקאסט ${HASH}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("a 09:00-10:30 slot survives an event starting 10:30", slotsOf(r2, HASH).includes("09:00"), true);
  // 09:30..11:30 all overlap [10:30,12:00); 09:00 ends exactly at 10:30 and
  // 12:00 starts exactly at 12:00, so both survive the half-open comparison
  check("חשמונאים loses exactly 5 to a 10:30-12:00 event", inRoom(r2, HASH), 13);
  check("the survivors are 09:00 then 12:00 onward", slotsOf(r2, HASH).slice(0, 2), ["09:00", "12:00"]);
}

console.log("\n=== 6. an all-day event blocks its room for the whole day ===");
{
  const r = run(cal(allDay(SUNDAY, "2026-09-28", `סגור ליום צילום ${GIVON}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("גבעון has no slots", inRoom(r, GIVON), 0);
  check("חשמונאים is full", inRoom(r, HASH), 18);
  check("גבעון גדול is full", inRoom(r, GIVON_BIG), 18);
  check("no warning — the room was named", r.unknownRoomBlocks.length, 0);
  // the day AFTER an exclusive DTEND is not blocked
  const r2 = run(cal(allDay(SUNDAY, "2026-09-28", `סגור ליום צילום ${GIVON}`)), BASE_WIN(SUNDAY, "2026-09-28", 30));
  check("Monday 28.9 unaffected by Sunday's all-day", r2.free.filter((s) => s.dateIsrael === "2026-09-28" && s.room === GIVON).length, 18);
}

console.log("\n=== 7. an all-day event naming two rooms blocks both ===");
{
  const r = run(cal(allDay(SUNDAY, "2026-09-28", `סגור ${GIVON} ו${HASH}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("גבעון 0", inRoom(r, GIVON), 0);
  check("חשמונאים 0", inRoom(r, HASH), 0);
  check("גבעון גדול still full", inRoom(r, GIVON_BIG), 18);
  check("total = one room's worth", r.free.length, 18);
}

console.log("\n=== 8. an all-day event naming no room warns once, blocks nothing ===");
{
  const r = run(cal(allDay(SUNDAY, "2026-09-28", "סגור ליום צילום לא לקבוע כלום")), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("all three rooms full", r.free.length, 54);
  check("warned exactly once", r.unknownRoomBlocks.length, 1);
  check("warning is flagged all-day", r.unknownRoomBlocks[0].allDay, true);
  check("warning is not a series", r.unknownRoomBlocks[0].isSeries, false);
  check("warning carries the Israeli date", r.unknownRoomBlocks[0].startIsrael, SUNDAY);
  // across a 3-day window the SAME event must still be reported once, not per day
  const r3 = run(cal(allDay(SUNDAY, "2026-09-30", "סגור ליום צילום לא לקבוע כלום")), BASE_WIN(SUNDAY, "2026-09-29", 30));
  check("multi-day all-day still warns exactly once", r3.unknownRoomBlocks.length, 1);
}

console.log("\n=== 9. גבעון and גבעון גדול are separate rooms ===");
{
  const r = run(cal(timed(SUNDAY, [10, 0], [11, 0], `פודקאסט ${GIVON}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("גבעון loses 4", inRoom(r, GIVON), 14);
  check("גבעון גדול untouched", inRoom(r, GIVON_BIG), 18);

  const r2 = run(cal(timed(SUNDAY, [10, 0], [11, 0], "הקלטה גבעון בחוץ")), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("גבעון בחוץ blocks גבעון גדול", inRoom(r2, GIVON_BIG), 14);
  check("גבעון בחוץ leaves גבעון alone", inRoom(r2, GIVON), 18);

  const r3 = run(cal(timed(SUNDAY, [10, 0], [11, 0], `הקלטה ${GIVON_BIG}`)), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("גבעון גדול blocks itself only", inRoom(r3, GIVON_BIG), 14);
  check("גבעון גדול does not block גבעון", inRoom(r3, GIVON), 18);
}

console.log("\n=== 10. TRANSP is ignored — a TRANSPARENT event still occupies ===");
{
  const r = run(cal(timed(SUNDAY, [10, 0], [11, 0], `פודקאסט ${HASH}`, ["TRANSP:TRANSPARENT"])), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("TRANSPARENT blocks exactly as OPAQUE does", inRoom(r, HASH), 14);
  const r2 = run(cal(allDay(SUNDAY, "2026-09-28", `סגור ליום צילום ${GIVON}`, ["TRANSP:TRANSPARENT"])), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("TRANSPARENT all-day still closes the day", inRoom(r2, GIVON), 0);
}

console.log("\n=== 11. recurring series — the gate, not an expansion ===");
{
  // live weekly series in חשמונאים, unbounded
  const live = cal(vevent([
    `SUMMARY:סדרה שבועית ${HASH}`,
    `DTSTART:${israelInstant(SUNDAY, 10, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTEND:${israelInstant(SUNDAY, 11, 30).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    "RRULE:FREQ=WEEKLY",
  ]));
  const r = run(live, BASE_WIN(SUNDAY, "2026-10-25", 30));
  check("חשמונאים is refused", r.roomsRefused.map((x) => x.room), [HASH]);
  check("refusal names the series", r.roomsRefused[0].seriesTitle, `סדרה שבועית ${HASH}`);
  check("חשמונאים gets zero slots across the whole window", inRoom(r, HASH), 0);
  check("גבעון unaffected by the refusal", inRoom(r, GIVON) > 0, true);

  // UNTIL before the window -> dead, no refusal
  const dead = cal(vevent([
    `SUMMARY:סדרה מתה ${HASH}`,
    "DTSTART:20260105T080000Z",
    "DTEND:20260105T093000Z",
    "RRULE:FREQ=WEEKLY;UNTIL=20260301T205959Z",
  ]));
  const rd = run(dead, BASE_WIN(SUNDAY, "2026-10-25", 30));
  check("a series that ended before the window refuses nothing", rd.roomsRefused.length, 0);
  check("and its room is fully offered", inRoom(rd, HASH) > 0, true);

  // every occurrence in the window excluded by EXDATE -> no refusal
  const d1 = israelInstant(SUNDAY, 10, 0);
  const d2 = new Date(d1.getTime() + 7 * 86_400_000);
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const excluded = cal(vevent([
    `SUMMARY:סדרה מוחרגת ${HASH}`,
    `DTSTART:${z(d1)}`,
    `DTEND:${z(new Date(d1.getTime() + 90 * 60000))}`,
    "RRULE:FREQ=WEEKLY;COUNT=2",
    `EXDATE:${z(d1)}`,
    `EXDATE:${z(d2)}`,
  ]));
  const rx = run(excluded, BASE_WIN(SUNDAY, "2026-10-25", 30));
  check("a series whose occurrences are all EXDATE'd refuses nothing", rx.roomsRefused.length, 0);

  // COUNT that runs out before the window
  const counted = cal(vevent([
    `SUMMARY:סדרה סגורה ${GIVON}`,
    "DTSTART:20260105T080000Z",
    "DTEND:20260105T093000Z",
    "RRULE:FREQ=WEEKLY;COUNT=3",
  ]));
  check("a COUNT-bounded series that finished refuses nothing", run(counted, BASE_WIN(SUNDAY, "2026-10-25", 30)).roomsRefused.length, 0);

  // a live series naming no room -> warning, and flagged as a series
  const roomless = cal(vevent([
    `SUMMARY:פלואו משרד הפנים`,
    `DTSTART:${z(d1)}`,
    `DTEND:${z(new Date(d1.getTime() + 90 * 60000))}`,
    "RRULE:FREQ=WEEKLY",
  ]));
  const rr = run(roomless, BASE_WIN(SUNDAY, "2026-10-25", 30));
  check("roomless live series refuses no room", rr.roomsRefused.length, 0);
  check("roomless live series warns exactly once", rr.unknownRoomBlocks.length, 1);
  check("and is marked isSeries", rr.unknownRoomBlocks[0].isSeries, true);

  // RECURRENCE-ID: the only in-window occurrence is cancelled by an override
  const d3 = new Date(d1.getTime() + 7 * 86_400_000);
  const overridden = cal(
    vevent([
      `SUMMARY:סדרה עם דריסה ${GIVON_BIG}`,
      `DTSTART:${z(d1)}`,
      `DTEND:${z(new Date(d1.getTime() + 90 * 60000))}`,
      "RRULE:FREQ=WEEKLY;COUNT=2",
      `EXDATE:${z(d1)}`,
    ]),
    // same UID as the master above is required for a real override; the
    // fixture builder numbers UIDs, so this is asserted on the parsed result
    // rather than constructed by hand here.
    ""
  );
  check("EXDATE+COUNT leaves one live occurrence, so the room is refused", run(overridden, BASE_WIN(SUNDAY, "2026-10-25", 30)).roomsRefused.map((x) => x.room), [GIVON_BIG]);
}

console.log("\n=== 11b. RECURRENCE-ID overrides, built with a shared UID ===");
{
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const occ1 = israelInstant(SUNDAY, 10, 0);
  const occ2 = new Date(occ1.getTime() + 7 * 86_400_000);
  const body = (uid: string, lines: string[]) => `BEGIN:VEVENT\r\nUID:${uid}\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;

  // master has exactly 2 occurrences, both in-window; both overridden away
  const bothCancelled = cal(
    body("shared-1", [`SUMMARY:סדרה ${HASH}`, `DTSTART:${z(occ1)}`, `DTEND:${z(new Date(occ1.getTime() + 5400000))}`, "RRULE:FREQ=WEEKLY;COUNT=2"]),
    body("shared-1", [`SUMMARY:סדרה ${HASH}`, `RECURRENCE-ID:${z(occ1)}`, `DTSTART:${z(occ1)}`, `DTEND:${z(new Date(occ1.getTime() + 5400000))}`, "STATUS:CANCELLED"]),
    body("shared-1", [`SUMMARY:סדרה ${HASH}`, `RECURRENCE-ID:${z(occ2)}`, `DTSTART:${z(occ2)}`, `DTEND:${z(new Date(occ2.getTime() + 5400000))}`, "STATUS:CANCELLED"])
  );
  const rc = run(bothCancelled, BASE_WIN(SUNDAY, "2026-10-25", 30));
  check("every occurrence cancelled by RECURRENCE-ID -> no refusal", rc.roomsRefused.length, 0);
  check("and the room is offered again", inRoom(rc, HASH) > 0, true);

  // one occurrence survives -> refusal stands
  const oneSurvives = cal(
    body("shared-2", [`SUMMARY:סדרה ${HASH}`, `DTSTART:${z(occ1)}`, `DTEND:${z(new Date(occ1.getTime() + 5400000))}`, "RRULE:FREQ=WEEKLY;COUNT=2"]),
    body("shared-2", [`SUMMARY:סדרה ${HASH}`, `RECURRENCE-ID:${z(occ1)}`, `DTSTART:${z(occ1)}`, `DTEND:${z(new Date(occ1.getTime() + 5400000))}`, "STATUS:CANCELLED"])
  );
  check("one surviving occurrence still refuses the room", run(oneSurvives, BASE_WIN(SUNDAY, "2026-10-25", 30)).roomsRefused.map((x) => x.room), [HASH]);
}

console.log("\n=== 12. an event with no end is skipped, never blocking ===");
{
  const noEnd = cal(vevent([`SUMMARY:פודקאסט ${HASH}`, `DTSTART:${israelInstant(SUNDAY, 10, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`]));
  const r = run(noEnd, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("skipped exactly one", r.skipped.length, 1);
  check("reason is no-end", r.skipped[0].reason, "no-end");
  check("חשמונאים is fully offered", inRoom(r, HASH), 18);
  check("all three rooms full", r.free.length, 54);

  const zeroLen = cal(timed(SUNDAY, [10, 0], [10, 0], `פודקאסט ${HASH}`));
  const r2 = run(zeroLen, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("zero-length skipped", r2.skipped.length, 1);
  check("zero-length reason", r2.skipped[0].reason, "zero-length");
  check("zero-length blocks nothing", r2.free.length, 54);

  // the three reported lists must all mean the same window: a broken event
  // from another year is not a warning about the next eight weeks
  const stale = cal(vevent([`SUMMARY:פודקאסט ${HASH}`, "DTSTART:20190217T083000Z"]));
  const r3 = run(stale, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("an end-less event OUTSIDE the window is not reported", r3.skipped.length, 0);
  check("and it still blocks nothing", r3.free.length, 54);
  const mixed = cal(
    vevent([`SUMMARY:פודקאסט ${HASH}`, "DTSTART:20190217T083000Z"]),
    vevent([`SUMMARY:פודקאסט ${GIVON}`, `DTSTART:${israelInstant(SUNDAY, 10, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`])
  );
  const r4 = run(mixed, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("in-window end-less event reported, stale one not — exactly one", r4.skipped.length, 1);
  check("and it is the in-window one", r4.skipped[0].title, `פודקאסט ${GIVON}`);
  // an all-day event with no DTEND at all still lands on its own day
  const allDayNoEnd = cal(vevent([`SUMMARY:סגור ${GIVON}`, `DTSTART;VALUE=DATE:${SUNDAY.replace(/-/g, "")}`]));
  const r5 = run(allDayNoEnd, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("all-day with no DTEND blocks its single day", inRoom(r5, GIVON), 0);
  check("all-day with no DTEND is not skipped", r5.skipped.length, 0);
  check("and leaves the other rooms alone", inRoom(r5, HASH), 18);
}

console.log("\n=== 13. TLV is a known room, and not a bookable one ===");
{
  const r = run(cal(timed(SUNDAY, [10, 0], [11, 0], "הקלטה TLV")), BASE_WIN(SUNDAY, SUNDAY, 30));
  check("no slots are offered for TLV", r.free.filter((s) => s.room === "TLV").length, 0);
  check("all three bookable rooms untouched", r.free.length, 54);
  check("TLV is NOT reported as an unknown room", r.unknownRoomBlocks.length, 0);
}

console.log("\n=== 14. LOCATION is never a room signal ===");
{
  const withAddress = cal(vevent([
    "SUMMARY:עומר חן פודקאסט",
    `DTSTART:${israelInstant(SUNDAY, 10, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTEND:${israelInstant(SUNDAY, 11, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    "LOCATION:החשמונאים 105, תל אביב-יפו, ישראל",
  ]));
  const r = run(withAddress, BASE_WIN(SUNDAY, SUNDAY, 30));
  check("the street address does not block חשמונאים", inRoom(r, HASH), 18);
  check("all three rooms full", r.free.length, 54);
  check("it surfaces as an unknown-room warning instead", r.unknownRoomBlocks.length, 1);
  check("the warning is the right event", r.unknownRoomBlocks[0].title, "עומר חן פודקאסט");
  // the double trap: one address naming two rooms
  const twoRoomAddress = cal(vevent([
    "SUMMARY:פגישה",
    `DTSTART:${israelInstant(SUNDAY, 10, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    `DTEND:${israelInstant(SUNDAY, 11, 0).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`,
    "LOCATION:החשמונאים 105 מול קניון TLV",
  ]));
  check("an address naming two rooms blocks neither", run(twoRoomAddress, BASE_WIN(SUNDAY, SUNDAY, 30)).free.length, 54);
}

console.log("\n=== 15. bad input throws rather than guessing ===");
throws("a malformed date", () => israelInstant("26-10-25", 9, 0));
throws("a date that does not exist", () => israelInstant("2026-02-30", 9, 0));
throws("a non-integer step", () => run(cal(), { ...BASE_WIN(SUNDAY, SUNDAY), slotStepMinutes: 0 }));
throws("closeHour <= openHour", () => run(cal(), { ...BASE_WIN(SUNDAY, SUNDAY), openHour: 19, closeHour: 9 }));

console.log("\n=== 16. the all-day host-timezone trap is actually closed ===");
{
  // parse.ts must carry the literal date, not an instant resolved in the
  // machine's zone. On an Israel-time machine the instant for 26.10 is
  // 25.10T22:00Z, whose UTC date is the 25th — the wrong day.
  const ev = parseIcsText(cal(allDay("2026-10-26", "2026-10-27", "בדיקה")))[0];
  check("allDay flag set", ev.allDay, true);
  check("literal start date preserved", ev.startDateOnly, "2026-10-26");
  check("literal end date preserved (exclusive)", ev.endDateOnly, "2026-10-27");
  check("timed events carry no date-only fields", parseIcsText(cal(timed(SUNDAY, [10, 0], [11, 0], "x")))[0].startDateOnly, undefined);
  check("timed events are not allDay", parseIcsText(cal(timed(SUNDAY, [10, 0], [11, 0], "x")))[0].allDay, false);
  // and the block lands on the 26th, whatever this machine's zone is
  const r = run(cal(allDay("2026-10-26", "2026-10-27", `סגור ${GIVON}`)), BASE_WIN("2026-10-25", "2026-10-27", 30));
  check("25.10 open", r.free.filter((s) => s.dateIsrael === "2026-10-25" && s.room === GIVON).length, 18);
  check("26.10 closed for גבעון", r.free.filter((s) => s.dateIsrael === "2026-10-26" && s.room === GIVON).length, 0);
  check("27.10 open again", r.free.filter((s) => s.dateIsrael === "2026-10-27" && s.room === GIVON).length, 18);
  check("26.10 still open for חשמונאים", r.free.filter((s) => s.dateIsrael === "2026-10-26" && s.room === HASH).length, 18);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
