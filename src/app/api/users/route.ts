import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Add a user — user-manager only. Two modes:
//   invite : sends a Supabase invite email (they set their own password)
//   manual : creates the account now with a random password; the person
//            uses "forgot password" to set one (no secret is ever returned)
// Either way the handle_new_user trigger creates a pending profile
// (approved=false, no permissions); the manager grants permissions after.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("can_manage_users").eq("id", user.id).single();
  if (!me?.can_manage_users) return NextResponse.json({ error: "רק מנהל משתמשים יכול להוסיף משתמשים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { email?: string; name?: string; mode?: "invite" | "manual" };
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "כתובת מייל לא תקינה" }, { status: 400 });
  }

  const admin = createAdminClient();
  let newId: string | undefined;

  if (body.mode === "invite") {
    // Land the invited user straight on the set-password screen. The email
    // link hits Supabase's verify endpoint, which redirects to redirectTo
    // with a code; /auth/callback exchanges it for a session, then forwards
    // to /welcome. Derived from the request origin so it's the deployment
    // that sent the invite (prod, not localhost) — this URL must also be in
    // Supabase Auth → Redirect URLs.
    const origin = new URL(request.url).origin;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { name },
      redirectTo: `${origin}/auth/callback?next=/welcome`,
    });
    if (error) {
      // free Supabase email quota exhausted is the common failure — name it
      const rateLimited = (error.status === 429) || /rate limit|too many|quota/i.test(error.message);
      const msg = rateLimited
        ? "נשלחו יותר מדי מיילים (מכסת המייל היומית). נסה שוב בעוד שעה, או צור קישור ידני."
        : `הזמנה נכשלה: ${error.message}`;
      return NextResponse.json({ error: msg }, { status: rateLimited ? 429 : 400 });
    }
    newId = data.user?.id;
  } else {
    const randomPassword = `Bz-${crypto.randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: randomPassword,
      email_confirm: true,
      user_metadata: { name },
    });
    if (error) return NextResponse.json({ error: `יצירת משתמש נכשלה: ${error.message}` }, { status: 400 });
    newId = data.user?.id;
  }

  // make sure the profile carries the given name (the trigger may have used
  // the email as a fallback)
  if (newId && name) {
    await admin.from("profiles").update({ name }).eq("id", newId);
  }
  if (newId) {
    await admin.from("events").insert({
      entity_type: "profile",
      entity_id: newId,
      event_type: "user_added",
      actor_id: user.id,
      payload: { email, mode: body.mode ?? "manual" },
    });
  }

  return NextResponse.json({ ok: true, id: newId });
}
