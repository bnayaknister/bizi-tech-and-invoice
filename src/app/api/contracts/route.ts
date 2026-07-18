import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Create a contract with its milestones. can_edit_money gated (route + RLS
// contracts_write / milestones_write, 0002 + the 0010 money guards).
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    client_id?: string;
    total_amount?: number;
    milestones?: { name: string; amount: number; expected_date?: string | null; is_estimated?: boolean }[];
  };
  const name = (body.name ?? "").trim();
  if (!name || !body.client_id || body.total_amount == null) {
    return NextResponse.json({ error: "חסרים שם, לקוח או סכום כולל" }, { status: 400 });
  }

  const { data: contract, error } = await supabase
    .from("contracts")
    .insert({ name, client_id: body.client_id, total_amount: body.total_amount, status: "active" })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const ms = (body.milestones ?? []).filter((m) => m.name?.trim() && m.amount != null);
  if (ms.length) {
    const { error: msErr } = await supabase.from("contract_milestones").insert(
      ms.map((m) => ({
        contract_id: contract.id,
        name: m.name.trim(),
        amount: m.amount,
        expected_date: m.expected_date || null,
        is_estimated: !!m.is_estimated,
        status: "pending",
      }))
    );
    if (msErr) return NextResponse.json({ error: msErr.message }, { status: 400 });
  }

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: contract.id,
    event_type: "contract_created",
    actor_id: user.id,
    payload: { name, total_amount: body.total_amount, milestones: ms.length },
  });

  return NextResponse.json({ ok: true, id: contract.id });
}
