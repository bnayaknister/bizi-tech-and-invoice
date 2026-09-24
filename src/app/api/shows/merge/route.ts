import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { mergeBookingsInto, supabaseMergeOps } from "@/lib/booking/showLifecycle";

// The one merge in the system: an explicit, rare, two-show merge.
// No algorithm, no suggestions (owner decision 2026-07-13).
// Source's productions move to the target, source's name + aliases become
// target aliases, source row is deleted. Everything logged to events.
export async function POST(request: Request) {
  const { sourceId, targetId } = (await request.json()) as {
    sourceId: string;
    targetId: string;
  };
  if (!sourceId || !targetId || sourceId === targetId) {
    return NextResponse.json({ error: "צריך תוכנית מקור ותוכנית יעד שונות" }, { status: 400 });
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  // explicit columns (never "*"): default_rate's SELECT privilege is revoked
  // from the authenticated role (0021 money compartmentalization), so a
  // "select *" here would be denied for every caller. The merge doesn't need
  // the price anyway.
  const { data: rows, error: fetchErr } = await supabase
    .from("shows")
    .select("id,name,aliases,client_id,billing_mode,default_studio,camera_count,notes,color,active,is_oneoff")
    .in("id", [sourceId, targetId]);
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 400 });
  const source = rows?.find((s) => s.id === sourceId);
  const target = rows?.find((s) => s.id === targetId);
  if (!source || !target) {
    return NextResponse.json({ error: "תוכנית המקור או היעד לא נמצאה" }, { status: 404 });
  }

  const { data: moved, error: movedErr } = await supabase
    .from("productions")
    .select("id")
    .eq("show_id", sourceId);
  if (movedErr) return NextResponse.json({ error: movedErr.message }, { status: 400 });

  const newAliases = Array.from(
    new Set([...(target.aliases ?? []), source.name, ...(source.aliases ?? [])])
  ).filter((a) => a !== target.name);

  const { error: aliasErr } = await supabase
    .from("shows")
    .update({ aliases: newAliases })
    .eq("id", targetId);
  if (aliasErr) return NextResponse.json({ error: aliasErr.message }, { status: 400 });

  const { error: repointErr } = await supabase
    .from("productions")
    .update({ show_id: targetId })
    .eq("show_id", sourceId);
  if (repointErr) return NextResponse.json({ error: repointErr.message }, { status: 400 });

  // ⚠️ THE BOOKINGS MOVE BEFORE THE DELETE, AND THE DELETE IS SKIPPED IF THEY
  // DO NOT (24.9). Until now this route did not know booking_links or
  // booking_requests existed, and 0096's link_id RESTRICT is non-deferrable —
  // so deleting the source either aborted on a raw FK error or took its
  // decision history with it.
  //
  // 🔴 NOT A TRANSACTION. supabase-js issues one HTTP request per statement, so
  // these two moves and the DELETE below are three independent statements, and
  // wrapping them would need a Postgres function (a schema change, which this
  // stage does not have). The ORDER is the guarantee instead: links, then
  // requests, then the delete — each stopping point leaves a state that
  // re-running the merge completes. See mergeBookingsInto.
  const movedBookings = await mergeBookingsInto(supabaseMergeOps(createTypedAdminClient()), {
    sourceId,
    targetId,
    userId: user.id,
  });
  if (!movedBookings.ok) {
    return NextResponse.json({ error: movedBookings.error }, { status: 400 });
  }

  const { error: deleteErr, count } = await supabase
    .from("shows")
    .delete({ count: "exact" })
    .eq("id", sourceId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 400 });
  if (count !== 1) {
    return NextResponse.json({ error: "אין הרשאה למחוק את תוכנית המקור" }, { status: 403 });
  }

  // events RLS blocks direct user inserts — audit writes go through the
  // service client, stamped with the acting user
  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: targetId,
    event_type: "show_merged",
    actor_id: user.id,
    payload: {
      target_id: targetId,
      target_aliases_before: target.aliases ?? [],
      source_show: source, // full snapshot — enables manual undo
      moved_production_ids: (moved ?? []).map((p) => p.id),
    },
  });

  return NextResponse.json({
    ok: true,
    movedProductions: (moved ?? []).length,
    targetAliases: newAliases,
  });
}
