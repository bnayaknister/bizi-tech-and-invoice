/**
 * The booking window's edges. Pure — no server, no feed, no database.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_booking_window.ts
 *
 * The case worth having a suite for is the two- or three-hour band after
 * Israeli midnight, when the UTC calendar date is STILL YESTERDAY. This code
 * runs on Vercel, which is UTC, so a window derived from a UTC date offers a
 * client THIS AFTERNOON — the one day the owner ruled out. It is silent, it is
 * nightly, and it is unreachable by hand without waiting for 00:30.
 */
import { bookingWindowFor, BOOKING_WINDOW_DAYS } from "../src/lib/calendar/bookingWindow";
import { israelDateOf, addIsraelDays, israelDatesBetween } from "../src/lib/calendar/availability";

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

// Israel is +03:00 in September 2026, so these three instants are given in UTC
// and their Israeli wall clock is stated in the label.
const CASES: { label: string; utc: string; israelClock: string; expectFrom: string }[] = [
  { label: "22.9 23:30 Israel", utc: "2026-09-22T20:30:00Z", israelClock: "2026-09-22 23:30", expectFrom: "2026-09-23" },
  { label: "23.9 00:30 Israel", utc: "2026-09-22T21:30:00Z", israelClock: "2026-09-23 00:30", expectFrom: "2026-09-24" },
  { label: "23.9 02:59 Israel", utc: "2026-09-22T23:59:00Z", israelClock: "2026-09-23 02:59", expectFrom: "2026-09-24" },
];

console.log("\n=== the three instants really are the Israeli times claimed ===");
for (const c of CASES) {
  const stamp = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Jerusalem", dateStyle: "short", timeStyle: "short",
  }).format(new Date(c.utc));
  check(`${c.utc} is ${c.israelClock} in Israel`, stamp, c.israelClock);
}

console.log("\n=== from = tomorrow, Israel time ===");
for (const c of CASES) {
  const w = bookingWindowFor(new Date(c.utc));
  check(`${c.label} -> from ${c.expectFrom}`, w.fromIsrael, c.expectFrom);
}

console.log("\n=== the UTC-date trap, stated as an assertion ===");
{
  // 23.9 00:30 Israel is still 22.9 in UTC. A window built from the UTC date
  // would open on 23.9 — today in Israel — which is the forbidden day.
  const instant = new Date("2026-09-22T21:30:00Z");
  check("UTC calendar date is still the 22nd", instant.toISOString().slice(0, 10), "2026-09-22");
  check("Israeli calendar date is already the 23rd", israelDateOf(instant), "2026-09-23");
  const w = bookingWindowFor(instant);
  check("so `from` is the 24th, not the 23rd", w.fromIsrael, "2026-09-24");
  check("and `from` is never today in Israel", w.fromIsrael === israelDateOf(instant), false);
}

console.log("\n=== to is exactly 55 days after from ===");
for (const c of CASES) {
  const w = bookingWindowFor(new Date(c.utc));
  check(`${c.label} -> to = from + 55`, w.toIsrael, addIsraelDays(w.fromIsrael, 55));
  check(`${c.label} -> window spans exactly 56 days`, israelDatesBetween(w.fromIsrael, w.toIsrael).length, 56);
}
check("BOOKING_WINDOW_DAYS is 56", BOOKING_WINDOW_DAYS, 56);

console.log("\n=== the window in the previous report reproduces exactly ===");
{
  const w = bookingWindowFor(new Date("2026-09-22T20:30:00Z")); // 22.9 23:30 Israel
  check("from", w.fromIsrael, "2026-09-23");
  check("to", w.toIsrael, "2026-11-17");
  check("open Sun-Thu days in it", israelDatesBetween(w.fromIsrael, w.toIsrael)
    .filter((d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)!;
      return [0, 1, 2, 3, 4].includes(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay());
    }).length, 40);
}

console.log("\n=== it crosses month ends and the DST boundary without drifting ===");
{
  // a window that starts before 25.10 and ends after it
  const w = bookingWindowFor(new Date("2026-10-01T06:00:00Z"));
  check("from", w.fromIsrael, "2026-10-02");
  check("to", w.toIsrael, "2026-11-26");
  check("spans 56 days across the DST change", israelDatesBetween(w.fromIsrael, w.toIsrael).length, 56);
  // month-end and leap-adjacent arithmetic
  check("31.12 -> 1.1 next year", addIsraelDays("2026-12-31", 1), "2027-01-01");
  check("28.2.2028 + 1 = 29.2 (leap)", addIsraelDays("2028-02-28", 1), "2028-02-29");
  check("28.2.2026 + 1 = 1.3 (non-leap)", addIsraelDays("2026-02-28", 1), "2026-03-01");
}

console.log("\n=== bad input throws ===");
for (const [label, fn] of [
  ["a non-Date now", () => bookingWindowFor("2026-09-22" as unknown as Date)],
  ["an invalid Date", () => bookingWindowFor(new Date("nope"))],
  ["a non-integer day count", () => addIsraelDays("2026-09-23", 1.5)],
] as const) {
  try {
    fn();
    failed++;
    console.log(`  ❌ ${label} — expected a throw`);
  } catch {
    passed++;
    console.log(`  ✅ ${label}`);
  }
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
