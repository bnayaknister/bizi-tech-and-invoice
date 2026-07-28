import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import AccruedClient, { type AccruedGroup } from "./AccruedClient";

export const dynamic = "force-dynamic";

// The accrued queue (owner spec 2026-07-28): work orders frozen by a client's
// billing_cadence (monthly / every_n), grouped by client. Each group is one
// "פדה" — a consolidated work order + consolidated deal invoice. Each row can
// be individually released ("הוצא עכשיו") — the bookkeeper always overrides.
export default async function AccruedPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const admin = createAdminClient();
  const { data } = await admin
    .from("pending_documents")
    .select(
      "id,amount,created_at,client_id,production_id," +
        "clients(name,billing_cadence,billing_every_n)," +
        "productions(podcast_name,record_date,guest)"
    )
    .eq("doc_type", "work_order")
    .eq("status", "accrued")
    .order("created_at", { ascending: true });

  const now = Date.now();
  const byClient = new Map<string, AccruedGroup>();
  for (const r of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const clientId = (r.client_id as string) ?? "—";
    const client = r.clients as { name?: string; billing_cadence?: string; billing_every_n?: number } | null;
    const prod = r.productions as { podcast_name?: string; record_date?: string; guest?: string } | null;
    const created = new Date(r.created_at as string).getTime();
    const ageDays = Math.floor((now - created) / 86_400_000);
    let g = byClient.get(clientId);
    if (!g) {
      g = {
        client_id: clientId,
        client_name: client?.name ?? "—",
        cadence: (client?.billing_cadence as AccruedGroup["cadence"]) ?? "per_episode",
        every_n: (client?.billing_every_n as number | null) ?? null,
        total: 0,
        oldest_age_days: 0,
        rows: [],
      };
      byClient.set(clientId, g);
    }
    g.total += Number(r.amount ?? 0);
    g.oldest_age_days = Math.max(g.oldest_age_days, ageDays);
    g.rows.push({
      id: r.id as string,
      amount: (r.amount as number | null) ?? null,
      show_name: prod?.podcast_name ?? "—",
      record_date: prod?.record_date ?? null,
      guest: prod?.guest ?? null,
      age_days: ageDays,
    });
  }

  // ready-to-redeem heuristic: every_n reached its N, or oldest waited 30+ days
  const groups = Array.from(byClient.values()).map((g) => ({
    ...g,
    ready:
      (g.cadence === "every_n" && g.every_n != null && g.rows.length >= g.every_n) ||
      g.oldest_age_days >= 30,
  }));
  groups.sort((a, b) => Number(b.ready) - Number(a.ready) || b.oldest_age_days - a.oldest_age_days);

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <AccruedClient groups={groups} canRedeem={!!profile.can_edit_money} />
    </div>
  );
}
