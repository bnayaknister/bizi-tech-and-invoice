// ═══════════════════════════════════════════════════════════════════════════
// T35 — server-side timing, behind PERF_TIMING=true. Edge- and Node-safe.
// ═══════════════════════════════════════════════════════════════════════════
//
// One timer per request. `lap(name)` records the time since the previous lap
// (or since start), `time(name, promise)` records how long one promise took —
// for queries that run in parallel, where laps cannot tell them apart. At the
// end `done()` writes ONE JSON line to the function log and returns the
// Server-Timing header value.
//
// ⚠️ OFF MEANS OFF. With PERF_TIMING unset every method is a no-op that returns
// its input untouched: no clock reads, no log line, no header. `time()` still
// has to return the promise, so it does — unwrapped.
//
// ⚠️ NO PERSONAL DATA. The line carries the route, the durations, and at most a
// production id (owner rule, T35). Never a user id, a name, an email or a
// phone — `done()` accepts only `production_id` for that reason.

export const PERF_LOG_TAG = "perf_timing";

export function isPerfTimingOn(): boolean {
  return process.env.PERF_TIMING === "true";
}

export type PerfStep = { name: string; ms: number };

export type PerfTimer = {
  readonly on: boolean;
  lap(name: string): void;
  time<T>(name: string, work: PromiseLike<T>): Promise<T>;
  /** writes the log line; returns the Server-Timing value ("" when off) */
  done(extra?: { production_id?: string | null; status?: number }): string;
};

const round = (ms: number) => Math.round(ms * 10) / 10;

/** Server-Timing allows a token as the metric name — no spaces, no dots. */
function metricName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "step";
}

export function serverTimingHeader(steps: PerfStep[], totalMs: number, totalName = "total"): string {
  return [...steps.map((s) => `${metricName(s.name)};dur=${s.ms}`), `${metricName(totalName)};dur=${round(totalMs)}`].join(", ");
}

/** The no-op timer — for a request that is not being measured. */
export const PERF_OFF: PerfTimer = {
  on: false,
  lap() {},
  time<T>(_name: string, work: PromiseLike<T>) {
    return Promise.resolve(work);
  },
  done() {
    return "";
  },
};

export function perfTimer(
  route: string,
  opts: { force?: boolean; log?: (line: string) => void; /** the Server-Timing name of the total — "mw_total" in the middleware, so the two hops do not collide */ totalName?: string } = {}
): PerfTimer {
  if (!opts.force && !isPerfTimingOn()) return PERF_OFF;
  const log = opts.log ?? ((line: string) => console.log(line));
  const start = performance.now();
  let last = start;
  const steps: PerfStep[] = [];
  let finished = false;
  return {
    on: true,
    lap(name) {
      const now = performance.now();
      steps.push({ name, ms: round(now - last) });
      last = now;
    },
    async time(name, work) {
      const t0 = performance.now();
      try {
        return await work;
      } finally {
        steps.push({ name, ms: round(performance.now() - t0) });
      }
    },
    done(extra) {
      const total = performance.now() - start;
      if (!finished) {
        finished = true;
        log(
          JSON.stringify({
            tag: PERF_LOG_TAG,
            route,
            total_ms: round(total),
            steps,
            ...(extra?.production_id ? { production_id: extra.production_id } : {}),
            ...(extra?.status ? { status: extra.status } : {}),
          })
        );
      }
      return serverTimingHeader(steps, total, opts.totalName);
    },
  };
}
