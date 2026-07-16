import type { ModuleDef } from "@/modules/types";
import { getAlertCounts } from "./alerts";

export const radarModule: ModuleDef = {
  key: "radar",
  title: "רדאר",
  icon: "radar",
  href: "/radar",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const counts = await getAlertCounts(supabase);
    return {
      label: "התראות קריטיות",
      value: String(counts.criticalTotal),
      tone: counts.criticalTotal > 0 ? "peak" : "signal",
    };
  },
};
