import type { ModuleDef } from "@/modules/types";

export const productionsModule: ModuleDef = {
  key: "productions",
  title: "הפקות",
  icon: "productions",
  href: "/productions",
  hasAccess: (profile) => profile.approved && profile.can_view_stages,
  getMetric: async (supabase, profile) => {
    // profile.id comes from the hub's single session lookup — no extra
    // auth.getUser() round-trip per hub load (owner perf note 2026-07-22)
    const { count } = await supabase
      .from("stages")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", profile.id)
      .eq("status", "pending");
    const n = count ?? 0;
    return {
      label: "שלבים מחכים לי",
      value: String(n),
      tone: n > 0 ? "warn" : "default",
    };
  },
};
