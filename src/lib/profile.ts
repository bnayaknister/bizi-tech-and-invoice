import { createClient } from "@/lib/supabase/server";
import { PERF_OFF, type PerfTimer } from "@/lib/perf/timing";

export type Profile = {
  id: string;
  name: string | null;
  email: string | null;
  role: "owner" | "admin" | "tech" | "bookkeeper" | null;
  approved: boolean;
  can_view_money: boolean;
  can_edit_money: boolean;
  can_view_stages: boolean;
  can_edit_stages: boolean;
  can_manage_users: boolean;
  can_import: boolean;
  /** 0107 (E17): Bnaya and Eli. Set only from the SQL Editor. */
  studio_admin: boolean;
};

/** `perf` (T35): optional — laps getUser and the profile read when timing is on. */
export async function getSessionAndProfile(perf: PerfTimer = PERF_OFF) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  perf.lap("getUser");

  if (!user) return { user: null, profile: null };

  const { data: profile } = await supabase
    .from("profiles")
    .select(
      "id,name,email,role,approved,can_view_money,can_edit_money,can_view_stages,can_edit_stages,can_manage_users,can_import,studio_admin"
    )
    .eq("id", user.id)
    .single();
  perf.lap("profile");

  return { user, profile: profile as Profile | null };
}
