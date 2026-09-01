import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDealInvoiceFromWorkOrder } from "@/lib/documents/bundle";

// Queue a DEAL INVOICE (300) for a contract milestone, on the basis of the work
// order the milestone already had issued.
//
// ═══ WHY THIS GOES THROUGH convert AND NOT enqueue ═══
// Owner requirement, stated plainly: "חשבון העסקה שנוצר על בסיס הזמנת העבודה
// סוגר אותה גם". Closing the order is not a side effect here — it is half the
// point of the document.
//
// What closes it is `linkedDocumentIds` on the outgoing payload
// (bundle.ts). And buildDocumentPayload — the builder behind
// /api/documents/enqueue and behind this route's work-order sibling — NEVER
// emits that field; there are zero occurrences of it in enqueue.ts. So a 300
// raised through the enqueue path bills the right amount to the right client
// and leaves the order OPEN in Morning forever, which is precisely the
// `order_not_closed` alert on the radar, self-inflicted and undetectable until
// the next nightly pull.
//
// A `docType: "deal_invoice"` parameter on milestones/[mid]/enqueue was built
// and removed the same day for exactly this reason. This route delegates to
// createDealInvoiceFromWorkOrder instead — the same function the registry's
// "צור חשבון עסקה" button has used since it was written, so both doors produce
// an identical document.
//
// ═══ WHAT THE LIBRARY DOES, SO IT IS NOT RE-DONE HERE ═══
// createDealInvoiceFromWorkOrder owns: the parent-type check, status='issued',
// the "dry-" refusal, idempotency on linkedDocumentIds, the billable-job gate,
// and the job resolution. That last one already handles this shape — its own
// comment names "an order raised from the REGISTRY … anchored to a job directly
// and carries no production_id at all", and the `wo.job_id` fallback is what
// catches a milestone's order. Nothing in the library needed changing.
//
// The amount is the ORDER's, never the milestone's: income lines are inherited
// verbatim so the invoice totals exactly what the order did. A milestone whose
// amount was edited after the order went out will disagree with its own
// document — the contracts screen says so in a warning line rather than
// blocking, because that edit is usually the correction, not the error.

export async function POST(_request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();

  const { data: ms } = await admin
    .from("contract_milestones")
    .select("id,contract_id,name,amount,job_id")
    .eq("id", params.mid)
    .maybeSingle();
  if (!ms) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });
  if (!ms.job_id) {
    return NextResponse.json(
      { error: `לאבן הדרך '${ms.name}' אין job — הנפיקי קודם הזמנת עבודה` },
      { status: 400 }
    );
  }

  // The parent, named before the library is asked. The library would refuse a
  // missing or unissued order too, but its message speaks about "ההזמנה" with
  // no idea which milestone the operator is looking at — and this screen shows
  // several at once.
  const { data: orders } = await admin
    .from("pending_documents")
    .select("id,status,morning_doc_id,morning_doc_number")
    .eq("job_id", ms.job_id as string)
    .eq("doc_type", "work_order")
    .eq("status", "issued");

  const real = (orders ?? []).filter((o) => {
    const mid2 = (o.morning_doc_id as string | null) ?? "";
    return mid2.trim() !== "" && !mid2.startsWith("dry-");
  });
  const order = real[0] ?? null;

  if (!order) {
    const dryOnly = (orders ?? []).length > 0 && real.length === 0;
    const why = dryOnly
      ? "הזמנת העבודה הונפקה בהרצה יבשה — אין מסמך אמיתי במורנינג לסגור"
      : "אין הזמנת עבודה מונפקת. חשבון עסקה נוצר על סמך הזמנה, כדי לסגור אותה במורנינג";
    return NextResponse.json({ error: `לאבן הדרך '${ms.name}': ${why}` }, { status: 400 });
  }

  const built = await createDealInvoiceFromWorkOrder(admin, order.id as string, user.id);
  if (!built.ok) {
    return NextResponse.json({ error: built.error }, { status: built.status });
  }

  // The library writes its own `via: "from_work_order"` event. This second one
  // carries what only this route knows — which milestone and which contract —
  // so a later question about a contract can be answered without joining back
  // through the job.
  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: built.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: {
      doc_type: "deal_invoice",
      via: "contract_milestone_deal_invoice",
      milestone_id: ms.id,
      contract_id: ms.contract_id,
      job_id: ms.job_id,
      work_order_pending_id: order.id,
      closes_morning_doc_number: order.morning_doc_number,
      amount: built.amount,
      lines: built.lines,
    },
  });

  return NextResponse.json({
    ok: true,
    id: built.id,
    amount: built.amount,
    lines: built.lines,
    // what the screen tells her it just closed
    closes_doc_number: order.morning_doc_number,
    status: "queued",
  });
}
