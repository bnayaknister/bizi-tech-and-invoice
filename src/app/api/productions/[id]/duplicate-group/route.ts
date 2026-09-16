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
  // can_edit_money rides along for the DELETE below — the row is fetched here
  // anyway, so the second tier costs no extra query. POST does not read it and
  // is unchanged: confirm/merge stay stages-tier.
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_stages)
    return { error: NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 }) } as const;
  return { supabase, user, canEditMoney: !!profile.can_edit_money } as const;
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

  // calendar_dup_ack=false scopes this to still-unresolved rows only — an
  // earlier confirmed/settled group for the same show+day (calendar_dup_ack
  // already true) must never get swept into a *new* confirm/merge action
  const { data: group } = await supabase
    .from("productions")
    .select("id,calendar_uid,created_at")
    .eq("show_id", origin.show_id)
    .eq("record_date", origin.record_date)
    .eq("calendar_dup_ack", false)
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
//
// ═══ MONEY TIER, ALWAYS — owner decision 2026-09-16 ═══
//
// Undoing a merge is not a technician action in any case. A technician who
// merged by mistake goes to the owner.
//
// This REPLACES the conditional tier of 45b5c2a, which asked whether THIS
// duplicate had a dismissed job or a rejected queue row and demanded money
// permission only then. The owner read that and drew the line higher, and the
// simpler rule is also the more honest one: the conditional version protected
// the money a merge had ALREADY moved, and had nothing to say about the money
// the un-merge is about to let flow — a production returning to the board can
// reach client approval and queue a fresh invoice, which is exactly how
// ליעד הרמן 28.8 ended up one click from being billed twice. Every merge in
// the table so far carried a dismissed job anyway (measured 16.9: 3 of 3), so
// the conditional branch was drawing a distinction the data never made.
//
// FIRST, before reading the row or its stages: the answer to "may I do this at
// all" must not depend on what the row happens to contain.
//
// The MERGE itself (POST above) is unchanged and stays stages-tier — a
// technician resolving a calendar duplicate is the case that button exists for.
export async function DELETE(_request: Request, { params }: { params: { id: string } }) {
  const gate = await requireStagesEditor();
  if ("error" in gate) return gate.error;
  const { supabase, user, canEditMoney } = gate;

  if (!canEditMoney) {
    return NextResponse.json(
      { error: "ביטול מיזוג זמין רק למנהלי כספים. פנה לבעלים." },
      { status: 403 }
    );
  }

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

  // ---- WHAT THIS UNDO IS ABOUT TO LEAVE BEHIND ---------------------------
  //
  // Read for the AUDIT TRAIL only — the permission question was settled at the
  // top of this function and no longer depends on any of it. The update below
  // clears merged_into and nothing else, so a dismissed job stays dismissed and
  // a rejected work order stays rejected: the production comes back to the
  // board with its money side still in the merged state. That was invisible
  // until now (the payload was `{}`), and reconstructing it on 16.9 took
  // reading two migrations.
  const admin = createAdminClient();
  const { data: dupJobLinks } = await admin
    .from("job_productions")
    .select("job_id,jobs(id,dismissed)")
    .eq("production_id", params.id);
  const dismissedJobIds = ((dupJobLinks ?? []) as unknown as Array<Record<string, unknown>>)
    .filter((l) => (l.jobs as { dismissed?: boolean } | null)?.dismissed === true)
    .map((l) => l.job_id as string);

  // Rejected queue rows reached through EITHER anchor. A work order queued at
  // creation carries production_id; one stamped later (0077) carries job_id.
  const jobIdsHere = ((dupJobLinks ?? []) as unknown as Array<Record<string, unknown>>).map(
    (l) => l.job_id as string
  );
  const [byProd, byJob] = await Promise.all([
    admin.from("pending_documents").select("id").eq("production_id", params.id).eq("status", "rejected"),
    jobIdsHere.length
      ? admin.from("pending_documents").select("id").in("job_id", jobIdsHere).eq("status", "rejected")
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);
  const rejectedDocIds = Array.from(
    new Set([...(byProd.data ?? []), ...(byJob.data ?? [])].map((r) => (r as { id: string }).id))
  );

  const { error } = await supabase.from("productions").update({ merged_into: null }).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "production_merge_undone",
    actor_id: user.id,
    // What this undo did NOT undo (gathered above) — naming it here makes the
    // next re-merge a query rather than a dig through migrations.
    payload: {
      restored_merged_into: false,
      not_restored: {
        dismissed_job_ids: dismissedJobIds,
        rejected_pending_document_ids: rejectedDocIds,
      },
    },
  });

  return NextResponse.json({ ok: true });
}
