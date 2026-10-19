import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStrictOwner } from "@/lib/roles";

// U1-4: the users API is the owner's alone — can_manage_users AND role=owner.
// (An admin keeps can_manage_users for the other admin actions.) The DB holds
// the same line: profiles_manager_update/delete demand is_owner_strict().
export async function requireUsersOwner(
  supabase: SupabaseClient
): Promise<{ userId: string } | { response: NextResponse }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { response: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) };
  const { data: me } = await supabase.from("profiles").select("can_manage_users,role").eq("id", user.id).single();
  if (!me?.can_manage_users || !isStrictOwner(me)) {
    return { response: NextResponse.json({ error: "רק בעלים יכולים לנהל משתמשים" }, { status: 403 }) };
  }
  return { userId: user.id };
}
