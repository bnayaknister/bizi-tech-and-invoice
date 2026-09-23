import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { ensureBookingLink } from "@/lib/booking/links";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/booking/links — the owner asks for a show's booking link.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, through the gate that already exists (`profiles.role === "owner"`
// plus `approved`) — the same three lines as /api/settings/accountant-email and
// the preview route next door. No new role, no new column.
//
// 🔴 THIS ROUTE EXISTS BECAUSE THE TOKEN CANNOT BE READ FROM THE BROWSER.
// 0096 left `token` out of the `authenticated` column grant on purpose
// (0096:224-231, canary at :245): the token IS the credential. So the browser
// can never select it, and the only way to put a URL on the owner's clipboard
// is a server route that reads it with the service role and returns the
// finished address — never the raw token, never the row.
//
// It is idempotent in the way that matters: a show with a live link gets that
// link back, unchanged, however many times the button is pressed. Nothing here
// revokes or replaces anything — replacing a leaked link is a separate,
// deliberate act and is explicitly not part of this stage.

export const dynamic = "force-dynamic";

const NO_CLEAN_ALIAS = "אין לתוכנית שם בלי שם של אולפן. הוסיפו לה שם חלופי כדי ליצור קישור.";

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role,approved").eq("id", user.id).single();
  if (!profile?.approved) return NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 });
  if (profile.role !== "owner") {
    return NextResponse.json({ error: "המסך הזה פתוח לבעלים בלבד" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { showId?: string };
  const showId = (body.showId ?? "").trim();
  if (!showId) {
    return NextResponse.json({ error: "חסר מזהה תוכנית" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const result = await ensureBookingLink(createTypedAdminClient(), showId, user.id);

  if (!result.ok) {
    if (result.reason === "no-clean-alias") {
      // 409 and not 400: the request is well-formed and the owner did nothing
      // wrong — the SHOW is in a state that cannot carry a link yet. The
      // sentence is approved copy and is what the button renders verbatim.
      return NextResponse.json({ error: NO_CLEAN_ALIAS }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    if (result.reason === "show-not-found") {
      return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "לא הצלחתי ליצור קישור" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }

  // The ORIGIN comes from the request, not from an env var: this app is reached
  // on a Vercel preview domain and on the production one, and a hard-coded base
  // would hand the owner a link to the wrong deployment without saying so.
  const origin = new URL(request.url).origin;

  return NextResponse.json(
    { url: `${origin}/b/${result.token}`, created: result.created },
    { headers: { "Cache-Control": "no-store" } }
  );
}
