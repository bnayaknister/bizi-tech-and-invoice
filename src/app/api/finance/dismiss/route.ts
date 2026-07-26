import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Hide / restore a finance record (owner spec 2026-07-26). A destructive-
// looking money action, so admin-only (can_manage_users) — NOT can_edit_money.
// Never deletes: sets dismissed + reason + who + when (or clears them on
// restore). Every action is evented. The write goes through the service role
// (auth.uid null → the 0041 guard passes); the permission wall is here.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_manage_users").eq("id", user.id).single();
  if (!profile?.can_manage_users) return NextResponse.json({ error: "רק מנהל משתמשים יכול להסתיר חיוב" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { job_id?: string; reason?: string; restore?: boolean };
  if (!body.job_id) return NextResponse.json({ error: "חסר מזהה חיוב" }, { status: 400 });

  const admin = createAdminClient();
  const { data: job } = await admin
    .from("jobs")
    .select("id,client_id,amount,invoice_biz,invoice_tax,dismissed")
    .eq("id", body.job_id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "החיוב לא נמצא" }, { status: 404 });

  if (body.restore) {
    await admin.from("jobs").update({ dismissed: false, dismiss_reason: null, dismissed_by: null, dismissed_at: null }).eq("id", body.job_id);
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: body.job_id,
      event_type: "job_restored",
      actor_id: user.id,
      payload: { amount: job.amount },
    });
    return NextResponse.json({ ok: true, dismissed: false });
  }

  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "חובה לציין סיבה" }, { status: 400 });

  const now = new Date().toISOString();
  await admin
    .from("jobs")
    .update({ dismissed: true, dismiss_reason: reason, dismissed_by: user.id, dismissed_at: now })
    .eq("id", body.job_id);
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: body.job_id,
    event_type: "job_dismissed",
    actor_id: user.id,
    payload: {
      reason,
      amount: job.amount,
      // recorded so an audit can see it was hidden despite a live Morning doc
      invoice_biz: job.invoice_biz ?? null,
      invoice_tax: job.invoice_tax ?? null,
    },
  });
  return NextResponse.json({ ok: true, dismissed: true });
}
