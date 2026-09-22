import { israelDateOf, addIsraelDays } from "./availability";

// ═══════════════════════════════════════════════════════════════════════════
// Which eight weeks are open for booking. PURE — `now` is a parameter.
// ═══════════════════════════════════════════════════════════════════════════
//
// Policy, not arithmetic: ./availability owns the slot maths, this owns the two
// owner rules that decide the window's edges (2026-09-22):
//
//   never the same day   -> the window opens TOMORROW
//   at most 8 weeks out  -> 56 Israeli days, `from` included
//
// ⚠️ WHY "TOMORROW" IS NOT `new Date(Date.now() + 86400000)`
// ══════════════════════════════════════════════════════════════════════════
// Israel runs 2 or 3 hours AHEAD of UTC, so between local midnight and 02:00
// (winter) or 03:00 (summer) the UTC calendar date is STILL YESTERDAY. This
// code runs on Vercel, which is UTC. Deriving tomorrow from a UTC date in that
// window yields TODAY in Israel — and today is exactly the day the owner ruled
// out. The failure is silent, it only happens for two or three hours a night,
// and what it produces is a client booking a studio for this afternoon.
//
// So the Israeli calendar date is read through Intl first, and the day is added
// to that STRING. No instant arithmetic anywhere in here.

/** 8 weeks counted inclusively: `from` plus 55 more days. */
export const BOOKING_WINDOW_DAYS = 56;

export type BookingWindowDates = {
  /** tomorrow, Israel time — "YYYY-MM-DD" */
  fromIsrael: string;
  /** fromIsrael + 55 days — "YYYY-MM-DD", inclusive */
  toIsrael: string;
};

/**
 * The bookable window as of `now`.
 *
 * @param now the instant to compute from. A parameter, never Date.now(), so
 *            the boundary cases (23:30, 00:30, 02:59 Israel) are testable
 *            rather than reachable only by waiting for them.
 */
export function bookingWindowFor(now: Date): BookingWindowDates {
  const todayIsrael = israelDateOf(now);
  const fromIsrael = addIsraelDays(todayIsrael, 1);
  return { fromIsrael, toIsrael: addIsraelDays(fromIsrael, BOOKING_WINDOW_DAYS - 1) };
}
