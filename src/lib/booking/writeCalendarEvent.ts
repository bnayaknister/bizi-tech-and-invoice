import type { SupabaseClient } from "@supabase/supabase-js";
import { createCalendarEvent } from "@/lib/calendar/write";
import { createProductionFromEvent, type ShowForProductionCreate } from "@/lib/calendar/createProductionFromEvent";
import { israelTimeHHMM } from "@/lib/dates";

// ═══════════════════════════════════════════════════════════════════════════
// Everything AFTER the deterministic eventId is already saved: the calendar
// write itself, the `booking_requests` columns it settles, the audit events,
// and — on a real, non-dry-run success — the production (created the SAME
// way calendar/sync/route.ts creates one, via createProductionFromEvent).
//
// Shared by TWO callers (feat/calendar-write, 7.10, E8):
//   · POST /api/bookings/[id]/approve        — the first attempt
//   · POST /api/bookings/[id]/retry-calendar — every attempt after a failure
//
// "אותה לוגיקה" (owner, step 4) is the whole point of this file existing: a
// retry that drifted from the approval's own write path is a retry that could
// succeed differently than a first attempt would have — a second production,
// a differently-shaped event, a forgotten column. One function, two callers.
//
// `admin` is a plain, UNTYPED `SupabaseClient` — see createProductionFromEvent's
// own note on why this whole family of calendar-write code stays off the
// typed client (database.types.ts does not know these columns until 0099 is
// applied and regenerated; calendar/sync/route.ts already made the same
// choice for the same reason).
// ═══════════════════════════════════════════════════════════════════════════

export type BookingCalendarWriteInput = {
  bookingId: string;
  showId: string;
  show: ShowForProductionCreate;
  /** the booking's OWN studio column — structurally known, nothing to parse */
  studio: string;
  startAtIso: string;
  endAtIso: string;
  guest: string | null;
  note: string | null;
  /** the calendar title — built once by the caller via eventTitle(), never twice */
  title: string;
  /** `israelDateOf(start)` — already resolved, this function does no date math */
  dateIsrael: string;
  /** from `calendarEventIdFor` — saved by the caller BEFORE this is called */
  eventId: string;
  actorId: string;
};

export type BookingCalendarWriteResult = {
  status: "created" | "failed";
  error: string | null;
  /** Google's own link, present only on a real (non-dry-run) success */
  htmlLink: string | null;
  dryRun: boolean;
  /** present only when a real production was created this call */
  productionId: string | null;
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
    return { status: "failed", error: result.error, htmlLink: null, dryRun: false, productionId: null };
  }

  // ═══ מצב בדיקה — האירוע לא נוצר ביומן. ═══
  // No real iCalUID exists to store, and — deliberately — NO production is
  // created: createProductionFromEvent needs a calendar_uid the NEXT SYNC
  // could genuinely recognise (G2), and a dry-run value is not that. The
  // dry-run path proves the rest of the flow without inventing data that
  // looks real.
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
    return { status: "created", error: null, htmlLink: null, dryRun: true, productionId: null };
  }

  // ═══ נוצר ביומן גוגל. ═══
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

  // the production, created the SAME way calendar/sync/route.ts creates one
  let contractId: string | null = null;
  if (input.show.billing_mode === "contract") {
    const { data: contractRow } = await admin
      .from("contracts")
      .select("id")
      .eq("show_id", input.showId)
      .eq("status", "active")
      .maybeSingle();
    contractId = (contractRow?.id as string | undefined) ?? null;
  }

  const created = await createProductionFromEvent(admin, {
    show: input.show,
    contractId,
    recordDate: input.dateIsrael,
    recordTime: israelTimeHHMM(new Date(input.startAtIso)),
    studio: input.studio,
    guest: input.guest,
    calendarUid: result.iCalUID,
    eventTitle: input.title,
    source: "booking_approval",
    now: new Date(),
  });
  await admin.from("booking_requests").update({ production_id: created.productionId }).eq("id", input.bookingId);

  return {
    status: "created",
    error: null,
    htmlLink: result.htmlLink,
    dryRun: false,
    productionId: created.productionId,
  };
}
