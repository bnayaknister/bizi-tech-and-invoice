import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDealInvoiceFromWorkOrder } from "@/lib/documents/bundle";

// "צור חשבון עסקה על סמך ההזמנה" (owner spec 2026-08-02) — the second half of
// redemption. Redemption issues ONE consolidated work order; this turns that
// order into the matching deal invoice, linked to it in Morning so the order
// closes there by itself.
//
// Nothing reaches Morning here: the invoice enters the normal approval queue
// as 'pending' and goes out through the existing review → issue path, with the
// same human gate and the same DRY_RUN brake. can_edit_money.
//
// The caller names the order explicitly (workOrderPendingId). A client can hold
// several issued order bundles at once — one per redemption — and nothing
// distinguishes them, so this route never guesses which one to bill.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { workOrderPendingId?: string };
  const workOrderPendingId = body.workOrderPendingId;
  if (!workOrderPendingId) return NextResponse.json({ error: "חסר מזהה הזמנת עבודה" }, { status: 400 });

  const admin = createAdminClient();
  const res = await createDealInvoiceFromWorkOrder(admin, workOrderPendingId, user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  return NextResponse.json({
    ok: true,
    deal_invoice: { id: res.id, lines: res.lines, amount: res.amount },
  });
}
