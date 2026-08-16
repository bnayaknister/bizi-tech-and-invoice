// Every server-side supabase-js call goes through Next's instrumented fetch,
// and on Vercel that means the PERSISTENT Data Cache — it survives deploys.
// Diagnosed 2026-08-16 on the public review page: production kept serving
// review_reels_required=false days after the DB said true, because the
// productions-row GET had been cached while the value was false; the page's
// `dynamic = "force-dynamic"` did not opt those fetches out. `cache:
// "no-store"` on the request itself is the explicit, per-call opt-out.
export const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });
