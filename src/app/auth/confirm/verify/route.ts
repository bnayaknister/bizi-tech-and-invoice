import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isConfirmType, safeNext } from "../params";

// U1-2: the "המשך" button on /auth/confirm posts here. verifyOtp with the
// token_hash runs on the server client, so the session lands in cookies
// (no PKCE verifier or #fragment involved, which is what broke the invite
// link in U1-1). 303 so the browser follows with a GET.
//
// A failure goes back to /auth/confirm with only an error code, never the
// token. "otp_expired" is what GoTrue returns for both an expired link and
// one that was already used, and both read the same to the user.
export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const tokenHash = String(form.get("token_hash") ?? "");
  const type = String(form.get("type") ?? "");

  const fail = (code: string) => NextResponse.redirect(`${origin}/auth/confirm?error=${code}`, 303);

  if (!tokenHash || !isConfirmType(type)) return fail("invalid");
  const next = safeNext(String(form.get("next") ?? ""), type);

  const supabase = createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
  if (error) {
    console.warn("auth/confirm: verifyOtp failed —", error.code, error.message);
    return fail(error.code === "otp_expired" ? "expired" : "failed");
  }

  return NextResponse.redirect(`${origin}${next}`, 303);
}
