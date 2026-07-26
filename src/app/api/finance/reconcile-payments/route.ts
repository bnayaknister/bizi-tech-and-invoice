import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { reconcileCertainPayments } from "@/lib/documents/reconcile";

// Reconcile the unique 1:1 payment matches (owner spec 2026-07-27, group A):
// unpaid jobs that have an unlinked receipt / מס-קבלה in the registry for the
// same client + amount, with no ambiguity → mark paid + link. These leave the
// debt because they WERE paid, not because anything was deleted. Ambiguous
// matches (a client+amount that fits more than one job) are never touched here.
// can_edit_money (the bookkeeper); every mark-paid + link is evented.
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const result = await reconcileCertainPayments(admin, user.id);
  return NextResponse.json({ ok: true, ...result });
}
