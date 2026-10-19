import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import UsersClient, { type UserRow } from "./UsersClient";
import { isStrictOwner } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  // U1-4: user management is the owner's alone — an admin keeps can_manage_users
  // for the other admin actions, but not this screen
  if (!profile.can_manage_users || !isStrictOwner(profile)) redirect("/");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("profiles")
    .select("id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import,created_at")
    .order("created_at", { ascending: true });
  // U1-5: "הוזמן, טרם נכנס" — whoever has no last_sign_in_at in auth.users.
  // The studio has a handful of users; one page of 1000 covers them all.
  const { data: authList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const signedIn = new Set((authList?.users ?? []).filter((u) => u.last_sign_in_at).map((u) => u.id));

  const users: UserRow[] = (rows ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    approved: r.approved,
    can_view_money: r.can_view_money,
    can_edit_money: r.can_edit_money,
    can_view_stages: r.can_view_stages,
    can_edit_stages: r.can_edit_stages,
    can_manage_users: r.can_manage_users,
    can_import: r.can_import,
    created_at: r.created_at,
    // a failed listUsers shows no one as "not signed in" rather than everyone
    never_signed_in: !!authList && !signedIn.has(r.id),
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <UsersClient users={users} selfId={user.id} />
      </main>
    </div>
  );
}
