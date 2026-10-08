import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { israelHHMM } from "@/lib/booking/publicView";
import { israelDateOf } from "@/lib/calendar/availability";
import { calendarDayUrl } from "@/lib/booking/queue";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/cancel — the owner cancels an APPROVED recording.
// E9-3, owner decision 8.10.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, same gate as approve/decline.
//
// ═══ 🔴 WHAT IT DOES, AND THE ONE THING IT DOES NOT ═══
// It writes `status = 'cancelled'` (0102) and a stamp. 0096's EXCLUDE
// constraint covers rows `where status = 'approved'`, and
// `toApprovedRequests` filters on the same value — so the slot is free again
// the instant this row lands, with no second place to update and no DELETE.
//
// ⛔ AND IT DOES NOT TOUCH THE GOOGLE CALENDAR. `lib/calendar/write.ts` has
// never had an `events.delete` and must not grow one (write.ts:24-32, enforced
// by a test that reads that file's own text): Google's sharing model has no
// "write only your own events" role, so a `writer` on the shared calendar can
// delete the ADVERTISING COMPANY's recordings too. The capability simply does
// not exist in this codebase, which is the only wall that cannot be routed
// around by a bug.
//
// So the response carries a reminder and a link to the right day in the
// calendar, and a human deletes the event. That is the owner's own decision
// ("הביטול נעשה ידנית ע"י הבעלים או הצוות"), not a limitation we are working
// around.
//
// ⚠️ WHY A DAY LINK AND NOT A LINK TO THE EVENT ITSELF: `writeBookingCalendar‐
// Event` stores `calendar_event_uid` but never `htmlLink` (writeCalendarEvent
// .ts:124-131), so for any row older than this request we do not have Google's
// own URL — and deriving one from the event id relies on an undocumented
// base64 format that would break silently. A day view always opens, always on
// the right date, and the event is the one with this show's name on it.
//
// ⚠️ ONLY AN APPROVED ROW. A pending one is `decline`; a declined or already
// cancelled one has no slot to release. Re-cancelling would also move
// `decided_at` and lose when the cancellation actually happened.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const GENERIC = "לא הצלחתי לבטל את ההקלטה. נסו שוב.";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role,approved").eq("id", user.id).single();
  if (!profile?.approved) return NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 });
  if (profile.role !== "owner") {
    return NextResponse.json({ error: "המסך הזה פתוח לבעלים בלבד" }, { status: 403 });
  }

  // ⚠️ Untyped: `cancelled` is 0102's value and the column's type is plain
  // text either way, but this route also reads nothing the generated types
  // need. Same choice as the webhook route while 0102 is unapplied.
  const admin = createAdminClient();

  const { data: row, error: readErr } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,status,calendar_write_status,shows(name)")
    .eq("id", params.id)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404, headers: NO_STORE });
  }

  const r = row as unknown as {
    id: string;
    show_id: string;
    studio: string;
    start_at: string;
    end_at: string;
    status: string;
    calendar_write_status: string | null;
    shows?: { name: string } | null;
  };

  if (r.status !== "approved") {
    return NextResponse.json(
      { error: "אפשר לבטל רק הקלטה מאושרת. רעננו את המסך." },
      { status: 409, headers: NO_STORE }
    );
  }

  const { error: updErr } = await admin
    .from("booking_requests")
    .update({ status: "cancelled", decided_at: new Date().toISOString(), decided_by: user.id })
    .eq("id", r.id)
    // re-asserted in the WHERE clause, same reason as approve and decline:
    // another tab may have decided this row since the read above.
    .eq("status", "approved");
  if (updErr) {
    console.error("bookings/cancel: העדכון נכשל", updErr);
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }

  const start = new Date(r.start_at);
  const dateIsrael = israelDateOf(start);

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: r.show_id,
    event_type: "booking_request_cancelled",
    actor_id: user.id,
    payload: {
      request_id: r.id,
      studio: r.studio,
      start_at: r.start_at,
      // 🔵 whether an event was ever written is what decides if anyone has to
      // go and delete one. Recorded so the question is answerable later.
      calendar_event_existed: r.calendar_write_status === "created",
    },
  });

  return NextResponse.json(
    {
      ok: true,
      request: {
        id: r.id,
        showName: r.shows?.name ?? "",
        studio: r.studio,
        dateIsrael,
        startIsrael: israelHHMM(start),
        endIsrael: israelHHMM(new Date(r.end_at)),
        // 🔴 the reminder is driven by THIS, not by "we cancelled something":
        // a booking whose calendar write failed or never ran has no event to
        // delete, and telling the owner to go and delete one would send them
        // looking for something that was never there.
        calendarEventExisted: r.calendar_write_status === "created",
        calendarDayUrl: calendarDayUrl(dateIsrael),
      },
    },
    { headers: NO_STORE }
  );
}
