import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Attach / detach the contract that bills a show (0056, item G).
//
// The write lands on contracts.show_id, not on the show — but the action
// belongs to the show card, which is where a human decides "this programme is
// billed by contract". Sending contract_id:null detaches whatever is linked.
//
// Exactly one active contract may point at a show (partial unique index
// contracts_one_active_per_show). Rather than let the caller hit a raw 23505,
// this route detaches the incumbent first and then attaches the new one, so
// re-pointing a show at a different contract is a single, ordinary action.
//
// can_edit_money on both walls: the route check below, and the DB guard
// (guard_contract_money_columns, which 0056 extended to cover show_id).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { contract_id?: string | null };
  const contractId = body.contract_id ?? null;

  const admin = createAdminClient();

  const { data: show, error: showErr } = await admin
    .from("shows")
    .select("id,name,client_id,billing_mode")
    .eq("id", params.id)
    .maybeSingle();
  if (showErr) return NextResponse.json({ error: showErr.message }, { status: 400 });
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });

  // A contract is client-scoped (contracts.client_id is NOT NULL), so a show
  // with no client has nothing to attach. Say so plainly instead of failing
  // on a constraint further down.
  if (contractId && !show.client_id) {
    return NextResponse.json(
      { error: "לתוכנית אין לקוח משויך — אי אפשר לצרף חוזה. שייך לקוח קודם." },
      { status: 400 }
    );
  }

  if (contractId) {
    const { data: contract, error: cErr } = await admin
      .from("contracts")
      .select("id,name,client_id,status,show_id")
      .eq("id", contractId)
      .maybeSingle();
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 400 });
    if (!contract) return NextResponse.json({ error: "החוזה לא נמצא" }, { status: 404 });
    if (contract.client_id !== show.client_id) {
      return NextResponse.json({ error: "החוזה שייך ללקוח אחר" }, { status: 400 });
    }
    if (contract.status !== "active") {
      return NextResponse.json({ error: "אפשר לצרף רק חוזה פעיל" }, { status: 400 });
    }
    if (contract.show_id && contract.show_id !== params.id) {
      return NextResponse.json({ error: "החוזה כבר משויך לתוכנית אחרת" }, { status: 409 });
    }
  }

  // detach the incumbent first — the partial unique index allows only one
  const { error: clearErr } = await admin
    .from("contracts")
    .update({ show_id: null })
    .eq("show_id", params.id)
    .eq("status", "active");
  if (clearErr) return NextResponse.json({ error: clearErr.message }, { status: 400 });

  if (contractId) {
    const { error: linkErr } = await admin.from("contracts").update({ show_id: params.id }).eq("id", contractId);
    if (linkErr) return NextResponse.json({ error: linkErr.message }, { status: 400 });
  }

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: contractId ? "show_contract_linked" : "show_contract_unlinked",
    actor_id: user.id,
    payload: { contract_id: contractId, show: show.name },
  });

  return NextResponse.json({ ok: true, contract_id: contractId });
}
