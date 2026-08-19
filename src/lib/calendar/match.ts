import type { Studio } from "./studios";

// Alias matching for the calendar sync (screens-spec §11, owner rule
// 2026-07-16): "permit, not block" — an event enters ONLY if its title
// contains a known show alias. Everything else is silently skipped; the
// system never invents a show or flags an unrecognized event.

// strips Hebrew niqud (diacritics, U+0591–U+05C7), collapses whitespace,
// lowercases, trims — same normalization the spec calls for on both the
// calendar title and the alias before comparing
export function normalizeForMatch(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[֑-ׇ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export type ShowForMatch = { id: string; name: string; aliases: string[] };

export type MatchResult = { show: ShowForMatch; alias: string } | null;

// substring match anywhere in the (normalized) title, not just a prefix.
// When multiple aliases match, the longest one wins — it's the more
// specific signal and the one least likely to be a coincidental substring.
export function matchTitleToShow(title: string, shows: ShowForMatch[]): MatchResult {
  const normTitle = normalizeForMatch(title);
  if (!normTitle) return null;

  let best: MatchResult = null;
  let bestLen = 0;
  for (const show of shows) {
    const candidates = [show.name, ...(show.aliases ?? [])];
    for (const raw of candidates) {
      const alias = normalizeForMatch(raw);
      if (alias.length === 0) continue;
      if (normTitle.includes(alias) && alias.length > bestLen) {
        best = { show, alias: raw };
        bestLen = alias.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Title convention (owner spec 2026-08-19) — studio + guest
// ---------------------------------------------------------------------------
//
// This REPLACES extractGuestFromTitle, which read "everything after the show
// alias" as the guest. That rule had no format to read: it swallowed the
// studio name ("גבעון גדול" was stored as a guest on 2 live productions), the
// noise word "פודקאסט", and it discarded any name written BEFORE the alias.
// A survey of the real feed (2,680 events) showed why it could never work —
// there was no convention in the titles at all. So one is being declared:
//
//   studio — one of the known studio names, ANYWHERE in the title.
//   guest  — the text after "אורח:" / "אורחת:", up to the next comma or end
//            of title.
//
// Both are read, never guessed. A title that doesn't follow the convention
// yields null, and null is the honest answer — the drawer field is editable
// and an empty box beats a confident wrong name.
//
//   "דעה לא פופולרית - ברק הרשקוביץ אורח: רות קבסה אברמזון, גבעון"
//     -> { studio: "גבעון", guest: "רות קבסה אברמזון" }
//
// Note what that example does NOT do: "ברק הרשקוביץ" sits before "אורח:" and
// is not the guest. Under this convention only the label decides.

export type TitleParts = {
  studio: string | null; // canonical studio name, never the matched variant
  guest: string | null;
};

// The label is fixed, in both grammatical genders: the owner records guests
// of both and writes whichever fits (owner, 2026-08-19). `\s*` before the
// colon absorbs "אורח :" — a spacing slip, not a third format. Nothing else
// is accepted; the colon is what makes this a label rather than a word that
// happens to appear in a sentence.
const GUEST_LABEL = /אורח(ת)?\s*:/;

// Escapes a variant for regex use, then lets any run of whitespace inside it
// match any run of whitespace in the title — the feed is full of double
// spaces, so a literal " " in "גבעון גדול" would miss "גבעון  גדול".
function variantPattern(variant: string): RegExp {
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(escaped, "gi");
}

/**
 * Pure. `studios` is passed in rather than imported (see ./studios) so this
 * function is testable against any list and indifferent to where the real one
 * is stored.
 */
export function extractStudioAndGuest(title: string, studios: Studio[]): TitleParts {
  let rest = title ?? "";

  // Longest variant first. "גבעון גדול" (10) is tested before "גבעון" (5), so
  // the more specific studio wins and can never be shadowed by the shorter
  // name it happens to contain. Same for "החשמונאים" over "חשמונאים".
  const variants = studios
    .flatMap((s) => s.variants.map((variant) => ({ canonical: s.canonical, variant })))
    .filter((v) => v.variant.trim().length > 0)
    .sort((a, b) => b.variant.length - a.variant.length);

  let studio: string | null = null;
  for (const { canonical, variant } of variants) {
    // Removed from the text, not just detected: the guest segment must not be
    // able to inherit the studio name when the title carries no comma
    // ("... אורח: רות גבעון"). Replacing with a space keeps the words on
    // either side from fusing.
    const next = rest.replace(variantPattern(variant), " ");
    if (next === rest) continue;
    studio = canonical;
    rest = next;
    break;
  }

  let guest: string | null = null;
  const label = GUEST_LABEL.exec(rest);
  if (label) {
    const after = rest.slice(label.index + label[0].length);
    const comma = after.indexOf(",");
    const cleaned = (comma === -1 ? after : after.slice(0, comma))
      .replace(/^[\s\-–:]+/, "") // "אורח: - רות" — a separator, not a name
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length > 0) guest = cleaned;
  }

  return { studio, guest };
}
