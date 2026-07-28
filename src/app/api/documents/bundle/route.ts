import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDealInvoiceBundle } from "@/lib/documents/bundle";

// Bundle several jobs into ONE deal invoice (owner spec — Feature 3): a podcast
// that records N episodes and pays at the end gets a single חשבון עסקה with a
// line per episode, not N invoices. The validation + build live in
// createDealInvoiceBundle so redemption (0046) reuses the exact same primitive;
// this route is the manual-selection entry point (≥2 jobs). can_edit_money.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { jobIds?: string[] };
  const jobIds = Array.from(new Set((body.jobIds ?? []).filter(Boolean)));
  if (jobIds.length < 2) return NextResponse.json({ error: "יש לבחור לפחות שתי עבודות לאיגוד" }, { status: 400 });

  const admin = createAdminClient();
  const res = await createDealInvoiceBundle(admin, jobIds, user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, id: res.id, jobs: jobIds.length, amount: res.amount });
}
