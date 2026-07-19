import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDocument } from "@/lib/documents/enqueue";

// Step 3 of the chain (owner spec 2026-07-19): the bookkeeper has marked the
// job paid and pressed "צור חשבונית מס". That press does NOT issue anything
// — it queues a tax document, and the queue row is then approved through the
// confirmation modal like everything else.
//
// Two presses, two routes, by design: this one creates the row, and
// /api/documents/pending/review issues it and requires confirmed:true. One
// click can never produce a tax document.
//
// Default type is tax_receipt (חשבונית מס קבלה) because by the time this is
// pressed the money is already in; the modal lets her switch to 305.

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    production_id?: string;
    job_id?: string;
    amount?: number;
  };
  if (!body.production_id) return NextResponse.json({ error: "חסר מזהה הפקה" }, { status: 400 });

  const admin = createAdminClient();
  const { data: prod } = await admin
    .from("productions")
    .select("id,kind,legacy,client_id,show_id,podcast_name,record_date")
    .eq("id", body.production_id)
    .maybeSingle();
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  const res = await enqueueDocument(admin, "tax_receipt", prod, {
    jobId: body.job_id ?? null,
    amountOverride: typeof body.amount === "number" ? body.amount : null,
  });

  if (res.status === "blocked") return NextResponse.json({ error: res.reason }, { status: 409 });
  if (res.status === "exists") {
    return NextResponse.json({ error: "כבר קיים מסמך מס פעיל להפקה זו" }, { status: 409 });
  }
  if (res.status === "error") return NextResponse.json({ error: res.error }, { status: 400 });

  // The caller now opens the confirmation modal against this id.
  return NextResponse.json({ ok: true, pending_document_id: res.id });
}
