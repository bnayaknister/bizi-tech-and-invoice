import { createClient } from "@/lib/supabase/server";

export type Profile = {
  id: string;
  name: string | null;
  email: string | null;
  role: "owner" | "tech" | "bookkeeper" | null;
  approved: boolean;
  can_view_money: boolean;
  can_edit_money: boolean;
  can_view_stages: boolean;
  can_edit_stages: boolean;
  can_manage_users: boolean;
  can_import: boolean;
};

export async function getSessionAndProfile() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { user: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import"
    )
    .eq("id", user.id)
    .single();

  return { user, profile: profile as Profile | null };
}
