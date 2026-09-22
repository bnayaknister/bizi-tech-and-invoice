import ICAL from "ical.js";

// A recurring event's rule, READ but never expanded (owner decision
// 2026-08-26). The sync deliberately does not support recurrence: a series
// reaches us as ONE master VEVENT carrying the rule, plus a separate VEVENT
// for each occurrence someone moved (RECURRENCE-ID). Every other occurrence
// exists only inside the rule, so it never becomes a production — which is
// how the 25.8 episode of "סדרת חינוך" was lost. Rather than expand (see
// docs/BACKLOG-V1b.md for why that is a much larger change than it looks),
// we carry the rule far enough to WARN about it. Nothing here iterates.
export type Recurrence = {
  freq: string | null; // WEEKLY / MONTHLY / ...
  interval: number; // defaults to 1
  count: number | null; // occurrence limit, when the rule uses one
  until: Date | null; // end date, when the rule uses one
};

export type CalendarEvent = {
  uid: string;
  title: string;
  start: Date | null;
  end: Date | null;
  location: string | null;
  // Non-null ONLY on a recurring master. An override (RECURRENCE-ID) is a
  // real, materialised VEVENT that the sync already handles normally, so it
  // is deliberately left null — it is not the thing we warn about.
  recurrence: Recurrence | null;

  // ═══ ADDITIVE, 2026-09-22 (booking availability, stage 2) ═══
  // The five fields above are what the sync reads and they are UNCHANGED —
  // verified byte-for-byte against the live feed by
  // scripts/verify_parse_unchanged.ts. Everything below is optional and
  // undefined for every caller that does not ask for it.

  /** DTSTART carried VALUE=DATE — an all-day event. */
  allDay?: boolean;

  /**
   * ⚠️ THE REASON THIS FIELD EXISTS — DO NOT DELETE IT AS REDUNDANT.
   *
   * An all-day DTSTART is a DATE with NO timezone ("floating"), and
   * ical.js resolves a floating value in the HOST MACHINE's zone. Measured
   * 2026-09-22 on `DTSTART;VALUE=DATE:20261026`:
   *
   *   on a machine set to Israel time -> toJSDate() = 2026-10-25T22:00:00Z
   *   getUTCDate() on that instant    -> 25.  THE WRONG DAY.
   *   on a UTC server (Vercel)        -> 2026-10-26T00:00:00Z
   *
   * So `start` above is, for an all-day event, an instant that DEPENDS ON
   * WHERE THE CODE RUNS, and the date cannot be recovered from it. A
   * booking screen that blocks "the day of this all-day event" by reading
   * `start` blocks the wrong day on one of the two machines — silently,
   * and only for half the year.
   *
   * These two carry the literal calendar text instead, so an all-day block
   * is timezone-free: exactly what the ICS wrote. DTEND is EXCLUSIVE per
   * RFC 5545, so a one-day event is start=20261026, end=20261027.
   */
  startDateOnly?: string; // "YYYY-MM-DD", only when allDay
  endDateOnly?: string; // "YYYY-MM-DD", exclusive, only when allDay

  /**
   * Did the VEVENT actually carry DTEND (or DURATION)?
   *
   * `end` above cannot answer this. When DTEND is absent, ical.js synthesises
   * endDate = startDate, so "no end time at all" and "a real zero-length
   * event" arrive identical (measured 2026-09-22). Both are refused by the
   * availability path either way — no duration is ever guessed — but the
   * owner's warning list should say which one it is, and only the raw
   * property knows.
   */
  hasExplicitEnd?: boolean;
};

// node-ical was tried first but its Temporal polyfill dependency breaks
// both Next's build-time route analysis AND actual runtime execution in
// this pipeline ("o.BigInt is not a function") — ical.js has no such
// dependency and parses the same VEVENT fields we need.
// Property inspection only — no ICAL.Event, no iterator, no exception
// relating. That last one matters: ICAL.Event's constructor relates EVERY
// RECURRENCE-ID component in the calendar to whatever event you build,
// without checking the UID (420 bogus links on the live feed, one of which
// already collides). This function never goes near that code path.
function readRecurrence(vevent: ICAL.Component): Recurrence | null {
  // An override is a materialised occurrence, not a series — the sync sees it
  // like any other event and it needs no warning.
  if (vevent.hasProperty("recurrence-id")) return null;
  const rrule = vevent.getFirstPropertyValue("rrule") as ICAL.Recur | null;
  if (!rrule) {
    // RDATE without RRULE is still a series whose extra dates we never
    // materialise. None exist on the feed today; treated as an unbounded
    // rule so it warns rather than hides.
    return vevent.hasProperty("rdate") ? { freq: null, interval: 1, count: null, until: null } : null;
  }
  let until: Date | null = null;
  try {
    until = rrule.until ? rrule.until.toJSDate() : null;
  } catch {
    // malformed UNTIL — treat as unbounded, which errs toward warning
  }
  return {
    freq: rrule.freq ? String(rrule.freq) : null,
    interval: rrule.interval || 1,
    count: rrule.count ?? null,
    until,
  };
}

// The literal calendar date an ICAL.Time names, with no timezone arithmetic
// anywhere in it — `.year/.month/.day` are the numbers the ICS actually wrote.
// Going through toJSDate() here would reintroduce exactly the host-timezone
// bug that startDateOnly exists to avoid.
function dateOnly(t: ICAL.Time): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)}`;
}

export function parseIcsText(text: string): CalendarEvent[] {
  const jcal = ICAL.parse(text);
  const comp = new ICAL.Component(jcal);
  const out: CalendarEvent[] = [];

  for (const vevent of comp.getAllSubcomponents("vevent")) {
    const status = vevent.getFirstPropertyValue("status");
    // cancelled events behave like they were removed from the calendar —
    // the sync's "removed" handling covers them the same way
    if (typeof status === "string" && status.toUpperCase() === "CANCELLED") continue;

    const event = new ICAL.Event(vevent);
    if (!event.uid || !event.summary) continue;

    let start: Date | null = null;
    let end: Date | null = null;
    try {
      start = event.startDate ? event.startDate.toJSDate() : null;
      end = event.endDate ? event.endDate.toJSDate() : null;
    } catch {
      // malformed date on this one event — skip its timing, keep the row
    }

    // All-day detection reads the RAW property, never `start` above — see the
    // warning on startDateOnly for why that instant is untrustworthy here.
    const rawStart = vevent.getFirstPropertyValue("dtstart") as ICAL.Time | null;
    const rawEnd = vevent.getFirstPropertyValue("dtend") as ICAL.Time | null;
    const allDay = rawStart ? rawStart.isDate === true : false;

    const location = vevent.getFirstPropertyValue("location");
    out.push({
      uid: String(event.uid),
      title: String(event.summary),
      start,
      end,
      location: location ? String(location) : null,
      recurrence: readRecurrence(vevent),
      allDay,
      hasExplicitEnd: vevent.hasProperty("dtend") || vevent.hasProperty("duration"),
      ...(allDay && rawStart ? { startDateOnly: dateOnly(rawStart) } : {}),
      ...(allDay && rawEnd ? { endDateOnly: dateOnly(rawEnd) } : {}),
    });
  }
  return out;
}

// read-only fetch of the real (secret) calendar URL — never writes to it
export async function fetchAndParseIcs(url: string): Promise<CalendarEvent[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`קריאת יומן נכשלה: ${res.status}`);
  const text = await res.text();
  return parseIcsText(text);
}
