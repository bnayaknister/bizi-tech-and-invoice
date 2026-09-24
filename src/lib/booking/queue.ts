import { israelDateOf } from "@/lib/calendar/availability";
import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";
import { israelHHMM } from "./publicView";
import { eventTitle, googleCalendarUrl } from "./title";

// ═══════════════════════════════════════════════════════════════════════════
// The owner's request queue. PURE — rows in, view models out.
// ═══════════════════════════════════════════════════════════════════════════
//
// `now` is a parameter everywhere, never Date.now(). Every rule on this screen
// turns on "has this moment passed?", and a screen whose behaviour depends on
// the wall clock is a screen that can only be tested by waiting.

/** A row exactly as the page selects it, plus the show's name resolved. */
export type QueueRow = {
  id: string;
  show_id: string;
  showName: string;
  studio: string;
  start_at: string; // ISO
  end_at: string; // ISO
  guest: string | null;
  note: string | null;
  status: string;
  created_at: string; // ISO
  /**
   * The show's CLEAN alias — the name that contains no room name — resolved by
   * the caller through `cleanAliasFor`.
   *
   * It lives on the row rather than being looked up here so that `toView` stays
   * a pure function of its arguments, and so that the calendar title is built
   * in ONE place for both the just-approved panel and every approved row in
   * history. Two builders would drift, and the one that drifted would be the
   * one the owner pastes.
   */
  alias: string;
};

export type QueueStatus = "pending" | "approved" | "declined" | "past";

export type QueueView = {
  id: string;
  showName: string;
  studio: string;
  /** "יום א׳ 27.9 · 09:00–10:30 · אולפן גבעון" */
  whenLine: string;
  /** the guest, or the approved "בלי אורח" — never an empty gap */
  guestLine: string;
  /** the raw stored guest, for the title builder and the room warning */
  guest: string | null;
  note: string | null;
  /** "נשלחה יום ד׳ 24.9 14:03" */
  sentLine: string;
  status: QueueStatus;
  statusLabel: string;
  /** another pending or approved request holds an overlapping slot in this room */
  overlapping: boolean;
  canApprove: boolean;
  canDecline: boolean;
  // the pieces the calendar hand-off and the messages need, already in Israeli
  // wall-clock form so no caller does timezone maths a second time
  dateIsrael: string;
  startIsrael: string;
  endIsrael: string;
  startIso: string;
  endIso: string;
  /** the calendar title to paste — "{alias}, אורח: {guest}, {room}" */
  title: string;
  /** a pre-filled Google "create event" link; opening it creates nothing */
  googleUrl: string;
};

/** Approved copy, 24.9. "המועד עבר" is a STATE, not a decision — see below. */
export const QUEUE_STATUS_LABEL: Record<QueueStatus, string> = {
  pending: "ממתינה",
  approved: "אושרה",
  declined: "נדחתה",
  past: "המועד עבר",
};

export const NO_GUEST = "בלי אורח";

/** "יום א׳ 27.9 · 09:00–10:30 · אולפן גבעון" */
export function whenLine(dateIsrael: string, startIsrael: string, endIsrael: string, studio: string): string {
  return `יום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)} · ${startIsrael}–${endIsrael} · אולפן ${studio}`;
}

/** "נשלחה יום ד׳ 24.9 14:03" */
export function sentLine(createdAt: Date): string {
  const d = israelDateOf(createdAt);
  return `נשלחה יום ${dowHebrew(d)} ${dayMonth(d)} ${israelHHMM(createdAt)}`;
}

/**
 * Half-open overlap, [start, end) on both sides — the SAME comparison the
 * availability grid uses. Two recordings that merely touch (10:30 end, 10:30
 * start) do not overlap; there is no buffer between bookings (owner: "בלי
 * מרווח") and a tag claiming otherwise would be noise on every back-to-back
 * pair.
 */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Does this pending request collide with another live request in the same room?
 *
 * Counted against PENDING and APPROVED rows only — a declined one holds
 * nothing. The row never collides with itself (compared by id).
 *
 * ⚠️ THIS IS A TAG, NOT A BLOCK. Two pending requests for one slot is a normal
 * state that 0096 designed for: two clients wanted the same afternoon and the
 * owner picks. The tag exists so the owner knows that approving this one makes
 * the other unapprovable, BEFORE they click — the EXCLUDE constraint would
 * otherwise deliver that news as a 409 on the second approval.
 */
export function isOverlapping(row: QueueRow, all: QueueRow[]): boolean {
  const s = Date.parse(row.start_at);
  const e = Date.parse(row.end_at);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return (all ?? []).some((other) => {
    if (other.id === row.id) return false;
    if (other.studio !== row.studio) return false;
    if (other.status !== "pending" && other.status !== "approved") return false;
    const os = Date.parse(other.start_at);
    const oe = Date.parse(other.end_at);
    return Number.isFinite(os) && Number.isFinite(oe) && overlaps(s, e, os, oe);
  });
}

