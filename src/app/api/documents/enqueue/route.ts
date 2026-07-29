import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDocumentPayload } from "@/lib/documents/enqueue";
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
    .select("id,client_id,amount,campaign,date")
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

  // don't double-queue the same document kind for the same job
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
