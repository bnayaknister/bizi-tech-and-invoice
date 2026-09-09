/**
 * The document -> parent-document link, parsed out of Morning's `remarks` line.
 *
 * Pure. No I/O, no lookups, no database. It takes the string Morning already
 * sent and returns the two columns 0075 created. That is deliberate: it runs
 * inside the pull's row-building map (registry.ts), once per document, and must
 * not add a single round-trip to a job that already pages through the account.
 *
 * ---------------------------------------------------------------------------
 * THESE THREE PATTERNS ARE THE SAME THREE MIGRATION 0075 RAN.
 *
 * 0075 backfilled 1,094 existing rows with them; this file keeps every new
 * pulled row consistent with that backfill. If the two ever diverge, the pull
 * does not merely stop finding links — it OVERWRITES the ones the backfill got
 * right, on every run, silently. So they are copied verbatim from
 * supabase/migrations/0075_document_parent_links.sql, and any edit here is an
 * edit there.
 *
 * ONE CHARACTER DIFFERS, and it has to: Postgres spells the word boundary `\y`,
 * JavaScript spells it `\b`. Everything else is byte-identical. The equivalence
 * is not asserted, it is measured — the non-regression run over all 1,094 rows
 * reproduced the backfill exactly (640 derived = 619 pull + 21 app, 5
 * cancellations, 23 multi-parent, zero rows changed).
 *
 * THAT MEASUREMENT IS A SCRIPT, AND IT IS THE POINT:
 *
 *     npx tsx scripts/check_parent_link_parity.ts
 *
 * Run it whenever either regex is touched — here or in 0075. It reads every
 * `documents` row and compares what this parser WOULD write against what is
 * stored, so a one-sided edit shows up as a row count instead of as a quiet
 * daily overwrite. Because the pull re-parses and re-writes these columns on
 * every run, a drifted regex here does not merely stop finding new links: it
 * overwrites the ones the backfill got right, once a day, without an error.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PATTERN IS ANCHORED TO THE WHOLE STRING, and never "find a number".
 *
 * Four families live in `remarks`, and three of them punish a loose parser:
 *   1. derivation, Hebrew  — "חשבון עסקה עבור הזמנה 10298"
 *   2. derivation, ENGLISH — "Proforma Invoice for Order 10078". Morning writes
 *      the same provenance in English on English documents; a parser keyed on
 *      "עבור" alone misses them without saying so.
 *   3. cancellation        — "ביטול חשבונית מס / קבלה 60162". Carries a number
 *      in the same position as a derivation and means the opposite.
 *   4. free text on price quotes — multi-line terms thick with numbers
 *      ("כל רילס נוסף … בעלות של 250 ₪", "תנאי תשלום שוטף+30"). A
 *      last-number-wins parser would file 250 as a document id.
 *
 * The anchor is what separates them. `\bfor\b` is word-bounded so the "for"
 * inside "Proforma" cannot supply the keyword.
 */

/** "<name> עבור|for <name> <number>[, <number>…]" — the whole string, or nothing. */
const DERIVED_RE = /^[^0-9\n]{3,40}(עבור|\bfor\b)[^0-9\n]{3,40}[0-9]{3,6}(,\s*[0-9]{3,6})*\s*$/;

/** "ביטול <name> <number>" — a reference, but the opposite relation. */
const CANCELLATION_RE = /^ביטול[^0-9\n]{3,40}[0-9]{3,6}\s*$/;

/** the trailing number list, once one of the two above has already matched. */
const TAIL_RE = /([0-9]{3,6}(?:,\s*[0-9]{3,6})*)\s*$/;

export type ParentRelation = "derived" | "cancellation";

export type ParentLink = {
  parent_doc_numbers: string[];
  parent_relation: ParentRelation;
};

/**
 * Returns null when the remark carries no document reference — which is the
 * common case and not a failure. Null means BOTH columns stay null: 0075's
 * `documents_parent_pair_chk` enforces that they travel together, and an empty
 * array would claim "parsed, found nothing", which is a different statement
 * from "no reference here".
 *
 * The parent order is preserved as Morning listed it. On 50027 that order is
 * the order nine deal invoices were folded into one tax invoice; re-sorting it
 * would invent a fact.
 */
export function parseParentLink(remarks: string | null | undefined): ParentLink | null {
  if (typeof remarks !== "string") return null;
  const s = remarks.trim();
  if (s === "") return null;

  const relation: ParentRelation | null = DERIVED_RE.test(s)
    ? "derived"
    : CANCELLATION_RE.test(s)
      ? "cancellation"
      : null;
  if (!relation) return null;

  // Only reached once the anchor matched, so a tail always exists — but a
  // missing one returns null rather than an empty array, for the same reason
  // as above: the pair is all-or-nothing.
  const tail = TAIL_RE.exec(s);
  if (!tail) return null;
  const numbers = tail[1]
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (numbers.length === 0) return null;

  return { parent_doc_numbers: numbers, parent_relation: relation };
}
