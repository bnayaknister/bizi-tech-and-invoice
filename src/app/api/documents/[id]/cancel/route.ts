import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelDocumentLocally } from "@/lib/documents/cancelLocal";

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

  // ⚠️ THE LOCAL EFFECT MOVED TO lib/documents/cancelLocal.ts ON 2026-10-06,
  // BEHAVIOUR UNCHANGED. The four writes it performs — documents, the job's
  // invoice_biz, the mirrored invoices row, and the release of the 'issued'
  // queue row — are exactly what stood here, in the same order, with the same
  // guards. They moved because `cancel-in-morning` has to produce the identical
  // state after it closes the document at Morning, and the one thing that must
  // never happen is two hand-written copies of this list drifting apart. The
  // reasoning for each write lives on that function.
  const now = new Date().toISOString();
  const { invoiceBizCleared, invoiceRowDeleted, queueRowReleased } = await cancelDocumentLocally(
    admin,
    {
      id: doc.id as string,
      morning_doc_id: doc.morning_doc_id as string | null,
      morning_doc_number: docNumber,
      type: doc.type as number,
      job_id: jobId,
    },
    { userId: user.id, reason, cancelledAt: now }
  );

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
