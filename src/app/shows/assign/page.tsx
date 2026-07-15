import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import AssignClient, { type OrphanRow } from "./AssignClient";

export const dynamic = "force-dynamic";

// Fast assignment of the active shows that still have no client — the ones
// the owner works through one by one (owner request 2026-07-15). Assigning
// a client + billing_mode is money classification, so the whole screen is
// can_edit_money-gated.
export default async function AssignPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_edit_money) redirect("/shows");

  const supabase = createClient();
  const [{ data: shows }, { data: productions }, { data: clients }] = await Promise.all([
    supabase
      .from("shows")
      .select("id,name,client_id,billing_mode")
      .eq("active", true)
      .is("client_id", null)
      .order("name"),
    supabase.from("productions").select("show_id"),
    supabase.from("clients").select("id,name").order("name"),
  ]);

  const episodeCounts: Record<string, number> = {};
  for (const p of productions ?? []) {
    if (p.show_id) episodeCounts[p.show_id] = (episodeCounts[p.show_id] ?? 0) + 1;
  }

  const rows: OrphanRow[] = (shows ?? [])
    .map((s) => ({
      id: s.id,
      name: s.name,
      billing_mode: s.billing_mode as OrphanRow["billing_mode"],
      episodes: episodeCounts[s.id] ?? 0,
    }))
    .sort((a, b) => b.episodes - a.episodes);

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <AssignClient rows={rows} clients={clients ?? []} />
      </main>
    </div>
  );
}
