import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Archive / restore ONE registry document (owner spec — the manual button).
// Archiving is not deleting: archived_at is the only flag and restore clears
// it. Never calls Morning. can_edit_money; both directions evented.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { action?: "archive" | "restore"; reason?: string };
  const restore = body.action === "restore";

  const admin = createAdminClient();
  const { data: doc } = await admin.from("documents").select("id,morning_doc_number,archived_at").eq("id", params.id).maybeSingle();
  if (!doc) return NextResponse.json({ error: "המסמך לא נמצא" }, { status: 404 });

  const now = new Date().toISOString();
  const patch = restore
    ? { archived_at: null, archived_by: null, archive_reason: null, updated_at: now }
    : { archived_at: now, archived_by: user.id, archive_reason: (body.reason ?? "").trim() || "ארכוב ידני", updated_at: now };
  await admin.from("documents").update(patch).eq("id", params.id);

  await admin.from("events").insert({
    entity_type: "document",
    entity_id: params.id,
    event_type: restore ? "document_restored" : "document_archived",
    actor_id: user.id,
    payload: { morning_doc_number: doc.morning_doc_number, manual: true, reason: restore ? null : patch.archive_reason },
  });

  return NextResponse.json({ ok: true, archived: !restore });
}
