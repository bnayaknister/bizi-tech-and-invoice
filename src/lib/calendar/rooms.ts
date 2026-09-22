import type { Studio } from "./studios";

// ═══════════════════════════════════════════════════════════════════════════
// EVERY room named in a title — the booking screen's question, which is NOT
// the sync's question.
// ═══════════════════════════════════════════════════════════════════════════
//
// `extractStudioAndGuest` in ./match answers "which studio is this recording
// in?" and returns exactly ONE canonical name. It is right to: a production
// row has one `studio` column. It must NOT be changed — the calendar sync
// depends on it, and 0095 normalised live data to agree with it.
//
// Measured against it 2026-09-22, so the difference is on the record rather
// than assumed:
//
//   "הקלטה בגבעון ובחשמונאים"  -> extractStudioAndGuest = "חשמונאים"
//   "חשמונאים וגבעון גדול"      -> extractStudioAndGuest = "גבעון גדול"
//
// Note what those two show: the winner is not the first room in the title, it
// is whichever room's variant is LONGEST. For availability that is the wrong
// answer twice over — one room silently disappears, and which one survives is
// an accident of spelling. A title naming two rooms blocks BOTH (owner,
// 2026-09-22), so availability needs every match, not the best one.
//
// ⚠️ WHY LOCATION IS NOT READ HERE, AND MUST NEVER BE
// ══════════════════════════════════════════════════════════════════════════
// This is the first place a reader will think to add it. Do not.
//
// The studio sits at 105 HaHashmonaim Street, and one of the rooms is called
// חשמונאים. So the building's STREET ADDRESS contains a room name. Measured
// on the live feed 2026-09-22:
//
//   74 events whose LOCATION parses as a room — every single one a postal
//      address: "החשמונאים 105, תל אביב-יפו, ישראל" (18x),
//      "BIZI Studio, החשמונאים 105..." (13x), "רחוב החשמונאים 105" (10x)...
//   "החשמונאים 105 מול קניון TLV" — ONE string naming TWO rooms, neither of
//      which it is in.
//   Of the 303 events carrying a LOCATION at all: title and location agree on
//      9, CONTRADICT each other on 5, and on 60 the location "supplies" a room
//      the title never named — all 60 of them addresses.
//
// Reading LOCATION would not add signal. It would file 74 recordings into
// חשמונאים because of the street they happened on, and it would block a room
// that was never booked. The title is the only room signal on this feed.
// (Owner decision 2026-09-22.)

/**
 * Every canonical studio named anywhere in `title`, de-duplicated.
 *
 * Pure, and takes `studios` as a parameter for the same reason ./match does:
 * so it is exercisable against any list and indifferent to where the real one
 * lives.
 *
 * Longest variant first, and each match is REMOVED from the working copy
 * before the next variant is tried. That is what keeps "גבעון גדול" from also
 * counting as "גבעון": by the time the 5-character variant is tested, the 10
 * characters it is contained in are gone. Same mechanism as
 * `extractStudioAndGuest`, deliberately — the two must never disagree about
 * what a single-room title means.
 *
 * "גבעון בחוץ" therefore yields ["גבעון גדול"] and never "גבעון" (owner,
 * 2026-09-22 — the name means the opposite of what it looks like).
 *
 * Returns [] for a title naming no room. That is the honest answer and the
 * caller must decide what to do with it; it is never "all rooms" and never a
 * default.
 */
export function roomsInTitle(title: string, studios: Studio[]): string[] {
  let rest = title ?? "";

  const variants = studios
    .flatMap((s) => s.variants.map((variant) => ({ canonical: s.canonical, variant })))
    .filter((v) => v.variant.trim().length > 0)
    .sort((a, b) => b.variant.length - a.variant.length);

  const found: string[] = [];
  for (const { canonical, variant } of variants) {
    // whitespace-tolerant, exactly as ./match does it: the feed is full of
    // double spaces, so a literal " " in "גבעון גדול" would miss "גבעון  גדול"
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const next = rest.replace(new RegExp(escaped, "gi"), " ");
    if (next === rest) continue;
    rest = next;
    if (!found.includes(canonical)) found.push(canonical);
  }
  return found;
}
