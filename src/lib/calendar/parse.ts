import ICAL from "ical.js";

export type CalendarEvent = {
  uid: string;
  title: string;
  start: Date | null;
  end: Date | null;
  location: string | null;
};

// node-ical was tried first but its Temporal polyfill dependency breaks
// both Next's build-time route analysis AND actual runtime execution in
// this pipeline ("o.BigInt is not a function") — ical.js has no such
// dependency and parses the same VEVENT fields we need.
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
