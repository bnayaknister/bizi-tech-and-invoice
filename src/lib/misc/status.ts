/**
 * The "רדיו ושונות" status vocabulary — ONE copy, two screens.
 *
 * ═══ WHY THIS MOVED OUT OF MiscClient ═══
 * /projects now shows misc work beside podcast episodes (owner decision 5.10),
 * so a second component needs the same four names and the same four colours. The
 * alternative was ProjectsClient importing from MiscClient — a "use client"
 * module whose other 800 lines are a kanban board, its drag handlers and its
 * fetch calls — to reach a four-entry record. That drags a client boundary and a
 * whole screen's worth of code into a dependency on nothing.
 *
 * So the vocabulary lives here and MiscClient reads it from here. Not a copy:
 * two spellings of a status colour is two chances for the same cancelled row to
 * be grey on one screen and red on the other.
 *
 * ═══ ★ THE RULE FOR EVERY READER — NAMED, NEVER RANGED ═══
 * 0074's header (migrations/0074_misc_productions.sql:59-67) states it and this
 * module is its UI half: `misc_production_status` is ordered
 *
 *     נפתח → בעבודה → הושלם → בוטל          ('בוטל' LAST)
 *
 * so ANY test shaped like `status >= 'הושלם'` or `status < 'בוטל'` sweeps
 * CANCELLED rows into the set it meant to exclude. The enum order exists for
 * display, not for logic. This is the same trap 0060, 0061 and 0062 each warn
 * about in turn for production_status, where 'בוטל' is likewise last.
 *
 * Every export below is keyed or listed by literal name. A record keyed on the
 * literal cannot make that mistake, and an unknown value falls through to a
 * neutral tone rather than being silently grouped with whatever sorts beside it.
 */

/** The one cancelled value. Named here so no caller has to spell it. */
export const MISC_CANCELLED = "בוטל";

/**
 * Status colour, keyed BY NAME.
 *
 * Hues follow DESIGN.md §2: cyan is open commitment (never debt), violet is the
 * active signal, green is done, and cancelled is greyed out rather than red — a
 * cancelled job is not a problem to fix, it is a job that will not happen.
 */
export const MISC_STATUS_TONE: Record<string, string> = {
  "נפתח": "var(--cyan)",
  "בעבודה": "var(--violet-light)",
  "הושלם": "var(--green)",
  [MISC_CANCELLED]: "var(--faint)",
};

/** Neutral fallback for a value this build does not know. Never a guess at the hue. */
export const MISC_STATUS_TONE_FALLBACK = "var(--dim)";

export const miscStatusTone = (status: string | null | undefined): string =>
  MISC_STATUS_TONE[status ?? ""] ?? MISC_STATUS_TONE_FALLBACK;

/**
 * The three board columns — 'בוטל' is NOT one, and that is MiscClient's own
 * decision (its note at :161-186): a cancel asks for a reason and a drag cannot,
 * so a 'בוטל' column would empty both decisions at once. Cancelled rows stay
 * visible in the TABLE. Off the board is not out of the screen.
 */
export const MISC_BOARD_STATES = ["נפתח", "בעבודה", "הושלם"] as const;

/** The two states that mean "work is still live". Listed, never ranged. */
export const MISC_OPEN_STATES = ["נפתח", "בעבודה"] as const;
