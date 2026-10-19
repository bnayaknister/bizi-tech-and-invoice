import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { calendarDayUrl } from "@/lib/booking/queue";
import { cancelApprovedBooking } from "@/lib/booking/cancel";
import { hasOwnerAccess } from "@/lib/roles";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/cancel — the owner cancels an APPROVED recording.
// E9-3; E9-5 (owner decision 11.10) adds the automatic calendar delete.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, same gate as approve/decline.
//
// Everything it does is lib/booking/cancel.ts — the SAME function the bot
// calls for a client's own cancellation ("ביטול במקום אחד", rule 2):
//   · `status = 'cancelled'` — frees the slot (0096's EXCLUDE and
//     `toApprovedRequests` both read 'approved'), and it stands regardless of
//     what happens to the event;
//   · the event is deleted ONLY if the system created it (rule 1 — the guard
//     lives inside the one delete function in lib/calendar/write.ts);
//   · an event the system did not create (pre-E8) -> the existing manual
//     reminder with the day link;
//   · a failed delete -> the cancellation stays, the screen shows "המחיקה
//     מהיומן נכשלה" with a retry, and the owner gets a notification.
//
// ⚠️ ONLY AN APPROVED ROW. A pending one is `decline`; a declined or already
// cancelled one has no slot to release.

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
  if (!hasOwnerAccess(profile)) {
    return NextResponse.json({ error: "המסך הזה פתוח לבעלים בלבד" }, { status: 403 });
  }

  const result = await cancelApprovedBooking(createTypedAdminClient(), {
    id: params.id,
    actorId: user.id,
    now: new Date(),
    source: "owner",
  });

  if (!result.ok) {
    if (result.code === "not-found") {
      return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404, headers: NO_STORE });
    }
    if (result.code === "not-approved") {
      return NextResponse.json(
        { error: "אפשר לבטל רק הקלטה מאושרת. רעננו את המסך." },
        { status: 409, headers: NO_STORE }
      );
    }
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }

  const r = result.request;
  return NextResponse.json(
    {
      ok: true,
      request: {
        id: r.id,
        showName: r.showName,
        studio: r.studio,
        dateIsrael: r.dateIsrael,
        startIsrael: r.startIsrael,
        endIsrael: r.endIsrael,
        // 🔴 what happened to the event drives the card: deleted / a manual
        // reminder / nothing to delete / failed with a retry
        calendarDelete: result.calendar.outcome,
        calendarDeleteError: result.calendar.error,
        calendarDayUrl: calendarDayUrl(r.dateIsrael),
      },
    },
    { headers: NO_STORE }
  );
}
