// ═══════════════════════════════════════════════════════════════════════════
// How long a recording is. PURE. E9-2, owner decision 8.10 (rule ג).
// ═══════════════════════════════════════════════════════════════════════════
//
// Until now the length was a CONSTANT in one place — `slotMinutes: 90` inside
// `loadAvailability` (availabilityServer.ts) — and the client was told about it
// in a sentence they could not act on ("הקלטה של שעה וחצי"). The owner's
// decision turns it into a CHOICE the client makes before the grid is drawn,
// because the grid is what changes: a 240-minute recording has far fewer
// legal start times than a 90-minute one, and some days have none at all.
//
// 🔴 THE THREE VALUES LIVE HERE AND NOWHERE ELSE. They are a closed list, not
// a number a caller may invent: a duration that is not one of these three
// would produce a calendar event of a length the studio does not sell, and —
// worse — an availability grid computed against a length nobody validated.
// Every entry point (the public availability route, the public request route,
// the owner's internal preview) validates through `validateDuration` and
// refuses anything else, rather than clamping or defaulting silently.
//
// ⚠️ 90 IS STILL THE DEFAULT, and that is what keeps this change backward
// compatible: a request that says nothing about duration gets exactly the
// behaviour it got before this file existed.
//
// ⚠️ AND THE STEP IS NOT THE LENGTH. `slotStepMinutes` (30) is the distance
// between offered START times; `slotMinutes` is how long the booking runs.
// They were conflated in conversation once already (owner, 8.10: "משבצות של
// 30 דק׳" meant the step) and the distinction is load-bearing: at a 30-minute
// step a 240-minute booking is still offered at 09:00, 09:30, 10:00 … up to
// the last start that fits before closing.

/** The three lengths a client may choose. Minutes. */
export const BOOKING_DURATIONS = [90, 180, 240] as const;

export type BookingDuration = (typeof BOOKING_DURATIONS)[number];

/** What a request with no stated duration gets — the pre-E9-2 behaviour. */
export const DEFAULT_BOOKING_DURATION: BookingDuration = 90;

/**
 * Approved copy (owner, 8.10). The parenthetical is part of the label: the
 * client is choosing between products, not entering a number of minutes, and
 * "פרק כפול" is the owner's own word for the middle one.
 */
export const DURATION_LABEL: Record<BookingDuration, string> = {
  90: "שעה וחצי (רגיל)",
  180: "שלוש שעות (פרק כפול)",
  240: "ארבע שעות",
};

/** The short form, for the owner's queue — "3 שעות" next to the time range. */
export const DURATION_SHORT: Record<BookingDuration, string> = {
  90: "שעה וחצי",
  180: "3 שעות",
  240: "4 שעות",
};

/**
 * A caller's value -> one of the three, or null.
 *
 * ⚠️ VALIDATED, NEVER CLAMPED. A body that says 120 is refused rather than
 * rounded to 90: the client's screen cannot produce 120, so a request carrying
 * it is either a bug in our page or somebody hand-crafting a call, and both are
 * worth failing on. Quietly booking 90 minutes for someone who asked for 120
 * is the shape of failure that only surfaces on the recording day.
 *
 * `undefined` and `null` mean "not stated" and yield the DEFAULT — that is the
 * backward-compatible path, and it is deliberately distinguished from a stated
 * value that is wrong.
 */
export function validateDuration(raw: unknown): BookingDuration | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_BOOKING_DURATION;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n)) return null;
  return (BOOKING_DURATIONS as readonly number[]).includes(n) ? (n as BookingDuration) : null;
}

/**
 * Minutes between two Israeli "HH:MM" strings on the same day, or null.
 *
 * Used to put a duration tag on a STORED request, where the only facts are
 * `start_at` and `end_at` — there is no duration column (and deliberately so:
 * see the note in 0096's own header about what the table does not carry; the
 * length is derivable from the two instants and a third copy of it could
 * disagree with them).
 */
export function durationFromRange(startIso: string, endIso: string): number | null {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.round((b - a) / 60000);
}

/**
 * The tag the owner's queue shows — and ONLY for a non-standard length.
 *
 * 90 minutes returns null on purpose: it is the overwhelming majority of rows,
 * and a tag on every one of them is noise that makes the exceptional ones
 * harder to see. A length that is not one of the three (a row from before this
 * feature, or one an owner edited by hand in the database) gets its raw minute
 * count rather than being hidden.
 */
export function durationTag(startIso: string, endIso: string): string | null {
  const m = durationFromRange(startIso, endIso);
  if (m === null || m === DEFAULT_BOOKING_DURATION) return null;
  return (DURATION_SHORT as Record<number, string | undefined>)[m] ?? `${m} דק׳`;
}
