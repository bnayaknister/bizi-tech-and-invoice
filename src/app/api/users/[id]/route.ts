import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Update a user's permission flags / role / approval. User-manager only.
// The DB is the real wall on two counts: profiles_manager_update RLS
// (can_manage_users) AND trg_prevent_self_permission_change, which blocks
// anyone — manager or not — from changing their OWN permissions. So a
// technician hitting this is refused up front (not a manager), and a
// manager pointing it at their own row is refused by the trigger.
const ALLOWED = new Set([
  "approved",
  "role",
  "can_view_money",
  "can_edit_money",
  "can_view_stages",
  "can_edit_stages",
  "can_manage_users",
  "can_import",
]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("can_manage_users").eq("id", user.id).single();
  if (!me?.can_manage_users) return NextResponse.json({ error: "רק מנהל משתמשים יכול לשנות הרשאות" }, { status: 403 });

  if (user.id === params.id) {
    // fast, explicit block — nobody edits their own permissions
    return NextResponse.json({ error: "אי אפשר לשנות את ההרשאות של עצמך" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { patch?: Record<string, unknown> };
  const patch = body.patch ?? {};
  const keys = Object.keys(patch);
  if (keys.length === 0) return NextResponse.json({ error: "אין שינויים" }, { status: 400 });
  const bad = keys.filter((k) => !ALLOWED.has(k));
  if (bad.length) return NextResponse.json({ error: `שדה לא מותר: ${bad.join(", ")}` }, { status: 400 });

  const { data: updated, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", params.id)
    .select("id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import")
    .maybeSingle();
  if (error) {
    const denied = /הרשאות של עצמך|row-level security|permission/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: denied ? 403 : 400 });
  }
  if (!updated) return NextResponse.json({ error: "המשתמש לא נמצא או שאין הרשאה" }, { status: 404 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "profile",
    entity_id: params.id,
    event_type: "permissions_updated",
    actor_id: user.id,
    payload: { patch },
  });

  return NextResponse.json({ ok: true, user: updated });
}
