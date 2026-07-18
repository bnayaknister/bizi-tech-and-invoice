import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { executeApproval, isApprovalAction } from "@/lib/approvals/execute";

const NIL = "00000000-0000-0000-0000-000000000000";

// A user-manager approves or rejects a pending request. On APPROVE the real
// destructive action runs here with the service-role client (owner rule:
// "the action itself runs only on approve, with admin rights") and only
// then is the request stamped approved. On REJECT nothing happens to the
// entity; the row is stamped rejected. Either way it's logged to events and
// the request is kept forever as an audit trail.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("can_manage_users").eq("id", user.id).single();
  if (!profile?.can_manage_users) return NextResponse.json({ error: "רק מנהל יכול לאשר בקשות" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { decision?: "approve" | "reject"; note?: string };
  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json({ error: "החלטה לא תקינה" }, { status: 400 });
  }

  const admin = createAdminClient();
  // read the request through the service role; it must still be pending
  const { data: req } = await admin
    .from("approval_requests")
    .select("id,action_type,entity_type,entity_id,payload,status,requested_by")
    .eq("id", params.id)
    .maybeSingle();
  if (!req) return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404 });
  if (req.status !== "pending") return NextResponse.json({ error: "הבקשה כבר טופלה" }, { status: 409 });

  const note = (body.note ?? "").trim() || null;

  if (body.decision === "reject") {
    await admin
      .from("approval_requests")
      .update({ status: "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString(), review_note: note })
      .eq("id", params.id);
    await admin.from("events").insert({
      entity_type: req.entity_type || "approval",
      entity_id: req.entity_id ?? NIL,
      event_type: "approval_rejected",
      actor_id: user.id,
      payload: { request_id: req.id, action_type: req.action_type, note },
    });
    return NextResponse.json({ ok: true, decision: "rejected" });
  }

  // approve → run the real action with admin rights, THEN stamp approved
  if (!isApprovalAction(req.action_type)) {
    return NextResponse.json({ error: "סוג פעולה לא נתמך" }, { status: 400 });
  }
  const result = await executeApproval(
    admin,
    req.action_type,
    (req.entity_id as string | null) ?? null,
    (req.payload as Record<string, unknown>) ?? {}
  );
  if (!result.ok) {
    // the action failed (e.g. a show that still has productions) — leave the
    // request pending so the manager can decide what to do, and tell them why
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await admin
    .from("approval_requests")
    .update({ status: "approved", reviewed_by: user.id, reviewed_at: new Date().toISOString(), review_note: note })
    .eq("id", params.id);
  await admin.from("events").insert({
    entity_type: req.entity_type || "approval",
    entity_id: req.entity_id ?? NIL,
    event_type: "approval_approved",
    actor_id: user.id,
    payload: { request_id: req.id, action_type: req.action_type, note, ...(result.detail ? { detail: result.detail } : {}) },
  });

  return NextResponse.json({ ok: true, decision: "approved" });
}
