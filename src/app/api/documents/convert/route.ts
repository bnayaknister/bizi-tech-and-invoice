import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDealInvoiceFromWorkOrder } from "@/lib/documents/bundle";

// "צור חשבון עסקה על סמך ההזמנה" (owner spec 2026-08-02) — the second half of
// redemption. Redemption issues ONE consolidated work order; this turns that
// order into the matching deal invoice, linked to it in Morning so the order
// closes there by itself. Since 2026-09-08 it also takes SEVERAL orders and
// folds them into one invoice that closes all of them.
//
// Nothing reaches Morning here: the invoice enters the normal approval queue
// as 'pending' and goes out through the existing review → issue path, with the
// same human gate and the same DRY_RUN brake. can_edit_money.
//
// The caller names the orders explicitly (workOrderPendingIds). A client can
// hold several issued order bundles at once — one per redemption — and nothing
// distinguishes them, so this route never guesses which ones to bill.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    workOrderPendingIds?: string[];
    workOrderPendingId?: string;
  };
  // `workOrderPendingId` is the single-id key this route shipped with, and it
  // is NOT dead: /documents/accrued still posts it (AccruedClient.tsx:160), one
  // consolidated order at a time, which is the shape redemption produces. It is
  // accepted here rather than chased across that screen so the widening lands
  // in one place; a one-element array reaches the builder either way and takes
  // the identical path through it.
  const rawIds = Array.isArray(body.workOrderPendingIds)
    ? body.workOrderPendingIds
    : body.workOrderPendingId
      ? [body.workOrderPendingId]
      : [];
  const ids = Array.from(new Set(rawIds.filter((v): v is string => typeof v === "string" && v.trim() !== "")));
  if (!ids.length) return NextResponse.json({ error: "חסר מזהה הזמנת עבודה" }, { status: 400 });

  const admin = createAdminClient();
  const res = await createDealInvoiceFromWorkOrder(admin, ids, user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });

  return NextResponse.json({
    ok: true,
    deal_invoice: { id: res.id, lines: res.lines, amount: res.amount },
  });
}
