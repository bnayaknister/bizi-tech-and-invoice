/**
 * The client screen's arithmetic: clickable days, hours per room, month paging.
 * Pure — no server, no feed, no database, no users. F19 is open; nothing here
 * goes near it.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_booking_calendar.ts
 */
import {
  clickableDays,
  hoursFor,
  monthsInWindow,
  monthGrid,
  monthOf,
  sameMonth,
  monthLabel,
  dayPhrase,
  dowHebrew,
  dayMonth,
  weekdayOf,
  type FreeSlot,
} from "../src/app/calendar/availability/booking";
import { bookableRoomForDefault } from "../src/lib/calendar/rooms";
import { STUDIOS } from "../src/lib/calendar/studios";

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

const GIVON = "גבעון";
const GIVON_BIG = "גבעון גדול";
const HASH = "חשמונאים";

const FROM = "2026-09-23";
const TO = "2026-11-17";

const slot = (room: string, dateIsrael: string, startIsrael: string, endIsrael: string): FreeSlot => ({
  room, dateIsrael, startIsrael, endIsrael,
});

// weekdays, verified rather than assumed
const SUN = "2026-09-27";
const MON = "2026-09-28";
const THU = "2026-10-01";
const FRI = "2026-09-25";
const SAT = "2026-09-26";

console.log("\n=== 0. the dates this suite rests on ===");
check("27.9 is Sunday", weekdayOf(SUN), 0);
check("28.9 is Monday", weekdayOf(MON), 1);
check("1.10 is Thursday", weekdayOf(THU), 4);
check("25.9 is Friday", weekdayOf(FRI), 5);
check("26.9 is Saturday", weekdayOf(SAT), 6);

console.log("\n=== 1. clickable days ===");
{
  const free = [
    slot(GIVON, SUN, "09:00", "10:30"),
    slot(GIVON, MON, "11:00", "12:30"),
    slot(HASH, THU, "09:00", "10:30"),
  ];
  check("גבעון has its two days", clickableDays(free, GIVON, FROM, TO), [SUN, MON]);
  check("חשמונאים has only its own", clickableDays(free, HASH, FROM, TO), [THU]);
  check("גבעון גדול has none", clickableDays(free, GIVON_BIG, FROM, TO), []);
  check("a null room yields none", clickableDays(free, null, FROM, TO), []);
  check("days come back sorted and unique",
    clickableDays([slot(GIVON, MON, "09:00", "10:30"), slot(GIVON, SUN, "09:00", "10:30"), slot(GIVON, SUN, "10:30", "12:00")], GIVON, FROM, TO),
    [SUN, MON]);
}

console.log("\n=== 1a. Friday and Saturday are never clickable, even if a slot claims otherwise ===");
{
  // a hand-built payload the route would never produce — the guard must hold
  const free = [slot(GIVON, FRI, "09:00", "10:30"), slot(GIVON, SAT, "09:00", "10:30"), slot(GIVON, SUN, "09:00", "10:30")];
  check("only Sunday survives", clickableDays(free, GIVON, FROM, TO), [SUN]);
  check("Friday alone yields nothing", clickableDays([slot(GIVON, FRI, "09:00", "10:30")], GIVON, FROM, TO), []);
  check("Saturday alone yields nothing", clickableDays([slot(GIVON, SAT, "09:00", "10:30")], GIVON, FROM, TO), []);
}

console.log("\n=== 1b. a day outside the window is never clickable ===");
{
  const before = "2026-09-22"; // the day the window opens after — Tuesday
  const after = "2026-11-18"; // one day past `to` — Wednesday
  check("before the window is rejected", weekdayOf(before) <= 4 && clickableDays([slot(GIVON, before, "09:00", "10:30")], GIVON, FROM, TO).length, 0);
  check("after the window is rejected", weekdayOf(after) <= 4 && clickableDays([slot(GIVON, after, "09:00", "10:30")], GIVON, FROM, TO).length, 0);
  check("the window's own first day IS accepted", clickableDays([slot(GIVON, FROM, "09:00", "10:30")], GIVON, FROM, TO), [FROM]);
  check("the window's own last day IS accepted", clickableDays([slot(GIVON, TO, "09:00", "10:30")], GIVON, FROM, TO), [TO]);
}

