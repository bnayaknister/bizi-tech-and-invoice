import type { ModuleDef } from "@/modules/types";
import { israelMonthKey, todayInIsrael } from "@/lib/dates";

// Reuses the productions waveform icon deliberately — this screen IS the
// productions list, read down the money axis instead of the pipeline axis. A
// new glyph would assert a new kind of object where there is none (DESIGN.md §4
// admits no emoji, so a new icon is a real drawing decision, not a one-liner).
// The card hue is what separates them: cyan here, violet on /productions.
export const projectsModule: ModuleDef = {
  key: "projects",
  title: "מעקב פרויקטים",
  icon: "productions",
  href: "/projects",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const month = todayInIsrael().slice(0, 7);
    // record_date only, with no created_at fallback — the same rule /projects
    // filters by, so the card and the screen can never disagree about how many
    // episodes the month has (see the range note in projects/page.tsx)
    const { data } = await supabase
      .from("productions")
      .select("record_date,created_at,merged_into")
      .gte("record_date", `${month}-01`);
    const count = (data ?? []).filter(
      (r) => !r.merged_into && israelMonthKey(r.record_date as string | null, r.created_at as string) === month
    ).length;
    return {
      label: "הפקות החודש",
      value: String(count),
      tone: count > 0 ? "signal" : "default",
    };
  },
};
