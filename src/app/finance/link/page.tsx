import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import AppHeader from "@/components/AppHeader";
import { suggestForJob, type Suggestion } from "@/lib/linking";
import LinkClient, { type JobRow, type ProductionOption } from "./LinkClient";

export const dynamic = "force-dynamic";

export default async function LinkJobsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  const supabase = createClient();
  const [jobsRes, linksRes, prodsRes, showsRes, clientsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id,client_id,date,campaign,amount,manual_only")
      .order("date", { ascending: true }),
    supabase.from("job_productions").select("job_id,production_id"),
    supabase
      .from("productions")
      .select("id,show_id,record_date,guest,client_id")
      .order("record_date", { ascending: false }),
    supabase.from("shows").select("id,name,aliases"),
    supabase.from("clients").select("id,name"),
  ]);

  // before migration 0009 runs, job_productions / jobs.manual_only don't
  // exist yet — say so instead of rendering a broken screen
  if (jobsRes.error || linksRes.error) {
    return (
      <div className="min-h-screen">
        <AppHeader profile={profile} />
        <main className="max-w-2xl mx-auto p-6">
          <h1 className="text-lg font-bold mb-3">🔗 קישור חיובים להפקות</h1>
          <div className="border border-[var(--rule)] rounded p-4 text-sm">
            המסך דורש את מיגרציה <b>0009_job_productions</b> — יש להריץ אותה
            ב-SQL Editor של Supabase ולרענן.
            <div className="mt-2 text-xs text-[var(--dim)]" dir="ltr">
              {jobsRes.error?.message ?? linksRes.error?.message}
            </div>
          </div>
        </main>
      </div>
    );
  }

  const jobs = jobsRes.data ?? [];
  const links = linksRes.data ?? [];
  const productions = prodsRes.data ?? [];
  const shows = showsRes.data ?? [];
  const clientName: Record<string, string> = {};
  for (const c of clientsRes.data ?? []) clientName[c.id] = c.name;
  const showName: Record<string, string> = {};
  for (const s of shows) showName[s.id] = s.name;

  const linkedProductionsByJob: Record<string, string[]> = {};
  for (const l of links) {
    (linkedProductionsByJob[l.job_id] ??= []).push(l.production_id);
  }

  const suggestions: Record<string, Suggestion> = {};
  for (const j of jobs) {
    if (j.manual_only || linkedProductionsByJob[j.id]) continue;
    suggestions[j.id] = suggestForJob(
      j,
      j.client_id ? clientName[j.client_id] ?? "" : "",
      shows,
      productions
    );
  }

  const rows: JobRow[] = jobs.map((j) => ({
    id: j.id,
    date: j.date,
    client: j.client_id ? clientName[j.client_id] ?? "—" : "—",
    campaign: j.campaign,
    amount: j.amount,
    manualOnly: j.manual_only,
    linked: linkedProductionsByJob[j.id] ?? [],
    suggestion: suggestions[j.id] ?? null,
  }));

  const productionOptions: ProductionOption[] = productions.map((p) => ({
    id: p.id,
    date: p.record_date,
    show: p.show_id ? showName[p.show_id] ?? "—" : "—",
    guest: p.guest,
  }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <LinkClient
          jobs={rows}
          productions={productionOptions}
          canEditMoney={profile.can_edit_money}
        />
      </main>
    </div>
  );
}
