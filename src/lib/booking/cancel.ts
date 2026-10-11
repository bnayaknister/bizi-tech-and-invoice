import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { deleteSystemCalendarEvent } from "@/lib/calendar/write";
import { israelDateOf } from "@/lib/calendar/availability";
import { israelHHMM } from "./publicView";
import { durationTag } from "./duration";
import { DELETE_DETAILS, deletePlan, deleteStatusFor, type CalendarDeleteOutcome } from "./manage";
import { recordDeleteOutcome } from "./moveStore";
import { notifyBookingChange, type BookingFacts } from "@/lib/whatsapp/notify";

// ═══════════════════════════════════════════════════════════════════════════
// Cancelling an approved recording — THE one implementation (E9-5).
// ═══════════════════════════════════════════════════════════════════════════
//
// Three callers, one behaviour (owner decision 11.10, 2: "ביטול במקום אחד"):
//   · POST /api/bookings/[id]/cancel — the owner's "בטל הקלטה"
//   · the bot, for a client cancelling more than 24 hours ahead
//   · a MOVE, for the recording the new slot replaced (event only — the row
//     was already cancelled by 0105's atomic swap)
//
// ═══ 🔴 THE ORDER: THE DATABASE FIRST, THEN THE CALENDAR ═══
// The flip to `cancelled` is what frees the slot (0096's EXCLUDE and
// `toApprovedRequests` both read `status = 'approved'`), and it stands whatever
// happens to the event afterwards. A failed delete does NOT undo the
// cancellation — it is recorded ('failed'), shown on /bookings with a retry,
// and the owner is told. That is the owner's rule, and it is also the only
// safe order: deleting first and then failing to cancel would leave an
// approved booking with no event, which the sync would never notice.

export type CalendarDeleteResult = { outcome: CalendarDeleteOutcome; error: string | null };

/**
 * Remove ONE booking's event, if the system created it — through the single
 * guarded delete in lib/calendar/write.ts — and record what happened.
 * Never throws.
 */
export async function removeBookingCalendarEvent(
  admin: SupabaseClient<Database>,
  row: { id: string; calendar_event_id: string | null; calendar_write_status: string | null },
  actorId: string | null
): Promise<CalendarDeleteResult> {
  let result: CalendarDeleteResult;
  const plan = deletePlan(row.calendar_write_status);

  if (plan !== "attempt") {
    result = { outcome: plan, error: null };
  } else {
    try {
      const del = await deleteSystemCalendarEvent({
        bookingId: row.id,
        calendarEventId: row.calendar_event_id,
        calendarWriteStatus: row.calendar_write_status,
      });
      if (del.ok) {
        result = { outcome: del.dryRun ? "dry-run" : del.alreadyGone ? "already-gone" : "deleted", error: null };
      } else if (del.refused) {
        // 'created' but the id is not the one this code derives: somebody
        // else's event as far as the guard is concerned — a human deletes it
        console.error("booking/cancel: המחיקה סורבה ע״י השומר", row.id, del.reason);
        result = { outcome: "not-ours", error: null };
      } else {
        result = { outcome: "failed", error: del.error };
      }
    } catch (e) {
      result = { outcome: "failed", error: e instanceof Error ? e.message : "שגיאה לא ידועה" };
    }
  }

  const status = deleteStatusFor(result.outcome);
  if (status) await recordDeleteOutcome(admin, row.id, status, result.error);

  if (plan === "attempt") {
    await admin.from("events").insert({
      entity_type: "booking_request",
      entity_id: row.id,
      event_type: result.outcome === "failed" ? "booking_calendar_event_delete_failed" : "booking_calendar_event_deleted",
      actor_id: actorId,
      payload: { event_id: row.calendar_event_id, outcome: result.outcome, error: result.error },
    });
  }
  return result;
}

export type CancelledView = {
  id: string;
  showId: string;
  showName: string;
  studio: string;
  dateIsrael: string;
  startIsrael: string;
  endIsrael: string;
  startIso: string;
  facts: BookingFacts;
};

export type CancelResult =
  | { ok: true; request: CancelledView; calendar: CalendarDeleteResult }
  | { ok: false; code: "not-found" | "not-approved" | "failed" };

export function factsOf(row: {
  start_at: string;
  end_at: string;
  studio: string;
  guest: string | null;
  showName: string;
}): BookingFacts {
  const start = new Date(row.start_at);
  return {
    showName: row.showName,
    dateIsrael: israelDateOf(start),
    startIsrael: israelHHMM(start),
    endIsrael: israelHHMM(new Date(row.end_at)),
    studio: row.studio,
    durationTag: durationTag(row.start_at, row.end_at),
    guest: row.guest,
  };
}

/**
 * Cancel an APPROVED recording: flip, audit, delete the event (rule 1), and
 * notify on a failed delete.
 *
 * @param source "owner" notifies the owner on a failed delete (rule 2); "bot"
 *   does not — its own change notice already says the delete failed, and a
 *   second message about the same thing is noise.
 */
export async function cancelApprovedBooking(
  admin: SupabaseClient<Database>,
  input: { id: string; actorId: string | null; now: Date; source: "owner" | "bot" }
): Promise<CancelResult> {
  const { data: row, error: readErr } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,status,calendar_event_id,calendar_write_status,shows(name)")
    .eq("id", input.id)
    .maybeSingle();
  if (readErr || !row) return { ok: false, code: "not-found" };
  if (row.status !== "approved") return { ok: false, code: "not-approved" };

  const { error: updErr } = await admin
    .from("booking_requests")
    .update({ status: "cancelled", decided_at: input.now.toISOString(), decided_by: input.actorId })
    .eq("id", row.id)
    // re-asserted: another tab, or the bot, may have decided it since the read
    .eq("status", "approved");
  if (updErr) {
    console.error("booking/cancel: העדכון נכשל", updErr);
    return { ok: false, code: "failed" };
  }

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_request_cancelled",
    actor_id: input.actorId,
    payload: {
      request_id: row.id,
      studio: row.studio,
      start_at: row.start_at,
      source: input.source,
      calendar_event_existed: row.calendar_write_status === "created",
    },
  });

  const calendar = await removeBookingCalendarEvent(admin, row, input.actorId);

  const showName = row.shows?.name ?? "";
  const facts = factsOf({ ...row, showName });
  if (calendar.outcome === "failed" && input.source === "owner") {
    await notifyBookingChange(admin, {
      change: "calendar-delete-failed",
      bookingId: row.id,
      facts,
      details: calendar.error ?? DELETE_DETAILS.failed,
    });
  }

  return {
    ok: true,
    request: {
      id: row.id,
      showId: row.show_id,
      showName,
      studio: row.studio,
      dateIsrael: facts.dateIsrael,
      startIsrael: facts.startIsrael,
      endIsrael: facts.endIsrael,
      startIso: row.start_at,
      facts,
    },
    calendar,
  };
}
