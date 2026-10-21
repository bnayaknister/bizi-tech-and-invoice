import { IN_PROGRESS_STATES, STATUS_LABEL, STATUS_ORDER, TERMINAL_STATES } from "./status";

// ═══════════════════════════════════════════════════════════════════════════
// The "היום" tab — ONE section per production (owner, 21.10). PURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Until 21.10 each section filtered the rows on its own, and two filters
// could both match: "עתיד להתחיל" read the STAGES (none done), "בעבודה עכשיו"
// read the STATUS (mid-pipeline) — so a production whose status was moved by
// hand to "נשלח ללקוח" while its stages were 0/3 showed in both
// (שומעת רגע?! 21.10, c517a024). Now one function decides, by priority:
//
//   דורש טיפול → תקוע → בעבודה עכשיו → עתיד להתחיל
//
// "עתיד להתחיל" requires BOTH a status that has not started (עתיד להתחיל)
// and no stage started. A today-production whose status has not moved but
// whose stages have started is work in progress: "בעבודה עכשיו".

export type TodaySection = "attention" | "stuck" | "working" | "upcoming";

export type TodayRow = {
  status: string;
  record_date: string | null;
  on_hold: boolean;
  needs_attention: boolean;
  stages_done: number;
  stages_total: number;
  in_progress: unknown[];
};

const stagesStarted = (p: TodayRow) => p.stages_done > 0 || p.in_progress.length > 0;

/** The one section of the "היום" tab this production belongs to, or null (not shown there). */
export function todaySection(p: TodayRow, todayIsrael: string): TodaySection | null {
  if (p.status === "בוטל") return null;
  if (p.needs_attention) return "attention";
  if (p.on_hold || p.status === "ממתין_לתגובת_לקוח") return "stuck";
  if (IN_PROGRESS_STATES.has(p.status)) return "working";
  if (TERMINAL_STATES.has(p.status)) return null;
  // the status has not started yet (עתיד להתחיל)
  if (p.record_date !== todayIsrael) return null;
  return stagesStarted(p) ? "working" : "upcoming";
}

const rank = (status: string) => (STATUS_ORDER as readonly string[]).indexOf(status);
/** "הוקלט" and every status after it claims the recording was done */
const RECORDED_RANK = rank("הוקלט");

/**
 * The status says the work has moved on, the stages say nothing was done
 * ("נשלח ללקוח · 0/3 שלבים") — the card marks it (owner, 21.10). Only the
 * mid-pipeline statuses: an approved / distributed production with no stage
 * rows is an old one, not a mismatch worth a mark.
 */
export function stageMismatch(p: TodayRow): boolean {
  const r = rank(p.status);
  return (
    r >= RECORDED_RANK &&
    (IN_PROGRESS_STATES.has(p.status) || p.status === "ממתין_לתגובת_לקוח") &&
    p.stages_total > 0 &&
    p.stages_done === 0 &&
    p.in_progress.length === 0
  );
}

/** "נשלח ללקוח · 0/3 שלבים" */
export function stageMismatchLabel(p: TodayRow): string {
  return `${STATUS_LABEL[p.status] ?? p.status} · ${p.stages_done}/${p.stages_total} שלבים`;
}

/**
 * A MANUAL status move forward to a status that says the recording was done,
 * while stages are still open — asked first (owner, 21.10): "0/3 שלבים בוצעו —
 * לקפוץ בכל זאת ל״נשלח ללקוח״?". Null = no question (a move back, a move to
 * a status before the recording, a cancel, or every stage done).
 */
export function skippedStagesNote(from: string, to: string, done: number, total: number): string | null {
  const rf = rank(from);
  const rt = rank(to);
  if (rt < 0 || rt < RECORDED_RANK) return null;
  if (rf >= 0 && rt <= rf) return null;
  if (total <= 0 || done >= total) return null;
  return `${done}/${total} שלבים בוצעו — לקפוץ בכל זאת ל״${STATUS_LABEL[to] ?? to}״?`;
}
