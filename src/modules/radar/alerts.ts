import type { SupabaseClient } from "@supabase/supabase-js";

export type AlertCounts = {
  paidNoTax: number;
  amountMissing: number;
  invoiceDateUnknown: number;
  criticalTotal: number; // 🔴 only
};

// Shared by the hub card (step 3) and the full radar screen (step 4) so
// the numbers never drift apart between the two.
export async function getAlertCounts(supabase: SupabaseClient): Promise<AlertCounts> {
  const [paidNoTax, amountMissing, invoiceDateUnknown] = await Promise.all([
    supabase.from("jobs").select("id", { count: "exact", head: true }).eq("paid", "כן").is("invoice_tax", null),
    supabase.from("jobs").select("id", { count: "exact", head: true }).is("amount", null),
    supabase.from("invoices").select("id", { count: "exact", head: true }).eq("date_is_estimated", true),
  ]);

  const paidNoTaxCount = paidNoTax.count ?? 0;
  const amountMissingCount = amountMissing.count ?? 0;
  const invoiceDateUnknownCount = invoiceDateUnknown.count ?? 0;

  return {
    paidNoTax: paidNoTaxCount,
    amountMissing: amountMissingCount,
    invoiceDateUnknown: invoiceDateUnknownCount,
    // 🔴 critical only: money that's already gone missing (no tax invoice)
    // or that's silently NULL (a job with no amount is a charge that will
    // never be collected until someone notices)
    criticalTotal: paidNoTaxCount + amountMissingCount,
  };
}
