import type { ModuleDef } from "@/modules/types";

const money = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

export const financeModule: ModuleDef = {
  key: "finance",
  title: "כספים",
  icon: "💰",
  href: "/finance",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const { data } = await supabase.from("jobs").select("amount").eq("paid", "לא");
    const total = (data ?? []).reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return {
      label: "חוב לגבייה",
      value: money(total),
      tone: total > 0 ? "warn" : "signal",
    };
  },
};
