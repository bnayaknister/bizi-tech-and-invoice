import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createReceiptFromTaxInvoices } from "@/lib/documents/receiptFromTaxInvoice";

// "צור קבלה על סמך החשבונית" — the last rung: 100 -> 300 -> 305 -> 400.
//
// Nothing reaches Morning here. The receipt enters the normal approval queue as
// 'pending' and goes out through review -> issue, where it needs the second
// confirmation like any tax document and cannot be issued without a payment
// block naming what actually came in.
//
// A route of its own rather than a branch in /api/documents/tax: that one calls
// a different builder, with a different signature and a different result shape
// (a tax document reports parentOpennessUnknown; a receipt cannot — it refuses
// outright, because it reads its total from the same raw). Folding them would
// put an `if` in the middle of a path already running in production.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { sourceIds?: string[] };
  const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds.filter(Boolean) : [];
  if (!sourceIds.length) return NextResponse.json({ error: "חסרים מסמכי מקור" }, { status: 400 });

  const admin = createAdminClient();
  const res = await createReceiptFromTaxInvoices(admin, sourceIds, user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  // hand the built payload back so the screen can show the real thing — the
  // link that closes the invoice, the printed remark, the gross — rather than a
  // summary of it
  const { data: row } = await admin.from("pending_documents").select("payload").eq("id", res.id).maybeSingle();

  return NextResponse.json({
    ok: true,
    receipt: {
      id: res.id,
      doc_type: "receipt",
      amount: res.amount,
      source_numbers: res.sourceNumbers,
      payload: row?.payload ?? null,
    },
  });
}
