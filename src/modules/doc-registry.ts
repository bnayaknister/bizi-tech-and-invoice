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
    // count only LIVE unassigned docs — exclude archived + cancelled. Those
    // columns ship in 0043/0045; if not applied yet, fall back to the plain
    // client_id-null count so the card never breaks.
    const unassignedCount = async () => {
      const filtered = await supabase
        .from("documents")
        .select("id", { count: "exact", head: true })
        .is("client_id", null)
        .is("archived_at", null)
        .is("cancelled_at", null);
      if (!filtered.error) return filtered.count ?? 0;
      const plain = await supabase.from("documents").select("id", { count: "exact", head: true }).is("client_id", null);
      return plain.count ?? 0;
    };
    const [unassigned, { data: paidJobs }] = await Promise.all([
      unassignedCount(),
      supabase.from("jobs").select("invoice_tax").eq("paid", "כן").eq("dismissed", false),
    ]);
    const missingTax = (paidJobs ?? []).filter(
      (j) => !(j.invoice_tax && String(j.invoice_tax).trim())
    ).length;
    const un = unassigned;
    const total = missingTax + un;

    return {
      label: `${missingTax} חסרות מס · ${un} לא משויכים`,
      value: String(total),
      tone: missingTax > 0 ? "peak" : un > 0 ? "warn" : "default",
    };
  },
};
