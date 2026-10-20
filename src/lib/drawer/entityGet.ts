import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDrawerLiveLinks } from "@/lib/review/drawerLiveLinks";
import type { DiskOption } from "@/lib/disks";
import { ENTITY_CONFIG, canEditField, canViewField, selectColumns, type EntityType } from "@/lib/entities";
import { deriveMilestoneState } from "@/lib/finance/milestone";
import { must, type QueryResult } from "@/lib/supabase/unwrap";
import { quotaOf, type QuotaProduction } from "@/lib/contracts/quota";
import { ACTIVE_CLIENT } from "@/lib/clients/status";
import { canManageBookingContacts } from "@/lib/clients/access";
import { PERF_OFF, type PerfTimer } from "@/lib/perf/timing";
import type { Profile } from "@/lib/profile";
import { publicVersion, type PublicVersion } from "@/lib/review/versions";
import { toVersionRow, VERSION_SELECT } from "@/lib/review/versionStore";
import { loadCommentHistory, type HistoryItem } from "@/lib/review/commentHistory";
import type { Database } from "@/lib/supabase/database.types";
import { hasOwnerAccess } from "@/lib/roles";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/entity/[type]/[id] — everything after authentication. T34.
// ═══════════════════════════════════════════════════════════════════════════
//
// The drawer's read used to run ~12 steps one after the other, 30–250ms each
// (T35, production, 14.10: total 1.05–1.6s). None of them needs the entity row:
// every block keys on the id and on the viewer's permissions alone. So:
//
//   auth        getUser → profile                       (in the route; the
//               permissions decide what is read at all)
//   wave_1      entity ‖ the select-option lists        (options need `fields`,
//               — then the 400 / 404 answer, exactly as before
//   wave_2      every type-specific block at once, each block keeping its own
//               short internal chain (at most three reads deep: contract →
//               included → siblings, or the live links → transcripts → carry)
//
// ═══ WHAT DID NOT CHANGE ═══
//   · Every permission gate is the same expression in the same place: a block
//     that did not run for a viewer does not run now (it returns its "not
//     read" value without touching the database).
//   · Every failure behaves as before, per block: the reads that ignored their
//     error still do; the client-review state still goes through `must` and
//     still fails the whole request (a 500 via SupabaseReadError — and since
//     the entity is answered first, a missing entity is still a 404 rather
//     than whatever a parallel read threw); the live links keep T36's ceiling
//     and `drawer_partial`.
//   · The JSON is identical, key for key — proven against the frozen pre-T34
//     body (scripts/_entity_get_legacy.ts) in scripts/test_entity_get_waves.ts.
//   · The T35 step names are kept (each now times its own block, overlapping),
//     with wave_1 / wave_2 added.
//
// UNTYPED clients, like the route: the table and column list are resolved at
// runtime from the field registry (see the route's header).

export type EntityGetDeps = {
  type: EntityType;
  id: string;
  user: { id: string };
  profile: Profile;
  /** the USER's client — RLS and the column guards are the real gates */
  supabase: SupabaseClient;
  admin: SupabaseClient;
  /** the base URL the review-link mint route stamps into links */
  origin: string;
  liveLinksTimeoutMs?: number;
  perf?: PerfTimer;
};

type Review = {
  episode_approved: boolean;
  reels_approved: boolean;
  reels_required: boolean;
  episode_note: string | null;
  reels_note: string | null;
};
type ReviewItem = {
  id: string;
  kind: string;
  reel_index: number | null;
  media_link: string | null;
  approved: boolean;
  last_note: string | null;
  // E13-4: the item's versions, oldest first — team only (the drawer's send-for-review panel)
  versions: PublicVersion[];
};

