import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import ProductionsClient, { type BoardProduction } from "./ProductionsClient";

export const dynamic = "force-dynamic";

type StageRollup = {
  done: number;
  total: number;
  inProgress: { track: string; step: string; assignee_id: string | null }[];
  assigneeIds: Set<string>;
};

// the select string is built conditionally (money gating), which defeats
// PostgREST's return-type inference — describe the row shape explicitly
type ProdRow = {
  id: string;
  status: string;
  record_date: string | null;
  guest: string | null;
  studio: string | null;
  on_hold: boolean;
  on_hold_reason: string | null;
  on_hold_since: string | null;
  needs_attention: boolean;
  show_id: string | null;
  client_id?: string | null;
};

export default async function ProductionsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_stages) redirect("/");

  const supabase = createClient();
  const canViewMoney = profile.can_view_money;

  // money columns (client) are only ever selected with the permission —
  // the board never carries money for a stages-only viewer
  const prodSelect = canViewMoney
    ? "id,status,record_date,guest,studio,on_hold,on_hold_reason,on_hold_since,needs_attention,show_id,client_id"
    : "id,status,record_date,guest,studio,on_hold,on_hold_reason,on_hold_since,needs_attention,show_id";

  const [prodsRes, { data: shows }, { data: stages }] = await Promise.all([
    supabase.from("productions").select(prodSelect),
    supabase.from("shows").select("id,name,color,active"),
    supabase.from("stages").select("production_id,status,track,step,assignee_id"),
  ]);
  const prods = (prodsRes.data ?? []) as unknown as ProdRow[];

  const showById = new Map((shows ?? []).map((s) => [s.id, s]));

  const rollup = new Map<string, StageRollup>();
  const assigneeIds = new Set<string>();
  for (const st of stages ?? []) {
    let r = rollup.get(st.production_id);
    if (!r) {
      r = { done: 0, total: 0, inProgress: [], assigneeIds: new Set() };
      rollup.set(st.production_id, r);
    }
    r.total += 1;
    if (st.status === "done") r.done += 1;
    if (st.status === "in_progress") {
      r.inProgress.push({ track: st.track, step: st.step, assignee_id: st.assignee_id });
    }
    if (st.assignee_id) {
      r.assigneeIds.add(st.assignee_id);
      assigneeIds.add(st.assignee_id);
    }
  }

  // client names (money only) and assignee names — assignees fetched via the
  // service client because profiles RLS is manager-only, but staff names on
  // the board are visible to the whole team by design (screens-spec §2)
  const admin = createAdminClient();
  const [{ data: profilesRows }, clientsRes] = await Promise.all([
    admin.from("profiles").select("id,name,email"),
    canViewMoney
      ? supabase.from("clients").select("id,name")
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
  ]);
  const nameById = new Map((profilesRows ?? []).map((p) => [p.id, p.name || p.email || "—"]));
  const clientById = new Map((clientsRes.data ?? []).map((c) => [c.id, c.name]));

  const board: BoardProduction[] = (prods ?? []).map((p) => {
    const show = p.show_id ? showById.get(p.show_id) : undefined;
    const r = rollup.get(p.id);
    const inProgress = (r?.inProgress ?? []).map((ip) => ({
      track: ip.track,
      step: ip.step,
      assignee: ip.assignee_id ? nameById.get(ip.assignee_id) ?? null : null,
    }));
    return {
      id: p.id,
      status: p.status,
      record_date: p.record_date,
      guest: p.guest,
      studio: p.studio,
      on_hold: p.on_hold,
      on_hold_reason: p.on_hold_reason ?? null,
      on_hold_since: p.on_hold_since ?? null,
      needs_attention: p.needs_attention,
      show_name: show?.name ?? "—",
      show_color: show?.color ?? null,
      show_active: show?.active ?? true,
      client_name:
        canViewMoney && "client_id" in p && p.client_id
          ? clientById.get(p.client_id as string) ?? null
          : null,
      stages_done: r?.done ?? 0,
      stages_total: r?.total ?? 0,
      in_progress: inProgress,
      mine: r ? r.assigneeIds.has(user.id) : false,
    };
  });

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ProductionsClient
          board={board}
          isTech={profile.role === "tech"}
          canEditStages={profile.can_edit_stages}
        />
      </main>
    </div>
  );
}
