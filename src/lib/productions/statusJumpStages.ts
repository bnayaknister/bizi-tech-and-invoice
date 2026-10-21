import { STATUS_ORDER } from "./status";

// ═══════════════════════════════════════════════════════════════════════════
// B38-6 — a manual status jump forward marks the episode stages it implies.
// PURE (the drawer and the board import it).
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner, 22.10: after a confirmed jump (B37) the stages are marked done the
// way the technician would have:
//   · 'הוקלט' / 'בעריכה'                    → "פרק · הקלטה"
//   · 'נערך' / 'נשלח_ללקוח' and beyond      → "פרק · הקלטה" + "פרק · עריכה"
// Episode track only — reels and the deliver step are never touched. A move
// back (or sideways) changes no stage.
//
// THE ORDER IN THE ROUTE MATTERS. derive_production_status aligns the status
// with the stages in BOTH directions while the status is inside its band
// (עתיד_להתחיל … נערך). Marking record+edit done AFTER a jump to 'נערך' would
// pull the status back to 'בעריכה'. So for a target inside the band the stages
// are marked FIRST (the trigger moves the status up to what they say) and the
// jump is applied on top; for a target past the band (נשלח_ללקוח …) the
// trigger keeps its hands off, and the stages are marked after the jump.

export type EpisodeStep = "record" | "edit";

/** derive_production_status's own band — it rewrites the status only inside it */
export const DERIVED_BAND = new Set(["עתיד_להתחיל", "בהקלטה", "הוקלט", "בעריכה", "נערך"]);

const rank = (s: string) => (STATUS_ORDER as readonly string[]).indexOf(s);
const RECORDED = rank("הוקלט");
const EDITED = rank("נערך");

/** the episode steps a status says were done */
export function stepsImpliedBy(status: string): EpisodeStep[] {
  const r = rank(status);
  if (r >= EDITED) return ["record", "edit"];
  if (r >= RECORDED) return ["record"];
  return [];
}

/**
 * The episode stages to mark done on a move from → to, in the order they must
 * be written (record before edit: enforce_stage_order). Forward moves only.
 * `episode` = the production's episode-track stages; null when the caller does
 * not have them (the board) — then every implied step is listed.
 */
export function autoStagesForJump<S extends { step: string; status: string }>(
  from: string | null | undefined,
  to: string,
  episode: S[] | null
): { steps: EpisodeStep[]; stages: S[] } {
  const rf = rank(from ?? "");
  const rt = rank(to);
  if (rf < 0 || rt <= rf) return { steps: [], stages: [] };
  const implied = stepsImpliedBy(to);
  if (episode === null) return { steps: implied, stages: [] };
  const stages = implied
    .map((step) => episode.find((s) => s.step === step))
    .filter((s): s is S => !!s && s.status !== "done");
  return { steps: stages.map((s) => s.step as EpisodeStep), stages };
}

const STEP_WORD: Record<EpisodeStep, string> = { record: "הקלטה", edit: "עריכה" };

/** the line the confirmation window adds: "השלבים הקלטה ועריכה יסומנו כבוצעו." */
export function autoStagesNote(steps: EpisodeStep[]): string | null {
  if (steps.length === 0) return null;
  if (steps.length === 1) return `השלב ${STEP_WORD[steps[0]]} יסומן כבוצע.`;
  return `השלבים ${steps.map((s) => STEP_WORD[s]).join(" ו")} יסומנו כבוצעו.`;
}

/** the production-journal note beside each auto-marked stage */
export function autoStageLogNote(who: string | null | undefined): string {
  return `סומן אוטומטית בעקבות קפיצת סטטוס – ${(who ?? "").trim() || "לא ידוע"}`;
}