export async function entityGet(deps: EntityGetDeps): Promise<{ status: number; json: Record<string, unknown> }> {
  const { type, id, user, profile, supabase, admin, origin, liveLinksTimeoutMs } = deps;
  const perf = deps.perf ?? PERF_OFF;
  const config = ENTITY_CONFIG[type];

  // field metadata the drawer renders from — only fields this viewer may see
  const fields = config.fields
    .filter((f) => canViewField(profile, f.view))
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      editable: canEditField(profile, f.edit),
      options: typeof f.options === "string" ? f.options : f.options ?? null,
    }));

  // select options (names only — RLS permits both audiences to read these)
  const needsClients = fields.some((f) => f.options === "clients");
  const needsShows = fields.some((f) => f.options === "shows");

  // ── wave_1: the entity, beside the option lists (they need `fields`, not the row)
  const [{ data: entity, error }, clients, shows] = await Promise.all([
    perf.time("entity", supabase.from(config.table).select(selectColumns(type, profile)).eq("id", id).maybeSingle()),
    perf.time(
      "options_clients_shows",
      Promise.all([
        needsClients ? supabase.from("clients").select("id,name").eq("status", ACTIVE_CLIENT).order("name") : Promise.resolve({ data: null }),
        needsShows ? supabase.from("shows").select("id,name").order("name") : Promise.resolve({ data: null }),
      ])
    ).then(([c, s]) => [c, s] as const),
  ]).then(([e, [c, s]]) => [e, c, s] as const);
  perf.lap("wave_1");
  if (error) return { status: 400, json: { error: error.message } };
  if (!entity) return { status: 404, json: { error: "לא נמצא או שאין הרשאה" } };

  const isProduction = type === "production";
  const seesStages = isProduction && profile.can_view_stages;

  // ── wave_2: every block at once ──────────────────────────────────────────

  // stages + per-track client-review state (the corrections notes render
  // inside the matching workflow block in the drawer, not in a generic field)
  const stagesReels = async () => {
    if (!seesStages) return { stages: null as unknown[] | null, review: null as Review | null, reelsSummary: null as { count: number } | null };
    const [{ data: stageRows }, reviewRes] = await Promise.all([
      supabase
        .from("stages")
        .select("id,track,step,status,assignee_id,done_at")
        .eq("production_id", id)
        .order("track")
        .order("step"),
      supabase
        .from("productions")
        .select(
          "review_episode_approved,review_reels_approved,review_reels_required,review_episode_note,review_reels_note,reels_count"
        )
        .eq("id", id)
        .maybeSingle(),
    ]);
    // must, not a bare destructure: a failure here used to drop the whole
    // client-review block and the reels tally out of the drawer with no sign
    // that anything had gone wrong.
    const r = must<Record<string, unknown>>(reviewRes as QueryResult<Record<string, unknown>>, "טעינת מצב אישור הלקוח של ההפקה");
    let review: Review | null = null;
    let reelsSummary: { count: number } | null = null;
    if (r) {
      review = {
        episode_approved: !!r.review_episode_approved,
        reels_approved: !!r.review_reels_approved,
        reels_required: !!r.review_reels_required,
        episode_note: (r.review_episode_note as string) ?? null,
        reels_note: (r.review_reels_note as string) ?? null,
      };
      // reels tally — one number, straight off the production (0055)
      reelsSummary = { count: Number(r.reels_count) || 0 };
    }
    return { stages: stageRows as unknown[] | null, review, reelsSummary };
  };

  // 0067 / F6 — the hourly pair. pricing_model is a classification granted to
  // `authenticated`; hourly_rate is NOT granted and is NOT read here.
  const hours = async () => {
    if (!seesStages) return null;
    const { data: hoursRow } = await supabase.from("productions").select("studio_hours,show_id").eq("id", id).maybeSingle();
    const hourlyShowId = (hoursRow?.show_id as string | null) ?? null;
    if (!hourlyShowId) return null;
    const { data: showRow } = await supabase.from("shows").select("pricing_model").eq("id", hourlyShowId).maybeSingle();
    return {
      // an absent column reads as per_episode — what the column's NOT NULL
      // DEFAULT says every existing row is
      pricing_model: (showRow?.pricing_model as string) ?? "per_episode",
      studio_hours: (hoursRow?.studio_hours as number | null) ?? null,
    };
  };

  // per-item media links (0057) — via the service role: the table has no user
  // policies, and can_view_stages is the real gate
  const reviewItems = async (): Promise<ReviewItem[] | null> => {
    if (!seesStages) return null;
    const { data: itemRows } = await admin
      .from("client_review_items")
      .select("id,kind,reel_index,media_link,approved,last_note")
      .eq("production_id", id)
      .order("kind")
      .order("reel_index", { ascending: true });
    // E13-4 — versions of these items. A failed read leaves the lists empty
    // and never fails the drawer (rule 38): the media fields still work.
    const ids = (itemRows ?? []).map((r) => r.id as string);
    const byItem = new Map<string, PublicVersion[]>();
    if (ids.length) {
      const { data: vRows } = await admin
        .from("client_review_versions")
        .select(VERSION_SELECT)
        .in("item_id", ids)
        .order("created_at", { ascending: true });
      for (const v of vRows ?? []) {
        const pv = publicVersion(toVersionRow(v));
        const list = byItem.get(v.item_id as string) ?? [];
        list.push(pv);
        byItem.set(v.item_id as string, list);
      }
    }
    return (itemRows ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      reel_index: (r.reel_index as number | null) ?? null,
      media_link: (r.media_link as string | null) ?? null,
      approved: !!r.approved,
      last_note: (r.last_note as string | null) ?? null,
      versions: byItem.get(r.id as string) ?? [],
    }));
  };

  // E13-8c (owner 17.10) — the client's comments, permanently: every item,
  // version and round, acked or not (lib/review/commentHistory). A failed read
  // leaves the section out and never fails the drawer (rule 38).
  const commentHistory = async (): Promise<HistoryItem[] | null> => {
    if (!seesStages || type !== "production") return null;
    try {
      return await loadCommentHistory(admin as unknown as SupabaseClient<Database>, id);
    } catch {
      return null;
    }
  };

  // LIVE review links (Q7), with T36's ceiling per read
  const liveLinks = async () => {
    if (!seesStages) return { links: null, incomplete: false };
    return loadDrawerLiveLinks({ supabase, admin, productionId: id, origin, timeoutMs: liveLinksTimeoutMs });
  };

  // production journal (§3) + disk autocomplete (§2), for anyone who can see
  // the production; author names through the admin client (profiles RLS is
  // self-or-owner, names are not sensitive)
  const logAndDisks = async () => {
    if (!(isProduction && (profile.can_view_stages || profile.can_view_money))) return { log: null as unknown[] | null, diskOptions: null as DiskOption[] | null };
    const [{ data: logRows }, { data: diskRows }] = await Promise.all([
      supabase
        .from("production_log")
        .select("id,kind,track,step,stage_status,note,author_id,created_at,edited_at")
        .eq("production_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      // B35 (0120): the closed list — visible disks only; the drawer adds the
      // production's own disk if it is hidden (lib/disks.ts diskChoices)
      supabase.from("storage_disks").select("id,name").eq("hidden", false).order("name"),
    ]);
    const authorIds = Array.from(new Set((logRows ?? []).map((r) => r.author_id).filter(Boolean)));
    const { data: authors } = authorIds.length
      ? await admin.from("profiles").select("id,name").in("id", authorIds as string[])
      : { data: [] };
    const authorName: Record<string, string> = {};
    for (const a of authors ?? []) authorName[a.id] = a.name;
    return {
      log: (logRows ?? []).map((r) => ({
        ...r,
        author: r.author_id ? authorName[r.author_id] ?? "—" : null, // null = client/system
        mine: r.author_id === user.id,
      })) as unknown[],
      diskOptions: (diskRows ?? []).map((d) => ({ id: d.id as string, name: d.name as string })),
    };
  };

  // the jobs this production is billed under
  const linkedJobs = async (): Promise<unknown[] | null | undefined> => {
    if (!(isProduction && profile.can_view_money)) return undefined; // "not read" — leaves `linked` to the other types
    const { data: links } = await supabase.from("job_productions").select("job_id").eq("production_id", id);
    if (!links?.length) return [];
    const { data } = await supabase.from("jobs").select("id,date,campaign,amount").in("id", links.map((l) => l.job_id));
    return data;
  };

  // 0098 — is THIS episode beyond its contract's package quota? READ-ONLY.
  // Through the ADMIN client behind the explicit can_view_money gate (a
  // user-scoped read would silently say "not over quota" to a stage viewer).
  const contractQuota = async (): Promise<{ included: number; contract_name: string | null } | null> => {
    if (!(isProduction && profile.can_view_money)) return null;
    const { data: prodRow } = await admin.from("productions").select("contract_id").eq("id", id).maybeSingle();
    const contractId = (prodRow?.contract_id as string | null) ?? null;
    if (!contractId) return null;
    const { data: contractRow } = await admin.from("contracts").select("id,name,included_episodes").eq("id", contractId).maybeSingle();
    const included = (contractRow?.included_episodes as number | null) ?? null;
    if (included == null) return null;
    const { data: siblings } = await admin
      .from("productions")
      .select("id,contract_id,status,cancelled_at,merged_into,record_date,created_at")
      .eq("contract_id", contractId);
    const q = quotaOf(included, contractId, (siblings ?? []) as unknown as QuotaProduction[]);
    // `some(id)`: quotaOf already decided which episodes are over
    if (q && q.over.some((p) => p.id === id)) {
      return { included: q.included, contract_name: (contractRow?.name as string | null) ?? null };
    }
    return null;
  };

  // the other drawer types (job → its productions, contract → milestones)
  const otherTypes = async (): Promise<{ linked?: unknown[] | null; milestones?: unknown[] | null }> => {
    if (type === "job" && profile.can_view_money) {
      const { data: links } = await supabase.from("job_productions").select("production_id").eq("job_id", id);
      if (!links?.length) return { linked: [] };
      const { data } = await supabase
        .from("productions")
        .select("id,podcast_name,record_date,guest")
        .in("id", links.map((l) => l.production_id));
      return { linked: data };
    }
    if (type === "contract" && profile.can_view_money) {
      const { data } = await supabase
        .from("contract_milestones")
        .select("id,name,amount,expected_date,is_estimated,status,job_id")
        .eq("contract_id", id)
        .order("expected_date");
      // the same derived state /contracts shows — needs is_estimated, the job's
      // paid, and whether a document number is on the job
      const jobIds = (data ?? []).map((m) => m.job_id).filter(Boolean) as string[];
      const { data: msJobs } = jobIds.length
        ? await supabase.from("jobs").select("id,paid,invoice_biz,invoice_tax").in("id", jobIds)
        : { data: [] };
      const jobById = new Map(
        (msJobs ?? []).map((j) => [j.id as string, j as { paid: string | null; invoice_biz: string | null; invoice_tax: string | null }])
      );
      const billed = (v: unknown) => v != null && String(v).trim() !== "";
      return {
        milestones: (data ?? []).map((m) => {
          const job = m.job_id ? jobById.get(m.job_id) ?? null : null;
          return {
            ...m,
            state: deriveMilestoneState({
              status: m.status,
              expected_date: m.expected_date,
              is_estimated: m.is_estimated,
              jobPaid: job?.paid ?? null,
              jobBilled: billed(job?.invoice_biz) || billed(job?.invoice_tax),
            }),
          };
        }),
      };
    }
    return {};
  };

  // change history — events RLS is owner-only; mirror that here
  const history = async (): Promise<unknown[] | null> => {
    if (!hasOwnerAccess(profile)) return null;
    const { data: events } = await admin
      .from("events")
      .select("id,event_type,actor_id,payload,created_at")
      .eq("entity_type", type)
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(20);
    const actorIds = Array.from(new Set((events ?? []).map((e) => e.actor_id).filter(Boolean)));
    const { data: actors } = actorIds.length ? await admin.from("profiles").select("id,name").in("id", actorIds) : { data: [] };
    const actorName: Record<string, string> = {};
    for (const a of actors ?? []) actorName[a.id] = a.name;
    return (events ?? []).map((e) => ({
      id: e.id,
      event_type: e.event_type,
      actor: e.actor_id ? actorName[e.actor_id] ?? "—" : "מערכת",
      payload: e.payload,
      created_at: e.created_at,
    }));
  };

  const [sr, hourly, items, comments, live, ld, prodLinked, quotaOver, other, hist] = await Promise.all([
    perf.time("stages_reels", stagesReels()),
    perf.time("hours", hours()),
    perf.time("review_items", reviewItems()),
    perf.time("review_comments", commentHistory()),
    perf.time("review_links_transcripts", liveLinks()),
    perf.time("log_disk_authors", logAndDisks()),
    perf.time("linked_jobs", linkedJobs()),
    perf.time("contract_quota", contractQuota()),
    perf.time("other_types", otherTypes()),
    perf.time("history", history()),
  ]);
  perf.lap("wave_2");

  // `linked` belongs to the production block for a production, and to the job
  // block for a job — exactly one of them ever ran, as before
  const linked: unknown[] | null = prodLinked !== undefined ? prodLinked : other.linked ?? null;

  return {
    status: 200,
    json: {
      type,
      icon: config.icon,
      label: config.label,
      title: (entity as unknown as Record<string, unknown>)[config.titleKey] ?? "—",
      entity,
      fields,
      optionsData: { clients: clients.data ?? [], shows: shows.data ?? [] },
      stages: sr.stages,
      linked,
      milestones: other.milestones ?? null,
      history: hist,
      // gates the drawer's production status controls — the DB trigger is the
      // real enforcement
      canEditStages: !!profile.can_edit_stages,
      // gates "יצירת עבודה לחיוב"; the route that does it re-checks
      canEditMoney: !!profile.can_edit_money,
      // E17-3: "הרשאות הזמנת חדרים" is drawn for studio_admin only
      canManageBookingContacts: canManageBookingContacts(profile),
      // 0098 — set only when this episode is beyond its contract's quota
      quotaOver,
      review: sr.review,
      reviewItems: items,
      commentHistory: comments,
      reviewLinks: live.links,
      reviewLinksIncomplete: live.incomplete,
      reelsSummary: sr.reelsSummary,
      hourly,
      log: ld.log,
      diskOptions: ld.diskOptions,
    },
  };
}
