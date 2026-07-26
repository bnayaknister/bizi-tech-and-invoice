import type { ModuleDef } from "@/modules/types";

// The documents registry (the 5-tab screen) surfaced on the hub — Shiri's
// central tool, reachable directly, not only via the finance screen (owner
// spec 2026-07-26, step 1). Distinct from the "מסמכים לאישור" module, which
// is the approval QUEUE; this opens the full registry.
//
// The number is what needs handling, combining the two attention buckets the
// owner named: documents with no client mapping ("לא משויך") and jobs still
// missing their tax invoice ("חסרה חשבונית מס" — the red finance state, the
// tax-exposure one). Red exposure turns the card critical.
export const docRegistryModule: ModuleDef = {
  key: "docregistry",
  title: "מסמכים",
  icon: "contracts",
  href: "/documents/registry",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const [{ count: unassigned }, { data: paidJobs }] = await Promise.all([
      supabase.from("documents").select("id", { count: "exact", head: true }).is("client_id", null),
      supabase.from("jobs").select("invoice_tax").eq("paid", "כן").eq("dismissed", false),
    ]);
    const missingTax = (paidJobs ?? []).filter(
      (j) => !(j.invoice_tax && String(j.invoice_tax).trim())
    ).length;
    const un = unassigned ?? 0;
    const total = missingTax + un;

    return {
      label: `${missingTax} חסרות מס · ${un} לא משויכים`,
      value: String(total),
      tone: missingTax > 0 ? "peak" : un > 0 ? "warn" : "default",
    };
  },
};
