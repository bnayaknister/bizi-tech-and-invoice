// ═══════════════════════════════════════════════════════════════════════════
// T35 — client-side timing, behind NEXT_PUBLIC_PERF_TIMING=true.
// ═══════════════════════════════════════════════════════════════════════════
//
// "From the click until the content is on screen": `perfStart(key)` at the
// click, `perfEndAfterPaint(key)` once the content has been committed — it
// waits one animation frame plus a macrotask, which lands after the browser
// has painted that frame. The result is ONE console line, tagged
// perf_timing_client, in the browser's console (never sent anywhere).
//
// ⚠️ NEXT_PUBLIC_* is inlined at BUILD time: flipping it needs a redeploy.
// With it unset every function returns immediately and nothing is recorded.

export const PERF_CLIENT_TAG = "perf_timing_client";

export function isPerfClientOn(): boolean {
  return process.env.NEXT_PUBLIC_PERF_TIMING === "true";
}

const starts = new Map<string, number>();
const extras = new Map<string, Record<string, unknown>>();

const round = (ms: number) => Math.round(ms * 10) / 10;

export function perfStart(key: string): void {
  if (!isPerfClientOn() || typeof performance === "undefined") return;
  starts.set(key, performance.now());
  extras.delete(key);
}

/** Attach facts to the pending measurement (e.g. the fetch time, Server-Timing). */
export function perfNote(key: string, facts: Record<string, unknown>): void {
  if (!isPerfClientOn() || !starts.has(key)) return;
  extras.set(key, { ...(extras.get(key) ?? {}), ...facts });
}

/**
 * Log the time since `perfStart(key)`, after the next paint. With no start
 * recorded and `fromNavigationStart`, measures from the page's own navigation
 * start instead (a full page load, where there was no in-app click to time).
 */
export function perfEndAfterPaint(key: string, opts: { fromNavigationStart?: boolean } = {}): void {
  if (!isPerfClientOn() || typeof window === "undefined") return;
  let t0 = starts.get(key);
  let mode = "click";
  if (t0 === undefined) {
    if (!opts.fromNavigationStart) return;
    t0 = 0; // performance.now() is measured from the navigation start
    mode = "full_load";
  }
  const facts = extras.get(key) ?? {};
  starts.delete(key);
  extras.delete(key);
  const begin = t0;
  requestAnimationFrame(() =>
    setTimeout(() => {
      console.log(JSON.stringify({ tag: PERF_CLIENT_TAG, what: key, mode, ms: round(performance.now() - begin), ...facts }));
    }, 0)
  );
}
