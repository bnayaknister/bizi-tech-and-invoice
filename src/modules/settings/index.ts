import type { ModuleDef } from "@/modules/types";

// Owner-only — this is where calendar_sync_enabled lives, the one setting
// (screens-spec §11, owner decision 2026-07-17) that decides whether the
// cron/manual sync may touch the real calendar at all.
export const settingsModule: ModuleDef = {
  key: "settings",
  title: "הגדרות",
  icon: "settings",
  href: "/settings",
  hasAccess: (profile) => profile.approved && profile.role === "owner",
  getMetric: async (supabase) => {
    const { data } = await supabase
      .from("app_settings")
      .select("calendar_sync_enabled")
      .eq("id", true)
      .maybeSingle();
    const on = data?.calendar_sync_enabled === true;
    return {
      label: "סנכרון יומן",
      value: on ? "פעיל" : "כבוי",
      tone: on ? "default" : "warn",
    };
  },
};
