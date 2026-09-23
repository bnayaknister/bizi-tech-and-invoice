import type { Studio } from "@/lib/calendar/studios";

// ═══════════════════════════════════════════════════════════════════════════
// "Does this show have a name that can carry a room?" — PURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// A booking link exists so that an APPROVED request can become a calendar
// event whose title the sync reads back correctly. The title the owner will
// paste has the shape
//
//     {alias}, אורח: {אורח}, {חדר}
//
// and `extractStudioAndGuest` (@/lib/calendar/match) finds the room by
// removing the LONGEST matching room variant from ANYWHERE in that string,
// before it reads anything else.
//
// ⚠️ SO A SHOW WHOSE NAME CONTAINS A ROOM NAME POISONS ITS OWN TITLES.
// Measured 2026-09-23 against the real parsers: a title built from a show
// called "פודקאסט גבעון גדול" booked into חשמונאים parses as studio
// "גבעון גדול" — the WRONG ROOM — because that variant is 10 characters and
// "חשמונאים" is 8, and the longest one wins. The production is then filed in
// a room the client never booked, and that flows into the invoice.
//
// This function is the gate that keeps such a show from ever getting a link.
// It is a REFUSAL, not a repair: renaming a show behind the owner's back, or
// quietly dropping the room from the title, would both be silent changes to
// data the owner owns. The owner adds an alias; nothing else unblocks it.

/**
 * Whitespace-tolerant, case-insensitive containment — the SAME tolerance the
 * two parsers apply (`match.ts:87`, `rooms.ts:80`). It has to be: a name that
 * this function calls clean but `roomsInTitle` finds a room in would defeat
 * the whole check, and "גבעון  גדול" with two spaces is exactly that shape.
 */
function containsVariant(text: string, variant: string): boolean {
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(escaped, "i").test(text);
}

/**
 * True when `text` names no room at all.
 *
 * Tested against the WHOLE studio list, `bookable` included and excluded
 * alike — the same distinction studios.ts exists to protect. TLV is not
 * bookable and a show called "TLV Talks" still cannot carry a clean title,
 * because `extractStudioAndGuest` recognises TLV wherever it appears.
 */
export function isCleanAlias(text: string | null | undefined, studios: Studio[]): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t === "") return false;
  return !studios.some((s) => s.variants.some((v) => v.trim() !== "" && containsVariant(t, v)));
}

/**
 * The first name this show can safely put in a calendar title, or null.
 *
 * ORDER IS THE SHOW'S OWN NAME FIRST, then `aliases` in stored order. The name
 * is what the owner and the client both call the show; an alias is a fallback
 * spelling, and promoting one over the name would rename the show on every
 * event it produces.
 *
 * null means "this show cannot have a booking link yet" — the caller turns
 * that into the owner-approved sentence, and creates nothing.
 */
export function cleanAliasFor(
  show: { name: string | null; aliases: string[] | null },
  studios: Studio[]
): string | null {
  const candidates = [show?.name ?? "", ...(show?.aliases ?? [])];
  for (const c of candidates) {
    if (isCleanAlias(c, studios)) return (c ?? "").replace(/\s+/g, " ").trim();
  }
  return null;
}
