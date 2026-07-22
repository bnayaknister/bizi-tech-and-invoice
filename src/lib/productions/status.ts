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

// the next status in the pipeline, or null if there is none (last stage, or a
// value off the pipeline like בוטל). Drives the drawer's one-tap advance.
export function nextStatus(status: string): string | null {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status);
  if (i === -1 || i === STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[i + 1];
}
