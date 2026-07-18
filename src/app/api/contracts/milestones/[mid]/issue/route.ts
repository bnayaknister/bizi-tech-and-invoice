import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Issue an invoice for a contract milestone — the same two-path flow as the
// finance screen (Morning dry-run OR manual), but here it also CREATES the
// linked job (the milestone had none yet) so the billing lands in the money
// pipeline like everything else: a job (contract_id set) + an invoices row +
// the milestone flipped to 'invoiced' and pointed at the job.
const DRY_RUN = process.env.MORNING_DRY_RUN !== "false";

export async function POST(request: Request, { params }: { params: { mid: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    mode?: "morning" | "manual";
    doc_number?: string;
    issued_at?: string;
    amount?: number;
    pdf_url?: string;
  };

  const { data: ms } = await supabase
    .from("contract_milestones")
    .select("id,contract_id,name,amount,job_id,status")
    .eq("id", params.mid)
    .maybeSingle();
  if (!ms) return NextResponse.json({ error: "אבן הדרך לא נמצאה" }, { status: 404 });
  if (ms.job_id) return NextResponse.json({ error: "כבר הונפקה חשבונית לאבן דרך זו" }, { status: 409 });

  const { data: contract } = await supabase
    .from("contracts")
    .select("id,name,client_id")
    .eq("id", ms.contract_id)
    .maybeSingle();
  if (!contract?.client_id) return NextResponse.json({ error: "לחוזה אין לקוח" }, { status: 400 });

  const isMorning = body.mode === "morning";
  const amount = body.amount ?? (ms.amount as number);
  const issued_at = body.issued_at ? new Date(body.issued_at).toISOString() : new Date().toISOString();
  let docNumber = (body.doc_number ?? "").trim();
  let morningDocId: string | null = null;
  if (isMorning) {
    docNumber = docNumber || `DRY-${`${Date.now()}`.slice(-6)}`;
    morningDocId = `biz-dry-${crypto.randomUUID().slice(0, 8)}`;
  } else if (!docNumber) {
    return NextResponse.json({ error: "חובה מספר מסמך בהנפקה ידנית" }, { status: 400 });
  }

  // 1. the job that carries this milestone's billing
  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      client_id: contract.client_id,
      contract_id: contract.id,
      campaign: `${contract.name} — ${ms.name}`,
      amount,
      date: issued_at.slice(0, 10),
      paid: "לא",
      invoice_biz: docNumber,
      legacy: false,
    })
    .select("id")
    .single();
  if (jobErr) return NextResponse.json({ error: jobErr.message }, { status: 400 });

  // 2. the document record
  const { error: invErr } = await supabase.from("invoices").insert({
    client_id: contract.client_id,
    job_id: job.id,
    type: "עסקה",
    doc_number: docNumber,
    morning_doc_id: morningDocId,
    amount,
    issued_at,
    source: isMorning ? "morning_api" : "manual",
    issued_by: user.id,
    pdf_url: body.pdf_url?.trim() || null,
    amount_is_estimated: false,
    date_is_estimated: false,
  });
  if (invErr) {
    await supabase.from("jobs").delete().eq("id", job.id); // roll the job back
    const dup = (invErr as { code?: string }).code === "23505";
    return NextResponse.json({ error: dup ? "מסמך זה כבר נרשם" : invErr.message }, { status: dup ? 409 : 400 });
  }

  // 3. link the milestone + advance it
  const { error: msErr } = await supabase
    .from("contract_milestones")
    .update({ job_id: job.id, status: "invoiced" })
    .eq("id", ms.id);
  if (msErr) return NextResponse.json({ error: msErr.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "contract",
    entity_id: contract.id,
    event_type: isMorning ? (DRY_RUN ? "milestone_invoiced_morning_dryrun" : "milestone_invoiced_morning") : "milestone_invoiced_manual",
    actor_id: user.id,
    payload: { milestone_id: ms.id, job_id: job.id, doc_number: docNumber, amount, dry_run: isMorning && DRY_RUN },
  });

  return NextResponse.json({ ok: true, job_id: job.id, dry_run: isMorning && DRY_RUN });
}