function toView(row: QueueRow, all: QueueRow[], now: Date): QueueView | null {
  const s = Date.parse(row.start_at);
  const e = Date.parse(row.end_at);
  // A row we cannot place in time is DROPPED rather than rendered somewhere
  // arbitrary: this screen's buttons write to the database, and a row whose
  // moment we misread is a row whose "has it passed?" answer is a guess.
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;

  const start = new Date(s);
  const end = new Date(e);
  const dateIsrael = israelDateOf(start);
  const startIsrael = israelHHMM(start);
  const endIsrael = israelHHMM(end);
  const isPast = s < now.getTime();

  const status: QueueStatus =
    row.status === "approved" ? "approved"
    : row.status === "declined" ? "declined"
    : isPast ? "past"
    : "pending";

  const created = new Date(Date.parse(row.created_at));
  const title = eventTitle({ alias: row.alias, guest: row.guest, studio: row.studio });

  return {
    id: row.id,
    showName: row.showName,
    studio: row.studio,
    whenLine: whenLine(dateIsrael, startIsrael, endIsrael, row.studio),
    guestLine: row.guest && row.guest.trim() !== "" ? row.guest.trim() : NO_GUEST,
    guest: row.guest && row.guest.trim() !== "" ? row.guest.trim() : null,
    note: row.note && row.note.trim() !== "" ? row.note.trim() : null,
    sentLine: Number.isFinite(created.getTime()) ? sentLine(created) : "",
    status,
    statusLabel: QUEUE_STATUS_LABEL[status],
    // only a live pending request can collide with anything
    overlapping: status === "pending" ? isOverlapping(row, all) : false,
    // ⚠️ APPROVE IS THE ONLY BUTTON WITH A TIME CONDITION. Approving a slot that
    // has already passed would produce a calendar event in the past and a
    // production for a recording that never happened. DECLINE stays available,
    // because a stale request still owes the client an answer.
    canApprove: status === "pending",
    canDecline: status === "pending" || status === "past",
    dateIsrael,
    startIsrael,
    endIsrael,
    startIso: row.start_at,
    endIso: row.end_at,
    // Built for EVERY row, not just approved ones: the owner may want to see
    // what a pending request would become before deciding, and a value computed
    // in one branch only is a value that is wrong in the other.
    title,
    googleUrl: googleCalendarUrl({ title, start, end, details: row.note }),
  };
}

/** The 30 most recent rows the history section shows. */
export const HISTORY_LIMIT = 30;

export type QueueSections = { waiting: QueueView[]; history: QueueView[] };

/**
 * Split the rows into the two sections the screen shows.
 *
 *   waiting  pending, still in the future, EARLIEST FIRST — it is a worklist,
 *            and the thing that needs deciding soonest belongs at the top.
 *   history  everything else: decided rows, plus pending ones whose moment
 *            passed. NEWEST FIRST, capped at 30.
 *
 * ⚠️ A PENDING ROW WHOSE MOMENT PASSED IS IN HISTORY, NOT IN THE WORKLIST.
 * It is no longer something the owner can act on usefully — approving it is
 * refused — but it is also not something to hide, because the client is still
 * looking at "ממתינה לאישור" on their own screen. It appears in history marked
 * "המועד עבר", with a decline button, which is the only honest pair.
 *
 * History is ordered by the RECORDING moment rather than by when the decision
 * was made. Every row on this screen leads with its slot, all three kinds of
 * history row have one, and only the decided ones have a decision time — so
 * ordering by the slot is the one ordering that means the same thing for all
 * of them.
 */
export function splitQueue(rows: QueueRow[] | null | undefined, now: Date): QueueSections {
  const all = rows ?? [];
  const views: { at: number; view: QueueView }[] = [];
  for (const r of all) {
    const v = toView(r, all, now);
    if (v) views.push({ at: Date.parse(r.start_at), view: v });
  }

  const waiting = views
    .filter((v) => v.view.status === "pending")
    .sort((a, b) => a.at - b.at)
    .map((v) => v.view);

  const history = views
    .filter((v) => v.view.status !== "pending")
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_LIMIT)
    .map((v) => v.view);

  return { waiting, history };
}

/**
 * The module card's number: pending requests still in the future.
 *
 * ⚠️ NOT "every pending row". A request whose moment passed is not waiting on
 * the owner in any useful sense, and counting it would leave a badge that never
 * clears and that the owner learns to ignore — which is the same as having no
 * badge, except worse, because the next real one is invisible too.
 */
export function pendingFutureCount(rows: QueueRow[] | null | undefined, now: Date): number {
  return (rows ?? []).filter((r) => {
    if (r?.status !== "pending") return false;
    const s = Date.parse(r.start_at ?? "");
    return Number.isFinite(s) && s >= now.getTime();
  }).length;
}

// ─── what the write can refuse, in the owner's words ────────────────────────

/** PostgreSQL's exclusion_violation. 0096's EXCLUDE constraint raises exactly this. */
export const EXCLUSION_VIOLATION = "23P01";

export const APPROVE_TAKEN_IN_DB = "כבר אושרה בקשה אחרת לאותו חדר ולאותה שעה.";
export const APPROVE_TAKEN_IN_CALENDAR = "המשבצת כבר תפוסה ביומן. אפשר לדחות את הבקשה.";

/**
 * A database error -> the sentence the owner reads.
 *
 * ⚠️ 23P01 IS NOT A BUG, IT IS THE GUARANTEE WORKING. 0096 chose to put
 * "no two approved requests overlap in one room" in the database precisely
 * because two approvals in two tabs would both read "free" and both write. When
 * this code fires, the constraint has just prevented a double-booked studio —
 * so it gets a sentence that says what happened, not a stack trace.
 *
 * Everything else returns null and the caller uses its own generic message: a
 * raw Postgres string in front of the owner is noise they cannot act on.
 */
export function approveErrorMessage(code: string | null | undefined): string | null {
  return code === EXCLUSION_VIOLATION ? APPROVE_TAKEN_IN_DB : null;
}
