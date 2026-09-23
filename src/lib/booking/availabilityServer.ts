import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseIcsText } from "@/lib/calendar/parse";
import { findLiveSeriesInWindow } from "@/lib/calendar/series";
import { STUDIOS } from "@/lib/calendar/studios";
import {
  computeAvailability,
  israelInstant,
  type ApprovedRequest,
  type AvailabilityResult,
} from "@/lib/calendar/availability";
import { bookingWindowFor } from "@/lib/calendar/bookingWindow";

// ═══════════════════════════════════════════════════════════════════════════
// "What is actually free right now" — the ONE place that answers it.
// ═══════════════════════════════════════════════════════════════════════════
//
// Three callers need the same answer and must never disagree about it: the
// owner's preview route, the public availability route, and the public request
// route that has to re-check the slot before it inserts. A second copy of this
// assembly is how the screen and the insert end up believing different things
// about the same afternoon.
//
// ⚠️ NO FALLBACK ON A FEED FAILURE. It throws, and every caller turns that into
// an error with NO data attached. This is the rule the internal route was
// written with and it matters more here, not less: availability that was true
// an hour ago is exactly what double-books a studio, and an empty `free` array
// would be rendered by the client screen as "nothing is available" — a lie in
// the safe direction that still loses the booking.

export type LoadedAvailability = {
  fromIsrael: string;
  toIsrael: string;
  rooms: string[];
  result: AvailabilityResult;
};

/**
 * Rows -> blocking requests, keeping ONLY the approved ones.
 *
 * ⚠️ THE STATUS FILTER EXISTS TWICE ON PURPOSE — once in the query below and
 * once here. The SQL narrows the fetch, which is the right place to narrow a
 * fetch; this is the place the rule can be ASSERTED, because a filter inside a
 * query string cannot be unit-tested without a database and F19 is open. The
 * same doubled shape as `toPickerShows` and `clickableDays`, for the same
 * reason.
 *
 * And the direction of the two failures is not symmetric. A pending request
 * that blocked would let anyone holding the link close a studio for everybody
 * by asking three times — 0096's rule is that two pending requests for one
 * slot is a NORMAL state the owner decides between. So "approved" is stated
 * positively and everything else falls through: a status invented later
 * blocks nothing until somebody says it should.
 */
export function toApprovedRequests(
  rows: { id: string; studio: string; start_at: string; end_at: string; status?: string | null }[] | null | undefined
): ApprovedRequest[] {
  return (rows ?? [])
    .filter((r) => r?.status === undefined || r?.status === "approved")
    .map((r) => ({
      id: r.id,
      room: r.studio,
      start: new Date(r.start_at),
      end: new Date(r.end_at),
    }));
}

/** Read-only fetch of the secret feed URL. Never writes to it. */
async function fetchIcsText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`קריאת יומן נכשלה: ${res.status}`);
  return res.text();
}

/**
 * Every APPROVED request that overlaps the window, for EVERY show.
 *
 * ⚠️ NOT filtered by show, and that is the point. A studio is a physical room:
 * a request approved for one podcast closes that room for every other podcast,
 * and a per-show filter would show each client a calendar in which only their
 * own bookings exist. Half-open overlap on both ends — `start_at < windowEnd`
 * and `end_at > windowStart` — matching the grid's own comparison exactly.
 *
 * ⚠️ FOUR COLUMNS, and `guest` and `note` are not among them. This list is
 * about to become occupancy that any link-holder can see the shape of; a guest
 * name has no business travelling with it. `toRequestBlocks` has no field to
 * put one in either, which is the second lock on the same door.
 */
async function loadApprovedRequests(
  admin: SupabaseClient<Database>,
  windowStart: Date,
  windowEnd: Date
): Promise<ApprovedRequest[]> {
  const { data, error } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,end_at,status")
    .eq("status", "approved")
    .lt("start_at", windowEnd.toISOString())
    .gt("end_at", windowStart.toISOString());

  // A failed read must NOT silently mean "nothing is booked" — that would open
  // every approved slot back up. Same rule as the feed: no answer beats a
  // confident wrong one.
  if (error) throw new Error(`קריאת בקשות מאושרות נכשלה: ${error.message}`);

  return toApprovedRequests(data);
}

/**
 * The window, the rooms, and the availability over both sources.
 *
 * `now` is a parameter so the window is testable; the callers pass new Date().
 * The window itself is never accepted from a caller's query string — "not
 * today" and "at most eight weeks" are owner rules, not client preferences.
 */
export async function loadAvailability(
  admin: SupabaseClient<Database>,
  opts: { now: Date; stepMinutes: number }
): Promise<LoadedAvailability> {
  const url = process.env.STUDIO_ICS_URL;
  if (!url) throw new Error("STUDIO_ICS_URL לא מוגדר");

  const { fromIsrael, toIsrael } = bookingWindowFor(opts.now);
  const windowStart = israelInstant(fromIsrael, 0, 0);
  const windowEnd = new Date(israelInstant(toIsrael, 0, 0).getTime() + 86_400_000);

  // ONE fetch, for the reason the internal route spells out: the events and the
  // recurring-series gate must come from the same read of the same feed, or the
  // busy blocks and the refusals describe two different calendars.
  const icsText = await fetchIcsText(url);
  const events = parseIcsText(icsText);
  const liveSeries = findLiveSeriesInWindow(icsText, windowStart, windowEnd, STUDIOS);
  const approved = await loadApprovedRequests(admin, windowStart, windowEnd);

  const result = computeAvailability(
    events,
    liveSeries,
    STUDIOS,
    {
      fromIsrael,
      toIsrael,
      openDays: [0, 1, 2, 3, 4], // Sun–Thu; Friday and Saturday are closed
      openHour: 9,
      closeHour: 19,
      slotMinutes: 90,
      slotStepMinutes: opts.stepMinutes,
    },
    approved
  );

  return {
    fromIsrael,
    toIsrael,
    rooms: STUDIOS.filter((s) => s.bookable).map((s) => s.canonical),
    result,
  };
}
