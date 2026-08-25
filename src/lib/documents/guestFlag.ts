import type { Studio } from "@/lib/calendar/studios";

// Does the document about to be issued still name the guest the production
// recorded? (owner spec 2026-08-25)
//
// B (381601f) puts the guest on the printed line at ENQUEUE time, and the
// payload is frozen from that moment: issue.ts sends it verbatim. So a line can
// disagree with its production in two ordinary ways, neither of them a bug in
// the enqueue plumbing —
//   • the row was queued before B shipped and issued after it (work order
//     10315: queued 20.8 06:01, B committed 20.8 23:10, issued 24.8)
//   • the guest was filled in or corrected in the drawer AFTER the row was
//     queued, which no path rewrites
//
// Pure, and deliberately so: it is imported by a client component and by two
// server pages. It reads no database and knows nothing about pending_documents
// — the callers hand it strings.
//
// `studios` is a PARAMETER rather than an import for the same reason
// extractStudioAndGuest takes it (see @/lib/calendar/studios): the real list is
// data, this is logic, and the logic must be exercisable against any list.

// The SAME normalization buildLineItemText applies before it writes a guest
// into a line (@/lib/documents/enqueue). It has to be the same one, or this
// function contradicts the builder it is checking: the feed really does carry
// "יואב בלום " with a trailing space, and a comparison that did not collapse
// whitespace would report him missing from a line that names him.
//
// Lowercased for comparison only. Hebrew is caseless, so this changes nothing
// for the common line — it is here for a hand-edited Latin name, where it can
// only ever suppress a false flag, never create one.
const norm = (v: string | null | undefined): string =>
  (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Is this "guest" actually the room the episode was recorded in?
 *
 * EXACT match after normalizing, never containment — and that distinction is
 * the entire reason this is its own function.
 *
 * The calendar's guest slot is sometimes filled with a studio instead of a
 * person. `guest = "גבעון"` sits on a real accrued production today; there is
 * no guest there to be missing, so it must stay silent.
 *
 * But `guest = "ברק הרשקוביץ-גבעון"` is a REAL person, also in the table today,
 * and a containment test would swallow him — quietly, on a document heading for
 * a client. The whole flag would then be worse than nothing: it would be a
 * check that reports "fine" on the exact shape it exists to catch. Exact-after-
 * normalize is what separates the room from the man named after it.
 */
export function isStudioName(guest: string | null | undefined, studios: Studio[]): boolean {
  const g = norm(guest);
  if (!g) return false;
  return studios.some((s) => s.variants.some((v) => norm(v) === g));
}

/**
 * The indexes of the printed lines that were supposed to name a guest and do
 * not. Empty array = nothing to warn about.
 *
 * `guests` is INDEX-ALIGNED to `lines`, and that alignment is what lets one
 * function serve both shapes without a mode flag:
 *
 *   • a production-anchored document passes `[guest]`. Only index 0 is checked,
 *     which is correct rather than convenient — buildDocumentPayload puts the
 *     session line at income[0] and every approved add-on AFTER it, and an
 *     add-on line ("עריכת ריל") never carries the guest and never should. A
 *     check that walked every line would flag every upsell in the system.
 *
 *   • a bundled work order passes one guest per line, resolved by its caller
 *     from the rows it consolidated.
 *
 * A short `guests` array is normal, not an error: a missing entry reads as
 * undefined, normalizes to "", and is skipped like any guestless line.
 *
 * Containment (not equality) against the line, per owner spec: the line is
 * "{show} · {guest} · {date}", so the guest is a substring of it by
 * construction, and a bookkeeper who rewrote the surrounding text by hand
 * should not be nagged about a guest she left in place.
 */
export function missingGuestLines(
  guests: (string | null | undefined)[],
  lines: (string | null | undefined)[],
  studios: Studio[]
): number[] {
  const missing: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const guest = norm(guests[i]);
    if (!guest) continue; // no guest recorded — nothing to be missing
    if (isStudioName(guest, studios)) continue; // a room, not a person
    if (!norm(lines[i]).includes(guest)) missing.push(i);
  }
  return missing;
}
