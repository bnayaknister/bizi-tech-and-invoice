import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveState } from "@/lib/finance/state";

// Issue a document — two routes, ONE record (owner spec 2026-07-18):
//   mode 'morning' : the Morning API path. MORNING_DRY_RUN is on for now, so
//                    this SIMULATES — it mints a doc number, writes the
//                    invoice + event, but never calls the real API. When the
//                    flag flips, the same button issues for real.
//   mode 'manual'  : "I already issued it in Morning" — the bookkeeper types
//                    the number/date/amount/PDF; stored with source='manual'.
// Either way: one invoices row (the document registry) + the job's quick flag
// (invoice_biz for עסקה / invoice_tax for מס) is set so the pipeline state
// moves. can_edit_money gated.
const DRY_RUN = process.env.MORNING_DRY_RUN !== "false"; // defaults ON

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    job_id?: string;
    type?: "עסקה" | "מס";
    mode?: "morning" | "manual";
    doc_number?: string;
    issued_at?: string;
    amount?: number;
    pdf_url?: string;
  };
  if (!body.job_id || (body.type !== "עסקה" && body.type !== "מס")) {
    return NextResponse.json({ error: "חסרים פרטי הנפקה" }, { status: 400 });
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("id,client_id,amount,invoice_biz,invoice_tax,paid")
    .eq("id", body.job_id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "החיוב לא נמצא" }, { status: 404 });
  if (!job.client_id) return NextResponse.json({ error: "לחיוב אין לקוח — אי אפשר להנפיק חשבונית" }, { status: 400 });

  const isMorning = body.mode === "morning";
  const source = isMorning ? "morning_api" : "manual";
  const amount = body.amount ?? (job.amount as number | null) ?? 0;
  const issued_at = body.issued_at ? new Date(body.issued_at).toISOString() : new Date().toISOString();

  let docNumber = (body.doc_number ?? "").trim();
  let morningDocId: string | null = null;
  if (isMorning) {
    // simulated Morning issuance — mint a unique doc number + system id so
    // the UNIQUE morning_doc_id constraint behaves exactly as it will live
    const n = `${Date.now()}`.slice(-6);
    docNumber = docNumber || `DRY-${n}`;
    morningDocId = `${body.type === "עסקה" ? "biz" : "tax"}-dry-${crypto.randomUUID().slice(0, 8)}`;
  } else if (!docNumber) {
    return NextResponse.json({ error: "חובה מספר מסמך בהנפקה ידנית" }, { status: 400 });
  }

  // 1. the document record
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .insert({
      client_id: job.client_id,
      job_id: job.id,
      type: body.type,
      doc_number: docNumber,
      morning_doc_id: morningDocId,
      amount,
      issued_at,
      source,
      issued_by: user.id,
      pdf_url: body.pdf_url?.trim() || null,
      amount_is_estimated: false,
      date_is_estimated: false,
    })
    .select("id,type,doc_number,source,pdf_url,issued_at,amount")
    .single();
  if (invErr) {
    const dup = invErr.code === "23505";
    return NextResponse.json({ error: dup ? "מסמך זה כבר נרשם" : invErr.message }, { status: dup ? 409 : 400 });
  }

  // 2. the job's quick flag so the pipeline state moves
  const patch = body.type === "עסקה" ? { invoice_biz: docNumber } : { invoice_tax: docNumber };
  const { data: updatedJob, error: jobErr } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", job.id)
    .select("id,paid,invoice_biz,invoice_tax")
    .single();
  if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "job",
    entity_id: job.id,
    event_type: isMorning ? (DRY_RUN ? "invoice_issued_morning_dryrun" : "invoice_issued_morning") : "invoice_issued_manual",
    actor_id: user.id,
    payload: { type: body.type, doc_number: docNumber, source, amount, dry_run: isMorning && DRY_RUN },
  });

  return NextResponse.json({
    ok: true,
    invoice: inv,
    state: deriveState(updatedJob),
    dry_run: isMorning && DRY_RUN,
  });
}
