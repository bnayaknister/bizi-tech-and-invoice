import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveState } from "@/lib/finance/state";

// "Paid" OPENS, it doesn't close (owner spec 2026-07-18). Marking a job
// paid='כן' either lands it in "סגור" (if a tax invoice already went out) or
// throws it into the red "חסרה חשבונית מס" tab — the money is in but the tax
// document isn't, which is the real exposure. The route just flips paid and
// tells the client which case it is, so the UI can pop the "issue a tax
// invoice now?" loop. can_edit_money gated (route + RLS + 0010 money guard).
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { job_id?: string };
  if (!body.job_id) return NextResponse.json({ error: "חסר מזהה חיוב" }, { status: 400 });

  const { data: updated, error } = await supabase
    .from("jobs")
    .update({ paid: "כן" })
    .eq("id", body.job_id)
    .select("id,paid,invoice_biz,invoice_tax")
    .maybeSingle();
  if (error) {
    const guard = /הרשאת|רק בעל/.test(error.message);
    return NextResponse.json({ error: error.message }, { status: guard ? 403 : 400 });
  }
  if (!updated) return NextResponse.json({ error: "החיוב לא נמצא או שאין הרשאה" }, { status: 404 });

  const state = deriveState(updated);
  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: body.job_id,
    event_type: "job_marked_paid",
    actor_id: user.id,
    payload: { state, needs_tax_invoice: state === "red" },
  });

  return NextResponse.json({ ok: true, state, needs_tax: state === "red" });
}
