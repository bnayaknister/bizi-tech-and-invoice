import type { ModuleDef } from "@/modules/types";

const money = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

export const contractsModule: ModuleDef = {
  key: "contracts",
  title: "חוזים",
  icon: "📄",
  href: "/contracts",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const { data } = await supabase.from("contract_milestones").select("amount").eq("status", "pending");
    const total = (data ?? []).reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return {
      label: "התחייבות פתוחה",
      value: money(total),
      tone: "default",
    };
  },
};
