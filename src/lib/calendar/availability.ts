import type { CalendarEvent } from "./parse";
import { roomsInTitle } from "./rooms";
import type { LiveSeries } from "./series";
import type { Studio } from "./studios";

// ═══════════════════════════════════════════════════════════════════════════
// Availability — PURE. No fetch, no database, no Date.now().
// ═══════════════════════════════════════════════════════════════════════════
//
// Stage 2 of client-booked recordings (owner decisions 2026-09-22). The window
// arrives as an argument precisely so this is deterministic and testable: the
// caller owns "not today" and "at most 8 weeks ahead", this file owns nothing
// but the arithmetic.
//
// ─── owner decisions this file implements, none of them re-openable ───
//  1. The calendar is the source of truth and it is complete. A sparse future
//     is a REAL state — recordings are booked days, not months, ahead — so a
//     mostly-free November is the correct answer, not a bug.
//  2. An event whose title names no room does NOT block. It is returned in
//     `unknownRoomBlocks` for the owner to look at. Blocking all three rooms
//     on it would empty the screen: 54.4% of events in the trailing 8 weeks
//     name no room (measured 2026-09-22).
//  3. An all-day event blocks the rooms ITS OWN TITLE names, for the whole
//     Israeli day, and no other room. Several rooms in the title -> all of
//     them. All-day with no room -> decision 2 applies, a warning, not a block.
//  4. TRANSP is ignored entirely. Every event occupies. The feed marks
//     "סגור ליום צילום לא לקבוע כלום" as TRANSPARENT, so honouring the flag
//     would open exactly the days the owner closed by hand.
//  5. LOCATION is never a room signal — see the long note in ./rooms.
//  6. Sun–Thu only, 09:00–19:00 Israel, 90-minute slot. Friday and Saturday
//     produce zero slots.
//  7. גבעון and גבעון גדול are separate rooms. Neither blocks the other.
//     TLV is a real room but not bookable (BOOKABLE_STUDIOS in ./studios).

export type BusyBlock = {
  /** null on an all-day block — it is a whole Israeli day, not an instant. */
  start: Date | null;
  end: Date | null;
  /** All rooms named in the title. Empty = unknown, which never blocks. */
  rooms: string[];
  allDay: boolean;
  /** Israeli dates an all-day block covers, inclusive. Empty when not allDay. */
  allDayDates: string[];
  uid: string;
  title: string;
  /**
   * WHERE THIS OCCUPANCY CAME FROM, and it is not decoration.
   *
   *   "calendar"  a parsed ICS event. Its room was READ from a title, so it may
   *               have none — which is why unknownRoomBlocks exists.
   *   "request"   an APPROVED booking request (0096/0097). Its room is a column
   *               with a CHECK on it, never a parse, so it always has exactly
   *               one and can never be "unknown".
   *
   * The distinction is load-bearing in two places below: a request block must
   * never reach the unknown-room warnings (it has nothing to warn about, and a
   * client's own approved booking listed as "an event we could not read" would
   * be nonsense), and its `title` must never be shown — see the type note there.
   */
  source: "calendar" | "request";
};

/**
 * An approved booking request, as occupancy.
 *
 * ⚠️ `title` is DELIBERATELY NOT a field here. A request carries a guest name
 * and a free-text note, and neither may ever reach a screen that another
 * client can see. Giving this shape a title would put one keystroke between a
 * refactor and a guest's name on a stranger's calendar. The id is opaque and
 * is used for nothing but de-duplication.
 */
export type ApprovedRequest = {
  id: string;
  room: string;
  start: Date;
  end: Date;
};

