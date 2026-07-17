import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Calendar-duplicate handling (screens-spec, multi-episode session support,
// owner request 2026-07-17): two calendar events for the same show on the
// same day already become two independent productions (each its own
// calendar_uid) — the sync never merges them on its own ("לעולם אל תמזג
// אוטומטית"). A technician resolves the ambiguity here:
//   confirm — really N separate episodes; silences the badge (calendar_dup_ack)
//   merge   — a calendar mistake; soft-hide every row but one (merged_into)
// Both are stages-tier (can_edit_stages), enforced by the 0019 guard
// trigger; this route just derives the group from the clicked production
// and writes the audit trail, same pattern as /api/productions/[id]/route.ts.

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

async function findDupGroup(
  supabase: ReturnType<typeof createClient>,
  productionId: string
) {
  const { data: origin } = await supabase
    .from("productions")
    .select("id,show_id,record_date")
    .eq("id", productionId)
    .maybeSingle();
  if (!origin?.show_id || !origin.record_date) return null;

  const { data: group } = await supabase
    .from("productions")
    .select("id,calendar_uid,created_at")
    .eq("show_id", origin.show_id)
    .eq("record_date", origin.record_date)
    .is("merged_into", null)
    .not("calendar_uid", "is", null);
  const rows = group ?? [];
  const distinctUids = new Set(rows.map((r) => r.calendar_uid));
  if (distinctUids.size < 2) return null;
  return rows;
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const gate = await requireStagesEditor();
  if ("error" in gate) return gate.error;
  const { supabase, user } = gate;

  const body = (await request.json().catch(() => ({}))) as { action?: "confirm" | "merge" };
  const rows = await findDupGroup(supabase, params.id);
  if (!rows) return NextResponse.json({ error: "אין קבוצת כפילויות פעילה" }, { status: 400 });

  const admin = createAdminClient();

  if (body.action === "confirm") {
    const ids = rows.map((r) => r.id);
    const { error } = await supabase.from("productions").update({ calendar_dup_ack: true }).in("id", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await admin.from("events").insert(
      ids.map((pid) => ({
        entity_type: "production",
        entity_id: pid,
        event_type: "calendar_duplicate_confirmed",
        actor_id: user.id,
        payload: { group_size: ids.length },
      }))
    );
    return NextResponse.json({ ok: true });
  }

  if (body.action === "merge") {
    const sorted = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    const survivor = sorted[0];
    const rest = sorted.slice(1);
    const { error } = await supabase
      .from("productions")
      .update({ merged_into: survivor.id })
      .in(
        "id",
        rest.map((r) => r.id)
      );
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    await admin.from("events").insert(
      rest.map((r) => ({
        entity_type: "production",
        entity_id: r.id,
        event_type: "production_merged",
        actor_id: user.id,
        payload: { merged_into: survivor.id, reason: "calendar_duplicate" },
      }))
    );
    return NextResponse.json({ ok: true, survivor: survivor.id, removed: rest.map((r) => r.id) });
  }

  return NextResponse.json({ error: "פעולה לא מוכרת" }, { status: 400 });
}

// Undo a merge (the other "iron rule" undo case) — only while the merged-
// away production itself never left 'pending'. `params.id` here is the
// ABSORBED production's id (surfaced on the survivor's card as "מוזג לכאן").
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireStagesEditor();
  if ("error" in gate) return gate.error;
  const { supabase, user } = gate;

  const { data: row, error: rowErr } = await supabase
    .from("productions")
    .select("id,merged_into")
    .eq("id", params.id)
    .maybeSingle();
  if (rowErr || !row) return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  if (!row.merged_into) return NextResponse.json({ error: "ההפקה אינה ממוזגת" }, { status: 400 });

  const { data: stages, error: stagesErr } = await supabase
    .from("stages")
    .select("status")
    .eq("production_id", params.id);
  if (stagesErr) return NextResponse.json({ error: stagesErr.message }, { status: 400 });
  if ((stages ?? []).some((s) => s.status !== "pending")) {
    return NextResponse.json({ error: "לא ניתן לבטל מיזוג — כבר התחילה עבודה" }, { status: 400 });
  }

  const { error } = await supabase.from("productions").update({ merged_into: null }).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "production_merge_undone",
    actor_id: user.id,
    payload: {},
  });

  return NextResponse.json({ ok: true });
}
