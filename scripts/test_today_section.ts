/**
 * The "היום" tab — one section per production, the status/stages mismatch
 * mark, and the confirmation before a manual jump past open stages
 * (owner, 21.10, after "שומעת רגע?! – קורין קיציס" showed twice). Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_today_section.ts
 * No database, no network. The board and the drawer are checked by reading
 * their source for the wiring (the same style as the other static checks).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { skippedStagesNote, stageMismatch, stageMismatchLabel, todaySection, type TodayRow } from "../src/lib/productions/todaySection";
import { STATUS_ORDER } from "../src/lib/productions/status";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const TODAY = "2026-10-21";
const row = (o: Partial<TodayRow> = {}): TodayRow => ({
  status: "עתיד_להתחיל", record_date: TODAY, on_hold: false, needs_attention: false,
  stages_done: 0, stages_total: 3, in_progress: [], ...o,
});

console.log("\n=== 1. the case that showed twice (c517a024, 21.10) ===");
{
  const p = row({ status: "נשלח_ללקוח" });
  eq("'נשלח ללקוח' with 0/3 stages, today -> 'בעבודה עכשיו' ONLY", todaySection(p, TODAY), "working");
  ok("…marked as a mismatch", stageMismatch(p));
  eq("…'נשלח ללקוח · 0/3 שלבים'", stageMismatchLabel(p), "נשלח ללקוח · 0/3 שלבים");
}

console.log("\n=== 2. the owner's cases: one section each ===");
{
  eq("frozen + not started, today -> 'תקוע' only (was also 'עתיד להתחיל')", todaySection(row({ on_hold: true }), TODAY), "stuck");
  eq("waiting for the client + not started, today -> 'תקוע' only", todaySection(row({ status: "ממתין_לתגובת_לקוח" }), TODAY), "stuck");
  eq("needs attention (and frozen, and in progress) -> 'דורש טיפול' only", todaySection(row({ needs_attention: true, on_hold: true, status: "בעריכה" }), TODAY), "attention");
  eq("needs attention + not started, today -> 'דורש טיפול' only", todaySection(row({ needs_attention: true }), TODAY), "attention");
  eq("frozen + in progress -> 'תקוע' (as before)", todaySection(row({ on_hold: true, status: "בעריכה", stages_done: 1 }), TODAY), "stuck");
  eq("not started (status + stages), today -> 'עתיד להתחיל'", todaySection(row(), TODAY), "upcoming");
  eq("status not moved, a stage IN PROGRESS, today -> 'בעבודה עכשיו'", todaySection(row({ in_progress: [{}] }), TODAY), "working");
  eq("status not moved, a stage done, today -> 'בעבודה עכשיו'", todaySection(row({ stages_done: 1 }), TODAY), "working");
  eq("not started, ANOTHER day -> not on the tab", todaySection(row({ record_date: "2026-10-22" }), TODAY), null);
  eq("in progress, another day -> 'בעבודה עכשיו' (as before)", todaySection(row({ status: "בעריכה", record_date: "2026-10-01", stages_done: 1 }), TODAY), "working");
  for (const st of ['אושר_ע"י_לקוח', "הופץ", "בוטל"]) eq(`'${st}' -> not on the tab`, todaySection(row({ status: st, stages_done: 3 }), TODAY), null);
}

console.log("\n=== 3. every combination lands in AT MOST one section ===");
{
  let combos = 0;
  let bad = 0;
  for (const status of [...STATUS_ORDER, "בוטל"])
    for (const on_hold of [false, true])
      for (const needs_attention of [false, true])
        for (const stages_done of [0, 1, 3])
          for (const ip of [0, 1])
            for (const record_date of [TODAY, "2026-10-20"]) {
              combos++;
              const p = row({ status, on_hold, needs_attention, stages_done, in_progress: ip ? [{}] : [], record_date });
              const s = todaySection(p, TODAY);
              // the old four filters, to show which combinations used to double-show
              const old = [
                needs_attention,
                record_date === TODAY && !["אושר_ע\"י_לקוח", "הופץ", "בוטל"].includes(status) && stages_done === 0 && ip === 0,
                ["בהקלטה", "הוקלט", "בעריכה", "נערך", "נשלח_ללקוח"].includes(status) && !on_hold,
                on_hold || status === "ממתין_לתגובת_לקוח",
              ].filter(Boolean).length;
              if (old > 0 && s === null && status !== "בוטל") bad++; // nothing that was shown may vanish
            }
  ok(`${combos} combinations: one section or none — never two (by construction)`, true);
  eq("nothing the old filters showed disappears (except cancelled)", bad, 0);
}

console.log("\n=== 4. the mismatch mark ===");
{
  for (const st of ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח"]) ok(`'${st}' + 0 stages -> marked`, stageMismatch(row({ status: st })));
  ok("'בהקלטה' + 0 stages -> not marked (recording may be under way)", !stageMismatch(row({ status: "בהקלטה" })));
  ok("'נשלח ללקוח' + a stage done -> not marked", !stageMismatch(row({ status: "נשלח_ללקוח", stages_done: 1 })));
  ok("'נשלח ללקוח' + a stage in progress -> not marked", !stageMismatch(row({ status: "נשלח_ללקוח", in_progress: [{}] })));
  ok("no stage rows at all (old production) -> not marked", !stageMismatch(row({ status: "נשלח_ללקוח", stages_total: 0 })));
  ok("'הופץ' + 0 stages -> not marked (old productions)", !stageMismatch(row({ status: "הופץ" })));
}

console.log("\n=== 5. the confirmation before a manual jump ===");
{
  eq("עתיד להתחיל -> נשלח ללקוח, 0/3", skippedStagesNote("עתיד_להתחיל", "נשלח_ללקוח", 0, 3), "0/3 שלבים בוצעו — לקפוץ בכל זאת ל״נשלח ללקוח״?");
  ok("-> הוקלט with 0/3: asked", skippedStagesNote("עתיד_להתחיל", "הוקלט", 0, 3) !== null);
  ok("-> הופץ with 2/3: asked", skippedStagesNote("נערך", "הופץ", 2, 3) !== null);
  eq("-> בהקלטה (before the recording): not asked", skippedStagesNote("עתיד_להתחיל", "בהקלטה", 0, 3), null);
  eq("a move BACK: not asked", skippedStagesNote("נשלח_ללקוח", "בעריכה", 0, 3), null);
  eq("every stage done: not asked", skippedStagesNote("נערך", "נשלח_ללקוח", 3, 3), null);
  eq("no stage rows: not asked", skippedStagesNote("עתיד_להתחיל", "נשלח_ללקוח", 0, 0), null);
  eq("cancel (not in the pipeline): not asked", skippedStagesNote("עתיד_להתחיל", "בוטל", 0, 3), null);
}

console.log("\n=== 6. the wiring (source) ===");
{
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
  const board = read("src/app/productions/ProductionsClient.tsx");
  ok("the 'היום' tab sorts with todaySection", /bySection\("upcoming"\)/.test(board) && board.includes("todaySection(p, today)"));
  ok("…the old overlapping filters are gone", !board.includes("const notStarted =") && !board.includes("IN_PROGRESS_STATES.has(p.status) && !p.on_hold"));
  ok("the card shows the mismatch mark", board.includes("stageMismatchLabel(p)"));
  ok("a drag on the board asks before skipping stages", /skippedStagesNote\(row\.status, status/.test(board) && board.includes("window.confirm(note)"));
  const drawer = read("src/components/EntityDrawer.tsx");
  ok("the drawer's status jump asks before skipping stages", drawer.includes("skippedStagesNote(") && drawer.includes("window.confirm(note)"));
  const route = read("src/app/api/productions/[id]/route.ts");
  ok("the status event records FROM and TO", route.includes("{ to: body.status, from: current?.status ?? null }"));
}

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
