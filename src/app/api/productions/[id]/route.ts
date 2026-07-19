import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDocument } from "@/lib/documents/enqueue";

// Productions board actions (screens-spec §2). The DB is the wall:
//  - any status move requires can_edit_stages (trg_guard_production_stages)
//  - the move INTO 'אושר_ע"י_לקוח' requires can_edit_money and fires billing
//    (trg_guard_client_approval + trg_on_production_approved) — 0010/0002.
// This route just turns a raw DB exception into a clean message and writes
// the audit event.
const STATUSES = new Set([
  "עתיד_להתחיל",
  "בהקלטה",
  "הוקלט",
  "בעריכה",
  "נערך",
  "נשלח_ללקוח",
  "ממתין_לתגובת_לקוח",
  'אושר_ע"י_לקוח',
  "הופץ",
]);

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const id = params.id;
  const body = (await request.json()) as {
    status?: string;
    hold?: { on: boolean; reason?: string };
    needs_attention?: boolean;
  };

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  let patch: Record<string, unknown> = {};
  let eventType = "";
  let eventPayload: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) {
      return NextResponse.json({ error: "סטטוס לא מוכר" }, { status: 400 });
    }
    patch = { status: body.status };
    eventType = "production_status_changed";
    eventPayload = { to: body.status };
  } else if (body.hold !== undefined) {
    patch = body.hold.on
      ? {
          on_hold: true,
          on_hold_reason: body.hold.reason?.trim() || null,
          on_hold_since: new Date().toISOString(),
          on_hold_by: user.id,
        }
      : { on_hold: false, on_hold_reason: null, on_hold_since: null, on_hold_by: null };
    eventType = body.hold.on ? "production_held" : "production_unheld";
    eventPayload = { reason: body.hold.reason ?? null };
  } else if (body.needs_attention !== undefined) {
    patch = { needs_attention: body.needs_attention };
    eventType = "production_attention_toggled";
    eventPayload = { needs_attention: body.needs_attention };
  } else {
    return NextResponse.json({ error: "אין פעולה" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("productions")
    .update(patch)
    .eq("id", id)
    .select("id,status,on_hold,on_hold_reason,on_hold_since,needs_attention")
    .single();

  if (error) {
    // DB guard rejections (permission) surface here as a clean 403
    const isGuard = /הרשאת|רק בעל/.test(error.message);
    return NextResponse.json({ error: error.message }, { status: isGuard ? 403 : 400 });
  }
  if (!updated) {
    return NextResponse.json({ error: "ההפקה לא נמצאה או שאין הרשאה" }, { status: 404 });
  }

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: id,
    event_type: eventType,
    actor_id: user.id,
    payload: eventPayload,
  });

  // Client approval owes a deal invoice (חשבון עסקה) — queued for the
  // bookkeeper, never issued here (owner spec 2026-07-19). The DB trigger
  // trg_on_production_approved has already created the job by this point,
  // so we look it up and attach it; the queue row is what links the two.
  let queued: string | null = null;
  if (body.status === 'אושר_ע"י_לקוח') {
    const { data: prod } = await admin
      .from("productions")
      .select("id,kind,legacy,client_id,show_id,podcast_name,record_date")
      .eq("id", id)
      .maybeSingle();
    if (prod) {
      const { data: link } = await admin
        .from("job_productions")
        .select("job_id")
        .eq("production_id", id)
        .limit(1)
        .maybeSingle();
      const res = await enqueueDocument(admin, "deal_invoice", prod, { jobId: link?.job_id ?? null });
      queued = res.status;
    }
  }

  return NextResponse.json({ ok: true, production: updated, document_queued: queued });
}
