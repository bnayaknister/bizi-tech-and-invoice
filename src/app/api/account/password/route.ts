import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { PASSWORD_MESSAGES, PASSWORD_MIN, passwordErrorKey, type PasswordErrorKey } from "@/lib/auth/passwordErrors";

// U1-7: set a new password for the signed-in user (cookie session).
//
// The current password is checked BY SUPABASE, not here: Auth setting
// security_update_password_require_current_password is ON (19.10, verified
// live). GoTrue then demands current_password on every password change,
// except (a) a user who has no password yet (invite) and (b) a recovery
// session (the email link) — so /reset-password calls this without it.
//
// After an in-app change (current_password given) every OTHER session of the
// user is signed out; this one stays.
function fail(key: PasswordErrorKey, status: number) {
  return NextResponse.json({ error: PASSWORD_MESSAGES[key], code: key }, { status });
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("no_session", 401);

  const body = (await request.json().catch(() => ({}))) as { password?: unknown; current_password?: unknown };
  const password = typeof body.password === "string" ? body.password : "";
  const current = typeof body.current_password === "string" && body.current_password ? body.current_password : undefined;
  if (password.length < PASSWORD_MIN) return fail("weak_password", 400);

  const { error } = await supabase.auth.updateUser(current ? { password, current_password: current } : { password });
  if (error) {
    const key = passwordErrorKey(error.code, error.status);
    if (!key) {
      console.error("account/password: updateUser failed —", error.status, error.code, error.message);
      return fail("generic", 400);
    }
    return fail(key, key === "rate_limit" ? 429 : key === "no_session" ? 401 : 400);
  }

  if (current) {
    const { error: outErr } = await supabase.auth.signOut({ scope: "others" });
    // the password IS changed; a failed sign-out of other devices is logged, not shown as a failure
    if (outErr) console.error("account/password: signOut(others) failed —", outErr.status, outErr.code, outErr.message);
  }
  return NextResponse.json({ ok: true });
}