/**
 * Approved requests -> busy blocks. Pure, and separate from `toBusyBlocks`
 * because the two have nothing in common but their output: one parses text it
 * is not sure about, this one copies two columns it is sure about.
 *
 * A row with a missing room, a missing instant, or an end at-or-before its
 * start is DROPPED rather than blocking. `booking_requests` has CHECK
 * constraints for exactly those (`booking_requests_range_chk`,
 * `booking_requests_studio_chk`), so a row like that cannot exist today — the
 * filter is here so a hand-built array in a test, or a column loosened later,
 * cannot invent a block that silently closes a studio.
 */
export function toRequestBlocks(requests: ApprovedRequest[]): BusyBlock[] {
  const out: BusyBlock[] = [];
  for (const r of requests ?? []) {
    if (!r || typeof r.room !== "string" || r.room.trim() === "") continue;
    if (!(r.start instanceof Date) || !(r.end instanceof Date)) continue;
    if (Number.isNaN(r.start.getTime()) || Number.isNaN(r.end.getTime())) continue;
    if (r.end.getTime() <= r.start.getTime()) continue;
    out.push({
      start: r.start,
      end: r.end,
      rooms: [r.room],
      allDay: false,
      allDayDates: [],
      uid: `request:${r.id}`,
      // never rendered; see the type note above
      title: "",
      source: "request",
    });
  }
  return out;
}

export type AvailabilityWindow = {
  /** inclusive, Israel calendar dates, "YYYY-MM-DD" */
  fromIsrael: string;
  toIsrael: string;
  /** 0 = Sunday. Owner: Sun–Thu. */
  openDays: number[];
  openHour: number; // 9
  closeHour: number; // 19
  /** length of a booking (owner: 90) */
  slotMinutes: number;
  /**
   * Distance between consecutive slot STARTS. 30 by default: the owner will
   * choose between a 30-minute and a 90-minute grid after seeing both, so it
   * is a parameter rather than a constant (2026-09-22).
   */
  slotStepMinutes?: number;
};

export type Slot = {
  room: string;
  dateIsrael: string; // "YYYY-MM-DD"
  startIsrael: string; // "HH:MM"
  endIsrael: string; // "HH:MM"
  start: Date; // absolute instant, DST-correct for that specific date
  end: Date;
};

export type UnknownRoomBlock = {
  uid: string;
  title: string;
  startIsrael: string | null; // "YYYY-MM-DD HH:MM", or the date for all-day
  allDay: boolean;
  /** true when this is a recurring master, not a single event. */
  isSeries: boolean;
};

export type RefusedRoom = {
  room: string;
  seriesUid: string;
  seriesTitle: string;
};

export type SkippedEvent = {
  uid: string;
  title: string;
  reason: "no-end" | "zero-length";
};

export type AvailabilityResult = {
  free: Slot[];
  /** Events that occupy something, but we cannot say what. Never blocking. */
  unknownRoomBlocks: UnknownRoomBlock[];
  /** Rooms offered NO slots at all, because a live series owns them. */
  roomsRefused: RefusedRoom[];
  /** Events we refused to guess a duration for. Never blocking. */
  skipped: SkippedEvent[];
};

// ═══════════════════════════════════════════════════════════════════════════
// Time. Every boundary is derived PER DATE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Israel leaves DST on 2026-10-25, inside any 8-week window opened in
// September — measured, not assumed. Before it 09:00 Israel is 06:00Z; after
// it, 07:00Z.
//
// `israelDayWindow` in the calendar sync route reads the offset ONCE, for
// `now`, and pastes it onto a date string. That is correct for the one day it
// was written for and wrong for every other day in this window: reusing it
// would shift the whole 09:00–19:00 band by an hour from 25.10 onward,
// offering 08:00 and refusing 19:00. It is deliberately not imported here.
//
// It also falls back to +2 on an unparseable offset (`|| 2`). Nothing here
// falls back: a boundary we cannot compute throws, because a silently wrong
// hour is a client standing outside a locked studio (owner, 2026-09-22).

const ISRAEL = "Asia/Jerusalem";

const OFFSET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ISRAEL,
  timeZoneName: "longOffset",
});