console.log("\n=== 1c. a day free in ANOTHER room is not clickable in this one ===");
{
  const free = [slot(HASH, SUN, "09:00", "10:30"), slot(GIVON_BIG, SUN, "09:00", "10:30")];
  check("גבעון sees nothing on a day its neighbours are free", clickableDays(free, GIVON, FROM, TO), []);
  check("חשמונאים sees it", clickableDays(free, HASH, FROM, TO), [SUN]);
  check("גבעון גדול sees it", clickableDays(free, GIVON_BIG, FROM, TO), [SUN]);
}

console.log("\n=== 1d. a refused room has zero clickable days ===");
{
  // a refused room carries no slots at all in the payload, so this needs no
  // special case — the absence of slots IS the dimming
  const free = [slot(GIVON, SUN, "09:00", "10:30"), slot(GIVON, MON, "09:00", "10:30")];
  check("the refused room (no slots) has no days", clickableDays(free, HASH, FROM, TO), []);
  check("the other room is unaffected", clickableDays(free, GIVON, FROM, TO).length, 2);
}

console.log("\n=== 2. hours for a room and a day ===");
{
  const free = [
    slot(GIVON, SUN, "11:00", "12:30"),
    slot(GIVON, SUN, "09:00", "10:30"),
    slot(GIVON, MON, "14:00", "15:30"),
    slot(HASH, SUN, "17:30", "19:00"),
  ];
  check("ascending by start", hoursFor(free, GIVON, SUN).map((h) => h.startIsrael), ["09:00", "11:00"]);
  check("other day excluded", hoursFor(free, GIVON, MON).map((h) => h.startIsrael), ["14:00"]);
  check("other room excluded", hoursFor(free, HASH, SUN).map((h) => h.startIsrael), ["17:30"]);
  check("unknown day", hoursFor(free, GIVON, THU), []);
  check("null room", hoursFor(free, null, SUN), []);
  check("null date", hoursFor(free, GIVON, null), []);
  check("hoursFor does not mutate its input", free.map((f) => f.startIsrael), ["11:00", "09:00", "14:00", "17:30"]);
}

console.log("\n=== 2a. switching room on the SAME day gives different hours ===");
{
  const free = [
    slot(GIVON, SUN, "09:00", "10:30"),
    slot(GIVON, SUN, "09:30", "11:00"),
    slot(HASH, SUN, "15:00", "16:30"),
    slot(HASH, SUN, "17:30", "19:00"),
    slot(GIVON_BIG, SUN, "12:00", "13:30"),
  ];
  check("גבעון", hoursFor(free, GIVON, SUN).map((h) => h.startIsrael), ["09:00", "09:30"]);
  check("חשמונאים", hoursFor(free, HASH, SUN).map((h) => h.startIsrael), ["15:00", "17:30"]);
  check("גבעון גדול", hoursFor(free, GIVON_BIG, SUN).map((h) => h.startIsrael), ["12:00"]);
  check("the three lists are disjoint",
    new Set([...hoursFor(free, GIVON, SUN), ...hoursFor(free, HASH, SUN), ...hoursFor(free, GIVON_BIG, SUN)].map((h) => h.startIsrael)).size,
    5);
}

console.log("\n=== 3. the end time comes from the slot, never recomputed ===");
{
  const free = [slot(GIVON, SUN, "11:00", "12:30"), slot(GIVON, SUN, "17:30", "19:00")];
  check("11:00 -> 12:30", hoursFor(free, GIVON, SUN)[0].endIsrael, "12:30");
  check("17:30 -> 19:00", hoursFor(free, GIVON, SUN)[1].endIsrael, "19:00");
  // if the route ever changes the slot length, this carries it through untouched
  const odd = [slot(GIVON, SUN, "09:00", "09:45")];
  check("a 45-minute slot is passed through, not corrected to 90",
    hoursFor(odd, GIVON, SUN)[0].endIsrael, "09:45");
}

