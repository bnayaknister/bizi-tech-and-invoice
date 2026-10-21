/**
 * B38-6 — a manual status jump forward marks the episode stages it implies
 * (owner, 22.10). Pure: no Supabase, no network.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_b38_status_jump_stages.ts
 *
 * Under test: stepsImpliedBy / autoStagesForJump / autoStagesNote /
 * autoStageLogNote, the ORDER argument against a faithful copy of
 * derive_production_status (live definition, read 22.10), and the wiring of
 * the status route, the drawer and the board.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  DERIVED_BAND,
  autoStageLogNote,
  autoStagesForJump,
  autoStagesNote,
  stepsImpliedBy,
} from "../src/lib/productions/statusJumpStages";

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

type St = { id: string; step: string; status: string };
const ep = (rec: string, edit: string, del = "pending"): St[] => [
  { id: "r", step: "record", status: rec },
  { id: "e", step: "edit", status: edit },
  { id: "d", step: "deliver", status: del },
];

// derive_production_status, episode-only production, as the live function reads
function derive(cur: string, s: St[], frozen = false): string {
  if (frozen || !DERIVED_BAND.has(cur)) return cur;
  const g = (step: string) => s.find((x) => x.step === step)?.status;
  if (g("deliver") === "done") return "נערך";
  if (["in_progress", "done"].includes(g("edit") ?? "pending") || (g("deliver") ?? "pending") !== "pending") return "בעריכה";
  if (g("record") === "done") return "הוקלט";
  if (g("record") === "in_progress") return "בהקלטה";
  return "עתיד_להתחיל";
}
/** the route: stage-first inside the band, after the jump past it */
function jump(from: string, to: string, stages: St[]): { status: string; stages: St[] } {
  let status = from;
  const s = stages.map((x) => ({ ...x }));
  const marks = autoStagesForJump(from, to, s).stages;
  const markAll = () => {
    for (const m of marks) {
      m.status = "done";
      status = derive(status, s);
    }
  };
  if (DERIVED_BAND.has(to)) {
    markAll();
    status = to;
  } else {
    status = to;
    markAll();
  }
  return { status, stages: s };
}

