import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Edit a milestone's expected date / estimated flag / name / amount.
// can_edit_money gated. The "edit an estimated date" action lives here.
const ALLOWED = new Set(["expected_date", "is_estimated", "name", "amount"]);

export async function POST(request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { patch?: Record<string, unknown> };
  const patch = body.patch ?? {};
  const bad = Object.keys(patch).filter((k) => !ALLOWED.has(k));
  if (bad.length) return NextResponse.json({ error: `שדה לא מותר: ${bad.join(", ")}` }, { status: 400 });
  if (!Object.keys(patch).length) return NextResponse.json({ error: "אין שינויים" }, { status: 400 });

  const { data, error } = await supabase
    .from("contract_milestones")
    .update(patch)
    .eq("id", params.mid)
    .select("id,contract_id,expected_date,is_estimated,name,amount")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: data.contract_id,
    event_type: "milestone_updated",
    actor_id: user.id,
    payload: { milestone_id: params.mid, patch },
  });
  return NextResponse.json({ ok: true, milestone: data });
}
