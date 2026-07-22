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

// EntityDrawer backend. Everything flows through the user's own client so
// RLS and the 0010 column-guard triggers are the real gates; the field
// registry decides which columns are even selected (a field without view
// permission is never in the response), and events are written through the
// service client stamped with the acting user.

function parseType(type: string): EntityType | null {
  return (ENTITY_TYPES as string[]).includes(type) ? (type as EntityType) : null;
}

export async function GET(
  _request: Request,
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
  let reelsSummary: { base: number; extra: number; total: number } | null = null;
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
    const { data: r } = await supabase
      .from("productions")
      .select("review_episode_approved,review_reels_approved,review_reels_required,review_episode_note,review_reels_note")
      .eq("id", params.id)
      .maybeSingle();
    if (r) {
      review = {
        episode_approved: !!r.review_episode_approved,
        reels_approved: !!r.review_reels_approved,
        reels_required: !!r.review_reels_required,
        episode_note: (r.review_episode_note as string) ?? null,
        reels_note: (r.review_reels_note as string) ?? null,
      };
    }

    // reels tally = 2 standard + extra reels bought via add-ons. Add-ons stay
    // the single source of truth (owner decision 2026-07-22: no reels_count
    // column to drift) — this is a display roll-up over the still-live
    // (proposed/approved) add-on lines explicitly flagged is_reels_addon
    // (migration 0036), not a fragile title match.
    const REELS_BASE = 2;
    const { data: addons } = await supabase
      .from("production_addons")
      .select("quantity,status,is_reels_addon")
      .eq("production_id", params.id)
      .eq("is_reels_addon", true)
      .in("status", ["proposed", "approved"]);
    const extra = (addons ?? []).reduce((s, a) => s + (Number(a.quantity) || 0), 0);
    reelsSummary = { base: REELS_BASE, extra, total: REELS_BASE + extra };
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
      .select("id,name,amount,expected_date,status")
      .eq("contract_id", params.id)
      .order("expected_date");
    milestones = data;
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
    reelsSummary,
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
