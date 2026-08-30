/**
 * The calendar-duplicate warning, checked against LIVE data.
 *
 * Run:  npx tsx scripts/test_manual_duplicate_guard.ts
 * READ-ONLY: replays the server's lookup as a SELECT. Creates no production,
 * calls no route, needs no dev server.
 *
 * ═══ WHAT IT ASSERTS ═══
 * The predicate the route runs is small enough to state exactly, so this
 * replays it over every (show, day) that has ever existed and checks the two
 * things that must hold:
 *
 *   • it FIRES on the three known duplicates — 28.7 סדרת חינוך, 13.8 חתונמיות,
 *     28.8 אוכלי סרטים — as they stood the moment the manual row was created
 *   • it stays SILENT on every all-calendar day (עומר חן ×3 on 3.8, SFI ×2 on
 *     17.8), which are ordinary multi-episode sessions
 *
 * The historical cases are replayed AS OF the creation instant, not as the rows
 * look now: two of the three have since been merged or cancelled, and the guard
 * deliberately ignores those states. Reading today's rows would show the
 * warning not firing and call it a pass for the wrong reason.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

type P = {
  id: string;
  show_id: string | null;
  podcast_name: string;
  record_date: string | null;
  record_time: string | null;
  created_at: string;
  calendar_uid: string | null;
  merged_into: string | null;
  cancelled_at: string | null;
  guest: string | null;
  status: string;
};

async function main() {
  const all: P[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin
      .from("productions")
      .select("id,show_id,podcast_name,record_date,record_time,created_at,calendar_uid,merged_into,cancelled_at,guest,status")
      .order("id")
      .range(from, from + 999);
    const rows = (data ?? []) as unknown as P[];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  const { data: evs } = await admin
    .from("events")
    .select("entity_id,event_type,created_at")
    .eq("event_type", "production_created_manually");
  const manual = new Set((evs ?? []).map((e) => e.entity_id as string));

  /** the route's own predicate, evaluated as of `asOf` */
  const wouldWarn = (p: P, asOf: string) =>
    all.filter(
      (o) =>
        o.id !== p.id &&
        o.show_id === p.show_id &&
        o.record_date === p.record_date &&
        o.calendar_uid !== null &&
        !o.merged_into &&
        !o.cancelled_at &&
        o.created_at < asOf
    );

  console.log("\n=== the three known duplicates, replayed at their creation instant ===");
  const KNOWN = [
    { date: "2026-07-28", name: "סדרת חינוך" },
    { date: "2026-08-13", name: "חתונמיות" },
    { date: "2026-08-28", name: "אוכלי סרטים" },
  ];
  for (const k of KNOWN) {
    const row = all.find(
      (p) => p.record_date === k.date && p.podcast_name.includes(k.name) && manual.has(p.id)
    );
    if (!row) {
      check(`${k.date} ${k.name}: the manual row is findable`, false, "not found");
      continue;
    }
    const hits = wouldWarn(row, row.created_at);
    check(
      `${k.date} ${k.name}: warning fires`,
      hits.length > 0,
      hits.length
        ? hits.map((h) => `${h.record_time ?? "—"}/${h.guest ?? "—"}`).join(", ")
        : "SILENT — would not have been caught"
    );
    const sameTime = hits.filter((h) => h.record_time && h.record_time === row.record_time);
    console.log(
      `        manual row ${row.record_time ?? "—"}  ·  ${hits.length} calendar episode(s) already there` +
        (sameTime.length ? `  ·  ${sameTime.length} at the SAME time` : "")
    );
  }

  console.log("\n=== all-calendar days must stay silent ===");
  const byKey = new Map<string, P[]>();
  for (const p of all) {
    if (!p.show_id || !p.record_date || p.merged_into) continue;
    const k = `${p.show_id}|${p.record_date}`;
    byKey.set(k, [...(byKey.get(k) ?? []), p]);
  }
  // Array.from, not a spread: tsconfig sets no `target`, so it defaults to ES5
  // and spreading a Map iterator needs downlevelIteration. tsx tolerates it;
  // `next build` type-checks every .ts in the repo and does not.
  const allCal = Array.from(byKey.values()).filter(
    (g) => g.length > 1 && g.every((p) => p.calendar_uid !== null)
  );
  console.log(`    show+day groups where EVERY episode came from the calendar: ${allCal.length}`);
  for (const g of allCal) {
    console.log(`      ${g[0].record_date} ${g[0].podcast_name.slice(0, 26)} ×${g.length}`);
  }
  check(
    "none of them contains a manual row (so none can warn)",
    allCal.every((g) => g.every((p) => !manual.has(p.id))),
    "a manual row inside an all-calendar group would contradict the grouping"
  );

  console.log("\n=== every manual creation ever, scored ===");
  const manualRows = all.filter((p) => manual.has(p.id) && p.record_date && p.show_id);
  let fired = 0;
  const firedRows: P[] = [];
  for (const p of manualRows) {
    const hits = wouldWarn(p, p.created_at);
    if (hits.length) {
      fired++;
      firedRows.push(p);
    }
  }
  console.log(`    manual creations: ${manualRows.length}   would have warned: ${fired}`);
  for (const p of firedRows) {
    console.log(`      ${p.record_date} ${p.podcast_name.slice(0, 26)}  (${p.created_at.slice(0, 16)})`);
  }
  check("exactly the three known duplicates warn, no more", fired === 3, `${fired}`);

  console.log("\n=== the guard ignores already-resolved duplicates ===");
  // 94d4a7ea was merged, 4696ed68 cancelled. Re-running the predicate TODAY
  // must not warn about them: a duplicate someone already dealt with is not
  // evidence, and warning on it would be noise on work already done.
  const resolved = all.filter((p) => p.merged_into || p.cancelled_at);
  const stillCounted = resolved.filter((p) =>
    all.some(
      (o) =>
        o.id !== p.id &&
        o.show_id === p.show_id &&
        o.record_date === p.record_date &&
        manual.has(o.id) &&
        wouldWarn(o, new Date().toISOString()).some((h) => h.id === p.id)
    )
  );
  check("a merged or cancelled episode never counts as evidence", stillCounted.length === 0, `${stillCounted.length}`);

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
