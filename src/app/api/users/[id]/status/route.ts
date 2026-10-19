import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUsersOwner } from "@/lib/users/ownerGate";
import { isStrictOwner } from "@/lib/roles";

// U1-8: disable / re-enable a user — owner only. Disabling replaces deleting:
// nothing is removed, so the person's history, events and productions stay,
// and their name keeps showing there.
//
// The marker is the Auth ban itself (banned_until), not a column: a ban makes
// GoTrue refuse GET /user (the middleware's per-request getUser), token refresh
// and password sign-in at once — verified live 19.10. ~100 years = "until
// re-enabled"; "none" lifts it.
//
// Residual, by design: an access token already issued stays valid at the data
// API (PostgREST) until it expires (jwt_exp = 1h). The app itself refuses it
// on the very next request (middleware).
const BAN_FOREVER = "876000h";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const gate = await requireUsersOwner(supabase);
  if ("response" in gate) return gate.response;

  const body = (await request.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "disable" && body.action !== "enable") {
    return NextResponse.json({ error: "פעולה לא מוכרת" }, { status: 400 });
  }
  if (params.id === gate.userId) {
    return NextResponse.json({ error: "אי אפשר להשבית את החשבון של עצמך" }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role,email").eq("id", params.id).maybeSingle();
  if (!target) return NextResponse.json({ error: "המשתמש לא נמצא" }, { status: 404 });
  if (isStrictOwner(target)) {
    return NextResponse.json({ error: "אי אפשר להשבית בעלים" }, { status: 403 });
  }

  const { error } = await admin.auth.admin.updateUserById(params.id, {
    ban_duration: body.action === "disable" ? BAN_FOREVER : "none",
  });
  if (error) {
    console.error("users/status: updateUserById failed —", error.status, error.code, error.message);
    return NextResponse.json({ error: "הפעולה נכשלה. אפשר לנסות שוב בעוד רגע." }, { status: 500 });
  }

  await admin.from("events").insert({
    entity_type: "profile",
    entity_id: params.id,
    event_type: body.action === "disable" ? "user_disabled" : "user_enabled",
    actor_id: gate.userId,
    payload: { email: target.email },
  });

  return NextResponse.json({ ok: true, disabled: body.action === "disable" });
}
