import type { ModuleDef } from "@/modules/types";

const money = (n: number) => `₪${Math.round(n).toLocaleString("he-IL")}`;

export const contractsModule: ModuleDef = {
  key: "contracts",
  title: "חוזים",
  icon: "contracts",
  href: "/contracts",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    // Closed contracts are out of the number, same rule as the radar's open
    // commitment (alerts.ts, owner spec 2026-08-22) — the hub tile and the
    // radar must never quote two different open commitments.
    const [{ data }, { data: contracts }] = await Promise.all([
      supabase.from("contract_milestones").select("amount,contract_id").eq("status", "pending"),
      supabase.from("contracts").select("id").eq("status", "active"),
    ]);
    const active = new Set((contracts ?? []).map((c) => c.id));
    const total = (data ?? [])
      .filter((r) => active.has(r.contract_id))
      .reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return {
      label: "התחייבות פתוחה",
      value: money(total),
      tone: "default",
    };
  },
};
