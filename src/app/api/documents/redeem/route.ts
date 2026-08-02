import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createWorkOrderBundle, type AccruedWorkOrder } from "@/lib/documents/bundle";

// "פדה [לקוח]" (owner spec 2026-07-28): the bookkeeper releases a monthly /
// every_n client's accrued episodes. It produces ONE consolidated work order
// (a line per episode), queued 'pending' for her normal approval → issue.
// Nothing reaches Morning here. can_edit_money.
//
// Redemption deliberately stops at the work order (2026-08-02). It used to
// also build a consolidated deal invoice over whichever episodes happened to
// have a job, which had two failure modes that returned 200 with a buried
// note, and priced the two halves differently (the work order folds frozen
// payloads, the deal invoice read jobs.amount live). The deal invoice now
// comes from the work order itself, via Morning's "create based on"
// (linkedDocumentIds) — which is also what closes the order there.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { clientId?: string };
  const clientId = body.clientId;
  if (!clientId) return NextResponse.json({ error: "חסר לקוח" }, { status: 400 });

  const admin = createAdminClient();

  // the accrued work orders for this client
  const { data: accrued } = await admin
    .from("pending_documents")
    .select("id,client_id,amount,production_id,payload")
    .eq("doc_type", "work_order")
    .eq("status", "accrued")
    .eq("client_id", clientId);
  const rows = (accrued ?? []) as AccruedWorkOrder[];
  if (rows.length === 0) {
    return NextResponse.json({ error: "אין פרקים מסוכמים לפדיון עבור לקוח זה" }, { status: 400 });
  }

  // the consolidated work order (folds + marks the accrued rows)
  const wo = await createWorkOrderBundle(admin, rows, user.id);
  if (!wo.ok) return NextResponse.json({ error: wo.error }, { status: wo.status });

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: clientId,
    event_type: "billing_redeemed",
    actor_id: user.id,
    payload: {
      work_order_id: wo.id,
      work_order_lines: wo.lines,
      work_order_amount: wo.amount,
    },
  });

  return NextResponse.json({
    ok: true,
    work_order: { id: wo.id, lines: wo.lines, amount: wo.amount },
  });
}
