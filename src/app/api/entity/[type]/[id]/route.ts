import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionAndProfile } from "@/lib/profile";
import {
  ENTITY_CONFIG,
  ENTITY_TYPES,
  canEditField,
  canViewField,
  editableKeys,
  selectColumns,
  type EntityType,
} from "@/lib/entities";
import { deriveMilestoneState } from "@/lib/finance/milestone";
import { must, SupabaseReadError, type QueryResult } from "@/lib/supabase/unwrap";
import { getAppBaseUrl } from "@/lib/appUrl";

// EntityDrawer backend. Everything flows through the user's own client so
// RLS and the 0010 column-guard triggers are the real gates; the field
// registry decides which columns are even selected (a field without view
// permission is never in the response), and events are written through the
// service client stamped with the acting user.
//
// ─── This route stays on the UNTYPED supabase client. By decision, not debt.
//
// It is a generic entity gateway: both the table (`config.table`) and the
// column list (`selectColumns(type, profile)`) are resolved at runtime from
// the field registry and the caller's permissions. That indirection is the
// feature — one route serves every entity, and a field's visibility is
// declared once in lib/entities.ts rather than duplicated per endpoint.
//
// A schema-aware client wants both of those as compile-time literals. Measured
// 2026-08-12: adding the generic here produces 12 of the repo's 35 errors, and
// every one of them is TypeScript objecting to the dynamism on purpose. The
// only way to satisfy it would be to unroll the registry into a literal per
// entity — trading the single source of truth for type coverage on a route
// whose whole job is to not have one.
//
// So: this file is deliberately excluded. Its safety net is the field registry
// plus RLS plus the DB guards, not the type system. Everything else in the repo
// should move to the typed client; do not "fix" this one to match.

function parseType(type: string): EntityType | null {
  return (ENTITY_TYPES as string[]).includes(type) ? (type as EntityType) : null;
}

// A read that fails must reach the caller as a failure. Without this the
// SupabaseReadError below would surface as a bare 500 with no message; with
// it, the drawer shows which read broke and why (see lib/supabase/unwrap.ts).
export async function GET(
  request: Request,
  ctx: { params: { type: string; id: string } }
) {
  try {
    return await handleGet(request, ctx);
  } catch (e) {
    if (e instanceof SupabaseReadError) {
      console.error("[entity]", e);
      return NextResponse.json({ error: e.message }, { status: 500 });
    }
    throw e;
  }
}

