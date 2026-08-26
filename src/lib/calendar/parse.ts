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

    const location = vevent.getFirstPropertyValue("location");
    out.push({
      uid: String(event.uid),
      title: String(event.summary),
      start,
      end,
      location: location ? String(location) : null,
      recurrence: readRecurrence(vevent),
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
