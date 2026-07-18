import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
