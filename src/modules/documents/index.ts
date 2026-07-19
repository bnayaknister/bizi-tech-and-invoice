import type { ModuleDef } from "@/modules/types";

// The document approval queue (owner spec 2026-07-19). Money users only.
//
// The metric is deliberately the count of things WAITING, and it escalates
// by age rather than by volume: a queue nobody empties is the exact leak
// this whole feature was built to prevent, so 72h+ turns the card red even
// if there is only one row in it.
export const documentsModule: ModuleDef = {
  key: "documents",
  title: "מסמכים לאישור",
  icon: "finance",
  href: "/documents",
  hasAccess: (profile) => profile.approved && profile.can_view_money,
  getMetric: async (supabase) => {
    const { data } = await supabase
      .from("pending_documents")
      .select("created_at")
      .eq("status", "pending");

    const rows = data ?? [];
    const n = rows.length;
    if (n === 0) return { label: "מסמכים ממתינים", value: "0", tone: "default" };

    const now = Date.now();
    const oldestHours = Math.max(
      ...rows.map((r) => (now - new Date(r.created_at as string).getTime()) / 3_600_000)
    );

    return {
      label: oldestHours > 72 ? "ממתינים — מעל 72 שעות!" : oldestHours > 24 ? "ממתינים — מעל 24 שעות" : "מסמכים ממתינים",
      value: String(n),
      tone: oldestHours > 72 ? "peak" : "warn",
    };
  },
};