/** Israel's UTC offset in minutes at a given instant. Throws, never guesses. */
export function israelOffsetMinutes(instant: Date): number {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("israelOffsetMinutes: תאריך לא תקין");
  }
  const raw = OFFSET_FMT.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value;
  // "GMT+03:00" / "GMT+02:00". Israel is never at a half-hour offset and never
  // at GMT exactly, so anything else means the runtime's timezone data is not
  // what this code was written against — which must be loud.
  const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(raw ?? "");
  if (!m) throw new Error(`israelOffsetMinutes: היסט לא צפוי מ-Intl: ${JSON.stringify(raw)}`);
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateParts(dateIsrael: string): [number, number, number] {
  const m = DATE_RE.exec(dateIsrael);
  if (!m) throw new Error(`תאריך חייב להיות בפורמט YYYY-MM-DD: ${JSON.stringify(dateIsrael)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // round-trips only for a real calendar date — rejects 2026-02-30
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`תאריך לא קיים: ${dateIsrael}`);
  }
  return [y, mo, d];
}

/**
 * The exact instant of a wall-clock time on an Israeli calendar date.
 *
 * Two passes: guess with the offset that applies at the naive instant, then
 * re-read the offset at the guessed instant and correct once. That is what
 * makes a date on the far side of a transition land correctly — a single-pass
 * conversion is off by an hour for the days after 25.10.
 */
export function israelInstant(dateIsrael: string, hour: number, minute: number): Date {
  const [y, mo, d] = parseDateParts(dateIsrael);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error("israelInstant: שעה ודקה חייבות להיות מספרים שלמים");
  }
  const naive = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
  const firstGuess = naive - israelOffsetMinutes(new Date(naive)) * 60_000;
  const corrected = naive - israelOffsetMinutes(new Date(firstGuess)) * 60_000;
  return new Date(corrected);
}

/** 0 = Sunday. Pure calendar arithmetic — no timezone involved. */
export function israelWeekday(dateIsrael: string): number {
  const [y, mo, d] = parseDateParts(dateIsrael);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/**
 * The Israeli calendar date an instant falls on — "YYYY-MM-DD".
 *
 * Through Intl, because this is the one question a UTC server gets wrong on its
 * own: between Israeli midnight and 02:00/03:00 the UTC date is still the day
 * before. See ./bookingWindow for what that costs.
 */
export function israelDateOf(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("israelDateOf: תאריך לא תקין");
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: ISRAEL }).format(instant);
}

/**
 * `n` days after an Israeli calendar date, as a date string.
 *
 * Pure calendar arithmetic on the DATE, never on an instant — adding 86400000
 * ms across the 25.10 transition lands on the wrong day, and a booking window
 * that is one day short is not a visible failure.
 */
export function addIsraelDays(dateIsrael: string, n: number): string {
  const [y, mo, d] = parseDateParts(dateIsrael);
  if (!Number.isInteger(n)) throw new Error("addIsraelDays: n חייב להיות מספר שלם");
  const shifted = new Date(Date.UTC(y, mo - 1, d + n));
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Every Israeli calendar date in [from, to], inclusive of both ends. */
export function israelDatesBetween(fromIsrael: string, toIsrael: string): string[] {
  const [fy, fm, fd] = parseDateParts(fromIsrael);
  const [ty, tm, td] = parseDateParts(toIsrael);
  let cursor = Date.UTC(fy, fm - 1, fd);
  const last = Date.UTC(ty, tm - 1, td);
  if (cursor > last) return [];
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  while (cursor <= last) {
    const d = new Date(cursor);
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
    cursor += 86_400_000;
  }
  return out;
}

/** "YYYY-MM-DD HH:MM" in Israel time, for display in the warning lists. */
function israelStamp(instant: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: ISRAEL,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "??";
  // en-CA renders hour 24 for midnight in some ICU builds; normalise it
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${g("year")}-${g("month")}-${g("day")} ${hh}:${g("minute")}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Events -> blocks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Turn parsed calendar events into occupancy, reporting what it refused to
 * interpret rather than guessing.
 *
 * `skipped` is the honest half of decision 1: an event with no DTEND, or one
 * that ends at or before it starts, has no duration we are entitled to invent.
 * Assuming 90 minutes would block a slot on a guess; assuming zero would free
 * a slot on a guess. It is reported instead, and blocks nothing.
 */
export function toBusyBlocks(
  events: CalendarEvent[],
  studios: Studio[]
): { blocks: BusyBlock[]; skipped: SkippedEvent[] } {
  const blocks: BusyBlock[] = [];
  const skipped: SkippedEvent[] = [];

  for (const e of events) {
    const rooms = roomsInTitle(e.title, studios);

    if (e.allDay === true) {
      // Timezone-free by construction: these strings are what the ICS wrote.
      // Reading e.start here instead would resolve a floating DATE in the host
      // machine's zone and land on the wrong day — see parse.ts.
      const first = e.startDateOnly;
      if (!first) {
        skipped.push({ uid: e.uid, title: e.title, reason: "no-end" });
        continue;
      }
      // DTEND is exclusive (RFC 5545): 26th->27th is the single day 26th.
      let dates: string[] = [first];
      if (e.endDateOnly) {
        const all = israelDatesBetween(first, e.endDateOnly);
        dates = all.length > 1 ? all.slice(0, -1) : [first];
      }
      blocks.push({ start: null, end: null, rooms, allDay: true, allDayDates: dates, uid: e.uid, title: e.title, source: "calendar" });
      continue;
    }

    // "no DTEND at all" before "ends where it starts": ical.js synthesises
    // endDate = startDate for a VEVENT with no DTEND, so checking the clock
    // first would label every end-less event "zero-length" — a wrong word in
    // front of the owner. hasExplicitEnd is the only thing that separates them.
    if (!e.start || !e.end || e.hasExplicitEnd === false) {
      skipped.push({ uid: e.uid, title: e.title, reason: "no-end" });
      continue;
    }
    if (e.end.getTime() <= e.start.getTime()) {
      skipped.push({ uid: e.uid, title: e.title, reason: "zero-length" });
      continue;
    }
    blocks.push({ start: e.start, end: e.end, rooms, allDay: false, allDayDates: [], uid: e.uid, title: e.title, source: "calendar" });
  }

  return { blocks, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════
// The computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Free slots per room, plus everything the computation could not account for.
 *
 * Intervals are HALF-OPEN, [start, end), on both sides. An event ending at
 * 10:30 does not touch a slot starting at 10:30 — back-to-back recordings are
 * the normal case here and there is no buffer (owner: "בלי מרווח").
 *
 * @param events  parsed calendar events, already narrowed to anything that
 *                could overlap the window. Passing more is harmless.
 * @param liveSeries  recurring masters with an occurrence in the window, from
 *                findLiveSeriesInWindow. Their rooms are refused wholesale.
 * @param knownStudios  the WHOLE studio list (STUDIOS), not just the bookable
 *                ones. This is the distinction studios.ts was written to
 *                protect: "is this text a room?" is asked of every entry,
 *                "may a client book it?" only of `bookable`. Passing only the
 *                bookable three would make a TLV recording parse as NO room,
 *                and it would surface as an unattributed warning forever — a
 *                real room misreported as a mystery. Slots are offered for
 *                `bookable` rooms alone, which is the filter below.
 * @param approvedRequests  APPROVED booking requests (0096/0097) that overlap
 *                the window. They block exactly like a calendar event and are
 *                OPTIONAL — defaulting to [] is what keeps every existing
 *                caller, and the 127-assertion suite, meaning precisely what
 *                they meant before.
 *
 *                ⚠️ PENDING REQUESTS ARE NOT PASSED HERE, and that is the
 *                owner's rule rather than an oversight (0096: two pending
 *                requests for one slot is a normal, frequent state that the
 *                owner decides between). A pending request that blocked would
 *                let any visitor holding the link close a studio for everyone
 *                by clicking three times.
 *
 *                An approved request that is ALSO already on the calendar —
 *                the owner pasted the event after approving — blocks the same
 *                slot twice, which removes it from `free` exactly once. There
 *                is nothing to de-duplicate: `free` is what is LEFT, so two
 *                reasons to remove a slot and one reason produce the same list.
 */
export function computeAvailability(
  events: CalendarEvent[],
  liveSeries: LiveSeries[],
  knownStudios: Studio[],
  win: AvailabilityWindow,
  approvedRequests: ApprovedRequest[] = []
): AvailabilityResult {
  const rooms = knownStudios.filter((s) => s.bookable);
  const step = win.slotStepMinutes ?? 30;
  if (!Number.isInteger(step) || step <= 0) throw new Error("slotStepMinutes חייב להיות מספר שלם חיובי");
  if (!Number.isInteger(win.slotMinutes) || win.slotMinutes <= 0) throw new Error("slotMinutes חייב להיות מספר שלם חיובי");
  if (!Number.isInteger(win.openHour) || !Number.isInteger(win.closeHour) || win.openHour >= win.closeHour) {
    throw new Error("openHour/closeHour לא תקינים");
  }

  // detection against the WHOLE list, offering against `rooms` — see above
  const { blocks: calendarBlocks, skipped: allSkipped } = toBusyBlocks(events, knownStudios);
  // One list from here down, so a request and an event are indistinguishable to
  // the grid: there is no second clash loop to keep in step with the first, and
  // a future change to how overlap is decided cannot apply to one and not the
  // other.
  const blocks = calendarBlocks.concat(toRequestBlocks(approvedRequests));

  // ---- rooms a live series takes off the market entirely -------------------
  const roomsRefused: RefusedRoom[] = [];
  const refused = new Set<string>();
  for (const s of liveSeries) {
    for (const room of s.rooms) {
      if (refused.has(room)) continue; // first series to claim a room names it
      refused.add(room);
      roomsRefused.push({ room, seriesUid: s.uid, seriesTitle: s.title });
    }
  }

  // ---- warnings: occupancy we cannot attribute to a room ------------------
  const unknownRoomBlocks: UnknownRoomBlock[] = [];
  const seenUnknown = new Set<string>();
  const pushUnknown = (u: UnknownRoomBlock) => {
    // exactly once per uid — a single event must not be reported twice just
    // because it is examined per room or per day (rule 56: count, don't find)
    if (seenUnknown.has(u.uid)) return;
    seenUnknown.add(u.uid);
    unknownRoomBlocks.push(u);
  };

  const windowStart = israelInstant(win.fromIsrael, 0, 0);
  const windowEnd = new Date(israelInstant(win.toIsrael, 0, 0).getTime() + 86_400_000);

  // ⚠️ All three reported lists must mean THE SAME WINDOW, or the screen lies
  // by juxtaposition. `toBusyBlocks` is a general utility and reports every
  // uninterpretable event it is handed — which is correct for it and wrong
  // here: the caller is allowed to pass the whole feed, and a 2019 event with
  // no DTEND is not a warning about the next eight weeks. Measured on the live
  // feed 2026-09-22: passing all 2,719 events surfaced 2 such warnings, both
  // dated outside the window, next to an unknown-room list that WAS filtered.
  const eventStartByUid = new Map<string, Date | null>();
  const allDayStartByUid = new Map<string, string | undefined>();
  for (const e of events) {
    if (!eventStartByUid.has(e.uid)) eventStartByUid.set(e.uid, e.start);
    if (e.allDay === true && !allDayStartByUid.has(e.uid)) allDayStartByUid.set(e.uid, e.startDateOnly);
  }
  const skipped = allSkipped.filter((s) => {
    const allDayDate = allDayStartByUid.get(s.uid);
    if (allDayDate) return allDayDate >= win.fromIsrael && allDayDate <= win.toIsrael;
    const start = eventStartByUid.get(s.uid) ?? null;
    // No usable start at all: we cannot place it, so we cannot exclude it
    // either. Reporting it is the conservative direction — a warning the owner
    // dismisses costs a glance; one we hid costs a double booking.
    if (!start) return true;
    return start >= windowStart && start < windowEnd;
  });

  // ⚠️ SERIES FIRST, AND THAT ORDER IS LOAD-BEARING. A recurring master is
  // also an ordinary event (its own DTSTART), so the same uid reaches both
  // loops. The dedupe keeps whichever arrives first — and "a weekly series
  // whose room we cannot read" is strictly more useful to the owner than "an
  // event on Sunday whose room we cannot read". Running the block loop first
  // silently drops the isSeries flag on exactly the events that most need it.
  for (const s of liveSeries) {
    if (s.rooms.length > 0) continue;
    pushUnknown({
      uid: s.uid, title: s.title,
      startIsrael: israelStamp(s.firstOccurrenceInWindow),
      allDay: false, isSeries: true,
    });
  }
  for (const b of blocks) {
    // a request always has exactly one room and nothing to warn about; it is
    // excluded by source rather than by "it happens to have a room", so the
    // guarantee survives a malformed row reaching toRequestBlocks
    if (b.source === "request") continue;
    if (b.rooms.length > 0) continue;
    if (b.allDay) {
      const inWindow = b.allDayDates.some((d) => d >= win.fromIsrael && d <= win.toIsrael);
      if (inWindow) pushUnknown({ uid: b.uid, title: b.title, startIsrael: b.allDayDates[0], allDay: true, isSeries: false });
      continue;
    }
    if (b.start && b.end && b.start < windowEnd && b.end > windowStart) {
      pushUnknown({ uid: b.uid, title: b.title, startIsrael: israelStamp(b.start), allDay: false, isSeries: false });
    }
  }

  // ---- the grid -----------------------------------------------------------
  const free: Slot[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  const openMinutes = win.openHour * 60;
  const closeMinutes = win.closeHour * 60;

  for (const date of israelDatesBetween(win.fromIsrael, win.toIsrael)) {
    if (!win.openDays.includes(israelWeekday(date))) continue;

    for (const studio of rooms) {
      const room = studio.canonical;
      if (refused.has(room)) continue;

      // all-day blocks are resolved per room per day, never as an instant
      const allDayBlocked = blocks.some(
        (b) => b.allDay && b.rooms.includes(room) && b.allDayDates.includes(date)
      );
      if (allDayBlocked) continue;

      // Every boundary on THIS date, so the DST transition is absorbed.
      for (let m = openMinutes; m + win.slotMinutes <= closeMinutes; m += step) {
        const startsAt = israelInstant(date, Math.floor(m / 60), m % 60);
        const endsAtMin = m + win.slotMinutes;
        const endsAt = israelInstant(date, Math.floor(endsAtMin / 60), endsAtMin % 60);

        const clash = blocks.some(
          (b) =>
            !b.allDay &&
            b.rooms.includes(room) &&
            b.start !== null &&
            b.end !== null &&
            // half-open on both sides: touching endpoints do not overlap
            b.start < endsAt &&
            b.end > startsAt
        );
        if (clash) continue;

        free.push({
          room,
          dateIsrael: date,
          startIsrael: `${pad(Math.floor(m / 60))}:${pad(m % 60)}`,
          endIsrael: `${pad(Math.floor(endsAtMin / 60))}:${pad(endsAtMin % 60)}`,
          start: startsAt,
          end: endsAt,
        });
      }
    }
  }

  return { free, unknownRoomBlocks, roomsRefused, skipped };
}
