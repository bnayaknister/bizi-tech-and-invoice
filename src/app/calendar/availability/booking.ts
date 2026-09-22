// ═══════════════════════════════════════════════════════════════════════════
// The client screen's arithmetic. PURE — no hooks, no fetch, no Date.now().
// ═══════════════════════════════════════════════════════════════════════════
//
// The route already answered the hard question (which slots are free, DST and
// all). Everything here is a narrowing of that answer for ONE room, done in the
// browser so the route and computeAvailability stay untouched.

export type FreeSlot = {
  room: string;
  dateIsrael: string; // "YYYY-MM-DD"
  startIsrael: string; // "HH:MM"
  endIsrael: string; // "HH:MM"
};

/** 0 = Sunday. Pure calendar arithmetic on the date string — no timezone. */
export function weekdayOf(dateIsrael: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) return -1;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}

export const OPEN_WEEKDAYS = [0, 1, 2, 3, 4]; // Sun-Thu; Friday and Saturday closed

/**
 * The days a client may click, for ONE room.
 *
 * ⚠️ THE THREE CONDITIONS ARE RE-CHECKED HERE, not assumed from the payload.
 * Every slot the route returns already satisfies them, so filtering by room
 * alone would produce the same list today. They are checked anyway because this
 * function is what the CLICKABILITY of a day depends on, and the cost of the two
 * failures is not symmetric: a day wrongly dimmed is a lost booking, a day
 * wrongly clickable is a client sent to a studio that is not free. A malformed
 * or hand-built payload must not be able to produce the second one.
 *
 * `roomsRefused` is handled by the caller passing no room, or by this returning
 * nothing for a room with no slots — a refused room has zero slots in `free`,
 * so every one of its days is dimmed without a special case.
 */
export function clickableDays(
  free: FreeSlot[],
  room: string | null,
  fromIsrael: string,
  toIsrael: string
): string[] {
  if (!room) return [];
  const days = new Set<string>();
  for (const s of free ?? []) {
    if (s?.room !== room) continue;
    const d = s.dateIsrael;
    if (!d || d < fromIsrael || d > toIsrael) continue;
    if (!OPEN_WEEKDAYS.includes(weekdayOf(d))) continue;
    days.add(d);
  }
  return Array.from(days).sort();
}

/**
 * The free slots of one day in one room, ascending.
 *
 * The END TIME IS THE SLOT'S OWN `endIsrael`. It is never recomputed as
 * start + 90: the slot length is the route's decision and re-deriving it here
 * would be a second source of truth that silently disagrees the moment the
 * owner changes it.
 */
export function hoursFor(free: FreeSlot[], room: string | null, dateIsrael: string | null): FreeSlot[] {
  if (!room || !dateIsrael) return [];
  return (free ?? [])
    .filter((s) => s?.room === room && s?.dateIsrael === dateIsrael)
    .slice()
    .sort((a, b) => a.startIsrael.localeCompare(b.startIsrael));
}

// ─── months ────────────────────────────────────────────────────────────────

export type Month = { year: number; month: number }; // month is 1-12

export function monthOf(dateIsrael: string): Month {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) throw new Error(`monthOf: תאריך לא תקין ${JSON.stringify(dateIsrael)}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export const sameMonth = (a: Month, b: Month) => a.year === b.year && a.month === b.month;

/**
 * Every month the window touches, in order. The arrows walk this list and
 * nothing else — a client can never page to a month the window does not reach.
 */
export function monthsInWindow(fromIsrael: string, toIsrael: string): Month[] {
  const first = monthOf(fromIsrael);
  const last = monthOf(toIsrael);
  const out: Month[] = [];
  let { year, month } = first;
  // bounded by construction: the window is 56 days, so at most three months
  for (let guard = 0; guard < 24; guard++) {
    out.push({ year, month });
    if (year === last.year && month === last.month) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

/**
 * A Sunday-first month grid: six rows of seven, leading and trailing cells null.
 *
 * Sunday-first because the week starts on Sunday in Israel and the booking week
 * is Sun-Thu — a Monday-first grid would put the two closed days at opposite
 * ends of the row.
 */
export function monthGrid(m: Month): (string | null)[] {
  const firstWeekday = new Date(Date.UTC(m.year, m.month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  const cells: (string | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`${m.year}-${pad(m.month)}-${pad(d)}`);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// ─── display ───────────────────────────────────────────────────────────────

const DOW_HE = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

/** "א׳".."ש׳" for an Israeli date string. */
export function dowHebrew(dateIsrael: string): string {
  const w = weekdayOf(dateIsrael);
  return w < 0 ? "" : DOW_HE[w];
}

/** "23.9" — from the string, never through a Date, so the day cannot shift. */
export function dayMonth(dateIsrael: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIsrael ?? "");
  if (!m) return dateIsrael ?? "—";
  return `${Number(m[3])}.${Number(m[2])}`;
}

/** "ספטמבר 2026" */
export function monthLabel(m: Month): string {
  const d = new Date(Date.UTC(m.year, m.month - 1, 1));
  const name = new Intl.DateTimeFormat("he-IL", { timeZone: "UTC", month: "long" }).format(d);
  return `${name} ${m.year}`;
}

/** "יום ג׳ 29.9" — the day phrase both the hours heading and the card reuse. */
export function dayPhrase(dateIsrael: string): string {
  return `יום ${dowHebrew(dateIsrael)} ${dayMonth(dateIsrael)}`;
}

// ─── the owner's podcast picker ──────────────────────────────────────────────

/** A row as the server selects it. `active` is NOT NULL in the schema. */
export type ShowRow = {
  id: string;
  name: string | null;
  default_studio: string | null;
  active: boolean;
};

/** What the picker needs. `defaultRoom` is null when nothing preselects. */
export type PickerShow = { id: string; name: string; defaultRoom: string | null };

/**
 * The shows the owner may preview, and the room each one preselects.
 *
 * ═══ WHY THE `active` FILTER LIVES HERE AND NOT ONLY IN THE SQL ═══
 * The page's query already carries `.eq("active", true)`, which is the house
 * convention (`api/shows/list/route.ts:32`) and the right place to narrow a
 * fetch. But a filter inside a SQL string cannot be unit-tested without a
 * database, and F19 is open. Restating it here as a pure predicate is what
 * makes the rule assertable at all — and it is the same predicate the calendar
 * sync already applies in memory (`api/calendar/sync/route.ts:213`,
 * `.filter((s) => s.active)`), so this is an existing shape rather than a new
 * one. The two agree by construction; if a future edit drops the `.eq`, this
 * still holds.
 *
 * ⚠️ `is_oneoff` is deliberately NOT consulted. It is a SEPARATE axis — the
 * /shows screen has three tabs, active / oneoff / all (`ShowsClient.tsx:171`),
 * and a one-off show can perfectly well be active. Filtering on it would hide
 * live shows.
 *
 * `active` is boolean NOT NULL in the schema, so `=== true` and truthiness
 * agree; the explicit comparison is there so a row arriving as undefined from
 * a hand-built payload is dropped rather than kept.
 */
export function toPickerShows(
  rows: ShowRow[] | null | undefined,
  defaultRoomFor: (studio: string | null) => string | null
): PickerShow[] {
  return (rows ?? [])
    .filter((r) => r?.active === true)
    .map((r) => ({
      id: r.id,
      name: r.name ?? "—",
      defaultRoom: defaultRoomFor(r.default_studio ?? null),
    }));
}
