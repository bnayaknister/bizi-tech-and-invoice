import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDocumentPayload } from "@/lib/documents/enqueue";
import { DOC_TYPE_LABEL } from "@/lib/morning/types";

// Queue a WORK ORDER for a contract milestone.
//
// WORK ORDER ONLY, and the two siblings say why. This route builds a document
// out of the milestone's own amount, which is the right verb for exactly one
// document: the head of the chain, the one with no parent. Everything after it
// is built from a PARENT and inherits that parent's frozen income lines —
// milestones/[mid]/deal-invoice (300) and milestones/[mid]/tax (305/320).
//
// A `docType` parameter briefly lived here and was removed the same day: a
// deal invoice must carry linkedDocumentIds to close its work order in Morning,
// and buildDocumentPayload never emits them, so routing a 300 through here
// produced a document that billed correctly and closed nothing.
//
// This is the route the sibling `issue` route is not. That one RECORDS a
// document raised by hand in Morning; this one puts a real one into the
// approval queue, and nothing here reaches Morning — approval does, via
// issue.ts, with the same human gate and the same DRY_RUN brake as everything
// else. Deliberately a separate route rather than a `mode` on `issue`: that
// route HAD a second mode and a5dbdf8 removed it (2026-07-30) precisely because
// one route answering both "record what happened" and "make it happen" is how
// a fake document got minted and logged as real. Its own 400 still points
// callers at /documents; adding a third mode would contradict that message.
//
// The job is the hinge. A milestone with no job gets a CLEAN one — no
// invoice_biz, unlike the one `issue` creates — because a job already carrying
// a document number is exactly what the enqueue guards refuse. A milestone that
// already has a job REUSES it: contract_milestones.job_id is a single column,
// so a second job would mean overwriting the link and orphaning the first, and
// the 1:1 is enforced elsewhere already (milestones/[mid]/route.ts).
//
// milestone.status is NOT advanced here. 'invoiced' means a document exists;
// at queue time none does. The screen reads the queue row itself for the
// in-between state.
//
// ═══ OPEN RISK, stated rather than hidden (owner accepted, stage 1) ═══
// Deleting a milestone while its document sits in the queue is NOT guarded,
// and cannot cheaply be: pending_documents carries no milestone or contract
// reference and never did — a5dbdf8 says so in as many words. The queue row
// survives the deletion and the document will still issue. The only link that
// outlives the milestone is the job (jobs.contract_id), which is what a later
// investigation would have to go on. Closing this properly means a milestone
// reference on pending_documents, i.e. a schema change, which stage 1 does not
// make.

// Only 'pending' work orders are refused a twin — the same statuses
// /api/documents/enqueue treats as live.
const LIVE_STATUSES = ["pending", "approved", "issued"];

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
    .select("id,contract_id,name,amount,job_id,status")
    .eq("id", params.mid)
    .maybeSingle();
  if (!ms) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });

  const { data: contract } = await admin
    .from("contracts")
    .select("id,name,client_id")
    .eq("id", ms.contract_id as string)
    .maybeSingle();
  if (!contract?.client_id) return NextResponse.json({ error: "לחוזה אין לקוח" }, { status: 400 });

  // A zero-amount milestone would otherwise build a 0 ₪ document: the amount
  // check in /api/documents/enqueue tests for null/undefined only, and 0 is
  // neither. The column is NOT NULL, so 0 (or a negative, by hand in SQL) is
  // the only shape that can get this far.
  const amount = Number(ms.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json(
      { error: `לאבן הדרך '${ms.name}' אין סכום חיובי — עדכני את הסכום לפני ההנפקה` },
      { status: 400 }
    );
  }

  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", contract.client_id as string)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  // iron rule: no issuance without a Morning-mapped client
  if (!client.morning_client_id) {
    return NextResponse.json({ error: `הלקוח '${client.name ?? ""}' לא ממופה למורנינג` }, { status: 400 });
  }

  // ---- the job: reuse, or create a clean one ------------------------------
  let jobId = (ms.job_id as string | null) ?? null;
  let createdJob = false;
  if (jobId) {
    const { data: existing } = await admin
      .from("jobs")
      .select("id,client_id,invoice_biz,invoice_tax")
      .eq("id", jobId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json(
        { error: "אבן הדרך מקושרת ל-job שלא קיים — נתקי את הקישור ונסי שוב" },
        { status: 409 }
      );
    }
    // The same refusal /api/documents/enqueue makes for a deal invoice, made
    // here for a work order too: a job that already carries a document number
    // has been billed, and a work order raised after the fact is an order for
    // work already invoiced.
    const present = (v: unknown) => v != null && String(v).trim() !== "";
    const biz = existing.invoice_biz as string | null;
    const tax = existing.invoice_tax as string | null;
    if (present(biz) || present(tax)) {
      const num = present(biz) ? biz : tax;
      const label = present(biz) ? "חשבון עסקה" : "חשבונית מס";
      return NextResponse.json(
        {
          error: `ל-job של אבן הדרך כבר יצא ${label} מספר ${num} — לא ניתן להנפיק עליו ${DOC_TYPE_LABEL.work_order}`,
          status: "exists",
        },
        { status: 409 }
      );
    }
  } else {
    const { data: job, error: jobErr } = await admin
      .from("jobs")
      .insert({
        client_id: contract.client_id,
        contract_id: contract.id,
        campaign: `${contract.name} — ${ms.name}`,
        amount,
        date: new Date().toISOString().slice(0, 10),
        paid: "לא",
        // deliberately NO invoice_biz — see the header. This job is clean until
        // the queue row it is about to carry is actually issued.
        legacy: false,
      })
      .select("id")
      .single();
    if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 400 });
    jobId = job.id as string;
    createdJob = true;

    const { error: linkErr } = await admin
      .from("contract_milestones")
      .update({ job_id: jobId })
      .eq("id", ms.id as string);
    if (linkErr) {
      // roll the job back rather than leave one nothing points at
      await admin.from("jobs").delete().eq("id", jobId);
      return NextResponse.json({ error: linkErr.message }, { status: 400 });
    }
  }

  // don't double-queue: the same test /api/documents/enqueue makes
  const { data: live } = await admin
    .from("pending_documents")
    .select("id,status")
    .eq("job_id", jobId)
    .eq("doc_type", "work_order")
    .in("status", LIVE_STATUSES)
    .maybeSingle();
  if (live) {
    // "הזמנת עבודה" is feminine, "חשבון עסקה" is masculine — one verb cannot
    // serve both without reading as broken Hebrew on a screen the bookkeeper
    // uses every day.
    return NextResponse.json(
      { error: `כבר קיימת ${DOC_TYPE_LABEL.work_order} ל-job הזה (${live.status})`, status: "exists" },
      { status: 409 }
    );
  }

  const description = `${DOC_TYPE_LABEL.work_order} — ${client.name ?? ""} ${contract.name} — ${ms.name}`.trim();

  const payload = buildDocumentPayload({
    docType: "work_order",
    morningClientId: client.morning_client_id as string,
    clientName: (client.name as string | null) ?? null,
    description,
    amount,
  });

  const { data: inserted, error } = await admin
    .from("pending_documents")
    .insert({
      doc_type: "work_order",
      production_id: null,
      job_id: jobId,
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
    payload: {
      doc_type: "work_order",
      via: "contract_milestone",
      milestone_id: ms.id,
      contract_id: contract.id,
      job_id: jobId,
      job_created: createdJob,
      client_id: client.id,
      amount,
    },
  });

  return NextResponse.json({ ok: true, id: inserted.id, job_id: jobId, status: "queued" });
}
