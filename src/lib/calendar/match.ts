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

// Multi-episode session support (owner request 2026-07-17): when the
// calendar title carries a guest name after the alias ("SFI יוסי"), pull
// it out so two same-day recordings of the same show read differently on
// the card. Matches on the alias's own raw text against the raw title —
// simpler and more reliable than mapping an index back from the
// normalized copy, since the normalization step never reorders characters.
export function extractGuestFromTitle(title: string, alias: string): string | null {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "i");
  const m = re.exec(title);
  if (!m) return null;
  const rest = title
    .slice(m.index + m[0].length)
    .replace(/^[\s\-–:,]+/, "")
    .trim();
  return rest.length > 0 ? rest : null;
}
