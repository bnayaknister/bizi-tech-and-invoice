import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import UsersClient, { type UserRow } from "./UsersClient";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_manage_users) redirect("/");

  const admin = createAdminClient();
  const { data: rows } = await admin
    .from("profiles")
    .select("id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import,created_at")
    .order("created_at", { ascending: true });

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
