/**
 * ONE-OFF REPORT, not a test. Runs the pure availability function against a
 * real ICS feed so a human can look at the numbers before a client ever does.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/report_availability_feed.ts <feed.ics> <fromIsrael> <toIsrael>
 *
 * The feed path is an ARGUMENT and the file is never committed — it carries
 * client names. Nothing here writes anywhere: no database, no network, no
 * files. It reads one local .ics and prints.
 */
import * as fs from "fs";
import { parseIcsText } from "../src/lib/calendar/parse";
import { findLiveSeriesInWindow } from "../src/lib/calendar/series";
import { STUDIOS } from "../src/lib/calendar/studios";
import { computeAvailability, israelInstant, type AvailabilityWindow } from "../src/lib/calendar/availability";

const [, , feedPath, fromIsrael, toIsrael] = process.argv;
if (!feedPath || !fromIsrael || !toIsrael) {
  console.error("usage: report_availability_feed.ts <feed.ics> <YYYY-MM-DD> <YYYY-MM-DD>");
  process.exit(2);
}

const text = fs.readFileSync(feedPath, "utf8");
const events = parseIcsText(text);
const from = israelInstant(fromIsrael, 0, 0);
const to = new Date(israelInstant(toIsrael, 0, 0).getTime() + 86_400_000);
const series = findLiveSeriesInWindow(text, from, to, STUDIOS);

const base: Omit<AvailabilityWindow, "slotStepMinutes"> = {
  fromIsrael, toIsrael,
  openDays: [0, 1, 2, 3, 4],
  openHour: 9, closeHour: 19, slotMinutes: 90,
};

console.log(`feed            : ${feedPath}`);
console.log(`events parsed   : ${events.length}`);
console.log(`window (Israel) : ${fromIsrael} .. ${toIsrael}  (inclusive)`);
console.log(`window (UTC)    : ${from.toISOString()} .. ${to.toISOString()}`);

for (const step of [30, 90]) {
  const r = computeAvailability(events, series, STUDIOS, { ...base, slotStepMinutes: step });
  console.log(`\n=== slotStepMinutes = ${step} ===`);
  const rooms = STUDIOS.filter((s) => s.bookable).map((s) => s.canonical);
  for (const room of rooms) {
    const n = r.free.filter((s) => s.room === room).length;
    const days = new Set(r.free.filter((s) => s.room === room).map((s) => s.dateIsrael)).size;
    console.log(`  ${room.padEnd(12)} free slots: ${String(n).padStart(4)}   over ${days} open days`);
  }
  console.log(`  ${"TOTAL".padEnd(12)} free slots: ${String(r.free.length).padStart(4)}`);
}

// the three lists are step-independent — compute once
const r = computeAvailability(events, series, STUDIOS, { ...base, slotStepMinutes: 30 });

console.log(`\n=== roomsRefused (live recurring series) — ${r.roomsRefused.length} ===`);
if (r.roomsRefused.length === 0) console.log("  (none)");
for (const x of r.roomsRefused) console.log(`  ${x.room} <- ${JSON.stringify(x.seriesTitle)} [${x.seriesUid}]`);
console.log(`  live series found in window: ${series.length}`);

console.log(`\n=== unknownRoomBlocks — ${r.unknownRoomBlocks.length} ===`);
for (const b of r.unknownRoomBlocks) {
  console.log(`  ${(b.startIsrael ?? "?").padEnd(17)} ${b.allDay ? "ALLDAY " : "       "}${b.isSeries ? "SERIES " : "       "}${JSON.stringify(b.title)}`);
}

console.log(`\n=== skipped — ${r.skipped.length} ===`);
for (const s of r.skipped) console.log(`  ${s.reason.padEnd(12)} ${JSON.stringify(s.title)}`);

// a sanity figure for the eye: how much of the grid is actually taken
const openDaysCount = new Set(r.free.map((s) => s.dateIsrael)).size;
console.log(`\nopen days that have at least one free slot: ${openDaysCount}`);
