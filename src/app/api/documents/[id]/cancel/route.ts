import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Mark a deal invoice (חשבון עסקה, type 300) as CANCELLED — owner spec.
//
// ⚠️ This does NOT call Morning. The bookkeeper cancels the document in Morning
// by hand; the app only REFLECTS it. So there is no DRY_RUN / approval-queue
// path here — nothing is issued or revoked at Morning, this is a local
// bookkeeping mirror. can_edit_money (Shiri) gates it.
//
// Effect: the document is flagged cancelled (hidden from the normal registry
// tabs, shown in "מבוטלים"); if it was linked to a job, the job reverts to its
// pre-invoice state — invoice_biz cleared and the mirrored invoices row removed
// — so it shows up as "not billed / open" again and a corrected invoice can be
// issued. Everything is evented with the reason.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return NextResponse.json({ error: "חובה לציין סיבה לביטול" }, { status: 400 });

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("documents")
    .select("id,morning_doc_id,morning_doc_number,type,amount,job_id,cancelled_at")
    .eq("id", params.id)
    .maybeSingle();
  if (!doc) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  // 100 joined 300 on 2026-08-25. The discount case is the reason: Shiri
  // closes an issued 800 work order in Morning and needs to issue a corrected
  // 400 — and until now nothing in the app could move that work order out of
  // 'issued', so pending_documents_one_live_per_production refused the
  // replacement with a raw 23505.
  //
  // Nothing else about this route changes for a work order. The invoice_biz
  // clearing below is already guarded by `job.invoice_biz === docNumber`,
  // which a work order can never satisfy — it stamps no invoice number — so
  // that branch simply does not run. Left as-is rather than wrapped in a type
  // check, because the guard already states the real condition.
  if (doc.type !== 300 && doc.type !== 100) {
    return NextResponse.json({ error: "ניתן לבטל רק חשבון עסקה או הזמנת עבודה" }, { status: 400 });
  }
  if (doc.cancelled_at) return NextResponse.json({ error: "המסמך כבר מבוטל" }, { status: 409 });

  const docNumber = (doc.morning_doc_number as string | null) ?? null;
  const jobId = (doc.job_id as string | null) ?? null;

  // revert a linked job to its pre-invoice state
  let invoiceBizCleared = false;
  let invoiceRowDeleted = false;
  if (jobId) {
    const { data: job } = await admin.from("jobs").select("id,invoice_biz").eq("id", jobId).maybeSingle();
    // only clear the flag if it points at THIS document (don't stomp a later one)
    if (job && docNumber && job.invoice_biz === docNumber) {
      await admin.from("jobs").update({ invoice_biz: null }).eq("id", jobId);
      invoiceBizCleared = true;
    }
    // remove the mirrored finance-registry row for this document
    const { data: del } = await admin
      .from("invoices")
      .delete()
      .eq("morning_doc_id", doc.morning_doc_id as string)
      .select("id");
    invoiceRowDeleted = (del?.length ?? 0) > 0;
  }

  const now = new Date().toISOString();
  await admin
    .from("documents")
    .update({ cancelled_at: now, cancelled_by: user.id, cancel_reason: reason, updated_at: now })
    .eq("id", params.id);

  // ---- release the queue row -------------------------------------------
  // The registry row is only half the record: the queue row that produced it
  // is still 'issued', and pending_documents_one_live_per_production counts
  // it. Leaving it there is what made a corrective document impossible —
  // verified by simulation, the replacement was refused with 23505 while the
  // old row sat at 'issued', and 0063 alone did not help because nothing ever
  // moved it to 'cancelled'.
  //
  // Keyed on morning_doc_id, which is UNIQUE (0025), so exactly the document
  // being cancelled is released — never a sibling on the same production.
  // The status filter makes a repeated call a no-op rather than a second
  // event, and refuses to disturb a row that has since moved on.
  let queueRowReleased = false;
  if (doc.morning_doc_id) {
    const { data: released } = await admin
      .from("pending_documents")
      .update({ status: "cancelled" })
      .eq("morning_doc_id", doc.morning_doc_id as string)
      .eq("status", "issued")
      .select("id");
    queueRowReleased = (released?.length ?? 0) > 0;
    for (const r of released ?? []) {
      await admin.from("events").insert({
        entity_type: "pending_document",
        entity_id: r.id,
        event_type: "document_cancelled_in_queue",
        actor_id: user.id,
        payload: { morning_doc_number: docNumber, doc_type: doc.type, reason, previous_status: "issued" },
      });
    }
  }

  // event on the document
  await admin.from("events").insert({
    entity_type: "document",
    entity_id: params.id,
    event_type: "document_cancelled",
    actor_id: user.id,
    payload: {
      morning_doc_number: docNumber,
      doc_type: doc.type,
      amount: doc.amount,
      reason,
      job_id: jobId,
      reverted: {
        invoice_biz_cleared: invoiceBizCleared,
        invoice_row_deleted: invoiceRowDeleted,
        queue_row_released: queueRowReleased,
      },
    },
  });
  // and on the job, since its money-state moved back
  if (jobId && (invoiceBizCleared || invoiceRowDeleted)) {
    await admin.from("events").insert({
      entity_type: "job",
      entity_id: jobId,
      event_type: "document_cancelled",
      actor_id: user.id,
      payload: { morning_doc_number: docNumber, doc_type: doc.type, reason, reverted_to: "not_billed" },
    });
  }

  return NextResponse.json({ ok: true, reverted: { invoiceBizCleared, invoiceRowDeleted, queueRowReleased } });
}
