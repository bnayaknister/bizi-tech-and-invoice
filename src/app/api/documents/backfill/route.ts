import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { backfillDocumentClients } from "@/lib/documents/backfill";
import { autoReconcile } from "@/lib/documents/reconcile";

// Resolve every "לא משויך" document whose Morning client is already mapped, and
// then run the certain-match auto-link over the newly-resolved set (owner spec
// 2026-07-27). can_edit_money. Idempotent — safe to run any time.
export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const { resolved } = await backfillDocumentClients(admin);
  const { linked } = await autoReconcile(admin);
  return NextResponse.json({ ok: true, backfilled: resolved, linked });
}
