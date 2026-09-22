import ICAL from "ical.js";
import { roomsInTitle } from "./rooms";
import type { Studio } from "./studios";

// ═══════════════════════════════════════════════════════════════════════════
// The recurring-series GATE. Not an expansion.
// ═══════════════════════════════════════════════════════════════════════════
//
// The sync does not expand RRULE (owner decision 2026-08-26, unchanged), so
// every occurrence of a series except the master's own date is invisible to
// the system. For a board that is a missing production. For a BOOKING SCREEN
// it is worse: a room that is busy every Tuesday at 10:00 would be offered to
// a client as free, and the client would arrive to a locked studio.
//
// The owner's decision for availability (2026-09-22) is neither to expand nor
// to ignore, but to REFUSE: a room with a live series in the window is not
// offered at all, for the whole window, and the screen says which series did
// it. A refusal the owner can see and act on beats a false "free".
//
// So this module answers exactly one question — "does this series put any
// occurrence inside the window?" — and answers it precisely, because a
// refusal that fires on a series which ended last year would take a bookable
// room off the market for nothing. Measured on the live feed 2026-09-22: all
// 20 masters are dead, 0 occurrences in the next 8 weeks. A sloppy gate would
// have refused rooms anyway.
//
// It reads ICS text rather than CalendarEvent[] on purpose: EXDATE and
// RECURRENCE-ID never reach CalendarEvent, and adding them there would mean
// reshaping a type the sync depends on.

export type LiveSeries = {
  uid: string;
  title: string;
  rooms: string[]; // every room named in the title — may be empty
  firstOccurrenceInWindow: Date;
  occurrencesInWindow: number;
};

// A pathological RRULE (FREQ=SECONDLY, no UNTIL) must not hang the request.
// The loop also stops at the window end, so this only ever trips on a rule
// whose step is absurdly small — in which case the series is nonsense and
// refusing the room is the right outcome anyway.
const MAX_ITERATIONS = 20_000;

/**
 * Every recurring master with at least one occurrence in [from, to).
 *
 * Honours, all four measured against ical.js 2026-09-22:
 *   UNTIL / COUNT   — ICAL.RecurExpansion stops on its own.
 *   EXDATE          — RecurExpansion skips excluded dates when the expansion
 *                     is built from the COMPONENT (not from a bare rule), so
 *                     it is built that way here.
 *   RECURRENCE-ID   — NOT handled by RecurExpansion. Handled below by hand:
 *                     an occurrence whose slot was overridden is dropped from
 *                     the base expansion, and the override's own DTSTART is
 *                     counted instead (or not at all, if the override was
 *                     cancelled). Without this, a series whose only occurrence
 *                     in the window was MOVED OUT of it would still refuse the
 *                     room, and one moved INTO the window would not.
 *
 * Pure with respect to time: `from`/`to` are inputs, nothing calls Date.now().
 */
export function findLiveSeriesInWindow(
  icsText: string,
  from: Date,
  to: Date,
  studios: Studio[]
): LiveSeries[] {
  const comp = new ICAL.Component(ICAL.parse(icsText));
  const vevents = comp.getAllSubcomponents("vevent");

  // ---- pass 1: index the RECURRENCE-ID overrides by their parent UID -------
  // key: `${uid}|${recurrence-id as UTC ms}` -> the override's own start, or
  // null when the override cancels that occurrence outright.
  const overrides = new Map<string, Date | null>();
  for (const ve of vevents) {
    const ridProp = ve.getFirstProperty("recurrence-id");
    if (!ridProp) continue;
    const uid = String(ve.getFirstPropertyValue("uid") ?? "");
    let ridMs: number;
    try {
      ridMs = (ridProp.getFirstValue() as ICAL.Time).toJSDate().getTime();
    } catch {
      continue; // unreadable RECURRENCE-ID — leave the base occurrence standing
    }
    const cancelled =
      String(ve.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
    let moved: Date | null = null;
    if (!cancelled) {
      try {
        moved = (ve.getFirstPropertyValue("dtstart") as ICAL.Time).toJSDate();
      } catch {
        moved = null;
      }
    }
    overrides.set(`${uid}|${ridMs}`, moved);
  }

  // ---- pass 2: expand each master, minus/plus its overrides ---------------
  const out: LiveSeries[] = [];
  for (const ve of vevents) {
    if (ve.hasProperty("recurrence-id")) continue; // an override is not a master
    if (!ve.hasProperty("rrule") && !ve.hasProperty("rdate")) continue;
    // A master the calendar itself cancelled is not a live series. The parser
    // drops CANCELLED events for the same reason; this path never sees them.
    if (String(ve.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") continue;

    const uid = String(ve.getFirstPropertyValue("uid") ?? "");
    const title = String(ve.getFirstPropertyValue("summary") ?? "");

    const dtstart = ve.getFirstPropertyValue("dtstart") as ICAL.Time | null;
    if (!dtstart) continue;

    const hits: Date[] = [];
    try {
      const expansion = new ICAL.RecurExpansion({ component: ve, dtstart });
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const next = expansion.next();
        if (!next) break;
        const base = next.toJSDate();
        if (base >= to) break; // occurrences are ascending — nothing further can land

        const key = `${uid}|${base.getTime()}`;
        let actual: Date | null = base;
        if (overrides.has(key)) actual = overrides.get(key) ?? null; // moved, or cancelled

        if (actual && actual >= from && actual < to) hits.push(actual);
      }
    } catch {
      // A rule ical.js cannot expand is a rule we cannot prove is dead.
      // Refusing the room is the conservative direction, so treat it as live
      // from the window's first moment rather than silently dropping it.
      hits.push(from);
    }

    // An override may move an occurrence INTO the window from a base slot at
    // or after `to` — the ascending break above would never have reached it.
    // Scan the overrides of this uid directly so that case is not missed.
    for (const [key, moved] of Array.from(overrides.entries())) {
      if (!key.startsWith(`${uid}|`)) continue;
      if (!moved) continue;
      if (moved >= from && moved < to && !hits.some((h) => h.getTime() === moved.getTime())) {
        hits.push(moved);
      }
    }

    if (hits.length === 0) continue;
    hits.sort((a, b) => a.getTime() - b.getTime());
    out.push({
      uid,
      title,
      rooms: roomsInTitle(title, studios),
      firstOccurrenceInWindow: hits[0],
      occurrencesInWindow: hits.length,
    });
  }
  return out;
}
