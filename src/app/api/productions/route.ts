import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDocument } from "@/lib/documents/enqueue";

// Manual production creation (owner request 2026-07-21). The calendar sync
// covers the automated path; this is the "+ הפקה חדשה" button on the board,
// for a session the calendar never carried. It mirrors the sync's create
// branch exactly so a hand-made production is indistinguishable from a
// synced one downstream:
//   - kind derived from the show's billing_mode (contract / client / internal)
//   - client / studio / camera_count / default editor inherited from the show
//   - 6 stages seeded by the create_default_stages() trigger
//   - a work order queued for the bookkeeper if the production is eligible
//   - legacy=false so it lands on the live board
//
// calendar_uid stays null on purpose: this row was never on the calendar,
// so the sync's match-by-uid loop must never touch it (no phantom "removed
// from calendar" flag, no update). The insert runs through the caller's own
// session so RLS (can_edit_stages) is the real wall — same pattern as the
// split route; admin is used only for show config, the audit event, the
// default-editor assignment, and the work-order queue.

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages")
    .eq("id", user.id)
    .single();
  if (!profile?.can_edit_stages)
    return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    show_id?: string;
    record_date?: string;
    record_time?: string | null;
    studio?: string | null;
    guest?: string | null;
    notes?: string | null;
  };

  const showId = body.show_id?.trim();
  const recordDate = body.record_date?.trim();
  if (!showId) return NextResponse.json({ error: "יש לבחור תוכנית" }, { status: 400 });
  if (!recordDate || !/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) {
    return NextResponse.json({ error: "תאריך הקלטה לא תקין" }, { status: 400 });
  }

  const admin = createAdminClient();
  // show config drives every inherited field — read it with admin so the
  // classification is resolved even for a stages-only creator who can't see
  // money columns, exactly as the calendar sync does
  const { data: show } = await admin
    .from("shows")
    .select("id,name,client_id,billing_mode,default_studio,camera_count,default_editor_id")
    .eq("id", showId)
    .maybeSingle();
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });

  // identical derivation to the sync create branch
  const kind =
    show.billing_mode === "contract"
      ? "contract"
      : show.billing_mode === "per_episode" && show.client_id
      ? "client"
      : "internal";

  const { data: inserted, error } = await supabase
    .from("productions")
    .insert({
      podcast_name: show.name,
      show_id: show.id,
      client_id: show.client_id,
      kind,
      record_date: recordDate,
      record_time: body.record_time?.trim() || null,
      guest: body.guest?.trim() || null,
      studio: body.studio?.trim() || show.default_studio || null,
      camera_count: show.camera_count,
      notes: body.notes?.trim() || null,
      calendar_uid: null,
      legacy: false,
    })
    .select("id")
    .single();
  if (error) {
    // RLS / guard rejection surfaces here as a clean 403
    const isGuard = /הרשאת|רק בעל/.test(error.message);
    return NextResponse.json({ error: error.message }, { status: isGuard ? 403 : 400 });
  }

  // "עורך קבוע" — auto-assign the edit steps the 6-stage trigger just created
  if (show.default_editor_id) {
    await admin
      .from("stages")
      .update({ assignee_id: show.default_editor_id })
      .eq("production_id", inserted.id)
      .eq("step", "edit");
  }

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: inserted.id,
    event_type: "production_created_manually",
    actor_id: user.id,
    payload: { show_id: show.id, show: show.name, record_date: recordDate, kind },
  });

  // same work-order queue as the sync create branch: queued if eligible,
  // otherwise a 🟡 with the reason (never issued here)
  const enq = await enqueueDocument(admin, "work_order", {
    id: inserted.id,
    kind,
    legacy: false,
    client_id: show.client_id,
    show_id: show.id,
    podcast_name: show.name,
    record_date: recordDate,
  });

  return NextResponse.json({ ok: true, id: inserted.id, work_order: enq.status });
}