async function handleGet(
  request: Request,
  { params }: { params: { type: string; id: string } }
) {
  const type = parseType(params.type);
  if (!type) return NextResponse.json({ error: "סוג ישות לא מוכר" }, { status: 400 });
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const supabase = createClient();
  const config = ENTITY_CONFIG[type];

  const { data: entity, error } = await supabase
    .from(config.table)
    .select(selectColumns(type, profile))
    .eq("id", params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!entity) return NextResponse.json({ error: "לא נמצא או שאין הרשאה" }, { status: 404 });

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
    needsClients ? supabase.from("clients").select("id,name").order("name") : Promise.resolve({ data: null }),
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
  if (type === "production" && profile.can_view_stages) {
    const { data } = await supabase
      .from("stages")
      .select("id,track,step,status,assignee_id,done_at")
      .eq("production_id", params.id)
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
        .eq("id", params.id)
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

    // per-item media links (0057) — read via the service role: the table has
    // no user policies, and can_view_stages above is the real gate. Empty for
    // a production the items model hasn't reached yet (seeded at link mint).
    const itemsAdmin = createAdminClient();
    const { data: itemRows } = await itemsAdmin
      .from("client_review_items")
      .select("id,kind,reel_index,media_link,approved,last_note")
      .eq("production_id", params.id)
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
    const { data: linkRows } = await supabase
      .from("client_review_links")
      .select("id,token,scope,created_at,expires_at,superseded,responded_at")
      .eq("production_id", params.id)
      .eq("superseded", false)
      .is("responded_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    // same base URL the mint route stamps into the link it hands out
    const origin = getAppBaseUrl(request);
    reviewLinks = (linkRows ?? []).map((r) => ({
      id: r.id as string,
      url: `${origin}/r/${r.token as string}`,
      scope: (r.scope as string) ?? "all",
      created_at: r.created_at as string,
    }));
  }

  // production journal (§3, owner 2026-07-24) + disk autocomplete (§2). Both
  // for anyone who can see the production. The log is RLS-gated (stage OR money
  // viewer); author names are resolved via the admin client because a non-owner
  // session can't read other profiles' rows (profiles RLS is self-or-owner) —
  // names aren't sensitive, and the log rows themselves were already permitted.
  let log: unknown[] | null = null;
  let diskOptions: string[] | null = null;
  if (type === "production" && (profile.can_view_stages || profile.can_view_money)) {
    const [{ data: logRows }, { data: diskRows }] = await Promise.all([
      supabase
        .from("production_log")
        .select("id,kind,track,step,stage_status,note,author_id,created_at,edited_at")
        .eq("production_id", params.id)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("productions")
        .select("storage_disk")
        .not("storage_disk", "is", null)
        .limit(1000),
    ]);
    const admin = createAdminClient();
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
    diskOptions = Array.from(
      new Set((diskRows ?? []).map((d) => (d.storage_disk as string)).filter(Boolean))
    ).sort();
  }
  if (type === "production" && profile.can_view_money) {
    const { data: links } = await supabase
      .from("job_productions")
      .select("job_id")
      .eq("production_id", params.id);
    if (links?.length) {
      const { data } = await supabase
        .from("jobs")
        .select("id,date,campaign,amount")
        .in("id", links.map((l) => l.job_id));
      linked = data;
    } else linked = [];
  }
  if (type === "job" && profile.can_view_money) {
    const { data: links } = await supabase
      .from("job_productions")
      .select("production_id")
      .eq("job_id", params.id);
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
      .eq("contract_id", params.id)
      .order("expected_date");
    // The drawer used to print the raw status column ("invoiced", in English,
    // on a Hebrew screen). It now carries the same derived state /contracts
    // shows — which needs is_estimated and the linked job's paid, or a
    // milestone whose job is paid would read "חויב" here and "שולם" there.
    const jobIds = (data ?? []).map((m) => m.job_id).filter(Boolean) as string[];
    const { data: msJobs } = jobIds.length
      ? await supabase.from("jobs").select("id,paid").in("id", jobIds)
      : { data: [] };
    const paidByJob = new Map((msJobs ?? []).map((j) => [j.id as string, j.paid as string | null]));
    milestones = (data ?? []).map((m) => ({
      ...m,
      state: deriveMilestoneState({
        status: m.status,
        expected_date: m.expected_date,
        is_estimated: m.is_estimated,
        jobPaid: m.job_id ? paidByJob.get(m.job_id) ?? null : null,
      }),
    }));
  }

  // change history — events RLS is owner-only; mirror that here
  let history: unknown[] | null = null;
  if (profile.role === "owner") {
    const admin = createAdminClient();
    const { data: events } = await admin
      .from("events")
      .select("id,event_type,actor_id,payload,created_at")
      .eq("entity_type", type)
      .eq("entity_id", params.id)
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

  return NextResponse.json({
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
    review,
    reviewItems,
    reviewLinks,
    reelsSummary,
    log,
    diskOptions,
  });
}

export async function POST(
  request: Request,
  { params }: { params: { type: string; id: string } }
) {
  const type = parseType(params.type);
  if (!type) return NextResponse.json({ error: "סוג ישות לא מוכר" }, { status: 400 });
  const { user, profile } = await getSessionAndProfile();
  if (!user || !profile?.approved) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json()) as {
    patch?: Record<string, unknown>;
    stage?: { id: string; patch: Record<string, unknown> };
    undoOf?: string; // event id this change reverts, for the audit trail
    confirm_morning?: boolean; // client edit: user confirmed the Morning propagation
  };
  const supabase = createClient();
  const admin = createAdminClient();
  const config = ENTITY_CONFIG[type];

  // --- stage sub-update (production drawer): RLS on stages is the gate ---
  if (type === "production" && body.stage) {
    const allowed = ["status", "assignee_id"];
    const stagePatch = Object.fromEntries(
      Object.entries(body.stage.patch).filter(([k]) => allowed.includes(k))
    );
    if (!Object.keys(stagePatch).length)
      return NextResponse.json({ error: "אין שדות מותרים בעדכון" }, { status: 400 });
    const { data, error } = await supabase
      .from("stages")
      .update(stagePatch)
      .eq("id", body.stage.id)
      .eq("production_id", params.id)
      .select("id,track,step,status,assignee_id,done_at");
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    if (!data?.length) return NextResponse.json({ error: "אין הרשאה לעדכן שלבים" }, { status: 403 });
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: params.id,
      event_type: "stage_updated",
      actor_id: user.id,
      payload: { stage_id: body.stage.id, patch: stagePatch, source: "entity_drawer" },
    });
    return NextResponse.json({ ok: true, stage: data[0] });
  }

  // --- entity field update ---
  const patch = body.patch ?? {};
  const allowed = editableKeys(type, profile);
  const rejected = Object.keys(patch).filter((k) => !allowed.has(k));
  if (rejected.length) {
    return NextResponse.json(
      { error: `אין הרשאה לערוך: ${rejected.join(", ")}` },
      { status: 403 }
    );
  }
  if (!Object.keys(patch).length)
    return NextResponse.json({ error: "אין שינויים" }, { status: 400 });

  const { data: before, error: beforeErr } = await supabase
    .from(config.table)
    .select(selectColumns(type, profile))
    .eq("id", params.id)
    .maybeSingle();
  if (beforeErr || !before)
    return NextResponse.json({ error: "לא נמצא או שאין הרשאה" }, { status: 404 });

  // Addition 2 (owner spec 2026-07-21): editing a MAPPED client's details
  // propagates to Morning. Morning-first + double confirmation so the two
  // never diverge: a failed Morning write leaves local untouched ("כשלון →
  // לא מעודכן באף אחד"); a success updates both. We only propagate the
  // fields Morning actually holds — today that's the client name.
  //
  // (Documents are deliberately absent here: an issued Morning document has
  // NO update endpoint — it's immutable by design — so it can never be edited
  // from the app. That boundary is enforced by there being no code path.)
  if (type === "client" && "name" in patch) {
    const { data: mc } = await admin
      .from("clients")
      .select("morning_client_id,name")
      .eq("id", params.id)
      .maybeSingle();
    const morningId = mc?.morning_client_id as string | null;
    const nameChanged = patch.name !== mc?.name;
    if (morningId && nameChanged) {
      if (!body.confirm_morning) {
        return NextResponse.json(
          {
            needs_morning_confirmation: true,
            changes: { name: { from: mc?.name ?? null, to: patch.name } },
          },
          { status: 409 }
        );
      }
      try {
        const { updateClient } = await import("@/lib/morning/client");
        await updateClient(morningId, { name: patch.name });
      } catch (e) {
        const message = e instanceof Error ? e.message : "עדכון מורנינג נכשל";
        await admin.from("events").insert({
          entity_type: "client",
          entity_id: params.id,
          event_type: "client_morning_update_failed",
          actor_id: user.id,
          payload: { attempted: { name: patch.name }, error: message },
        });
        // nothing local changed — the update below never runs
        return NextResponse.json({ error: `עדכון מורנינג נכשל, לא בוצע שינוי: ${message}` }, { status: 502 });
      }
    }
  }

  const { data: updated, error } = await supabase
    .from(config.table)
    .update(patch)
    .eq("id", params.id)
    .select(selectColumns(type, profile));
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated?.length) return NextResponse.json({ error: "אין הרשאה לעדכן" }, { status: 403 });

  const beforeRec = before as unknown as Record<string, unknown>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(patch)) {
    changes[k] = { from: beforeRec[k] ?? null, to: patch[k] ?? null };
  }
  await admin.from("events").insert({
    entity_type: type,
    entity_id: params.id,
    event_type: body.undoOf ? "entity_update_reverted" : "entity_updated",
    actor_id: user.id,
    payload: {
      changes,
      source: "entity_drawer",
      ...(body.confirm_morning ? { propagated_to_morning: true } : {}),
      ...(body.undoOf ? { undo_of: body.undoOf } : {}),
    },
  });

  return NextResponse.json({ ok: true, entity: updated[0] });
}
