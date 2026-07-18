import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // touching getUser() is what actually refreshes the session cookie
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Hard wall for un-approved accounts (owner rule 2026-07-18): a signed-up
  // but not-yet-approved user may reach ONLY the waiting screen + auth. Every
  // page bounces to /pending; every API call gets a clean 403. RLS already
  // returns zero rows to them (is_approved() gates every can_* function), but
  // this makes the block explicit and central, so nothing new leaks by
  // forgetting a per-route check.
  if (user) {
    const path = request.nextUrl.pathname;
    const open =
      path === "/pending" ||
      path === "/login" ||
      path.startsWith("/auth") ||
      path.startsWith("/reset-password");
    if (!open) {
      const { data: prof } = await supabase.from("profiles").select("approved").eq("id", user.id).maybeSingle();
      if (!prof?.approved) {
        if (path.startsWith("/api/")) {
          return NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 });
        }
        const url = request.nextUrl.clone();
        url.pathname = "/pending";
        return NextResponse.redirect(url);
      }
    }
  }

  return response;
}
