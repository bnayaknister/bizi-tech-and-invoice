/**
 * T35 — timing instrumentation (PERF_TIMING / NEXT_PUBLIC_PERF_TIMING).
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_perf_timing.ts
 *
 * ═══ F19 ═══
 * Pure: no database, no network. `global.fetch` throws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { perfTimer, PERF_OFF, PERF_LOG_TAG, serverTimingHeader, isPerfTimingOn } from "../src/lib/perf/timing";
import { isPerfClientOn, perfStart, perfNote, perfEndAfterPaint } from "../src/lib/perf/client";

global.fetch = (async () => {
  throw new Error("F19: this suite must not perform any fetch");
}) as unknown as typeof fetch;

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
const section = (t: string) => console.log(`\n── ${t}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  section("1. off means off");
  delete process.env.PERF_TIMING;
  check("PERF_TIMING unset -> off", isPerfTimingOn(), false);
  const off = perfTimer("/productions");
  check("the no-op timer is returned", off === PERF_OFF, true);
  const logged: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  off.lap("x");
  const v = await off.time("q", Promise.resolve(42));
  const header = off.done({ production_id: "p1" });
  console.log = realLog;
  check("time() still returns the value", v, 42);
  check("no header", header, "");
  check("no log line at all", logged.length, 0);
  process.env.PERF_TIMING = "false";
  check("PERF_TIMING=false -> off", isPerfTimingOn(), false);
  process.env.PERF_TIMING = "true";
  check("PERF_TIMING=true -> on", isPerfTimingOn(), true);
  delete process.env.PERF_TIMING;

  section("2. on: one JSON line, laps and parallel timings");
  {
    const lines: string[] = [];
    const t = perfTimer("/api/entity/production/[id]", { force: true, log: (l) => lines.push(l) });
    await sleep(5);
    t.lap("getUser");
    const [a, b] = await Promise.all([t.time("q_a", sleep(10).then(() => "A")), t.time("q_b", sleep(3).then(() => "B"))]);
    t.lap("wave");
    const h = t.done({ production_id: "6d71a228-3cfb-4210-a504-a0fe78d21517" });
    const again = t.done({ production_id: "x" });
    check("values pass through", [a, b], ["A", "B"]);
    check("exactly one log line, even if done() is called twice", lines.length, 1);
    const j = JSON.parse(lines[0]);
    check("the line's keys: tag, route, total_ms, steps, production_id — nothing else", Object.keys(j), ["tag", "route", "total_ms", "steps", "production_id"]);
    check("tag + route", [j.tag, j.route], [PERF_LOG_TAG, "/api/entity/production/[id]"]);
    check("steps in completion order with names", j.steps.map((s: { name: string }) => s.name), ["getUser", "q_b", "q_a", "wave"]);
    check("every step has a numeric ms", j.steps.every((s: { ms: unknown }) => typeof s.ms === "number" && s.ms >= 0), true);
    check("parallel q_a took longer than q_b", j.steps.find((s: { name: string }) => s.name === "q_a").ms > j.steps.find((s: { name: string }) => s.name === "q_b").ms, true);
    check("total >= the sum of the laps", j.total_ms >= j.steps.find((s: { name: string }) => s.name === "getUser").ms, true);
    check("Server-Timing: name;dur=, comma-separated, ending in total", /^(?:[A-Za-z0-9_-]+;dur=[0-9.]+, )+total;dur=[0-9.]+$/.test(h), true);
    check("the second done() still returns a header", again.length > 0, true);
  }
  {
    const lines: string[] = [];
    perfTimer("/productions", { force: true, log: (l) => lines.push(l) }).done();
    check("no production_id key when none is given", "production_id" in JSON.parse(lines[0]), false);
  }
  check("metric names are sanitised to tokens", serverTimingHeader([{ name: "a b.c/ד", ms: 1 }], 2), "a_b_c__;dur=1, total;dur=2");
  check("the middleware's total has its own name", serverTimingHeader([], 3, "mw_total"), "mw_total;dur=3");

  section("3. client: off is a no-op in any environment");
  delete process.env.NEXT_PUBLIC_PERF_TIMING;
  check("NEXT_PUBLIC_PERF_TIMING unset -> off", isPerfClientOn(), false);
  let threw = false;
  try {
    perfStart("k");
    perfNote("k", { a: 1 });
    perfEndAfterPaint("k", { fromNavigationStart: true });
  } catch {
    threw = true;
  }
  check("no throw without window when off", threw, false);

  section("4. privacy + scope (static)");
  const root = join(__dirname, "..");
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const files = ["src/lib/supabase/middleware.ts", "src/app/productions/page.tsx", "src/app/api/entity/[type]/[id]/route.ts"];
  for (const f of files) {
    const calls = read(f).match(/perf\.done\(([^)]*)\)/g) ?? [];
    check(`${f}: done() is called`, calls.length > 0, true);
    check(`${f}: done() carries nothing but production_id`, calls.every((c) => !/user|email|name|phone|wa_id|profile/i.test(c)), true);
  }
  const route = read("src/app/api/entity/[type]/[id]/route.ts");
  check("drawer route: only the production type is timed", /type === "production" \? perfTimer\(/.test(route), true);
  check("drawer route: Server-Timing only when on", /if \(perf\.on\) res\.headers\.set\("Server-Timing"/.test(route), true);
  const mw = read("src/lib/supabase/middleware.ts");
  check("middleware: only /productions and the production drawer API are timed", mw.includes("const PERF_PATHS = /^\\/(productions(\\/|$)|api\\/entity\\/production\\/)/;"), true);
  check("middleware: other paths get the no-op timer", /: PERF_OFF;/.test(mw), true);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
