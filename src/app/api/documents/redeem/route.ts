import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createWorkOrderBundle, createDealInvoiceBundle, type AccruedWorkOrder } from "@/lib/documents/bundle";

// "פדה [לקוח]" (owner spec 2026-07-28): the bookkeeper releases a monthly /
// every_n client's accrued episodes. It produces ONE consolidated work order
// (a line per episode) and ONE consolidated deal invoice (the existing bundle
// mechanism, 0044) — both queued 'pending' for her normal approval → issue.
// Nothing reaches Morning here. can_edit_money.
//
// Robustness: the work order folds the accrued rows; the deal invoice bundles
// only the episodes that already have a job (client-approved). If a client
// still has un-approved episodes, its work order consolidates all of them and
// the deal invoice covers the approved subset — the two never silently drift
// because the response reports both counts.
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

  // 1) consolidated work order (folds + marks the accrued rows)
  const wo = await createWorkOrderBundle(admin, rows, user.id);
  if (!wo.ok) return NextResponse.json({ error: wo.error }, { status: wo.status });

  // 2) consolidated deal invoice over the jobs of those productions that have
  //    been client-approved (a job exists). createDealInvoiceBundle drops any
  //    already-billed / already-queued job on its own.
  const productionIds = rows.map((r) => r.production_id).filter(Boolean) as string[];
  let dealResult: { ok: boolean; id?: string; amount?: number; lines?: number; error?: string } = { ok: false, error: "אין פרקים מאושרים לחיוב" };
  if (productionIds.length) {
    const { data: jp } = await admin
      .from("job_productions")
      .select("job_id")
      .in("production_id", productionIds);
    const jobIds = Array.from(new Set((jp ?? []).map((r) => r.job_id).filter(Boolean))) as string[];
    if (jobIds.length) {
      const di = await createDealInvoiceBundle(admin, jobIds, user.id);
      dealResult = di.ok
        ? { ok: true, id: di.id, amount: di.amount, lines: di.lines }
        : { ok: false, error: di.error };
    }
  }

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: clientId,
    event_type: "billing_redeemed",
    actor_id: user.id,
    payload: {
      work_order_id: wo.id,
      work_order_lines: wo.lines,
      work_order_amount: wo.amount,
      deal_invoice: dealResult.ok ? { id: dealResult.id, amount: dealResult.amount, lines: dealResult.lines } : null,
      deal_invoice_error: dealResult.ok ? null : dealResult.error,
    },
  });

  return NextResponse.json({
    ok: true,
    work_order: { id: wo.id, lines: wo.lines, amount: wo.amount },
    deal_invoice: dealResult.ok
      ? { id: dealResult.id, lines: dealResult.lines, amount: dealResult.amount }
      : null,
    deal_invoice_note: dealResult.ok ? null : dealResult.error,
  });
}
