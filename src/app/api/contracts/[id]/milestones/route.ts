import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Add a milestone to an existing contract. can_edit_money gated.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    amount?: number;
    expected_date?: string | null;
    is_estimated?: boolean;
  };
  if (!body.name?.trim() || body.amount == null) {
    return NextResponse.json({ error: "חסר שם או סכום לאבן הדרך" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("contract_milestones")
    .insert({
      contract_id: params.id,
      name: body.name.trim(),
      amount: body.amount,
      expected_date: body.expected_date || null,
      is_estimated: !!body.is_estimated,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: params.id,
    event_type: "milestone_added",
    actor_id: user.id,
    payload: { milestone_id: data.id, name: body.name.trim(), amount: body.amount },
  });
  return NextResponse.json({ ok: true, id: data.id });
}
