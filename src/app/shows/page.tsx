import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import ShowsClient, { type EpisodeRow, type ShowRow } from "./ShowsClient";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_stages && !profile.can_view_money) redirect("/");

  const supabase = createClient();
  const canViewMoney = profile.can_view_money;

  // money columns are simply never selected without the permission —
  // "not hidden, not present in the response" (screens spec, section 12)
  const showColumns = canViewMoney
    ? "id,name,client_id,aliases,default_rate,default_studio,active,is_oneoff,color"
    : "id,name,aliases,default_studio,active,is_oneoff,color";

  const [{ data: shows }, { data: productions }, { data: clients }] = await Promise.all([
    supabase.from("shows").select(showColumns).order("name"),
    supabase
      .from("productions")
      .select("id,show_id,record_date,status,guest,studio_hours,edit_hours")
      .order("record_date", { ascending: false }),
    canViewMoney ? supabase.from("clients").select("id,name").order("name") : Promise.resolve({ data: [] }),
  ]);

  // cumulative revenue per show: jobs → job_productions → production → show.
  // Live jobs only; archive never enters any calculation. A job linked to
  // several productions splits its amount equally between them, so a
  // "2 פרקים" job never counts twice.
  const revenueByShow: Record<string, number> = {};
  if (canViewMoney) {
    const [{ data: jobs }, { data: links }] = await Promise.all([
      supabase.from("jobs").select("id,amount"),
      supabase.from("job_productions").select("job_id,production_id"),
    ]);
    const showByProduction: Record<string, string> = {};
    for (const p of productions ?? []) {
      if (p.show_id) showByProduction[p.id] = p.show_id;
    }
    const amountByJob: Record<string, number> = {};
    for (const j of jobs ?? []) {
      if (j.amount) amountByJob[j.id] = Number(j.amount);
    }
    const linkCountByJob: Record<string, number> = {};
    for (const l of links ?? []) {
      linkCountByJob[l.job_id] = (linkCountByJob[l.job_id] ?? 0) + 1;
    }
    for (const l of links ?? []) {
      const showId = showByProduction[l.production_id];
      const amount = amountByJob[l.job_id];
      if (showId && amount) {
        revenueByShow[showId] = (revenueByShow[showId] ?? 0) + amount / linkCountByJob[l.job_id];
      }
    }
  }

  const episodeCounts: Record<string, number> = {};
  for (const p of productions ?? []) {
    if (p.show_id) episodeCounts[p.show_id] = (episodeCounts[p.show_id] ?? 0) + 1;
  }

  const rows: ShowRow[] = ((shows ?? []) as unknown as Record<string, unknown>[]).map((s) => ({
    id: s.id as string,
    name: s.name as string,
    client_id: (s.client_id as string) ?? null,
    aliases: (s.aliases as string[]) ?? [],
    default_rate: canViewMoney ? ((s.default_rate as number) ?? null) : null,
    default_studio: (s.default_studio as string) ?? null,
    active: s.active as boolean,
    is_oneoff: s.is_oneoff as boolean,
    color: (s.color as string) ?? null,
    episodes: episodeCounts[s.id as string] ?? 0,
    revenue: canViewMoney ? (revenueByShow[s.id as string] ?? 0) : null,
  }));

  const episodes: EpisodeRow[] = (productions ?? [])
    .filter((p) => p.show_id)
    .map((p) => ({
      id: p.id,
      show_id: p.show_id as string,
      record_date: p.record_date,
      status: p.status,
      guest: p.guest,
      studio_hours: p.studio_hours,
      edit_hours: p.edit_hours,
    }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ShowsClient
          shows={rows}
          episodes={episodes}
          clients={clients ?? []}
          canViewMoney={canViewMoney}
          canEditMoney={profile.can_edit_money}
          canEditStages={profile.can_edit_stages}
        />
      </main>
    </div>
  );
}
