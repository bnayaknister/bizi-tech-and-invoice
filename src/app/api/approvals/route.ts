import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isApprovalAction } from "@/lib/approvals/execute";

// A technician (can_edit_stages) files a request for a destructive action.
// Nothing is performed here — a row lands in approval_requests as 'pending'
// and waits for a user-manager to approve/reject. RLS (approvals_insert,
// 0021) is the real gate; this route validates shape + writes the audit
// event. Reason is mandatory (both here and by a DB check constraint).
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    action_type?: string;
    entity_type?: string;
    entity_id?: string | null;
    payload?: Record<string, unknown>;
    reason?: string;
  };

  const action = body.action_type ?? "";
  if (!isApprovalAction(action)) return NextResponse.json({ error: "סוג פעולה לא מוכר" }, { status: 400 });
  const reason = (body.reason ?? "").trim();
  if (!reason) return NextResponse.json({ error: "חובה לציין סיבה לבקשה" }, { status: 400 });

  const { data, error } = await supabase
    .from("approval_requests")
    .insert({
      requested_by: user.id,
      action_type: action,
      entity_type: body.entity_type ?? "",
      entity_id: body.entity_id ?? null,
      payload: body.payload ?? {},
      reason,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    // RLS rejection (not a stages editor) surfaces here
    const denied = /row-level security|permission/i.test(error.message);
    return NextResponse.json({ error: denied ? "אין הרשאה לבקש פעולה זו" : error.message }, { status: denied ? 403 : 400 });
  }

  const NIL = "00000000-0000-0000-0000-000000000000"; // events.entity_id is NOT NULL
  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: body.entity_type ?? "approval",
    entity_id: body.entity_id ?? NIL,
    event_type: "approval_requested",
    actor_id: user.id,
    payload: { request_id: data.id, action_type: action, reason },
  });

  return NextResponse.json({ ok: true, id: data.id });
}
