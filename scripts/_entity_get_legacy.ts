/**
 * T34 — the FROZEN pre-T34 body of GET /api/entity/[type]/[id] (everything
 * after authentication), kept only as the reference the new wave version is
 * compared against in scripts/test_entity_get_waves.ts.
 *
 * Generated mechanically from the route at 192908a: the only edits are
 * dependency injection (`supabase`, `admin`, `origin`, `id` instead of
 * createClient / createAdminClient / getAppBaseUrl / params.id), `{status, json}`
 * instead of NextResponse, the perf laps removed, and the live-links timeout
 * passed through so a hang can be tested quickly. NOT imported by the app.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDrawerLiveLinks } from "../src/lib/review/drawerLiveLinks";
import { ENTITY_CONFIG, canEditField, canViewField, selectColumns, type EntityType } from "../src/lib/entities";
import { deriveMilestoneState } from "../src/lib/finance/milestone";
import { must, type QueryResult } from "../src/lib/supabase/unwrap";
import { quotaOf, type QuotaProduction } from "../src/lib/contracts/quota";
import { ACTIVE_CLIENT } from "../src/lib/clients/status";
import { canManageBookingContacts } from "../src/lib/clients/access";
import type { Profile } from "../src/lib/profile";

export async function legacyEntityGet(deps: {
  type: EntityType;
  id: string;
  user: { id: string };
  profile: Profile;
  supabase: SupabaseClient;
  admin: SupabaseClient;
  origin: string;
  liveLinksTimeoutMs?: number;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const { type, id, user, profile, supabase, admin, origin, liveLinksTimeoutMs } = deps;
  const config = ENTITY_CONFIG[type];

  const { data: entity, error } = await supabase
    .from(config.table)
    .select(selectColumns(type, profile))
    .eq("id", id)
    .maybeSingle();
  if (error) return { status: 400, json: { error: error.message } };
  if (!entity) return { status: 404, json: { error: "לא נמצא או שאין הרשאה" } };

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
  const [clients, shows] = await Promise.all([
    needsClients ? supabase.from("clients").select("id,name").eq("status", ACTIVE_CLIENT).order("name") : Promise.resolve({ data: null }),
    needsShows ? supabase.from("shows").select("id,name").order("name") : Promise.resolve({ data: null }),
  ]);

  // type-specific extras
  let stages: unknown[] | null = null;
  let linked: unknown[] | null = null;
  let milestones: unknown[] | null = null;
  let review: {
    episode_approved: boolean; reels_approved: boolean; reels_required: boolean;
    episode_note: string | null; reels_note: string | null;
  } | null = null;
  let reelsSummary: { count: number } | null = null;
  let reviewItems:
    | { id: string; kind: string; reel_index: number | null; media_link: string | null; approved: boolean; last_note: string | null }[]
    | null = null;
  let reviewLinks: { id: string; url: string; scope: string; created_at: string }[] | null = null;
  // T36: true when the live-links block was skipped (timeout or error)
  let reviewLinksIncomplete = false;
  // 0067 / F6 — the two facts the hourly flag is derived from, in their own
  // block rather than as generic drawer fields.
  //
  // NOT registered in lib/entities.ts, deliberately. `pricing_model` lives on
  // the SHOW, which the registry cannot express (it selects one table), and
  // `studio_hours` as a generic row would render an editable number beside the
  // guest with no rate, no context and no consequence — the exact bare-row
  // problem `billing_block_reason` is filtered out of the drawer for.
  //
  // NO MONEY CROSSES THIS LINE. pricing_model is a classification and 0067
  // grants it to `authenticated` for precisely this reason; hourly_rate is NOT
  // granted and is NOT read here. The technician learns that the show is billed
  // by the hour and how many hours are recorded — never what an hour costs, and
  // never what the session is worth.
  let hourly: { pricing_model: string; studio_hours: number | null } | null = null;
  if (type === "production" && profile.can_view_stages) {
    const { data } = await supabase
      .from("stages")
      .select("id,track,step,status,assignee_id,done_at")
      .eq("production_id", id)
      .order("track")
      .order("step");
    stages = data;

    // per-track client-review state (the corrections notes render inside the
    // matching workflow block in the drawer, not in a generic field)
    // must, not a bare destructure: a failure here used to drop the whole
    // client-review block and the reels tally out of the drawer with no sign
    // that anything had gone wrong — the technician just saw a production
    // that looked like it had never been sent for approval.
    const r = must<Record<string, unknown>>(
      (await supabase
        .from("productions")
        .select(
          "review_episode_approved,review_reels_approved,review_reels_required,review_episode_note,review_reels_note,reels_count"
        )
        .eq("id", id)
        .maybeSingle()) as QueryResult<Record<string, unknown>>,
      "טעינת מצב אישור הלקוח של ההפקה"
    );
    if (r) {
      review = {
        episode_approved: !!r.review_episode_approved,
        reels_approved: !!r.review_reels_approved,
        reels_required: !!r.review_reels_required,
        episode_note: (r.review_episode_note as string) ?? null,
        reels_note: (r.review_reels_note as string) ?? null,
      };
      // reels tally — one number, straight off the production (0055). This
      // reverses 0036, which made the add-on lines the counter because there
      // was no plan number to count from; now there is. reels_count is the
      // TOTAL planned for this production: it starts as the show's figure and
      // an approved reels add-on raises it, so nothing has to be summed here.
      // production_addons stays the money record, not the tally.
      reelsSummary = { count: Number(r.reels_count) || 0 };
    }

    // the hourly pair. Through the user's own client: both columns are granted
    // to `authenticated` by 0067, so a viewer who may not see them simply reads
    // nothing — the same gate as every other select on this route.
    const { data: hoursRow } = await supabase
      .from("productions")
      .select("studio_hours,show_id")
      .eq("id", id)
      .maybeSingle();
    const hourlyShowId = (hoursRow?.show_id as string | null) ?? null;
    if (hourlyShowId) {
      const { data: showRow } = await supabase
        .from("shows")
        .select("pricing_model")
        .eq("id", hourlyShowId)
        .maybeSingle();
      hourly = {
        // an absent column reads as per_episode — today's behaviour, and what
        // the column's NOT NULL DEFAULT says every existing row is
        pricing_model: (showRow?.pricing_model as string) ?? "per_episode",
        studio_hours: (hoursRow?.studio_hours as number | null) ?? null,
      };
    }

    // per-item media links (0057) — read via the service role: the table has
    // no user policies, and can_view_stages above is the real gate. Empty for
    // a production the items model hasn't reached yet (seeded at link mint).
    const itemsAdmin = admin;
    const { data: itemRows } = await itemsAdmin
      .from("client_review_items")
      .select("id,kind,reel_index,media_link,approved,last_note")
      .eq("production_id", id)
      .order("kind")
      .order("reel_index", { ascending: true });
    reviewItems = (itemRows ?? []).map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      reel_index: (r.reel_index as number | null) ?? null,
      media_link: (r.media_link as string | null) ?? null,
      approved: !!r.approved,
      last_note: (r.last_note as string | null) ?? null,
    }));

    // LIVE review links (Q7) — the drawer had no way to retrieve a link it had
    // already sent, so the tech pressed send again and superseded the one the
    // client was holding (20 links on one production in two days). Read
    // through the user's own client: the table's select policy is
    // can_view_stages(), the same gate this block already sits behind.
    // Supersession is scope-aware since the B1 fix, so an episode link and a
    // reels link can BOTH be live — this is a list, not a single row.
    // T36: the live-links block, with a 5s ceiling per read — see
    // lib/review/drawerLiveLinks.ts for why (the 62s drawer of 14.10).
    const live = await loadDrawerLiveLinks({
      supabase,
      admin: admin,
      productionId: id,
      origin,
      timeoutMs: liveLinksTimeoutMs,
    });
    reviewLinks = live.links;
    reviewLinksIncomplete = live.incomplete;
  }

  // production journal (§3, owner 2026-07-24) + disk autocomplete (§2). Both
  // for anyone who can see the production. The log is RLS-gated (stage OR money
  // viewer); author names are resolved via the admin client because a non-owner
  // session can't read other profiles' rows (profiles RLS is self-or-owner) —
  // names aren't sensitive, and the log rows themselves were already permitted.
  let log: unknown[] | null = null;
  let diskOptions: { id: string; name: string }[] | null = null;
  if (type === "production" && (profile.can_view_stages || profile.can_view_money)) {
    const [{ data: logRows }, { data: diskRows }] = await Promise.all([
      supabase
        .from("production_log")
        .select("id,kind,track,step,stage_status,note,author_id,created_at,edited_at")
        .eq("production_id", id)
        .order("created_at", { ascending: false })
        .limit(200),
      // B35 (0120): moved forward with the live route — the closed disk list
      supabase.from("storage_disks").select("id,name").eq("hidden", false).order("name"),
    ]);
    const authorIds = Array.from(new Set((logRows ?? []).map((r) => r.author_id).filter(Boolean)));
    const { data: authors } = authorIds.length
      ? await admin.from("profiles").select("id,name").in("id", authorIds as string[])
      : { data: [] };
    const authorName: Record<string, string> = {};
    for (const a of authors ?? []) authorName[a.id] = a.name;
    log = (logRows ?? []).map((r) => ({
      ...r,
      author: r.author_id ? authorName[r.author_id] ?? "—" : null, // null = client/system
      mine: r.author_id === user.id,
    }));
    diskOptions = (diskRows ?? []).map((d) => ({ id: d.id as string, name: d.name as string }));
  }
  if (type === "production" && profile.can_view_money) {
    const { data: links } = await supabase
      .from("job_productions")
      .select("job_id")
      .eq("production_id", id);
    if (links?.length) {
      const { data } = await supabase
        .from("jobs")
        .select("id,date,campaign,amount")
        .in("id", links.map((l) => l.job_id));
      linked = data;
    } else linked = [];
  }
  // ── 0098: is THIS episode beyond its contract's package quota? ───────────
  //
  // 🔴 READ-ONLY, and that is the owner's decision rather than a property of
  // this route: "התראה בלבד, לא חסימה ולא מסמך". The verdict is derived from
  // three reads and the pure module; nothing here touches checkEligibility,
  // enqueueDocument or ensure_job_for_production.
  //
  // Through the ADMIN client, and that is the permission note: `contracts` is
  // RLS'd to can_view_money (contracts_view, 0002:358), and the explicit
  // `profile.can_view_money` gate below is what stands in for it — the same
  // shape the `hourly` block above uses for its own reason. A user-scoped read
  // would return nothing for a stage-only viewer and the drawer would silently
  // say "not over quota", which is the quiet direction.
  //
  // Only when the production actually HAS a contract_id: the two reads below
  // are skipped entirely for every per-episode production, which is almost all
  // of them.
  let quotaOver: { included: number; contract_name: string | null } | null = null;
  if (type === "production" && profile.can_view_money) {
    const { data: prodRow } = await admin
      .from("productions")
      .select("contract_id")
      .eq("id", id)
      .maybeSingle();
    const contractId = (prodRow?.contract_id as string | null) ?? null;
    if (contractId) {
      const { data: contractRow } = await admin
        .from("contracts")
        .select("id,name,included_episodes")
        .eq("id", contractId)
        .maybeSingle();
      const included = (contractRow?.included_episodes as number | null) ?? null;
      if (included != null) {
        const { data: siblings } = await admin
          .from("productions")
          .select("id,contract_id,status,cancelled_at,merged_into,record_date,created_at")
          .eq("contract_id", contractId);
        const q = quotaOf(included, contractId, (siblings ?? []) as unknown as QuotaProduction[]);
        // `some(id)` and not "am I past the count": the order is what decides
        // which episodes are over, and quotaOf already applied it. Asking the
        // question any other way here would be a second definition of
        // "the seventh episode".
        if (q && q.over.some((p) => p.id === id)) {
          quotaOver = { included: q.included, contract_name: (contractRow?.name as string | null) ?? null };
        }
      }
    }
  }

  if (type === "job" && profile.can_view_money) {
    const { data: links } = await supabase
      .from("job_productions")
      .select("production_id")
      .eq("job_id", id);
    if (links?.length) {
      const { data } = await supabase
        .from("productions")
        .select("id,podcast_name,record_date,guest")
        .in("id", links.map((l) => l.production_id));
      linked = data;
    } else linked = [];
  }
  if (type === "contract" && profile.can_view_money) {
    const { data } = await supabase
      .from("contract_milestones")
      .select("id,name,amount,expected_date,is_estimated,status,job_id")
      .eq("contract_id", id)
      .order("expected_date");
    // The drawer used to print the raw status column ("invoiced", in English,
    // on a Hebrew screen). It now carries the same derived state /contracts
    // shows — which needs is_estimated and the linked job's paid, or a
    // milestone whose job is paid would read "חויב" here and "שולם" there.
    //
    // invoice_biz / invoice_tax ride along since 2026-09-15: the state is
    // derived from the JOB now, and a document number on it means the bill went
    // out. Reading only `paid` here would put this drawer back where /contracts
    // used to be — a billed milestone reading "פתוח".
    const jobIds = (data ?? []).map((m) => m.job_id).filter(Boolean) as string[];
    const { data: msJobs } = jobIds.length
      ? await supabase.from("jobs").select("id,paid,invoice_biz,invoice_tax").in("id", jobIds)
      : { data: [] };
    const jobById = new Map(
      (msJobs ?? []).map((j) => [
        j.id as string,
        j as { paid: string | null; invoice_biz: string | null; invoice_tax: string | null },
      ])
    );
    const billed = (v: unknown) => v != null && String(v).trim() !== "";
    milestones = (data ?? []).map((m) => {
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
    });
  }

  // change history — events RLS is owner-only; mirror that here
  let history: unknown[] | null = null;
  if (profile.role === "owner") {
    const { data: events } = await admin
      .from("events")
      .select("id,event_type,actor_id,payload,created_at")
      .eq("entity_type", type)
      .eq("entity_id", id)
      .order("created_at", { ascending: false })
      .limit(20);
    const actorIds = Array.from(new Set((events ?? []).map((e) => e.actor_id).filter(Boolean)));
    const { data: actors } = actorIds.length
      ? await admin.from("profiles").select("id,name").in("id", actorIds)
      : { data: [] };
    const actorName: Record<string, string> = {};
    for (const a of actors ?? []) actorName[a.id] = a.name;
    history = (events ?? []).map((e) => ({
      id: e.id,
      event_type: e.event_type,
      actor: e.actor_id ? actorName[e.actor_id] ?? "—" : "מערכת",
      payload: e.payload,
      created_at: e.created_at,
    }));
  }

  return { status: 200, json: {
    type,
    icon: config.icon,
    label: config.label,
    title: (entity as unknown as Record<string, unknown>)[config.titleKey] ?? "—",
    entity,
    fields,
    optionsData: { clients: clients.data ?? [], shows: shows.data ?? [] },
    stages,
    linked,
    milestones,
    history,
    // gates the drawer's production status controls (the phone-friendly path
    // that replaces drag) — the DB trigger is the real enforcement
    canEditStages: !!profile.can_edit_stages,
    // gates "יצירת עבודה לחיוב" in the drawer. A separate flag and not
    // `linked !== null`: that block is populated for can_view_money, and
    // creating a job is a money WRITE. The route that does it re-checks
    // can_edit_money itself — this only decides whether the button is drawn.
    canEditMoney: !!profile.can_edit_money,
    // E17-3: "הרשאות הזמנת חדרים" is drawn for studio_admin only. The
    // booking-contacts route asks the same predicate and refuses everyone else.
    canManageBookingContacts: canManageBookingContacts(profile),
    // 0098 — set only when this episode is beyond its contract's quota.
    // null is the ordinary case and means "nothing to say".
    quotaOver,
    review,
    reviewItems,
    reviewLinks,
    reviewLinksIncomplete,
    reelsSummary,
    hourly,
    log,
    diskOptions,
  } };
}
