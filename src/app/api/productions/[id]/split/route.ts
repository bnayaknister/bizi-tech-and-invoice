import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Manual split (screens-spec, multi-episode session support, owner request
// 2026-07-17): the calendar sometimes bundles 2-3 real episodes into one
// event — only a technician on-site knows the true count. Everything runs
// through the caller's own session client so RLS (can_edit_stages, same
// gate as the calendar-sync columns, 0019) is the real wall; admin is used
// only to write the audit trail, matching /api/productions/[id]/route.ts.
//
// Split siblings deliberately share one calendar_uid — the original
// becomes "פרק 1 מתוך N", each new row "פרק 2..N מתוך N". A production with
// no calendar_uid yet (a manually-created one) gets a synthetic one so the
// group still has a shared key.
//
// Undo (DELETE) is one of the two "iron rule" undo cases: allowed only
// while no stage anywhere in the family has left 'pending' — it never hard
// deletes (this schema never does), it soft-hides the created siblings via
// merged_into, same mechanism as the calendar-duplicate merge.

async function requireStagesEditor() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) } as const;
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages)
    return { error: NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 }) } as const;
  return { supabase, user } as const;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const gate = await requireStagesEditor();
  if ("error" in gate) return gate.error;
  const { supabase, user } = gate;

  const body = (await request.json().catch(() => ({}))) as { count?: number };
  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 2 || count > 12) {
    return NextResponse.json({ error: "מספר פרקים לא תקין (2 עד 12)" }, { status: 400 });
  }

  const { data: original, error: origErr } = await supabase
    .from("productions")
    .select(
      "id,podcast_name,show_id,client_id,kind,contract_id,record_date,record_time,studio,camera_count,calendar_uid,split_count"
    )
    .eq("id", params.id)
    .maybeSingle();
  if (origErr || !original) return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  if (original.split_count) return NextResponse.json({ error: "ההפקה כבר מפוצלת" }, { status: 400 });

  const uid = original.calendar_uid ?? `manual-split-${crypto.randomUUID()}`;

  const { error: updOrigErr } = await supabase
    .from("productions")
    .update({ calendar_uid: uid, split_index: 1, split_count: count })
    .eq("id", params.id);
  if (updOrigErr) return NextResponse.json({ error: updOrigErr.message }, { status: 400 });

  const newRows = Array.from({ length: count - 1 }, (_, i) => ({
    podcast_name: original.podcast_name,
    show_id: original.show_id,
    client_id: original.client_id,
    kind: original.kind,
    contract_id: original.contract_id,
    record_date: original.record_date,
    record_time: original.record_time,
    studio: original.studio,
    camera_count: original.camera_count,
    calendar_uid: uid,
    split_index: i + 2,
    split_count: count,
    legacy: false,
  }));

  const { data: created, error: insErr } = await supabase.from("productions").insert(newRows).select("id");
  if (insErr) {
    // roll the original back rather than leave it "split" with no siblings
    await supabase.from("productions").update({ split_index: null, split_count: null }).eq("id", params.id);
    return NextResponse.json({ error: insErr.message }, { status: 400 });
  }

  const admin = createAdminClient();
  const createdIds = (created ?? []).map((r) => r.id as string);
  await admin.from("events").insert([
    {
      entity_type: "production",
      entity_id: params.id,
      event_type: "production_split",
      actor_id: user.id,
      payload: { count, created_ids: createdIds },
    },
    ...createdIds.map((cid) => ({
      entity_type: "production",
      entity_id: cid,
      event_type: "production_split_created",
      actor_id: user.id,
      payload: { split_of: params.id, split_count: count },
    })),
  ]);

  return NextResponse.json({ ok: true, created: createdIds });
}

export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireStagesEditor();
  if ("error" in gate) return gate.error;
  const { supabase, user } = gate;

  const { data: row, error: rowErr } = await supabase
    .from("productions")
    .select("id,calendar_uid,split_count,split_index")
    .eq("id", params.id)
    .maybeSingle();
  if (rowErr || !row) return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  if (!row.split_count || !row.calendar_uid) {
    return NextResponse.json({ error: "ההפקה אינה חלק מפיצול" }, { status: 400 });
  }

  const { data: family, error: famErr } = await supabase
    .from("productions")
    .select("id,split_index")
    .eq("calendar_uid", row.calendar_uid)
    .is("merged_into", null);
  if (famErr) return NextResponse.json({ error: famErr.message }, { status: 400 });

  const original = (family ?? []).find((f) => f.split_index === 1);
  if (!original) return NextResponse.json({ error: "לא נמצא הפרק המקורי של הפיצול" }, { status: 400 });
  const siblingIds = (family ?? []).filter((f) => f.id !== original.id).map((f) => f.id);

  const allIds = [original.id, ...siblingIds];
  const { data: stages, error: stagesErr } = await supabase
    .from("stages")
    .select("status")
    .in("production_id", allIds);
  if (stagesErr) return NextResponse.json({ error: stagesErr.message }, { status: 400 });
  if ((stages ?? []).some((s) => s.status !== "pending")) {
    return NextResponse.json({ error: "לא ניתן לבטל פיצול — כבר התחילה עבודה על אחד הפרקים" }, { status: 400 });
  }

  if (siblingIds.length) {
    const { error: mergeErr } = await supabase
      .from("productions")
      .update({ merged_into: original.id })
      .in("id", siblingIds);
    if (mergeErr) return NextResponse.json({ error: mergeErr.message }, { status: 400 });
  }
  // a synthetic uid (generated only because this production had none of its
  // own when split) has no reason to linger once the family is back down to
  // one row — clearing it keeps a since-undone split from ever looking like
  // a calendar duplicate later. A real, calendar-derived uid is left alone.
  const resetPatch: Record<string, unknown> = { split_index: null, split_count: null };
  if (row.calendar_uid.startsWith("manual-split-")) resetPatch.calendar_uid = null;

  const { error: resetErr } = await supabase.from("productions").update(resetPatch).eq("id", original.id);
  if (resetErr) return NextResponse.json({ error: resetErr.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: original.id,
    event_type: "production_split_undone",
    actor_id: user.id,
    payload: { removed_ids: siblingIds },
  });

  return NextResponse.json({ ok: true });
}
