import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { showDeleteBlockedByBookings, SHOW_HAS_BOOKINGS } from "@/lib/booking/showLifecycle";

// Direct show deletion — an ADMIN (user-manager) action. A technician has
// can_edit_stages but not can_manage_users, so a DELETE straight to the API
// is refused with 403 (owner rule: "a tech sending DELETE directly -> 403").
// Their path is the approval queue, which runs the delete with the service
// role on approve. RLS (shows_delete -> can_manage_users, 0021) is the real
// wall; this check just turns it into a clean 403 up front.
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("can_manage_users").eq("id", user.id).single();
  if (!profile?.can_manage_users) {
    return NextResponse.json({ error: "מחיקת תוכנית דורשת אישור מנהל — הגש בקשה במקום" }, { status: 403 });
  }

  const { count } = await supabase
    .from("productions")
    .select("id", { count: "exact", head: true })
    .eq("show_id", params.id);
  if ((count ?? 0) > 0) {
    return NextResponse.json({ error: `לתוכנית יש ${count} הפקות — אפשר לארכב או למזג, לא למחוק` }, { status: 400 });
  }

  // ⚠️ THE SECOND GUARD, ADDED 24.9, AND IT IS NOT COSMETIC. 0096 made
  // booking_requests.link_id ON DELETE RESTRICT while both show_id keys are
  // ON DELETE CASCADE, and PostgreSQL documents RESTRICT as non-deferrable.
  // Deleting a show with a link that has requests therefore either aborts with
  // a raw foreign_key_violation the owner cannot act on, or — depending which
  // cascade fires first — destroys the decision history RESTRICT exists to
  // protect. Counted with the SERVICE ROLE so an RLS miss cannot read as zero.
  const bookingCount = await createTypedAdminClient()
    .from("booking_requests")
    .select("id", { count: "exact", head: true })
    .eq("show_id", params.id);
  if (showDeleteBlockedByBookings(bookingCount.count)) {
    return NextResponse.json({ error: SHOW_HAS_BOOKINGS }, { status: 400 });
  }

  const { error } = await supabase.from("shows").delete().eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "show_deleted",
    actor_id: user.id,
    payload: { direct: true },
  });
  return NextResponse.json({ ok: true });
}
