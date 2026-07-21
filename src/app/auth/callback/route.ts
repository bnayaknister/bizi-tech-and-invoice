import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Exchanges the email-link code for a session, then forwards to `next`
// (/welcome for invites + recovery). The one-time code is often pre-consumed
// by a mail/AV/WhatsApp link scanner, so the exchange can fail even on a
// genuine click — in that case we still land the user on the target, where
// the no-session branch offers a "resend link" escape hatch instead of a
// silent dead end (owner, 2026-07-21).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // when it fails the redirect below still runs; /welcome then shows the
    // resend form because getUser() finds no session. Nothing to do but log.
    if (error) console.warn("auth/callback: code exchange failed —", error.message);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
