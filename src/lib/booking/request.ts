import type { Slot } from "@/lib/calendar/availability";

// ═══════════════════════════════════════════════════════════════════════════
// Everything the public request endpoint decides. PURE — no fetch, no client,
// no Date.now(). The route hands these functions rows and a clock and does
// nothing but forward the answer.
// ═══════════════════════════════════════════════════════════════════════════
//
// The split is the point. An endpoint that a stranger can reach with a link is
// exactly the code that must be assertable without a database, and F19 is
// open: no test here creates a user or writes a row.

/** The three rooms a client may book — the canonical spellings, as 0096's CHECK holds them. */
export const BOOKABLE_ROOM_NAMES = ["גבעון", "גבעון גדול", "חשמונאים"] as const;
export type BookableRoom = (typeof BOOKABLE_ROOM_NAMES)[number];

/** 0097's CHECK, restated so the app rejects before the database has to. */
export const GUEST_MAX_CHARS = 120;
/** 0096's CHECK on `note`. */
export const NOTE_MAX_CHARS = 500;

/** Owner rules (23.9), the three brakes on a link that has leaked or is being hammered. */
export const MAX_PENDING_PER_SHOW = 3;
export const MAX_REQUESTS_PER_LINK_PER_DAY = 10;
export const LINK_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ─── guest ──────────────────────────────────────────────────────────────────

/**
 * Whitespace, in every form that reaches a text input, collapsed to one space.
 *
 * Written out rather than left to `\s` even though JavaScript's `\s` already
 * covers NBSP and every Unicode space separator: the DIRECTIONAL marks do not
 * belong to it, they are invisible, and a Hebrew form pasted from WhatsApp
 * carries them. A name that differs from another only by an invisible U+200F
 * is a name the owner cannot match by eye.
 *
 *   \s            spaces, tabs, newlines, NBSP, ZWNBSP
 *   ‎-‏ LRM / RLM
 *   ‪-‮ LRE RLE PDF LRO RLO
 *   ⁦-⁩ LRI RLI FSI PDI
 */
const BLANKISH = /[\s‎‏‪-‮⁦-⁩]+/g;

/**
 * Count CHARACTERS, the way `char_length` does, not UTF-16 units.
 *
 * `"…".length` counts a surrogate pair as 2 and Postgres counts it as 1, so a
 * 120-character name containing one emoji would be refused here and accepted
 * there. The app must not be stricter than the constraint it is protecting —
 * a client retyping a name the database would have taken is a failure with no
 * error message anywhere.
 */
export const charLength = (s: string): number => Array.from(s).length;

export type GuestResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: "too-long" };

/**
 * The guest name exactly as the client typed it, minus whitespace noise.
 *
 * 🔴 NOTHING ELSE IS DONE TO IT. No comma substitution, no room-name guard, no
 * title shaping — all of which the title format will eventually need, and all
 * of which belong to the APPROVAL step (3ג) where a title is actually built.
 * Doing any of it here would mean the database stores a name the client never
 * wrote, permanently, to satisfy a format that does not exist yet. The stored
 * value must stay the client's own words; the title is derived later, from it.
 *
 * Empty after normalizing -> null, never "". That is 0097's rule enforced one
 * layer up: the CHECK rejects '' precisely so the app resolves the ambiguity
 * here instead of leaving two representations of "no guest" in the column.
 */
export function normalizeGuest(raw: unknown): GuestResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: true, value: null };
  const v = raw.replace(BLANKISH, " ").trim();
  if (v === "") return { ok: true, value: null };
  if (charLength(v) > GUEST_MAX_CHARS) return { ok: false, reason: "too-long" };
  return { ok: true, value: v };
}

export type NoteResult = { ok: true; value: string | null } | { ok: false; reason: "too-long" };

/**
 * The note, TRIMMED ONLY.
 *
 * Deliberately not collapsed like the guest: a note is prose, the client may
 * have written two lines on purpose, and flattening them changes what they
 * said. The guest is a name going into a one-line calendar title; this is not.
 */
export function normalizeNote(raw: unknown): NoteResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: true, value: null };
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  if (charLength(v) > NOTE_MAX_CHARS) return { ok: false, reason: "too-long" };
  return { ok: true, value: v };
}

// ─── studio ─────────────────────────────────────────────────────────────────

/**
 * One of the three, exactly. TLV lands here and is refused: it is a real room
 * the parsers recognise everywhere, and `bookable: false` is the whole reason
 * this list is three names and not four.
 */
export function validateStudio(raw: unknown): BookableRoom | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim();
  return (BOOKABLE_ROOM_NAMES as readonly string[]).includes(v) ? (v as BookableRoom) : null;
}

// ─── the slot ───────────────────────────────────────────────────────────────

