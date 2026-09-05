// Reversing the join that flattens a per-reel answer into one column.
//
// In item mode the client answers reel by reel, and those answers are joined
// into a single string before they are stored: `ריל N: …` per line, "\n"
// between them (links.ts:335 and :351). The structure is real — it is only
// flattened on the way into client_review_links.reels_note. This splits it
// back out.
//
// Lives in lib/ and not in the route that uses it because a route.ts may only
// export HTTP methods and Next's route config: the generated type check
// (.next/types/**/route.ts) diffs the module's exports against that list and
// fails the build on anything else. Same reason lib/productions/hours.ts is
// shared rather than exported from the hours route.

export type ReelNote = { reel: number | null; note: string };

const REEL_LINE = /^ריל\s+(\d+):\s*(.*)$/;

export function parseReelNotes(reelsNote: string): ReelNote[] {
  // nothing to split. The caller already treats an empty note as "no reels
  // correction", and a bare "" must not become a block with an empty note.
  if (!reelsNote.trim()) return [];

  const blocks: ReelNote[] = [];
  for (const line of reelsNote.split("\n")) {
    const m = line.match(REEL_LINE);
    if (m) {
      blocks.push({ reel: Number(m[1]), note: m[2] });
      continue;
    }
    // not a "ריל N:" line — a continuation of the block above it (the client's
    // own line break). With no block above (a track-mode note, or text before
    // the first prefix) it stands on its own, unattributed rather than lost.
    const prev = blocks[blocks.length - 1];
    if (prev) prev.note = prev.note ? `${prev.note}\n${line}` : line;
    else blocks.push({ reel: null, note: line });
  }
  return blocks;
}
