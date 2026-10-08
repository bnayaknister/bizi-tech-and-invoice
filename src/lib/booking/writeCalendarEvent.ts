import type { SupabaseClient } from "@supabase/supabase-js";
import { createCalendarEvent } from "@/lib/calendar/write";

// ═══════════════════════════════════════════════════════════════════════════
// Everything AFTER the deterministic eventId is already saved: the calendar
// write itself, the `booking_requests` columns it settles, and the audit
// event.
//
// Shared by TWO callers (feat/calendar-write, 7.10, E8):
//   · POST /api/bookings/[id]/approve        — the first attempt
//   · POST /api/bookings/[id]/retry-calendar — every attempt after a failure
//
// "אותה לוגיקה" (owner, step 4) is the whole point of this file existing: a
// retry that drifted from the approval's own write path is a retry that could
// succeed differently than a first attempt would have — a differently-shaped
// event, a forgotten column. One function, two callers.
//
// ═══ 🔴 AN APPROVAL DOES NOT CREATE A PRODUCTION (owner correction, 7.10) ═══
// The feat/calendar-write prompt stated "הפקה נוצרת מיד באישור (מתווה א׳)"
// as an owner decision. It was not — it was an unapproved recommendation,
// and this file used to act on it (createProductionFromEvent + a work-order
// enqueue + a `production_id` write, all removed here).
//
// THE ACTUAL RULE, unchanged since 2026-07-17: productions enter the system
// through ONE door only — the morning sync, over events of THAT SAME DAY
// (calendar/sync/route.ts:443 gates on 06:00 Israel; :465 and :504/:509
// filter the feed to `israelDayWindow`, today's Israel calendar day,
// half-open; :222 scopes the existing-production read to
// `record_date = today`). A booking approved three weeks out would, under
// "מתווה א׳", mint a production three weeks early — and the owner's point
// is measured, not hypothetical: every future approval would land on the
// productions board at once, weeks before anyone records anything.
//
// So this function writes the EVENT and stops. On the recording morning the
// sync finds that event in the feed like any other, matches no existing
// production under its UID (nothing created one), and creates it in
// `toCreate` — once, exactly as it always has. That path is untouched here.
//
// ⛔ Do not reintroduce a production write to this file. `production_id`
//    still exists on `booking_requests` (0099, applied 7.10 — no migration
//    reverses it) and is deliberately never written; see the PR report, and
//    scripts/test_calendar_write.ts, which reads this file's own text and
//    fails if `createProductionFromEvent` or `enqueueDocument` ever appears
//    in it again.
//
// `admin` is a plain, UNTYPED `SupabaseClient` so either factory can be
// passed; the columns below are all 0099's and database.types.ts knows them
// since it was regenerated (35d4ced).
// ═══════════════════════════════════════════════════════════════════════════

export type BookingCalendarWriteInput = {
  bookingId: string;
  startAtIso: string;
  endAtIso: string;
  /** becomes the event's DESCRIPTION — the request's own note, or nothing */
  note: string | null;
  /** the calendar title — built once by the caller via eventTitle(), never twice */
  title: string;
  /** from `calendarEventIdFor` — saved by the caller BEFORE this is called */
  eventId: string;
  /**
   * Who approved it — or NULL for an automatic approval (E9-2).
   *
   * `events.actor_id` is nullable (0002:306) and the null is the RECORD of the
   * decision having been automatic, not a missing value: see the note on the
   * flip in lib/booking/decide.ts. Widened from `string` here rather than
   * passing a sentinel id, because a fake profile row called "the bot" is a
   * fake person in an audit trail.
   */
  actorId: string | null;
};

export type BookingCalendarWriteResult = {
  status: "created" | "failed";
  error: string | null;
  /** Google's own link, present only on a real (non-dry-run) success */
  htmlLink: string | null;
  dryRun: boolean;
};

export async function writeBookingCalendarEvent(
  admin: SupabaseClient,
  input: BookingCalendarWriteInput
): Promise<BookingCalendarWriteResult> {
  const result = await createCalendarEvent({
    eventId: input.eventId,
    title: input.title,
    startIso: input.startAtIso,
    endIso: input.endAtIso,
    description: input.note,
  });

  // ═══ "האישור נשמר, אך היצירה ביומן נכשלה — {שגיאה}. אפשר לנסות שוב." ═══
  if (!result.ok) {
    await admin
      .from("booking_requests")
      .update({ calendar_write_status: "failed", calendar_write_error: result.error })
      .eq("id", input.bookingId);
    await admin.from("events").insert({
      entity_type: "booking_request",
      entity_id: input.bookingId,
      event_type: "booking_calendar_event_failed",
      actor_id: input.actorId,
      payload: { event_id: input.eventId, error: result.error, status: result.status },
    });
    return { status: "failed", error: result.error, htmlLink: null, dryRun: false };
  }

  // ═══ מצב בדיקה — האירוע לא נוצר ביומן. ═══
  // No real iCalUID exists to store, so none is stored — a dry run invents
  // no data that looks real.
  if (result.dryRun) {
    await admin
      .from("booking_requests")
      .update({ calendar_write_status: "created", calendar_write_error: null })
      .eq("id", input.bookingId);
    await admin.from("events").insert({
      entity_type: "booking_request",
      entity_id: input.bookingId,
      event_type: "booking_calendar_event_created",
      actor_id: input.actorId,
      payload: { event_id: input.eventId, dry_run: true },
    });
    return { status: "created", error: null, htmlLink: null, dryRun: true };
  }

  // ═══ נוצר ביומן גוגל. ═══
  // 🔴 `calendar_event_uid` is the iCalUID, NOT the API `id`: it is the value
  // the ICS feed will carry in its own UID: line, and therefore the only one
  // that can ever be matched against `productions.calendar_uid` — by the
  // sync when it creates the production on the recording morning, and by any
  // future link-back from the request to that production (🔵, see the report).
  await admin
    .from("booking_requests")
    .update({
      calendar_event_uid: result.iCalUID,
      calendar_write_status: "created",
      calendar_write_error: null,
    })
    .eq("id", input.bookingId);
  await admin.from("events").insert({
    entity_type: "booking_request",
    entity_id: input.bookingId,
    event_type: "booking_calendar_event_created",
    actor_id: input.actorId,
    payload: { event_id: input.eventId, i_cal_uid: result.iCalUID, dry_run: false },
  });

  return { status: "created", error: null, htmlLink: result.htmlLink, dryRun: false };
}
