import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { removeBookingCalendarEvent } from "@/lib/booking/cancel";
import { hasOwnerAccess } from "@/lib/roles";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/retry-calendar-delete — "נסה שוב" after a failed
// calendar delete (E9-5, owner decision 11.10, rule 2). Owner-only.
// ═══════════════════════════════════════════════════════════════════════════
//
// Only a CANCELLED row: deleting the event of a live booking is exactly the
// thing this whole feature must never do. The delete itself is the one guarded
// function (lib/calendar/write.ts) via removeBookingCalendarEvent — the same
// call the cancellation made — so a retry can never delete differently than
// the first attempt would have.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

  const admin = createTypedAdminClient();
  const { data: row, error } = await admin
    .from("booking_requests")
    .select("id,status,calendar_event_id,calendar_write_status")
    .eq("id", params.id)
    .maybeSingle();
  if (error || !row) return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404, headers: NO_STORE });
  if (row.status !== "cancelled") {
    return NextResponse.json(
      { error: "אפשר למחוק מהיומן רק הקלטה שבוטלה. רעננו את המסך." },
      { status: 409, headers: NO_STORE }
    );
  }

  const result = await removeBookingCalendarEvent(admin, row, user.id);
  return NextResponse.json(
    { ok: result.outcome !== "failed", calendarDelete: result.outcome, calendarDeleteError: result.error },
    { status: result.outcome === "failed" ? 502 : 200, headers: NO_STORE }
  );
}
