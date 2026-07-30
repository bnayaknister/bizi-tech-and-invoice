import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveState } from "@/lib/finance/state";

// Record a document that was already issued in Morning — the bookkeeper types
// the number/date/amount/PDF, and we write one invoices row plus the job's
// quick flag (invoice_biz for עסקה / invoice_tax for מס) so the pipeline state
// moves. can_edit_money gated.
//
// This route does NOT issue anything. A mode 'morning' branch used to live here
// (owner spec 2026-07-18, a day before the real pipeline existed): it minted a
// fake "DRY-nnnnnn" number and wrote it into invoices + jobs.invoice_biz
// without ever calling Morning, and once MORNING_DRY_RUN went to false it also
// logged the event as a real issuance. Removed 2026-07-30 — it had never been
// called in production (zero events, zero DRY- rows). Real issuance is the
// approval queue: enqueue -> a human approves -> issue.ts, which is the only
// code that talks to Morning.

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
  if (body.mode === "morning") {
    return NextResponse.json(
      { error: "הנפקה דרך מורנינג לא עוברת כאן — היא עוברת בתור האישורים במסך המסמכים (/documents). כאן רושמים מסמך שהונפק כבר." },
      { status: 400 }
    );
  }

  const { data: job } = await supabase
    .from("jobs")
    .select("id,client_id,amount,invoice_biz,invoice_tax,paid")
    .eq("id", body.job_id)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "החיוב לא נמצא" }, { status: 404 });
  if (!job.client_id) return NextResponse.json({ error: "לחיוב אין לקוח — אי אפשר להנפיק חשבונית" }, { status: 400 });

  const amount = body.amount ?? (job.amount as number | null) ?? 0;
  const issued_at = body.issued_at ? new Date(body.issued_at).toISOString() : new Date().toISOString();

  const docNumber = (body.doc_number ?? "").trim();
  if (!docNumber) {
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
      // a hand-recorded document carries no Morning system id — only issue.ts
      // ever fills that, from the API response
      morning_doc_id: null,
      amount,
      issued_at,
      source: "manual",
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
    event_type: "invoice_issued_manual",
    actor_id: user.id,
    payload: { type: body.type, doc_number: docNumber, source: "manual", amount },
  });

  return NextResponse.json({
    ok: true,
    invoice: inv,
    state: deriveState(updatedJob),
  });
}
