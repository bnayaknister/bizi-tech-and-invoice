import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isStrictOwner } from "@/lib/roles";

// Update a user's permission flags / role / approval. Owner only (U1-4): an
// admin keeps can_manage_users for the other admin actions, but not this.
// The DB is the real wall: profiles_manager_update RLS (can_manage_users AND
// is_owner_strict, 0119), trg_guard_profile_permissions (no permission change
// by a non-owner session, 0119) and trg_prevent_self_permission_change (no
// one changes their OWN permissions).
//
// Owner rows are protected HERE, by owner decision (19.10), not in the DB:
// no one demotes an owner (role) or disables one (approved=false) from the
// app. There is no delete route; deleting a user is not offered in the app.
const ALLOWED = new Set([
  "name",
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

  const { data: me } = await supabase.from("profiles").select("can_manage_users,role").eq("id", user.id).single();
  if (!me?.can_manage_users || !isStrictOwner(me)) return NextResponse.json({ error: "רק בעלים יכולים לשנות הרשאות" }, { status: 403 });

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
  if ("name" in patch) {
    // U1-7 fix: a name for a user who has none — trimmed, 1..80 characters
    const name = typeof patch.name === "string" ? patch.name.trim() : "";
    if (!name || name.length > 80) return NextResponse.json({ error: "שם לא תקין" }, { status: 400 });
    patch.name = name;
  }

  const { data: target } = await supabase.from("profiles").select("role").eq("id", params.id).maybeSingle();
  if (isStrictOwner(target)) {
    const demotes = "role" in patch && patch.role !== "owner";
    const disables = "approved" in patch && patch.approved !== true;
    if (demotes || disables) {
      return NextResponse.json({ error: "אי אפשר להוריד בדרגה או להשבית בעלים" }, { status: 403 });
    }
  }

  const { data: updated, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", params.id)
    .select("id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import")
    .maybeSingle();
  if (error) {
    const denied = /הרשאות של עצמך|רק בעלים|row-level security|permission/i.test(error.message);
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
