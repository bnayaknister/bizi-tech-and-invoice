import { matchTitleToShow, type ShowForMatch } from "./match";
import type { CalendarEvent, Recurrence } from "./parse";

// Detection, not repair (owner decision 2026-08-26). The sync does not expand
// RRULE, so every occurrence of a recurring series except the master's own
// date — and except occurrences someone moved, which get their own VEVENT —
// silently never becomes a production. That is how the 25.8 episode of
// "סדרת חינוך" was lost: nothing failed, nothing was logged, the day was
// simply absent.
//
// The owner's decision was NOT to build expansion (docs/BACKLOG-V1b.md holds
// the full analysis — the blocker is the partial UNIQUE index on
// calendar_uid, not the iteration) but to make the silence visible, and to
// keep creating single events by hand. This module is that warning: it reads
// the rule's properties and nothing else. No iterator, no expansion, no
// ICAL.Event — so it cannot inherit any of the traps that make the real fix
// expensive.

export type UnsyncedRecurring = {
  uid: string;
  title: string;
  showId: string;
  showName: string;
};

const FREQ_DAYS: Record<string, number> = {
  SECONDLY: 1 / 86400,
  MINUTELY: 1 / 1440,
  HOURLY: 1 / 24,
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 30,
  YEARLY: 365,
};

/**
 * Is this series still producing occurrences? Deliberately cheap and
 * deliberately approximate.
 *
 * The point is triage, not precision: most masters on the feed are dead
 * (a 2019 standing meeting, a 2020 client series that ended). Warning about
 * those would train the owner to ignore the alert, which is the one outcome
 * worth avoiding. Both approximations below round toward "alive", so the
 * failure mode is a warning we did not need — never a silence we did.
 *
 *   UNTIL -> the rule says when it stops. Exact.
 *   COUNT -> last occurrence is approximated as
 *            dtstart + (count - 1) x interval x FREQ_DAYS. This ignores
 *            BYDAY/BYMONTHDAY and treats a month as 30 days and a year as
 *            365, so it can be off by days near the boundary. Accepted by
 *            the owner: a series that ended within days of today is a
 *            harmless thing to mention.
 *   neither -> unbounded. This is the case that actually matters
 *              ("FREQ=WEEKLY" with no end is what סדרת חינוך carries).
 */
export function isStillRunning(rec: Recurrence, dtstart: Date | null, now: Date): boolean {
  if (rec.until) return rec.until >= now;
  if (rec.count !== null && dtstart) {
    const perStep = FREQ_DAYS[rec.freq ?? ""] ?? 7; // unknown FREQ -> weekly, the common case
    const spanDays = (rec.count - 1) * (rec.interval || 1) * perStep;
    return new Date(dtstart.getTime() + spanDays * 86_400_000) >= now;
  }
  return true; // no UNTIL, no COUNT
}

/**
 * The two filters, in the order that makes the second one cheap.
 *
 * `shows` must already be the ACTIVE ones — the caller passes the same
 * `showsForMatch` list the sync itself matches against, so an archived
 * show's stale alias can never raise this.
 *
 * ⚠️ `events` must be the WHOLE parsed feed, NOT the day-window slice. A
 * master's own DTSTART is whatever day the series began — סדרת חינוך's is
 * 18.8 — so it survives the day filter on exactly one day per series. Run
 * this after the filter and the warning fires one day a year.
 */
export function findUnsyncedRecurring(
  events: CalendarEvent[],
  shows: ShowForMatch[],
  now: Date
): UnsyncedRecurring[] {
  const out: UnsyncedRecurring[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!event.recurrence) continue;
    if (!isStillRunning(event.recurrence, event.start, now)) continue;
    const match = matchTitleToShow(event.title, shows);
    if (!match) continue; // same "permit, not block" rule as the sync itself
    if (seen.has(event.uid)) continue;
    seen.add(event.uid);
    out.push({ uid: event.uid, title: event.title, showId: match.show.id, showName: match.show.name });
  }
  return out;
}
