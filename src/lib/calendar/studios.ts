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
// being read as the studio "גבעון" followed by the word "גדול".
export type Studio = {
  canonical: string;
  variants: string[];
};

export const STUDIOS: Studio[] = [
  // A studio of its own, NOT a size qualifier on גבעון — hence its own entry
  // with its own canonical name.
  { canonical: "גבעון גדול", variants: ["גבעון גדול"] },
  {
    canonical: "גבעון",
    // "גבעון קטן" is the same room as "גבעון" (owner, 2026-08-19) — the
    // shows table currently carries both as default_studio values, and this
    // is what collapses them on the way in. The apostrophe in "בוט'" is
    // listed twice: U+0027 and the Hebrew geresh U+05F3, both of which occur
    // in the real feed.
    variants: ["גבעון", "גבעון קטן", "גבעון בוט'", "גבעון בוט׳"],
  },
  { canonical: "חשמונאים", variants: ["חשמונאים", "החשמונאים"] },
];
