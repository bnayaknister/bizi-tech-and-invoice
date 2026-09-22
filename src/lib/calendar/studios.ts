// The studios a calendar title may name (owner spec 2026-08-19).
//
// Data only — no logic. `extractStudioAndGuest` in ./match takes this list as
// a parameter rather than importing it, so the parser stays a pure function of
// its arguments and can be exercised against any list at all. Moving this to a
// table later is a change at the CALL SITE only; the parser never learns where
// the list came from.
//
// `canonical` is what gets written to productions.studio. `variants` is every
// spelling that may appear in a title, INCLUDING the canonical form itself —
// the parser does not assume the canonical name is matchable.
//
// Ordering in this array is irrelevant: the parser sorts every variant by
// length, descending, before matching. That is what keeps "גבעון גדול" from
// being read as the studio "גבעון" followed by the word "גבעון".
export type Studio = {
  canonical: string;
  variants: string[];
  /**
   * Can a client book this room themselves?
   *
   * ═══ WHY THIS IS NOT THE SAME QUESTION AS "IS THIS A STUDIO" ═══
   * Added 2026-09-22 (owner decision) for the client booking feature. The list
   * answers two different questions and they were about to be conflated:
   *
   *   "is this text a room?"        → EVERY entry. That is what the calendar
   *                                   parser and isStudioName ask, and a room
   *                                   nobody may book is still a room when its
   *                                   name shows up in a title or a guest slot.
   *   "may a client book it?"       → only `bookable`. A room can be real,
   *                                   parsed, and written to productions.studio
   *                                   while being off-limits to self-service.
   *
   * So `extractStudioAndGuest` and `isStudioName` keep taking the WHOLE list —
   * narrowing them to bookable rooms would silently stop recognising a real
   * room's name, which is a parsing regression wearing a booking feature's
   * clothes. Only a booking surface reads BOOKABLE_STUDIOS below.
   *
   * ⚠️ NOTHING READS BOOKABLE_STUDIOS YET. The booking screen is a later step;
   * this field exists now so the distinction is recorded at the moment it was
   * decided, rather than reconstructed later from memory.
   */
  bookable: boolean;
};

export const STUDIOS: Studio[] = [
  {
    // A studio of its own, NOT a size qualifier on גבעון — hence its own entry
    // with its own canonical name. ⚠️ Merging this into "גבעון" destroys a real
    // distinction and cannot be undone; migration 0095 guards it explicitly.
    canonical: "גבעון גדול",
    // "גבעון בחוץ" is THE SAME ROOM as גבעון גדול (owner, 2026-09-22).
    //
    // ⚠️ THIS ENTRY IS A CORRECTION, NOT A CONVENIENCE. Without it the parser
    // does the opposite of what the owner decided: "גבעון בחוץ" contains the
    // substring "גבעון", so the shorter variant would match and the title
    // would be filed under גבעון — the small room. It lands here, above the
    // "גבעון" entry, because the parser tests variants longest-first: at 10
    // characters it is tested before "גבעון" at 5 and therefore wins.
    // Migration 0095 moved the one existing row the same way, so the data and
    // the parser now agree; changing one without the other re-opens the split.
    variants: ["גבעון גדול", "גבעון בחוץ"],
    bookable: true,
  },
  {
    canonical: "גבעון",
    // "גבעון קטן" is the same room as "גבעון" (owner, 2026-08-19), and 0095
    // collapsed the stored values accordingly — both tables carried it.
    //
    // The apostrophe in "בוט'" is listed twice: U+0027 and the Hebrew geresh
    // U+05F3, both of which occur in the real feed. "גבעון בוט" with NO
    // apostrophe is listed as well (owner, 2026-09-22, same room): it already
    // resolved correctly through the bare "גבעון" substring, but only as a
    // PREFIX — the parser removes the matched text before reading the guest,
    // so " בוט" was left behind in the remainder and could be read as part of
    // a guest name. Naming the whole phrase removes the whole phrase.
    variants: ["גבעון", "גבעון קטן", "גבעון בוט'", "גבעון בוט׳", "גבעון בוט"],
    bookable: true,
  },
  { canonical: "חשמונאים", variants: ["חשמונאים", "החשמונאים"], bookable: true },
  // ⚠️ TLV IS DELIBERATELY ABSENT, PENDING ONE ANSWER — see the note below.
];

/**
 * The rooms a client may book for themselves. Derived, never hand-maintained:
 * a room added above with `bookable: true` appears here automatically, and one
 * marked false cannot be forgotten here by accident.
 *
 * ⚠️ Not read by anything yet — the booking screen is a later step.
 */
export const BOOKABLE_STUDIOS: Studio[] = STUDIOS.filter((s) => s.bookable);

/**
 * ═══ PENDING: TLV — a fourth, KNOWN but NOT BOOKABLE room ═══
 *
 * The owner's decision (2026-09-22): TLV is a real room of the business, used
 * rarely, its stored values stay exactly as they are (0095 does not touch
 * them), and it is NOT one of the three rooms open to client booking. Its
 * entry is therefore:
 *
 *   { canonical: "TLV", variants: ["TLV"], bookable: false },
 *
 * ⚠️ WHY IT IS NOT WRITTEN YET. Adding a name here does more than teach the
 * calendar parser — `isStudioName` (lib/documents/guestFlag.ts) compares the
 * GUEST column against these same variants, and a match SUPPRESSES the
 * missing-guest warning on a client-facing document. So a production whose
 * guest is exactly "TLV" would silently stop being checked. That is the exact
 * failure the function's own docstring warns about: "a check that reports
 * 'fine' on the exact shape it exists to catch."
 *
 * The risk is narrow — the comparison is EXACT after normalising, so "TLV
 * Media" or "מרכז איינגאר יוגה TLV" are unaffected — and the evidence so far
 * says it is empty: in the 2026-07-12 snapshot TLV appears only in the studio
 * column, never as a guest. But that snapshot is stale and untracked, so it
 * decides nothing. One read-only query settles it:
 *
 *   select id, podcast_name, guest, record_date from public.productions
 *    where lower(btrim(guest)) = 'tlv';
 *
 * Zero rows → add the entry above as written. Any rows → the owner decides
 * whether that guest is the room or a name, before the line goes in.
 */
