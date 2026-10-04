/**
 * israelDate — the Israeli CALENDAR DAY of an instant.
 *
 * Run:  npx tsx scripts/test_israel_date.ts
 * Reads nothing, writes nothing, needs no dev server.
 *
 * ═══ THE BUG THIS PINS ═══
 * /api/calendar/sync derived a production's record_date with
 *   action.event.start.toISOString().slice(0, 10)
 * which is UTC. Israel is UTC+3 in summer and UTC+2 in winter, so a session
 * starting before 03:00 (02:00 in winter) was filed under the PREVIOUS DAY —
 * and when that day was the 1st, under the previous MONTH.
 *
 * record_date is the anchor for the rate rule, for /projects, for the radar,
 * and since the owner's 2026-10-04 decision for WHICH CARD and which
 * consolidated work order an episode belongs to. An hour of drift here is a
 * billing-period error downstream: a 1 Oct session at 01:00 would have been
 * redeemed inside September's work order no matter how correct the split is.
 *
 * The giveaway that it was wrong rather than merely different: the very next
 * line of that insert wrote record_time through an Asia/Jerusalem formatter.
 * One timestamp, two rules — a 01:00 session stored as record_date 30.09 with
 * record_time "01:00".
 *
 * Each case below asserts the Israeli day AND, where they differ, shows what
 * the old UTC expression produced — so the test states the delta rather than
 * just the new answer.
 */
import { israelDate, todayInIsrael } from "../src/lib/dates";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (!ok && detail ? `   [${detail}]` : ""));
  if (!ok) failures++;
};

/** what the code did before: UTC */
const oldUtc = (iso: string) => new Date(iso).toISOString().slice(0, 10);

function day(label: string, iso: string, expected: string) {
  const got = israelDate(new Date(iso));
  const was = oldUtc(iso);
  const note = was === expected ? "unchanged" : `old UTC said ${was}`;
  check(`${label} -> ${expected}  (${note})`, got === expected, `got ${got}`);
}

console.log("\nthe four cases the owner named\n");
// 00:30 Israel on 1 Oct. Summer time, UTC+3, so UTC is still 30 Sep 21:30 —
// the exact shape of the reported bug, one month out.
day("2026-10-01 00:30 +03:00", "2026-10-01T00:30:00+03:00", "2026-10-01");
// a normal morning session: UTC and Israel agree, and must keep agreeing
day("2026-10-01 09:00 +03:00", "2026-10-01T09:00:00+03:00", "2026-10-01");
// the year boundary: winter time, UTC+2, UTC says 2026-12-31
day("2027-01-01 01:30 +02:00", "2027-01-01T01:30:00+02:00", "2027-01-01");
// 25 Oct 2026 is the DST transition. 01:30 occurs on that date in Israel on
// both sides of the change; the day must be 25 Oct either way.
day("2026-10-25 01:30 (DST change) +03:00", "2026-10-25T01:30:00+03:00", "2026-10-25");
day("2026-10-25 01:30 (DST change) +02:00", "2026-10-25T01:30:00+02:00", "2026-10-25");

console.log("\nthe drift boundary, hour by hour (1 Oct, summer, UTC+3)\n");
// 00:00..02:59 Israel used to fall back a day; 03:00 onward did not. Pinning
// both sides so a future "simplification" back to UTC fails here.
for (const h of ["00:00", "01:59", "02:59", "03:00", "03:01"]) {
  day(`2026-10-01 ${h}`, `2026-10-01T${h}:00+03:00`, "2026-10-01");
}

console.log("\nwinter boundary (1 Feb, UTC+2): the cliff moves to 02:00\n");
for (const h of ["00:00", "01:59", "02:00"]) {
  day(`2027-02-01 ${h}`, `2027-02-01T${h}:00+02:00`, "2027-02-01");
}

console.log("\nmidday and late evening are not affected at all\n");
day("2026-09-30 23:30 +03:00", "2026-09-30T23:30:00+03:00", "2026-09-30");
day("2026-09-30 12:00 +03:00", "2026-09-30T12:00:00+03:00", "2026-09-30");

console.log("\nthe shape of the output, and the helper it now backs\n");
check(
  "always YYYY-MM-DD",
  /^\d{4}-\d{2}-\d{2}$/.test(israelDate(new Date("2026-10-01T00:30:00+03:00"))),
  israelDate(new Date("2026-10-01T00:30:00+03:00"))
);
// todayInIsrael was rewritten as israelDate(new Date()) — same formatter, same
// zone. Asserted so the refactor cannot have changed the value it returns.
check("todayInIsrael agrees with israelDate(now)", todayInIsrael() === israelDate(new Date()), todayInIsrael());
check("todayInIsrael is still YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(todayInIsrael()), todayInIsrael());

console.log(failures === 0 ? "\nOK\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
