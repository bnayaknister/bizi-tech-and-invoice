// Client name normalization + near-duplicate detection (owner request
// 2026-07-17): the "smart client field" must never create a second row for
// a client that already exists under a slightly different spelling — the
// exact failure mode that produced 4 versions of "גל אורן" before.
//
// normalizeClientName matches the convention scripts/seed.py's `norm()`
// already used to populate the ~157 real clients' `normalized_name`
// (lowercase + all whitespace stripped), extended with niqud-stripping
// (same range as src/lib/calendar/match.ts's normalizeForMatch) since the
// owner explicitly wants niqud-insensitive matching here too.
const NIQUD = /[֑-ׇ]/g;

export function normalizeClientName(s: string | null | undefined): string {
  return (s ?? "")
    .replace(NIQUD, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// classic edit distance, iterative DP — no dependency needed for a check
// this small
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

export type ClientForMatch = { id: string; name: string; normalized_name?: string | null };

// exact match (post-normalization) short-circuits: same client, no question.
// Otherwise, close-but-not-exact (typo, hyphen vs. space, a stray niqud
// mark that survived, ...) surfaces as a "did you mean" suggestion instead
// of silently creating a near-duplicate. Word-order swaps and unrelated
// short names aren't caught by edit distance — an acceptable gap, not a
// promise of perfect fuzzy matching.
export function findClientMatch(
  name: string,
  clients: ClientForMatch[]
): { exact: ClientForMatch } | { suggestion: ClientForMatch } | null {
  const norm = normalizeClientName(name);
  if (!norm) return null;

  let best: { client: ClientForMatch; dist: number } | null = null;
  for (const c of clients) {
    const cn = normalizeClientName(c.normalized_name ?? c.name);
    if (cn === norm) return { exact: c };
    const dist = levenshtein(norm, cn);
    const threshold = Math.max(2, Math.floor(Math.max(norm.length, cn.length) * 0.25));
    if (dist <= threshold && (!best || dist < best.dist)) best = { client: c, dist };
  }
  return best ? { suggestion: best.client } : null;
}
