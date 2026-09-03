import { hasBeenPerformed } from "./status";

// Studio hours (F6, migration 0067) — the small set of facts that BOTH the
// server and the screens need, in one client-safe module so they cannot drift.
//
// WHY A SEPARATE FILE. The billing side of this rule lives in
// lib/documents/enqueue.ts, which imports the Supabase client and the whole
// Morning type surface. A "use client" component that imported it would drag
// all of that into the browser bundle. Everything here is plain data.
//
// WHY THE UI COMPUTES THE FLAG AT ALL. `billing_block_reason` already carries
// the same sentence — but only after something has RUN checkEligibility, and
// nothing re-runs it on a status change. More decisively: technicians have no
// access to /radar, where that column is surfaced. If the drawer waited for the
// server to flag it, the one person who can answer "how long did it run?" would
// never be asked. So the flag is derived at render time from three columns the
// screens already load, and it is correct the instant the recording ends.

/** the quarter-hour the form steps in — hours are entered in 15-minute units */
export const HOURS_STEP = 0.25;

/**
 * The ceiling, shared by the form and the route that validates it.
 *
 * A route-level judgement with a readable sentence rather than a CHECK
 * constraint, exactly as 0067's header says it should be: a studio day cannot
 * exceed one, and a 48 that reaches the rate is a document for twice the money
 * with nothing to catch it.
 */
export const MAX_HOURS = 24;

/**
 * Is this production waiting for its studio hours?
 *
 * Three conditions, and the third is what keeps it quiet:
 *   1. the show is priced by the studio hour
 *   2. no hours have been entered
 *   3. the recording has actually happened
 *
 * (3) is `hasBeenPerformed` — the same predicate 0060/0061 draw in the database
 * and the accrued screen uses, so "the work was done" means one thing across
 * the system. Before the session runs, missing hours are the calendar, not a
 * fault, and a flag there would fire on every future episode of every hourly
 * show. 'בוטל' is excluded by that same function: a cancelled recording never
 * happened and never will.
 *
 * checkEligibility reaches the identical conclusion server-side (the silent
 * `applicable:false` branch vs the 🟡 one) — this is the same line drawn where
 * the technician can see it.
 */
export function hoursMissing(p: {
  pricing_model: string | null | undefined;
  studio_hours: number | null | undefined;
  status: string | null | undefined;
}): boolean {
  if (p.pricing_model !== "per_hour") return false;
  if (p.studio_hours != null) return false;
  return hasBeenPerformed(p.status);
}

/**
 * Is this a number the hours field may submit? Mirrors the route's validation
 * so the form refuses before the round trip — the route is still the wall.
 * numeric(5,2) rounds a third decimal on write, and money that changes itself
 * on the way into the database is the one thing this system does not do.
 */
export function hoursError(raw: string): string | null {
  if (raw.trim() === "") return "יש להזין את מספר שעות ההקלטה";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "מספר השעות אינו מספר תקין";
  if (n <= 0) return "מספר השעות חייב להיות גדול מאפס";
  if (n > MAX_HOURS) return `מספר השעות חייב להיות עד ${MAX_HOURS}`;
  if (Number(n.toFixed(2)) !== n) return "מספר השעות מוגבל לשתי ספרות אחרי הנקודה";
  return null;
}
