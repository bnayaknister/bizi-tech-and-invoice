import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// The bookkeeper's per-row override in the queue (owner spec 2026-07-28):
// cadence sets the DEFAULT, she always wins. Flip one work order between
// 'accrued' (frozen, waits for redemption) and 'pending' ("הוצא עכשיו" — issue
// it now on its own). Only a live, not-yet-issued work order can be toggled.
// can_edit_money.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { id?: string; accrue?: boolean };
  if (!body.id) return NextResponse.json({ error: "חסר מזהה מסמך" }, { status: 400 });
  const target = body.accrue ? "accrued" : "pending";
  const from = body.accrue ? "pending" : "accrued";

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,client_id")
    .eq("id", body.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });
  if (row.doc_type !== "work_order") {
    return NextResponse.json({ error: "רק הזמנת עבודה ניתנת לסימון מסוכם/הוצא" }, { status: 400 });
  }
  if (row.status !== from) {
    return NextResponse.json({ error: `לא ניתן לשנות מסמך בסטטוס '${row.status}'` }, { status: 409 });
  }

  const { error } = await admin.from("pending_documents").update({ status: target }).eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "pending_document",
    entity_id: body.id,
    event_type: body.accrue ? "document_accrued" : "document_released",
    actor_id: user.id,
    payload: { doc_type: "work_order", from, to: target, client_id: row.client_id },
  });

  return NextResponse.json({ ok: true, status: target });
}
