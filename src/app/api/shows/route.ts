import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Create a show ("+ תוכנית חדשה"). Until now every show came from the historical
// import — a brand-new podcast walking into the studio had nowhere to go
// (owner 2026-07-22). Operational fields need can_edit_stages; money fields
// (client, rate, billing) need can_edit_money — a stages-only tech creates the
// show without them and the owner fills them in later.

// Same normalization the calendar-sync matcher uses (linking.ts): a collision
// under THIS function is a collision the sync would make — a recording landing
// on the wrong show. Keep the two in lockstep.
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’"׳״`.,:;!?()[\]/\\*+\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_stages && !profile?.can_edit_money) {
    return NextResponse.json({ error: "אין הרשאה ליצור תוכנית" }, { status: 403 });
  }
  const canMoney = !!profile.can_edit_money;

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    aliases?: string[];
    client_id?: string | null;
    billing_mode?: string;
    default_rate?: number | null;
    // 0067 — a separate axis from billing_mode. An hourly show still bills once
    // per production (billing_mode stays 'per_episode'); only the way the
    // amount is computed changes.
    pricing_model?: string;
    hourly_rate?: number | null;
    default_studio?: string | null;
    camera_count?: number | null;
    default_editor_id?: string | null;
    notes?: string | null;
    internal_confirmed?: boolean;
    // deliverables composition (0055) — stage-tier, so a stages-only creator
    // sets it too. Omitted => the column defaults (episode + 2 reels), which
    // is what every show looked like before 0055.
    has_episode?: boolean;
    reels_count?: number | null;
  };

  const name = (body.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return NextResponse.json({ error: "שם התוכנית חובה" }, { status: 400 });
  // de-dupe, drop blanks, drop an alias equal to the name
  const aliases = Array.from(
    new Set((body.aliases ?? []).map((a) => a.trim().replace(/\s+/g, " ")).filter((a) => a && a !== name))
  );

  // ---- deliverables composition (0055) ----
  const hasEpisode = body.has_episode ?? true;
  const reelsCount = body.reels_count == null ? 2 : Number(body.reels_count);
  if (!Number.isInteger(reelsCount) || reelsCount < 0) {
    return NextResponse.json({ error: "כמות הרילז חייבת להיות מספר שלם שאינו שלילי" }, { status: 400 });
  }
  // the DB guard says the same thing; catching it here returns the sentence
  // without a round trip and without a raw postgres error in the UI
  if (!hasEpisode && reelsCount === 0) {
    return NextResponse.json(
      { error: "תוכנית חייבת לכלול פרק מוקלט או לפחות ריל אחד — אחרת היא לא מייצרת שום תוצר" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // ---- duplicate name / alias check across every existing show ----
  const { data: existing, error: exErr } = await admin.from("shows").select("id,name,aliases");
  if (exErr) return NextResponse.json({ error: exErr.message }, { status: 400 });
  const mine = new Set([name, ...aliases].map(norm));
  for (const s of existing ?? []) {
    for (const label of [s.name as string, ...(((s.aliases as string[]) ?? []))]) {
      if (label && mine.has(norm(label))) {
        return NextResponse.json(
          { error: `התוכנית "${s.name}" כבר משתמשת ב"${label}" — כינוי כפול ישלח הקלטה לתוכנית הלא נכונה`, code: "duplicate" },
          { status: 409 }
        );
      }
    }
  }

  // ---- money vs stages: a stages-only creator never sets client/rate/billing
  const client_id = canMoney ? body.client_id ?? null : null;
  let billing_mode = canMoney ? body.billing_mode ?? "none" : "none";
  let default_rate = canMoney && billing_mode === "per_episode" ? body.default_rate ?? null : null;

  // ---- 0067: which of the two rates this show carries -----------------------
  // Only per-episode billing has a pricing model to choose: a contract show
  // bills from milestones and an internal one bills nothing, so neither has a
  // rate of either kind. shows_one_rate_per_model refuses a row carrying both,
  // which is why they are computed together here rather than passed through
  // independently — the constraint is not a validation to bounce off, it is the
  // shape the row has to arrive in.
  let pricing_model =
    canMoney && billing_mode === "per_episode" && body.pricing_model === "per_hour" ? "per_hour" : "per_episode";
  let hourly_rate = pricing_model === "per_hour" ? body.hourly_rate ?? null : null;
  if (pricing_model === "per_hour") default_rate = null;
  if (hourly_rate != null && (!Number.isFinite(Number(hourly_rate)) || Number(hourly_rate) < 0)) {
    return NextResponse.json({ error: "תעריף שעתי לא תקין" }, { status: 400 });
  }
  if (default_rate != null && (!Number.isFinite(Number(default_rate)) || Number(default_rate) < 0)) {
    return NextResponse.json({ error: "מחיר לפרק לא תקין" }, { status: 400 });
  }

  // ---- no client => internal, and only with an explicit confirmation (same
  // rule the orphan-shows flow uses) ----
  if (!client_id) {
    billing_mode = "none";
    default_rate = null;
    // an internal show carries neither rate, so it is per_episode by default —
    // the value every existing row has, and the only one the constraint allows
    // beside a null default_rate
    pricing_model = "per_episode";
    hourly_rate = null;
    if (!body.internal_confirmed) {
      return NextResponse.json(
        { error: "אין לקוח מקושר — זו הפקה פנימית?", code: "needs_internal_confirmation" },
        { status: 409 }
      );
    }
  }

  const { data: show, error } = await admin
    .from("shows")
    .insert({
      name,
      aliases,
      client_id,
      billing_mode,
      default_rate,
      pricing_model,
      hourly_rate,
      default_studio: body.default_studio?.trim() || null,
      camera_count: body.camera_count ?? null,
      default_editor_id: body.default_editor_id || null,
      notes: body.notes?.trim() || null,
      active: true,
      has_episode: hasEpisode,
      reels_count: reelsCount,
    })
    // hourly_rate stays out of the returning list beside default_rate — this
    // insert runs on the service role so it COULD be read, but the response is
    // handed to a screen that must not learn a rate it did not already know.
    // The caller gets it back through `default_rate`/`hourly_rate` below, which
    // are the values it just sent.
    .select("id,name,client_id,aliases,default_studio,camera_count,notes,active,is_oneoff,color,billing_mode,has_episode,reels_count,pricing_model")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: show.id,
    event_type: "show_created",
    actor_id: user.id,
    payload: {
      name, aliases, client_id, billing_mode, internal: !client_id,
      has_episode: hasEpisode, reels_count: reelsCount,
      // 0067: which rate this show was born carrying, so "why is this episode
      // 875 ₪" is answerable from the log rather than reconstructed
      pricing_model, priced: pricing_model === "per_hour" ? hourly_rate != null : default_rate != null,
    },
  });

  return NextResponse.json({ ok: true, show, default_rate, hourly_rate });
}
