import type { ModuleDef } from "@/modules/types";
import { isStrictOwner } from "@/lib/roles";

export const usersModule: ModuleDef = {
  key: "users",
  title: "משתמשים",
  icon: "users",
  href: "/users",
  hasAccess: (profile) => profile.approved && profile.can_manage_users && isStrictOwner(profile),
  getMetric: async (supabase) => {
    const { count } = await supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("approved", false);
    const n = count ?? 0;
    return {
      label: "ממתינים לאישור",
      value: String(n),
      tone: n > 0 ? "warn" : "default",
    };
  },
};
