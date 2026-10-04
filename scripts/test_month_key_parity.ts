/**
 * THE PRE-CONDITION FOR COMMIT 1. Proves the three month-key implementations
 * that exist today agree, on the inputs where they could differ, BEFORE two of
 * them are deleted in favour of the canonical one.
 *
 * Run:  npx tsx scripts/test_month_key_parity.ts
 * Reads nothing, writes nothing, needs no dev server.
 *
 * Why this file exists: `israelMonthKey` (src/lib/dates.ts) was lifted OUT of
 * the accrued page to stop exactly this drift, and its own header says so --
 * yet the inline copy stayed behind, and the radar grew a third. Replacing a
 * copy with the canonical function is only safe if they actually agree; if
 * they do not, the "refactor" silently moves an episode into a different
 * month, on the money path, and the commit that did it looks like a cleanup.
 *
 * So the two doomed copies are reproduced here VERBATIM (byte-for-byte from
 * the files named above, with only the const renamed to avoid a collision) and
 * compared against the import. Once commit 1 lands, two of these three are the
 * historical record of what was replaced -- that is the point, and it is why
 * they are copied rather than imported.
 *
 * Each case asserts BOTH three-way agreement AND the expected value. Three
 * implementations agreeing on a wrong answer is still a wrong answer.
 */
import { israelMonthKey } from "../src/lib/dates";

// ---- copy 1: src/app/documents/accrued/page.tsx:18-25 (verbatim) ----------
const ISRAEL_DAY_PAGE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const monthKeyOf = (recordDate: string | null, createdAt: string) =>
  recordDate ? recordDate.slice(0, 7) : ISRAEL_DAY_PAGE.format(new Date(createdAt)).slice(0, 7);

// ---- copy 2: src/modules/radar/alerts.ts:128-133 + :623 + the call site ---
// The radar never had a two-argument function: `israelMonth` takes only the
// timestamp, and the record_date branch is spelled inline at alerts.ts:660
// (`rd ? rd.slice(0, 7) : israelMonth(r.created_at)`). Both halves are
// reproduced, because the composite is what actually has to match.
const ISRAEL_DAY_ALERTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const israelMonth = (iso: string) => ISRAEL_DAY_ALERTS.format(new Date(iso)).slice(0, 7);
const alertsMonthKey = (rd: string | null, createdAt: string) =>
  rd ? rd.slice(0, 7) : israelMonth(createdAt);

// --------------------------------------------------------------------------
let failures = 0;

function parity(label: string, recordDate: string | null, createdAt: string, expected: string) {
  const a = israelMonthKey(recordDate, createdAt);
  const b = monthKeyOf(recordDate, createdAt);
  const c = alertsMonthKey(recordDate, createdAt);
  const agree = a === b && b === c;
  const correct = a === expected;
  if (agree && correct) {
    console.log(`  PASS  ${label}  -> ${a}`);
    return;
  }
  failures++;
  if (!agree) {
    console.log(`  FAIL  ${label}  DRIFT: dates.ts=${a}  page.tsx=${b}  alerts.ts=${c}`);
  } else {
    console.log(`  FAIL  ${label}  all three agree on ${a} but expected ${expected}`);
  }
}

console.log("\nmonth-key parity: dates.ts vs accrued/page.tsx vs radar/alerts.ts\n");

// ---- record_date present: a plain `date` column, sliced as a string -------
// No Date, no zone. These must be exact regardless of where the process runs.
console.log("record_date present (string slice, no timezone):");
parity("1 Oct", "2026-10-01", "2026-09-15T12:00:00Z", "2026-10");
parity("30 Sep", "2026-09-30", "2026-10-02T12:00:00Z", "2026-09");
parity("31 Dec", "2026-12-31", "2027-01-05T12:00:00Z", "2026-12");
parity("1 Jan (next year)", "2027-01-01", "2026-12-20T12:00:00Z", "2027-01");

// ---- record_date null: the created_at fallback, read in Israel time -------
// The cases that matter are the ones where UTC and Israel disagree about the
// DAY, because for a monthly client that disagreement is a whole month.
console.log("\nrecord_date null, created_at fallback (Israel time):");
parity("00:30 Israel on 1 Oct (UTC still 30 Sep)", null, "2026-10-01T00:30:00+03:00", "2026-10");
parity("23:30 Israel on 30 Sep", null, "2026-09-30T23:30:00+03:00", "2026-09");
parity("22:00Z on 30 Sep = 01:00 Israel on 1 Oct", null, "2026-09-30T22:00:00Z", "2026-10");
parity("05:00 Israel on 1 Oct (both agree)", null, "2026-10-01T02:00:00Z", "2026-10");

// ---- the year boundary ---------------------------------------------------
// Same hour problem, one digit further left: UTC says 2026-12 while Israel is
// already in 2027-01.
console.log("\nyear boundary:");
parity("23:30 Israel on 31 Dec", null, "2026-12-31T23:30:00+02:00", "2026-12");
parity("00:30 Israel on 1 Jan", null, "2027-01-01T00:30:00+02:00", "2027-01");
parity("23:00Z on 31 Dec = 01:00 Israel on 1 Jan", null, "2026-12-31T23:00:00Z", "2027-01");

// ---- DST: Israel leaves summer time on 25 Oct 2026 ------------------------
// The offset changes from +03:00 to +02:00 mid-month. A manual offset would
// get one of these wrong; the Intl formatter gets both.
console.log("\nDST transition (25 Oct 2026):");
parity("01:30 Israel, 25 Oct", null, "2026-10-24T22:30:00Z", "2026-10");
parity("01:30 Israel, 26 Oct (after the change)", null, "2026-10-25T23:30:00Z", "2026-10");

// ---- empty string: not a date, and must take the fallback ----------------
// `if (recordDate)` and `recordDate ? ...` both treat "" as absent. Asserted
// because a truthiness test is the one place these could have been written
// differently (`!= null` would send "" down the slice path and return "").
console.log("\nempty string record_date (must fall through, not slice to \"\"):");
parity("empty + Oct created_at", "", "2026-10-05T12:00:00Z", "2026-10");

console.log(
  failures === 0
    ? "\nOK - all three implementations agree, and agree with the expected value. Safe to replace.\n"
    : `\n${failures} FAILURE(S) - do NOT replace the copies. Report and stop.\n`
);
process.exit(failures === 0 ? 0 : 1);
