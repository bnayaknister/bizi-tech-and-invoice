import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createAccessLink, linkErrorMessage } from "@/lib/users/accessLink";
import { requireUsersOwner } from "@/lib/users/ownerGate";

// U1-5: a fresh first sign-in for a user who has never signed in — owner only.
//   mode "email": Supabase sends it (Hebrew template → /auth/confirm)
//   mode "link" : our own /auth/confirm link to copy (lib/users/accessLink)
// Which kind: a user who never accepted the invite (email not confirmed) gets
// an invite again; a confirmed user who never signed in (the old "manual" add)
// gets a recovery link. Both land on /reset-password with a session.
// A user who already signed in is refused: they use "שכחתי סיסמה".
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const gate = await requireUsersOwner(supabase);
  if ("response" in gate) return gate.response;

  const body = (await request.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== "email" && body.mode !== "link") {
    return NextResponse.json({ error: "אופן שליחה לא מוכר" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.getUserById(params.id);
  if (error || !data.user?.email) return NextResponse.json({ error: "המשתמש לא נמצא" }, { status: 404 });
  const target = data.user;
  const email = target.email!;
  if (target.last_sign_in_at) {
    return NextResponse.json({ error: "המשתמש כבר נכנס למערכת. אפשר להשתמש ב'שכחתי סיסמה'." }, { status: 409 });
  }
  const kind: "invite" | "recovery" = target.email_confirmed_at ? "recovery" : "invite";

  let link: string | null = null;
  if (body.mode === "email") {
    const { error: sendErr } =
      kind === "invite"
        ? await admin.auth.admin.inviteUserByEmail(email, { data: target.user_metadata ?? {} })
        : await admin.auth.resetPasswordForEmail(email);
    if (sendErr) return NextResponse.json({ error: linkErrorMessage(sendErr.message) }, { status: sendErr.status ?? 400 });
  } else {
    const res = await createAccessLink(admin, request, { email, kind });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    link = res.url;
  }

  await admin.from("events").insert({
    entity_type: "profile",
    entity_id: params.id,
    event_type: "user_access_resent",
    actor_id: gate.userId,
    payload: { email, mode: body.mode, kind },
  });

  return NextResponse.json({ ok: true, link });
}