async function main() {
  console.log("\n=== 1. which steps a status implies ===");
  eq("עתיד_להתחיל -> none", stepsImpliedBy("עתיד_להתחיל"), []);
  eq("בהקלטה -> none", stepsImpliedBy("בהקלטה"), []);
  eq("הוקלט -> record", stepsImpliedBy("הוקלט"), ["record"]);
  eq("בעריכה -> record", stepsImpliedBy("בעריכה"), ["record"]);
  eq("נערך -> record + edit", stepsImpliedBy("נערך"), ["record", "edit"]);
  eq("נשלח_ללקוח -> record + edit", stepsImpliedBy("נשלח_ללקוח"), ["record", "edit"]);
  eq('אושר_ע"י_לקוח -> record + edit', stepsImpliedBy('אושר_ע"י_לקוח'), ["record", "edit"]);
  eq("הופץ -> record + edit", stepsImpliedBy("הופץ"), ["record", "edit"]);
  eq("בוטל -> none", stepsImpliedBy("בוטל"), []);

  console.log("\n=== 2. what a jump marks ===");
  eq("עתיד_להתחיל -> נשלח_ללקוח, nothing done: record, edit (in write order)", autoStagesForJump("עתיד_להתחיל", "נשלח_ללקוח", ep("pending", "pending")).stages.map((s) => s.id), ["r", "e"]);
  eq("…record already done: only edit", autoStagesForJump("הוקלט", "נשלח_ללקוח", ep("done", "pending")).steps, ["edit"]);
  eq("…both done: nothing", autoStagesForJump("בעריכה", "נשלח_ללקוח", ep("done", "done")).steps, []);
  eq("בהקלטה -> הוקלט: record (in progress -> done)", autoStagesForJump("בהקלטה", "הוקלט", ep("in_progress", "pending")).steps, ["record"]);
  eq("deliver is never marked", autoStagesForJump("עתיד_להתחיל", "הופץ", ep("pending", "pending")).stages.some((s) => s.step === "deliver"), false);
  eq("a move BACK (נשלח_ללקוח -> הוקלט): nothing", autoStagesForJump("נשלח_ללקוח", "הוקלט", ep("pending", "pending")).steps, []);
  eq("same status: nothing", autoStagesForJump("נערך", "נערך", ep("pending", "pending")).steps, []);
  eq("from an unknown status (בוטל): nothing", autoStagesForJump("בוטל", "נשלח_ללקוח", ep("pending", "pending")).steps, []);
  eq("forward but before the recording (עתיד_להתחיל -> בהקלטה): nothing", autoStagesForJump("עתיד_להתחיל", "בהקלטה", ep("pending", "pending")).steps, []);
  eq("no episode track (reels-only): nothing", autoStagesForJump("עתיד_להתחיל", "נשלח_ללקוח", []).steps, []);
  eq("the board (no stage picture): the implied steps", autoStagesForJump("עתיד_להתחיל", "נשלח_ללקוח", null).steps, ["record", "edit"]);

  console.log("\n=== 3. the words ===");
  eq("two steps", autoStagesNote(["record", "edit"]), "השלבים הקלטה ועריכה יסומנו כבוצעו.");
  eq("one step", autoStagesNote(["record"]), "השלב הקלטה יסומן כבוצע.");
  eq("none -> no line", autoStagesNote([]), null);
  eq("the journal note", autoStageLogNote("שחר"), "סומן אוטומטית בעקבות קפיצת סטטוס – שחר");
  eq("…with no name", autoStageLogNote(null), "סומן אוטומטית בעקבות קפיצת סטטוס – לא ידוע");

  console.log("\n=== 4. the ORDER keeps the jumped status (derive_production_status) ===");
  for (const [from, to, rec, edit] of [
    ["עתיד_להתחיל", "הוקלט", "pending", "pending"],
    ["עתיד_להתחיל", "בעריכה", "pending", "pending"],
    ["עתיד_להתחיל", "נערך", "pending", "pending"],
    ["בהקלטה", "נערך", "in_progress", "pending"],
    ["בעריכה", "נערך", "done", "in_progress"],
    ["עתיד_להתחיל", "נשלח_ללקוח", "pending", "pending"],
    ["בהקלטה", 'אושר_ע"י_לקוח', "in_progress", "pending"],
  ] as const) {
    const r = jump(from, to, ep(rec, edit));
    ok(`${from} -> ${to}: ends on ${to}, record done${["record", "edit"].every((x) => stepsImpliedBy(to).includes(x as "record")) ? " + edit done" : ""}`,
      r.status === to && stepsImpliedBy(to).every((st) => r.stages.find((s) => s.step === st)?.status === "done") && r.stages.find((s) => s.step === "deliver")?.status === "pending", r);
  }
  {
    // the wrong order, to show why the route does not use it
    const s = ep("pending", "pending");
    let status = "נערך";
    for (const m of autoStagesForJump("עתיד_להתחיל", "נערך", s).stages) {
      m.status = "done";
      status = derive(status, s);
    }
    eq("(status FIRST, then the stages, on 'נערך' would be pulled back to בעריכה)", status, "בעריכה");
  }

  console.log("\n=== 5. the wiring (source) ===");
  {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf-8");
    const route = read("src/app/api/productions/[id]/route.ts");
    const iBefore = route.indexOf("if (jumpStages.length && DERIVED_BAND.has(body.status))");
    const iUpdate = route.indexOf(".update(patch)");
    const iAfter = route.indexOf("// B38-6: past the derived band — the stages after the jump");
    ok("route: inside the band the stages are marked BEFORE the status update", iBefore > 0 && iBefore < iUpdate);
    ok("…past the band, AFTER it", iAfter > iUpdate);
    ok("…through the user client (RLS on stages, the journal author)", /markJumpStages\(supabase,/.test(route) && route.includes('.from("stages")\n      .update({ status: "done" })'));
    ok("…a journal note per marked stage", route.includes('from("production_log").insert') && route.includes("autoStageLogNote("));
    ok("…an auto-marked recording asks for the job, then the work-order helper", route.indexOf("if (recordMarked) await ensureJobWhenRecorded(admin, id);") > 0 && route.indexOf("if (recordMarked) await ensureJobWhenRecorded(admin, id);") < route.indexOf("workOrder = (await enqueueWorkOrderWhenPerformed(admin, id)).status;"));
    ok("…episode track only", route.includes('.eq("track", "episode")'));
    const drawer = read("src/components/EntityDrawer.tsx");
    ok("drawer: the confirmation names the stages to be marked", drawer.includes("autoStagesNote(") && drawer.includes('stages.filter((s) => s.track === "episode")'));
    const board = read("src/app/productions/ProductionsClient.tsx");
    ok("board: the confirmation names them too", board.includes("autoStagesNote(autoStagesForJump(row.status, status, null).steps)"));
    const labels = read("src/lib/events/labels.ts");
    ok("the event has a Hebrew label", labels.includes("stages_auto_marked_by_status_jump:"));
  }

  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
