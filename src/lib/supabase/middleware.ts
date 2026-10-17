import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { noStoreFetch } from "./no-store-fetch";
import { PERF_OFF, perfTimer } from "@/lib/perf/timing";

// T35: only the two screens being measured are timed here — the middleware
// runs on every request, and a log line per asset would bury the ones we want.
const PERF_PATHS = /^\/(productions(\/|$)|api\/entity\/production\/)/;

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const perfPath = request.nextUrl.pathname;
  const perf = PERF_PATHS.test(perfPath)
    ? perfTimer(`middleware ${perfPath.startsWith("/api/") ? "/api/entity/production/[id]" : "/productions"}`, { totalName: "mw_total" })
    : PERF_OFF;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: noStoreFetch },
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
  perf.lap("mw_getUser");

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
      // a freshly-invited (unapproved) user must reach the set-password screen
      // before the wall bounces them to /pending
      path === "/welcome" ||
      path.startsWith("/auth") ||
      path.startsWith("/reset-password") ||
      // public client review links + their response endpoint — account-less,
      // token is the only credential; must never bounce to /pending
      path.startsWith("/r/") ||
      path.startsWith("/api/r/") ||
      // public client BOOKING links + their two endpoints (3ב) — account-less,
      // the token is the only credential, and a signed-in-but-unapproved user
      // must not be bounced to /pending off a link a client sent them
      path.startsWith("/b/") ||
      path.startsWith("/api/book/") ||
      // public REGISTRATION links (E17-4) — same family as /b: account-less,
      // the token is the only credential. Both answer 404 while
      // REGISTRATION_ENABLED is off.
      path.startsWith("/join/") ||
      path.startsWith("/api/join/") ||
      // the WhatsApp webhook (E9-1). Meta sends no cookies, so `user` is null
      // and this wall never fires for a real delivery — it is listed anyway
      // because the one person who WILL arrive here with a session is whoever
      // is debugging the handshake from a browser tab, and a /pending bounce
      // in the middle of that reads as the route being broken. The route's own
      // gate is the HMAC signature, which is strictly stronger than this wall.
      path.startsWith("/api/wa/") ||
      // Bunny Stream's webhook (E13-5). Same reasoning as /api/wa/: Bunny
      // sends no cookies, and the route's own gate is the HMAC signature.
      path.startsWith("/api/bunny/") ||
      // the public privacy policy Meta's app settings link to (E9). Anyone may
      // read it, an unapproved account included — a /pending bounce would make
      // the policy unreachable for exactly the people it describes.
      path === "/privacy";
    if (!open) {
      const { data: prof } = await supabase.from("profiles").select("approved").eq("id", user.id).maybeSingle();
      perf.lap("mw_profile");
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

  if (perf.on) {
    // one Server-Timing header per hop: the route handler adds its own, and
    // the browser shows both (the names here carry the mw_ prefix)
    const pid = /^\/api\/entity\/production\/([0-9a-f-]{36})/.exec(perfPath)?.[1] ?? null;
    response.headers.append("Server-Timing", perf.done({ production_id: pid }));
  }
  return response;
}
