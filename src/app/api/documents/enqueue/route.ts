import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDocumentPayload, findBilledEvidenceForJobs } from "@/lib/documents/enqueue";
import { createDealInvoiceFromWorkOrder } from "@/lib/documents/bundle";
import {
  resolveWorkOrdersForJobs,
  recordParentRefusal,
  refusalMessage,
} from "@/lib/documents/parentRef";
import { DOC_TYPE_LABEL, type PendingDocType } from "@/lib/morning/types";

// Issue a work order or deal invoice straight from the documents registry
// (owner spec — Feature 2): the bookkeeper picks a job, and a queue row is
// created that flows through the EXISTING approval → issuance path (same
// brakes: approval queue, morning_doc_id UNIQUE, DRY_RUN honoured, all
// evented). Nothing here reaches Morning — approval does, via issue.ts.
//
// Only work_order / deal_invoice are allowed here (owner spec). Tax documents
// keep their own guarded path (double confirmation), never this one.
const ALLOWED: PendingDocType[] = ["work_order", "deal_invoice"];
// a document already in flight for the same job — don't double-queue
const LIVE_STATUSES = ["pending", "approved", "issued"];

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    docType?: string;
    jobId?: string;
    amount?: number | null;
    description?: string;
  };
  const docType = body.docType as PendingDocType;
  if (!ALLOWED.includes(docType)) {
    return NextResponse.json({ error: "ניתן להנפיק כאן רק הזמנת עבודה או חשבון עסקה" }, { status: 400 });
  }
  if (!body.jobId) return NextResponse.json({ error: "יש לבחור job" }, { status: 400 });

  const admin = createAdminClient();
  const { data: job } = await admin
    .from("jobs")
    // invoice_biz/invoice_tax used to feed the already-issued guard below; that
    // guard now lives in findBilledEvidenceForJobs, which reads them itself.
    // They stay in the select because the payload builder and the failure paths
    // below read this row, and dropping columns from a shared read to save a
    // few bytes is how a later edit finds one missing.
    .select("id,client_id,amount,campaign,date,invoice_biz,invoice_tax")
    .eq("id", body.jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "ה-job לא נמצא" }, { status: 404 });
  if (!job.client_id) return NextResponse.json({ error: "ל-job אין לקוח" }, { status: 400 });

  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", job.client_id as string)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  // iron rule: no issuance without a Morning-mapped client
  if (!client.morning_client_id) {
    return NextResponse.json({ error: `הלקוח '${client.name ?? ""}' לא ממופה למורנינג` }, { status: 400 });
  }

  const amount = body.amount ?? (job.amount as number | null);
  if (amount === null || amount === undefined) {
    return NextResponse.json({ error: "אין סכום ל-job — יש להזין סכום" }, { status: 400 });
  }

  // ---- already billed? (deal_invoice only) --------------------------------
  // ONE question, asked in ONE place (2026-09-16). This route used to carry its
  // own two checks — invoice_biz/invoice_tax on the job, then a live queue row —
  // which were rules (a) and (b) of findBilledEvidence written a second time.
  // They were also the WHOLE list: neither one read the registry, so the case
  // that produced this change — חברת החשמל, a 300 and a 305 sitting unlinked in
  // `documents` — would have walked through here exactly as it walked through
  // the client-approval path. Rules (c) and (c2) come for free by asking the
  // shared function instead.
  //
  // The messages below are the ones this route has always returned, verbatim,
  // and so is the 409. What the caller sees on a block does not change.
  //
  // deal_invoice ONLY, same reason findBilledEvidence gives: a work order is
  // queued when the production is created, long before any invoice exists, and
  // this test there would block an ordinary re-sync.
  if (docType === "deal_invoice") {
    const billed = await findBilledEvidenceForJobs(admin, [job.id as string]);
    if (billed) {
      // Rule (a) keeps its two distinct sentences: "you already have a deal
      // invoice" and "a tax invoice already went out" call for different next
      // actions, which is why they were never one message.
      const num = billed.detail.doc_number ?? "";
      const message =
        billed.rule === "a"
          ? billed.detail.column === "invoice_biz"
            ? `לג'וב הזה כבר יש חשבון עסקה מספר ${num} — לא ניתן ליצור נוסף`
            : `לג'וב הזה כבר יצאה חשבונית מס מספר ${num} — לא ניתן ליצור חשבון עסקה בדיעבד`
          : billed.rule === "b"
            // The found row's type, not the requested one. In the old narrow
            // check those were always equal (it filtered on docType); rule (b)
            // also sees a live tax row, and naming it is what keeps this
            // sentence true in the case the old check could not reach.
            ? `כבר קיים ${DOC_TYPE_LABEL[(billed.detail.doc_type as PendingDocType) ?? docType] ?? DOC_TYPE_LABEL[docType]} ל-job הזה (${billed.detail.queue_status ?? ""})`
            : billed.rule === "c"
              ? `לג'וב הזה כבר מקושר מסמך חיוב ${num} במרשם — לא ניתן ליצור חשבון עסקה נוסף`
              : `במרשם יש מסמך חיוב ${num} שמתאים ל-job הזה (אותו לקוח, אותו סכום, הפרש ${billed.detail.days_gap} ימים) ואינו מקושר אליו. יש לשייך אותו ב"גאפים לטיפול" לפני יצירת חשבון עסקה`;
      return NextResponse.json({ error: message, status: "exists" }, { status: 409 });
    }
  } else {
    // work_order: don't double-queue the same document kind for the same job.
    // findBilledEvidence deliberately does not cover work orders (they are
    // queued before any invoice exists), so this check stays exactly as it was.
    const { data: live } = await admin
      .from("pending_documents")
      .select("id,status")
      .eq("job_id", job.id as string)
      .eq("doc_type", docType)
      .in("status", LIVE_STATUSES)
      .maybeSingle();
    if (live) {
      return NextResponse.json(
        { error: `כבר קיים ${DOC_TYPE_LABEL[docType]} ל-job הזה (${live.status})`, status: "exists" },
        { status: 409 }
      );
    }
  }

  // ---- a deal invoice is raised ON an order, never on a bare job ----------
  //
  // Owner rule 2026-09-17, the same one the /finance bundle now follows: a 300
  // exists to settle an order, so if there is no issued order there is nothing
  // to settle and nothing to close. Until today this route built a 300 with
  // production_id NULL and no parent at all — and because issue.ts's linker is
  // keyed on production_id, that row could not pick one up later either. It was
  // the last path of the five that closed nothing and printed nothing.
  //
  // Delegating rather than adding two lines, for the reason stated at length in
  // bundle.ts: the invoice must total exactly what the order did, and only the
  // order's own income lines guarantee that.
  //
  // ⚠️ CONSEQUENCE, stated because it is a real behaviour change: `amount` and
  // `description` from the request body no longer apply to a deal invoice here
  // — the order's are inherited verbatim. They still apply to a work order,
  // which is the other half of this route and is untouched.
  if (docType === "deal_invoice") {
    const resolved = await resolveWorkOrdersForJobs(admin, [job.id as string]);
    if (!resolved.ok) {
      await recordParentRefusal(admin, {
        actorId: user.id,
        via: "registry_new_deal_invoice",
        jobIds: [job.id as string],
        failures: resolved.failures,
      });
      return NextResponse.json({ error: refusalMessage(resolved.failures, 1), status: "no_parent" }, { status: 409 });
    }
    const built = await createDealInvoiceFromWorkOrder(admin, resolved.workOrderIds, user.id);
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status });
    return NextResponse.json({ ok: true, id: built.id, amount: built.amount, via: "from_work_order" });
  }

  const description =
    (body.description ?? "").trim() ||
    `${DOC_TYPE_LABEL[docType]} — ${client.name ?? ""} ${(job.campaign as string | null) ?? ""}`.trim();

  const payload = buildDocumentPayload({
    docType,
    morningClientId: client.morning_client_id as string,
    clientName: (client.name as string | null) ?? null,
    description,
    amount,
  });

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: docType,
      production_id: null,
      job_id: job.id,
      client_id: client.id,
      amount,
      payload,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return NextResponse.json({ status: "exists" }, { status: 409 });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: inserted.id,
    event_type: "document_queued",
    actor_id: user.id,
    payload: { doc_type: docType, via: "registry_manual", job_id: job.id, client_id: client.id, amount },
  });

  return NextResponse.json({ ok: true, id: inserted.id, status: "queued" });
}