/** "YYYY-MM-DD HH:MM" or "YYYY-MM-DDTHH:MM", Israel wall clock. */
const START_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})$/;

export type ParsedStart = { dateIsrael: string; startIsrael: string };

export function parseStartIsrael(raw: unknown): ParsedStart | null {
  if (typeof raw !== "string") return null;
  const m = START_RE.exec(raw.trim());
  if (!m) return null;
  return { dateIsrael: m[1], startIsrael: m[2] };
}

export type SlotMatch =
  | { ok: true; slot: Slot }
  | { ok: false; reason: "bad-start" | "not-free" | "end-mismatch" };

/**
 * The requested moment, resolved against the availability the SERVER just
 * recomputed — never against anything the client sent.
 *
 * ⚠️ THE END COMES FROM THE SLOT. `endIsrael` in the body is accepted only to
 * be CHECKED: if the client sends one and it disagrees with the slot, the
 * request is refused rather than quietly corrected. A client that believes it
 * booked 09:00–10:00 while the row says 09:00–10:30 is a disagreement worth
 * failing on; silently overwriting it would hide a real bug in the page.
 *
 * Everything else this function refuses, it refuses by ABSENCE rather than by
 * a rule of its own: today, yesterday, a Saturday, a date past the eight-week
 * edge and a refused room are all simply not in `free`, because the window and
 * the grid already decided that. There is no second copy of those rules here
 * to drift from the first.
 */
export function matchSlot(
  free: Slot[],
  input: { studio: string; startIsrael: unknown; endIsrael?: unknown }
): SlotMatch {
  const parsed = parseStartIsrael(input.startIsrael);
  if (!parsed) return { ok: false, reason: "bad-start" };

  const slot = (free ?? []).find(
    (s) =>
      s?.room === input.studio &&
      s?.dateIsrael === parsed.dateIsrael &&
      s?.startIsrael === parsed.startIsrael
  );
  if (!slot) return { ok: false, reason: "not-free" };

  if (input.endIsrael !== undefined && input.endIsrael !== null) {
    const wanted = typeof input.endIsrael === "string" ? input.endIsrael.trim() : "";
    if (wanted !== slot.endIsrael) return { ok: false, reason: "end-mismatch" };
  }
  return { ok: true, slot };
}

// ─── the three brakes ───────────────────────────────────────────────────────

export type ExistingRequest = {
  id: string;
  studio: string;
  start_at: string; // ISO
  status: string;
  created_at: string; // ISO
};

/**
 * Has this show already got as many pending requests as the owner will look at?
 *
 * Counted over rows the caller selected for ONE show. `>=` and not `>`: with
 * the limit at 3, the request being judged would be the fourth.
 */
export function pendingLimitReached(rowsForShow: ExistingRequest[]): boolean {
  return (rowsForShow ?? []).filter((r) => r?.status === "pending").length >= MAX_PENDING_PER_SHOW;
}

/**
 * Has this LINK been used ten times in the last 24 hours?
 *
 * Every status counts, not just pending: the limit exists for a leaked or
 * hammered link, and a burst that happens to get approved is still a burst.
 * `now` is a parameter so the boundary is testable rather than reachable only
 * by waiting a day.
 */
export function linkRateLimitReached(rowsForLink: ExistingRequest[], now: Date): boolean {
  const floor = now.getTime() - LINK_RATE_WINDOW_MS;
  const recent = (rowsForLink ?? []).filter((r) => {
    const t = Date.parse(r?.created_at ?? "");
    return Number.isFinite(t) && t >= floor;
  });
  return recent.length >= MAX_REQUESTS_PER_LINK_PER_DAY;
}

/**
 * The pending request this one would duplicate, or null.
 *
 * A double-tap on a phone, or a client reopening the link and asking again for
 * the slot they already asked for, must not become two rows the owner has to
 * decline one of. Returning the EXISTING row lets the caller answer success
 * without inserting — the client sees their request, which is the truth.
 *
 * Only PENDING counts. A declined request for the same slot is a decision the
 * owner already made and the client may legitimately ask again; an approved
 * one cannot collide, because an approved request blocks its slot and the slot
 * would not be free.
 *
 * Compared on the INSTANT, not on the wall-clock string: the two are the same
 * moment written two ways, and a row stored as "…T06:00:00+00" must match a
 * slot resolved to 09:00 Israel.
 */
export function findDuplicatePending(
  rowsForShow: ExistingRequest[],
  input: { studio: string; start: Date }
): ExistingRequest | null {
  const want = input.start.getTime();
  for (const r of rowsForShow ?? []) {
    if (r?.status !== "pending") continue;
    if (r.studio !== input.studio) continue;
    const t = Date.parse(r.start_at ?? "");
    if (Number.isFinite(t) && t === want) return r;
  }
  return null;
}
