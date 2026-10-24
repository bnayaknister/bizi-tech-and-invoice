/**
 * The evening crons across the clock changes (owner, 24.10 — Israel moves to
 * winter time on 25.10.2026, back on 26.3.2027). The 21:00 check
 * (/api/cron/unrecorded-check) and the 21:30 free-text summary
 * (/api/cron/freetext-summary) are scheduled in UTC at BOTH 18 and 19, and act
 * only when the Israeli hour is 21. This suite reads the REAL schedules from
 * vercel.json and checks that on every day around both changes EXACTLY ONE run
 * of each acts, at 21:xx Israel. Pure — no network, no env.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_cron_dst.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { israelHour, israelTimeHHMM, israelDate } from "../src/lib/dates";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) passed++;
  else failed++;
  console.log(`  ${good ? "✅" : "❌"} ${name}${good ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const vercel = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf-8")) as { crons: { path: string; schedule: string }[] };

/** "M H * * *" -> [H, M] in UTC (only daily schedules are expected here) */
function daily(path: string): [number, number][] {
  return vercel.crons
    .filter((c) => c.path === path)
    .map((c) => {
      const [m, h, ...rest] = c.schedule.split(" ");
      if (rest.join(" ") !== "* * *") throw new Error(`not a daily schedule: ${c.schedule}`);
      return [Number(h), Number(m)] as [number, number];
    });
}

const DAYS = [
  // summer, the change (Sunday 25.10.2026 02:00 -> 01:00), winter
  "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-12-15",
  // back to summer (Friday 26.3.2027 02:00 -> 03:00)
  "2027-03-25", "2027-03-26", "2027-03-27",
];

for (const [path, wantMinute] of [["/api/cron/unrecorded-check", "00"], ["/api/cron/freetext-summary", "30"]] as const) {
  console.log(`\n=== ${path} ===`);
  const runs = daily(path);
  check("scheduled at both 18 and 19 UTC", runs.map(([h]) => h).sort(), [18, 19]);
  for (const day of DAYS) {
    const acting = runs
      .map(([h, m]) => new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`))
      .filter((d) => israelHour(d) === 21);
    check(`${day}: exactly one run acts, at 21:${wantMinute} Israel, on that Israeli day`, acting.map((d) => [israelDate(d), israelTimeHHMM(d)]), [[day, `21:${wantMinute}`]]);
  }
}

console.log("\n=== israelHour ===");
check("summer: 18:00 UTC = 21", israelHour(new Date("2026-10-24T18:00:00Z")), 21);
check("winter: 18:00 UTC = 20 (that run skips)", israelHour(new Date("2026-10-25T18:00:00Z")), 20);
check("winter: 19:00 UTC = 21", israelHour(new Date("2026-10-25T19:00:00Z")), 21);
check("midnight is 0, never 24", israelHour(new Date("2026-12-15T22:00:00Z")), 0);

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
