import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getAccessToken, isDryRun, morningEnv, MorningError } from "@/lib/morning/client";

// A safe config health-check for the Morning integration. Returns BOOLEANS
// ONLY — never a key, never a token — so it can't leak a secret. Money-gated.
//
// Purpose: read the live production config (is DRY_RUN really off? are the
// keys present? does auth actually work from here?) without issuing anything.
// The auth probe requests a token, which the spec confirms creates no
// document — it only proves the credentials are valid from this deployment.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_money").eq("id", user.id).single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const hasClientId = !!process.env.MORNING_CLIENT_ID;
  const hasClientSecret = !!process.env.MORNING_CLIENT_SECRET;

  // token-only auth probe — no document is created
  let authOk = false;
  let authError: string | null = null;
  if (hasClientId && hasClientSecret) {
    try {
      const token = await getAccessToken();
      authOk = !!token;
    } catch (e) {
      authError = e instanceof MorningError ? `${e.message} (${e.status})` : e instanceof Error ? e.message : "שגיאה";
    }
  }

  return NextResponse.json({
    ok: true,
    dryRun: isDryRun(),
    env: morningEnv(),
    hasClientId,
    hasClientSecret,
    authOk,
    authError,
  });
}
