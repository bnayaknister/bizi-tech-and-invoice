/**
 * parseReelNotes — splitting a joined per-reel client answer back into blocks.
 *
 * Run:  npx tsx scripts/test_reel_notes.ts
 *
 * TOUCHES NOTHING. No database, no network, no env. The parser is pure, so
 * this file is strings in / blocks out.
 *
 * The convention under test is not invented here — it is written by
 * links.ts:335 (`ריל ${index}: ${note}`) and joined by links.ts:351 ("\n").
 * This is the only shape the column ever holds, so it is the only shape worth
 * parsing; everything else is treated as the client's own text and preserved
 * rather than guessed at.
 *
 * Why it matters that this test exists at all: verified against the live
 * catalogue on 2026-09-05, NOT ONE row in client_review_links has ever carried
 * a reels_note (0 of 68 links). The only evidence the format is real comes
 * from events left behind by deleted test productions. This parser therefore
 * has no production data to be proven against, and these cases are the whole
 * of its coverage until a client actually answers a reels round.
 */
import { parseReelNotes, type ReelNote } from "../src/lib/review/reelNotes";

let failed = 0;
function eq(name: string, got: ReelNote[], want: ReelNote[]) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok ? "" : `\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`)
  );
}

// ---------------------------------------------------------------------------
console.log("the shape links.ts actually writes");
// ---------------------------------------------------------------------------
eq("1. a single reel", parseReelNotes("ריל 1: תקן צבע"), [{ reel: 1, note: "תקן צבע" }]);

eq("2. three reels, one per line", parseReelNotes("ריל 1: א\nריל 2: ב\nריל 3: ג"), [
  { reel: 1, note: "א" },
  { reel: 2, note: "ב" },
  { reel: 3, note: "ג" },
]);

eq(
  "3. a multi-line note stays with its reel",
  parseReelNotes("ריל 1: שורה ראשונה\nהמשך ההערה\nריל 2: אחר"),
  [
    { reel: 1, note: "שורה ראשונה\nהמשך ההערה" },
    { reel: 2, note: "אחר" },
  ]
);

eq("4. track mode — free text with no prefix", parseReelNotes("הערה חופשית בלי ריל"), [
  { reel: null, note: "הערה חופשית בלי ריל" },
]);

eq("5a. empty string", parseReelNotes(""), []);
eq("5b. whitespace only", parseReelNotes("   \n  "), []);

// Number(), not a single-digit capture: the regex reads \d+ so reel 10 is ten,
// not one followed by a stray zero. A tally of 10+ reels is ordinary here —
// reels_count is raised by approved add-ons.
eq("6. two-digit reel indexes", parseReelNotes("ריל 10: עשר\nריל 11: אחת-עשרה"), [
  { reel: 10, note: "עשר" },
  { reel: 11, note: "אחת-עשרה" },
]);

// ---------------------------------------------------------------------------
console.log("\nedges the format allows but the cases above do not cover");
// ---------------------------------------------------------------------------
// links.ts writes "תיקונים התבקשו" when the client sends revisions with no
// text, so an empty note after the colon is not a shape that reaches the
// column today — but the parser must not lose the reel if it ever does.
eq("7. a prefix with nothing after it keeps the reel", parseReelNotes("ריל 3:"), [
  { reel: 3, note: "" },
]);

// text before the first prefix belongs to nobody — kept, not dropped
eq(
  "8. free text ahead of the first prefix becomes its own block",
  parseReelNotes("שלום\nריל 1: תקן"),
  [
    { reel: null, note: "שלום" },
    { reel: 1, note: "תקן" },
  ]
);

// a blank line inside a note is the client's own paragraph break
eq(
  "9. a blank line inside a note is preserved",
  parseReelNotes("ריל 1: פסקה\n\nפסקה שנייה"),
  [{ reel: 1, note: "פסקה\n\nפסקה שנייה" }]
);

console.log(
  failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`
);
process.exit(failed === 0 ? 0 : 1);
