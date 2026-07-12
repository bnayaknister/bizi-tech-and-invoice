import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/profile";

export type ModuleMetric = {
  label: string;
  value: string;
  tone: "default" | "warn" | "peak" | "signal";
};

export type ModuleDef = {
  key: string;
  title: string;
  icon: string;
  href: string;
  hasAccess: (profile: Profile) => boolean;
  getMetric: (supabase: SupabaseClient) => Promise<ModuleMetric>;
};
