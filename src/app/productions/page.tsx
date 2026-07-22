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
  record_time: string | null;
  guest: string | null;
  studio: string | null;
  on_hold: boolean;
  on_hold_reason: string | null;
  on_hold_since: string | null;
  needs_attention: boolean;
  show_id: string | null;
  client_id?: string | null;
  calendar_uid: string | null;
  split_index: number | null;
  split_count: number | null;
  calendar_dup_ack: boolean;
  merged_into: string | null;
  legacy: boolean;
};

// stages has ~4.3k rows and PostgREST caps any single response at 1000, so a
// plain .select() silently returned only the first 1000 stage rows — 546 of
// 713 productions (including every active kanban card) then rendered 0/0
// progress from an empty rollup (owner-reported 2026-07-22). Page through the
// whole table so every card's done/total is complete. NOTE: a per-production
// aggregate view collapses this to a single round-trip (~713 rows, not 4.3k
// across 5 pages) — that's the queued perf follow-up; correctness ships first,
// with no schema change required.
async function fetchAllStages(supabase: ReturnType<typeof createClient>) {
  const page = 1000;
  type StageRow = { production_id: string; status: string; track: string; step: string; assignee_id: string | null };
  const out: StageRow[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("stages")
      .select("production_id,status,track,step,assignee_id")
      .range(from, from + page - 1);
    if (error) throw error;
    const rows = (data ?? []) as StageRow[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

export default async function ProductionsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_stages) redirect("/");

  const supabase = createClient();
  const canViewMoney = profile.can_view_money;

  // money columns (client) are only ever selected with the permission —
  // the board never carries money for a stages-only viewer
  const commonCols =
    "id,status,record_date,record_time,guest,studio,on_hold,on_hold_reason,on_hold_since,needs_attention,show_id,calendar_uid,split_index,split_count,calendar_dup_ack,merged_into,legacy";
  const prodSelect = canViewMoney ? `${commonCols},client_id` : commonCols;

  // fetched without a merged_into filter — a merged-away / un-split-away
  // row must still surface as "absorbed" on its survivor's card, it just
  // never becomes a board entry of its own (see split below)
  const [prodsRes, { data: shows }, stages] = await Promise.all([
    supabase.from("productions").select(prodSelect),
    supabase.from("shows").select("id,name,color,active"),
    fetchAllStages(supabase),
  ]);
  const allProds = (prodsRes.data ?? []) as unknown as ProdRow[];
  const prods = allProds.filter((p) => !p.merged_into);

  // productions absorbed into a survivor (calendar-duplicate merge, or an
  // undone split) — surfaced on the survivor's card with an undo action
  const absorbedBySurvivor = new Map<string, { id: string }[]>();
  for (const p of allProds) {
    if (!p.merged_into) continue;
    const arr = absorbedBySurvivor.get(p.merged_into) ?? [];
    arr.push({ id: p.id });
    absorbedBySurvivor.set(p.merged_into, arr);
  }

  // calendar duplicate detection (screens-spec, owner request 2026-07-17):
  // two DISTINCT calendar_uid values for the same show on the same day is
  // a real duplicate — a split family shares exactly one uid, so it never
  // trips this. Silenced once every member of the group is acknowledged.
  const dupGroups = new Map<string, ProdRow[]>();
  for (const p of prods) {
    if (!p.show_id || !p.record_date || !p.calendar_uid) continue;
    const key = `${p.show_id}|${p.record_date}`;
    const arr = dupGroups.get(key) ?? [];
    arr.push(p);
    dupGroups.set(key, arr);
  }
  const dupInfoByProdId = new Map<string, { count: number; ids: string[] }>();
  for (const group of Array.from(dupGroups.values())) {
    const distinctUids = new Set(group.map((p) => p.calendar_uid));
    if (distinctUids.size < 2) continue;
    if (group.every((p) => p.calendar_dup_ack)) continue;
    const info = { count: distinctUids.size, ids: group.map((p) => p.id) };
    for (const p of group) dupInfoByProdId.set(p.id, info);
  }

  const showById = new Map((shows ?? []).map((s) => [s.id, s]));

  const rollup = new Map<string, StageRollup>();
  const assigneeIds = new Set<string>();
  for (const st of stages) {
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
      record_time: p.record_time,
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
      split_index: p.split_index,
      split_count: p.split_count,
      dup_group: dupInfoByProdId.get(p.id) ?? null,
      absorbed: absorbedBySurvivor.get(p.id) ?? [],
      legacy: p.legacy,
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
          shows={(shows ?? [])
            .filter((s) => s.active)
            .map((s) => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.name.localeCompare(b.name, "he"))}
        />
      </main>
    </div>
  );
}
