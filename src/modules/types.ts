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
  // profile is passed so a metric never re-fetches the session it already has
  // (the hub resolves it once in getSessionAndProfile) — modules that don't
  // need it simply ignore the argument
  getMetric: (supabase: SupabaseClient, profile: Profile) => Promise<ModuleMetric>;
};
