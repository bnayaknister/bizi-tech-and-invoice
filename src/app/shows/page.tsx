import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import ShowsClient, { type EpisodeRow, type ShowRow, type ContractOption } from "./ShowsClient";
import { mustRows, type QueryResult } from "@/lib/supabase/unwrap";

export const dynamic = "force-dynamic";

export default async function ShowsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_stages && !profile.can_view_money) redirect("/");

  const supabase = createClient();
  const canViewMoney = profile.can_view_money;

  // default_rate's SELECT privilege is revoked from the authenticated role
  // (0021) — even a money user's own session can't read it — so the session
  // query never mentions it. Money users get the rate through the service
  // role instead, below, gated on canViewMoney here. Everything else is the
  // same "not present in the response for a stages viewer" pattern.
  // has_episode / reels_count are stage-tier (0055) so both branches carry
  // them. They are readable only because 0055 added them to the column-explicit
  // grant 0022 introduced — a new shows column is invisible to `authenticated`
  // until it is named in a grant.
  // annotated `string` on purpose: supabase-js parses a select() literal into
  // a row type, and a ternary of two lists this long makes tsc give up with
  // "union type that is too complex to represent". The rows are re-shaped by
  // hand into ShowRow below anyway, so the inferred type buys nothing here.
  const showColumns: string = canViewMoney
    ? "id,name,client_id,aliases,default_studio,camera_count,notes,active,is_oneoff,color,billing_mode,has_episode,reels_count"
    : "id,name,aliases,default_studio,camera_count,notes,active,is_oneoff,color,billing_mode,has_episode,reels_count";

  // mustRows, not `?? []`: these three ARE the screen. A failure here used to
  // render "0 פעילות · 0 חד־פעמיות" with a clean console — see lib/supabase/
  // unwrap.ts. Throwing surfaces Next's error overlay in dev and a 500 with a
  // stack in the terminal, which is what a shows page that cannot read shows
  // should do. (The contracts panel below is the deliberate exception: it is
  // one panel, so it degrades in place instead of taking the page down.)
  const [showsRes, productionsRes, clientsRes] = await Promise.all([
    supabase.from("shows").select(showColumns).order("name"),
    supabase
      .from("productions")
      .select("id,show_id,record_date,status,guest,legacy")
      .order("record_date", { ascending: false }),
    canViewMoney
      ? supabase.from("clients").select("id,name,morning_client_id").order("name")
      : Promise.resolve({ data: [], error: null }),
  ]);
  const shows = mustRows(showsRes as QueryResult<Record<string, unknown>[]>, "טעינת התוכניות");
  const productions = mustRows(
    productionsRes as QueryResult<{ id: string; show_id: string | null; record_date: string | null; status: string; guest: string | null; legacy: boolean }[]>,
    "טעינת ההפקות למסך התוכניות"
  );
  const clients = mustRows(clientsRes as QueryResult<{ id: string; name: string; morning_client_id?: string | null }[]>, "טעינת הלקוחות");

  // default_rate via the service role, money-gated — the one money column
  // that lives on an otherwise stages-readable table (0021)
  const rateByShow: Record<string, number | null> = {};
  // contracts for the "מחויבת בחוזה" picker (0056). Money viewers only —
  // contracts are can_view_money throughout. The milestone count rides along
  // because a contract with none cannot issue anything, and the card has to
  // say so rather than present the show as settled.
  const contracts: ContractOption[] = [];
  let contractsError: string | null = null;
  if (canViewMoney) {
    const admin = createAdminClient();
    const { data: rateRows } = await admin.from("shows").select("id,default_rate");
    for (const r of rateRows ?? []) rateByShow[r.id as string] = (r.default_rate as number) ?? null;

    const { data: contractRows, error: contractsErr } = await admin
      .from("contracts")
      .select("id,name,client_id,show_id,status,total_amount,contract_milestones(count)")
      .eq("status", "active")
      .order("name");
    // Degrade explicitly, never silently. Swallowing this would render an
    // empty picker that reads as "this client has no contracts" — a plausible
    // screen that is simply wrong, the exact failure mode that cost a
    // debugging round on 2026-08-12. Throwing would take the whole shows
    // screen down over one panel. So: the screen lives, and the panel that
    // cannot load says it cannot load.
    if (contractsErr) {
      contractsError = `טעינת החוזים נכשלה: ${contractsErr.message}${
        contractsErr.code === "42703" ? " — נראה שמיגרציה 0056 טרם הורצה" : ""
      }`;
      console.error("[shows] contracts load failed:", contractsErr);
    }
    for (const c of contractRows ?? []) {
      const embedded = (c as { contract_milestones?: { count: number }[] }).contract_milestones;
      contracts.push({
        id: c.id as string,
        name: (c.name as string) ?? "",
        client_id: (c.client_id as string) ?? null,
        show_id: (c.show_id as string) ?? null,
        total_amount: (c.total_amount as number) ?? null,
        milestone_count: embedded?.[0]?.count ?? 0,
      });
    }
  }

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
    for (const p of productions) {
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
  for (const p of productions) {
    if (p.show_id) episodeCounts[p.show_id] = (episodeCounts[p.show_id] ?? 0) + 1;
  }

  const rows: ShowRow[] = shows.map((s) => ({
    id: s.id as string,
    name: s.name as string,
    client_id: (s.client_id as string) ?? null,
    aliases: (s.aliases as string[]) ?? [],
    default_rate: canViewMoney ? (rateByShow[s.id as string] ?? null) : null,
    default_studio: (s.default_studio as string) ?? null,
    camera_count: (s.camera_count as number) ?? null,
    notes: (s.notes as string) ?? null,
    active: s.active as boolean,
    is_oneoff: s.is_oneoff as boolean,
    color: (s.color as string) ?? null,
    billing_mode: (s.billing_mode as string) ?? "per_episode",
    has_episode: (s.has_episode as boolean) ?? true,
    reels_count: (s.reels_count as number) ?? 2,
    episodes: episodeCounts[s.id as string] ?? 0,
    revenue: canViewMoney ? (revenueByShow[s.id as string] ?? 0) : null,
  }));

  const episodes: EpisodeRow[] = productions
    .filter((p) => p.show_id)
    .map((p) => ({
      id: p.id,
      show_id: p.show_id as string,
      record_date: p.record_date,
      status: p.status,
      guest: p.guest,
      legacy: p.legacy,
    }));

  // shows this viewer already has a pending destructive request on (RLS
  // returns the viewer's own pending rows) — the card shows "ממתין לאישור"
  const { data: myPending } = await supabase
    .from("approval_requests")
    .select("entity_id")
    .eq("status", "pending")
    .eq("entity_type", "show");
  const pendingShowIds = (myPending ?? []).map((r) => r.entity_id).filter(Boolean) as string[];

  // staff for the "עורך קבוע" picker in the new-show modal — names are
  // team-visible by design (same as the productions board), fetched via the
  // service role since profiles RLS is manager-only
  const { data: staffRows } = await createAdminClient().from("profiles").select("id,name,email").order("name");
  const staff = (staffRows ?? []).map((p) => ({ id: p.id as string, name: (p.name as string) || (p.email as string) || "—" }));

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ShowsClient
          shows={rows}
          episodes={episodes}
          clients={clients}
          canViewMoney={canViewMoney}
          canEditMoney={profile.can_edit_money}
          canEditStages={profile.can_edit_stages}
          canManageUsers={profile.can_manage_users}
          pendingShowIds={pendingShowIds}
          staff={staff}
          contracts={contracts}
          contractsError={contractsError}
        />
      </main>
    </div>
  );
}
