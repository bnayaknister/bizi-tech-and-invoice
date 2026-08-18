// The app's public base URL — the one that goes into a link a CLIENT will open.
//
// Deriving it from the incoming request (`new URL(request.url).origin`) is
// what we did until 2026-08-18, and it is wrong for anything outward-facing:
// the origin is whatever host the technician happened to have open. On Vercel
// that is often a branch alias (…-git-main-….vercel.app), which sits behind
// Deployment Protection — a client opening such a link lands on Vercel's SSO
// screen, not on the review page. Verified: the branch alias 302s to
// vercel.com/sso-api for /r/<token>, while the production domain serves 200.
//
// So: an explicit env var wins, and the request origin is only a fallback for
// local dev and for a deployment where the var was never set. Set
// NEXT_PUBLIC_APP_URL to the production domain (no trailing slash).
export function getAppBaseUrl(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}
