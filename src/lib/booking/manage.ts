import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// Cancelling and moving a recording — the RULES. PURE. E9-5.
// ═══════════════════════════════════════════════════════════════════════════
//
// No client, no clock, no env: every function takes `now` and rows, so the
// boundary the owner set can be asserted to the millisecond with zero
// database (F19).

/** Owner decision 11.10 (3): the bot acts alone only MORE than this far ahead. */
export const SELF_SERVE_MIN_MS = 24 * 60 * 60 * 1000;

/**
 * May the bot cancel or move this recording by itself?
 *
 * 🔴 STRICTLY MORE than 24 hours before `start_at`, measured on ABSOLUTE time
 * (two instants, no wall clock, no timezone). Exactly 24 hours is "24 שעות או
 * פחות" — the team decides. A start we cannot parse is never self-serve: the
 * safe direction is a human.
 */
export function selfServeAllowed(startAtIso: string, now: Date): boolean {
  const t = Date.parse(startAtIso);
  if (!Number.isFinite(t)) return false;
  return t - now.getTime() > SELF_SERVE_MIN_MS;
}

/**
 * What happened to the calendar event when a recording was cancelled.
 *
 *   deleted       — the system deleted the event it had created
 *   already-gone  — Google said 404/410: someone deleted it already. Success.
 *   dry-run       — CALENDAR_WRITE_DRY_RUN is on: recorded, nothing deleted
 *   not-ours      — the system did not create this event (a pre-E8 booking,
 *                   or an id that is not the derived one): a HUMAN deletes it
 *   none          — no event was ever written (the write failed): nothing to do
 *   failed        — the delete was attempted and failed: retry
 */
export type CalendarDeleteOutcome = "deleted" | "already-gone" | "dry-run" | "not-ours" | "none" | "failed";

/**
 * The calendar fields of a row -> what the cancellation must do about the
 * event, BEFORE any network call. PURE.
 *
 * `calendar_write_status` null is a booking from before the system wrote events
 * (pre-E8) — there may well be an event, but a person created it, so it is
 * theirs to delete: "not-ours", which shows the existing manual reminder.
 * 'failed' means the system tried and nothing was written: "none".
 * 'created' is the only case that goes on to the guarded delete.
 */
export function deletePlan(calendarWriteStatus: string | null): "attempt" | "not-ours" | "none" {
  if (calendarWriteStatus === "created") return "attempt";
  if (calendarWriteStatus === "failed") return "none";
  return "not-ours";
}

/** The persisted form of an outcome (0105's CHECK), or null for "none". */
export function deleteStatusFor(o: CalendarDeleteOutcome): "deleted" | "failed" | "not_ours" | "dry_run" | null {
  switch (o) {
    case "deleted":
    case "already-gone":
      return "deleted";
    case "dry-run":
      return "dry_run";
    case "not-ours":
      return "not_ours";
    case "failed":
      return "failed";
    case "none":
      return null;
  }
}

/** `{{5}}` of the change template for a cancellation — what the owner must still do. */
export const DELETE_DETAILS: Record<CalendarDeleteOutcome, string> = {
  deleted: "האירוע נמחק מהיומן אוטומטית",
  "already-gone": "האירוע כבר לא היה ביומן",
  "dry-run": "מצב בדיקה, האירוע לא נמחק מהיומן",
  "not-ours": "האירוע לא נוצר על ידי המערכת, יש למחוק אותו ביומן ידנית",
  none: "לא היה אירוע ביומן",
  failed: "המחיקה מהיומן נכשלה, אפשר לנסות שוב במסך הבקשות",
};

/** `{{5}}` for a request the bot forwarded instead of acting on. */
export function forwardedDetails(waId: string, kind: "cancel" | "move"): string {
  return kind === "cancel"
    ? `הבוט לא ביטל, הבקשה ממתינה לצוות. מספר הלקוח: ${waId}`
    : `הבוט לא הזיז, הבקשה ממתינה לצוות. מספר הלקוח: ${waId}`;
}

/** E9-6: `{{4}}` of a team recording whose title names no room */
export const TEAM_STUDIO_UNKNOWN = "לא צוין";

/**
 * E9-6: `{{5}}` for a request about a team recording — the bot touched
 * nothing; the client's own words for a move travel as written (one line).
 */
export function teamRequestDetails(waId: string, kind: "cancel" | "move", wanted?: string | null): string {
  const w = (wanted ?? "").replace(/\s+/g, " ").trim();
  return kind === "cancel"
    ? `הבוט לא ביטל — ההקלטה נקבעה ידנית ביומן. מספר הלקוח: ${waId}`
    : `המועד המבוקש: "${w || "לא צוין"}". הבוט לא הזיז — ההקלטה נקבעה ידנית ביומן. מספר הלקוח: ${waId}`;
}

/** `{{5}}` for a move the bot carried out. */
export function movedDetails(n: { dateIsrael: string; startIsrael: string; endIsrael: string; studio: string }): string {
  return `המועד החדש: יום ${dowHebrew(n.dateIsrael)} ${dayMonth(n.dateIsrael)}, ${n.startIsrael}–${n.endIsrael}, אולפן ${n.studio}`;
}

/**
 * After the shared approval of a MOVE, should the original's event be deleted?
 *
 * 🔴 Only when the swap actually happened AND stuck: the new one is approved
 * (with or without its own event — the manual path keeps an approval whose
 * write failed) and the old one was the row cancelled by the swap. A reverted
 * move restored the original, whose event must stay exactly where it is.
 */
export function shouldDeleteReplacedEvent(input: {
  swap: "swapped" | "approved-only" | null;
  outcome: "approved" | "approved-calendar-failed" | "reverted-to-pending";
}): boolean {
  return input.swap === "swapped" && input.outcome !== "reverted-to-pending";
}