console.log("\n=== 4. months, and the arrows' range ===");
{
  check("23.9 -> 17.11 spans three months", monthsInWindow(FROM, TO),
    [{ year: 2026, month: 9 }, { year: 2026, month: 10 }, { year: 2026, month: 11 }]);
  check("a window inside one month is one month", monthsInWindow("2026-10-05", "2026-10-20"), [{ year: 2026, month: 10 }]);
  check("a window across a year end", monthsInWindow("2026-12-20", "2027-02-10"),
    [{ year: 2026, month: 12 }, { year: 2027, month: 1 }, { year: 2027, month: 2 }]);
  check("monthOf reads the string", monthOf("2026-11-17"), { year: 2026, month: 11 });
  check("sameMonth", [sameMonth({ year: 2026, month: 9 }, { year: 2026, month: 9 }), sameMonth({ year: 2026, month: 9 }, { year: 2027, month: 9 })], [true, false]);
  check("the first month is the window's own", sameMonth(monthsInWindow(FROM, TO)[0], monthOf(FROM)), true);
  check("the last month is the window's own", sameMonth(monthsInWindow(FROM, TO).slice(-1)[0], monthOf(TO)), true);
}

console.log("\n=== 5. the month grid is Sunday-first and complete ===");
{
  // September 2026: the 1st is a Tuesday (weekday 2), 30 days
  check("1.9.2026 is a Tuesday", weekdayOf("2026-09-01"), 2);
  const sep = monthGrid({ year: 2026, month: 9 });
  check("two leading blanks", sep.slice(0, 2), [null, null]);
  check("the 1st sits in the third cell", sep[2], "2026-09-01");
  check("30 real days", sep.filter((c) => c !== null).length, 30);
  check("a whole number of weeks", sep.length % 7, 0);
  check("the last real day is the 30th", sep.filter((c): c is string => c !== null).slice(-1)[0], "2026-09-30");

  // February 2028 is a leap February
  const feb = monthGrid({ year: 2028, month: 2 });
  check("29 days in Feb 2028", feb.filter((c) => c !== null).length, 29);
  const feb27 = monthGrid({ year: 2027, month: 2 });
  check("28 days in Feb 2027", feb27.filter((c) => c !== null).length, 28);

  // every real cell lands in the column its weekday says it should
  const wrong = sep.map((c, i) => (c && weekdayOf(c) !== i % 7 ? c : null)).filter(Boolean);
  check("every day sits under its own weekday column", wrong, []);
}

console.log("\n=== 6. display helpers ===");
{
  check("dowHebrew", [dowHebrew(SUN), dowHebrew(THU), dowHebrew(FRI), dowHebrew(SAT)], ["א׳", "ה׳", "ו׳", "ש׳"]);
  check("dayMonth drops leading zeros", [dayMonth("2026-09-27"), dayMonth("2026-11-07")], ["27.9", "7.11"]);
  check("dayPhrase", dayPhrase("2026-09-29"), "יום ג׳ 29.9");
  check("monthLabel is Hebrew + year", monthLabel({ year: 2026, month: 9 }), "ספטמבר 2026");
  check("monthLabel November", monthLabel({ year: 2026, month: 11 }), "נובמבר 2026");
  check("a malformed date does not crash dayMonth", dayMonth("nope"), "nope");
  check("a malformed date gives no weekday", dowHebrew("nope"), "");
}

console.log("\n=== 7. default_studio -> preselected room ===");
{
  check("גבעון", bookableRoomForDefault("גבעון", STUDIOS), GIVON);
  check("גבעון גדול", bookableRoomForDefault("גבעון גדול", STUDIOS), GIVON_BIG);
  check("חשמונאים", bookableRoomForDefault("חשמונאים", STUDIOS), HASH);
  check("TLV gives NO default", bookableRoomForDefault("TLV", STUDIOS), null);
  check("null gives no default", bookableRoomForDefault(null, STUDIOS), null);
  check("undefined gives no default", bookableRoomForDefault(undefined, STUDIOS), null);
  check("empty string gives no default", bookableRoomForDefault("   ", STUDIOS), null);
  check("an unknown value gives no default", bookableRoomForDefault("אולפן חדש", STUDIOS), null);
  // variants resolve the same way a calendar title would
  check("גבעון בחוץ -> גבעון גדול", bookableRoomForDefault("גבעון בחוץ", STUDIOS), GIVON_BIG);
  check("גבעון קטן -> גבעון", bookableRoomForDefault("גבעון קטן", STUDIOS), GIVON);
  check("החשמונאים -> חשמונאים", bookableRoomForDefault("החשמונאים", STUDIOS), HASH);
  check("whitespace and case tolerated", bookableRoomForDefault("  tlv  ", STUDIOS), null);
  check("no bookable room is ever TLV", STUDIOS.filter((s) => s.bookable).map((s) => s.canonical).includes("TLV"), false);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
