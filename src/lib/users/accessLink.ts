import type { SupabaseClient } from "@supabase/supabase-js";
import { getAppBaseUrl } from "@/lib/appUrl";

// U1-5: a one-time sign-in link for the owner to copy and send by hand.
//
// generateLink's own `action_link` is NOT used: it goes through Supabase's
// /verify, which answers with tokens in a #fragment that our PKCE client
// rejects (proven broken in U1-1). We build our own link from
// `hashed_token` to /auth/confirm — the same page the email templates use
// (U1-2), where a "המשך" click runs verifyOtp, so a link scanner that opens
// it does not burn it. Valid for one hour (mailer_otp_exp), single use.
//
// "invite" for a user who never accepted an invite (creates the user when
// missing); "recovery" for an existing confirmed user who never signed in.
export async function createAccessLink(
  admin: SupabaseClient,
  request: Request,
  input: { email: string; kind: "invite" | "recovery"; name?: string }
): Promise<{ url: string; userId: string } | { error: string; status: number }> {
  const { data, error } =
    input.kind === "invite"
      ? await admin.auth.admin.generateLink({ type: "invite", email: input.email, options: { data: { name: input.name ?? "" } } })
      : await admin.auth.admin.generateLink({ type: "recovery", email: input.email });
  if (error || !data?.properties?.hashed_token || !data.user) {
    return { error: linkErrorMessage(error?.message), status: error?.status ?? 400 };
  }
  const url =
    `${getAppBaseUrl(request)}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}` +
    `&type=${input.kind}`;
  return { url, userId: data.user.id };
}

export function linkErrorMessage(message: string | undefined): string {
  if (message && /already been registered|already registered|already exists/i.test(message)) {
    return "כבר קיים משתמש עם הכתובת הזו.";
  }
  if (message && /rate limit|too many|quota/i.test(message)) {
    return "נשלחו יותר מדי מיילים. אפשר לנסות שוב בעוד שעה, או להשתמש ב'העתק קישור'.";
  }
  return `הפעולה נכשלה: ${message ?? "שגיאה לא ידועה"}`;
}
