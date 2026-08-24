// The production pipeline status machine — the kanban columns. Extracted here
// (was duplicated in ProductionsClient, EntityDrawer, ApprovalsClient) so the
// board and the drawer's "advance to next stage" button can never disagree on
// what "next" is. The canonical status VALUES carry underscores (they're the
// stored enum); STATUS_LABEL is the human spacing.
export const STATUS_ORDER = [
  "עתיד_להתחיל",
  "בהקלטה",
  "הוקלט",
  "בעריכה",
  "נערך",
  "נשלח_ללקוח",
  "ממתין_לתגובת_לקוח",
  'אושר_ע"י_לקוח',
  "הופץ",
] as const;

export const STATUS_LABEL: Record<string, string> = {
  עתיד_להתחיל: "עתיד להתחיל",
  בהקלטה: "בהקלטה",
  הוקלט: "הוקלט",
  בעריכה: "בעריכה",
  נערך: "נערך",
  נשלח_ללקוח: "נשלח ללקוח",
  ממתין_לתגובת_לקוח: "ממתין לתגובת לקוח",
  'אושר_ע"י_לקוח': 'אושר ע"י לקוח',
  הופץ: "הופץ",
  בוטל: "בוטל",
};

// mid-pipeline = actively being worked (for the Today "in progress" bucket)
export const IN_PROGRESS_STATES = new Set(["בהקלטה", "הוקלט", "בעריכה", "נערך", "נשלח_ללקוח"]);

// end of the line — no forward move from here (cancelled isn't even on the board)
export const TERMINAL_STATES = new Set(['אושר_ע"י_לקוח', "הופץ", "בוטל"]);

/**
 * The episode has not been performed yet — scheduled, or mid-recording.
 *
 * This is the billing line, and it is the same one migration 0060/0061 draws
 * in the database: a job is work that was DONE, so it is born at הוקלט and
 * never before. Both surfaces that decide what may be redeemed read this set,
 * so the accrued screen and the redeem route can never disagree about which
 * episodes are ready — a screen-only filter would have shown the bookkeeper
 * four episodes while the redemption folded five.
 *
 * Listed literally, never as a range: 'בוטל' is the LAST value of the
 * production_status enum, so any "before הוקלט" comparison would sweep
 * cancelled episodes in with the scheduled ones.
 */
export const NOT_YET_PERFORMED = new Set(["עתיד_להתחיל", "בהקלטה"]);

/** true when the episode's work has actually happened (and it is not cancelled) */
export function hasBeenPerformed(status: string | null | undefined, cancelledAt?: string | null): boolean {
  if (cancelledAt) return false;
  if (!status) return false;
  return !NOT_YET_PERFORMED.has(status) && status !== "בוטל";
}

// the next status in the pipeline, or null if there is none (last stage, or a
// value off the pipeline like בוטל). Drives the drawer's one-tap advance.
export function nextStatus(status: string): string | null {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status);
  if (i === -1 || i === STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[i + 1];
}
