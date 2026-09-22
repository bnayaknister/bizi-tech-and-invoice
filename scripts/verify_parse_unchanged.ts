/**
 * Proof that the additive fields on CalendarEvent changed NOTHING the calendar
 * sync reads.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/verify_parse_unchanged.ts <feed.ics> --write <baseline.json>
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/verify_parse_unchanged.ts <feed.ics> --check <baseline.json>
 *
 * The feed is passed as a PATH and never committed — it carries client names.
 *
 * The six fields below are the whole contract with the sync: buildSyncPlan,
 * matchTitleToShow, extractStudioAndGuest and findUnsyncedRecurring read these
 * and nothing else. They are projected in a FIXED key order and compared as
 * bytes, so a reordering, a rounding, or a single changed character fails.
 *
 * Why this exists rather than a type check: `allDay`, `startDateOnly`,
 * `endDateOnly` and `hasExplicitEnd` are optional, so TypeScript would accept
 * the change even if reading the raw DTSTART property had perturbed the parse
 * of a malformed event somewhere in 2,700 of them. Bytes settle it.
 */
import * as fs from "fs";
import { parseIcsText, type CalendarEvent } from "../src/lib/calendar/parse";

const [, , feedPath, mode, baselinePath] = process.argv;
if (!feedPath || !["--write", "--check"].includes(mode ?? "") || !baselinePath) {
  console.error("usage: verify_parse_unchanged.ts <feed.ics> --write|--check <baseline.json>");
  process.exit(2);
}

// fixed order — the six fields that existed before 2026-09-22
function projectSix(events: CalendarEvent[]) {
  return events.map((e) => ({
    uid: e.uid,
    title: e.title,
    start: e.start,
    end: e.end,
    location: e.location,
    recurrence: e.recurrence,
  }));
}

const events = parseIcsText(fs.readFileSync(feedPath, "utf8"));
const json = JSON.stringify(projectSix(events), null, 0);

if (mode === "--write") {
  fs.writeFileSync(baselinePath, json);
  console.log(`events=${events.length} bytes=${Buffer.byteLength(json)} -> ${baselinePath}`);
  process.exit(0);
}

const expected = fs.readFileSync(baselinePath, "utf8");
const same = expected === json;
console.log(`events parsed      : ${events.length}`);
console.log(`baseline bytes     : ${Buffer.byteLength(expected)}`);
console.log(`current  bytes     : ${Buffer.byteLength(json)}`);
console.log(`six fields identical: ${same ? "YES — byte for byte" : "NO"}`);

if (!same) {
  // show the first divergence rather than dumping half a megabyte
  const before = JSON.parse(expected) as unknown[];
  const after = JSON.parse(json) as unknown[];
  if (before.length !== after.length) console.log(`  event COUNT differs: ${before.length} -> ${after.length}`);
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = JSON.stringify(before[i]);
    const b = JSON.stringify(after[i]);
    if (a !== b) {
      console.log(`  first differing event, index ${i}:\n    baseline: ${a}\n    current : ${b}`);
      break;
    }
  }
}

// and a census of the new fields, so "identical" is not confused with "inert"
const allDay = events.filter((e) => e.allDay === true).length;
const withDateOnly = events.filter((e) => typeof e.startDateOnly === "string").length;
const noExplicitEnd = events.filter((e) => e.hasExplicitEnd === false).length;
console.log(`\nadditive fields (these are NEW, and are expected to be non-zero):`);
console.log(`  allDay === true      : ${allDay}`);
console.log(`  startDateOnly present: ${withDateOnly}`);
console.log(`  hasExplicitEnd false : ${noExplicitEnd}`);

process.exit(same ? 0 : 1);
