import type { ModuleDef } from "@/modules/types";

export const productionsModule: ModuleDef = {
  key: "productions",
  title: "הפקות",
  icon: "🎬",
  href: "/productions",
  hasAccess: (profile) => profile.approved && profile.can_view_stages,
  getMetric: async (supabase) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { count } = await supabase
      .from("stages")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", user?.id ?? "")
      .eq("status", "pending");
    const n = count ?? 0;
    return {
      label: "שלבים מחכים לי",
      value: String(n),
      tone: n > 0 ? "warn" : "default",
    };
  },
};
