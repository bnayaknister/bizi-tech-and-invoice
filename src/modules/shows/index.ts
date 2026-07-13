import type { ModuleDef } from "@/modules/types";

export const showsModule: ModuleDef = {
  key: "shows",
  title: "תוכניות",
  icon: "📺",
  href: "/shows",
  hasAccess: (profile) => profile.approved && (profile.can_view_stages || profile.can_view_money),
  getMetric: async (supabase) => {
    const { count } = await supabase
      .from("shows")
      .select("id", { count: "exact", head: true })
      .eq("active", true);
    const n = count ?? 0;
    return {
      label: "תוכניות פעילות",
      value: String(n),
      tone: "default",
    };
  },
};
