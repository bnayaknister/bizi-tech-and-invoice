/**
 * chainIds, against the REAL rows the candidate query returns.
 *
 * Run:  npx tsx scripts/test_document_chains.ts
 * Pure. Reads nothing, writes nothing, needs no database and no dev server —
 * the rows below were measured with SELECT on 2026-09-15 and pasted in, so this
 * asserts the grouping rather than re-asserting that the query still works.
 *
 * ═══ WHY THIS EXISTS ═══
 * The chain is what stops two descriptions of one bill being added together.
 * בר ביצוע's 40326 (300) and 50070 (305) both carry ₪49,560 against a ₪42,000
 * net milestone; if they land in different chains the screen stops saying "these
 * are one charge" and the door to summing them is open again. The join between
 * them runs THROUGH 10333, a work order that is not itself a candidate, which is
 * the one part of the algorithm that is easy to get wrong and impossible to see
 * by reading the output.
 */
import { chainIds, type ChainableDoc } from "../src/lib/documents/chains";

let failures = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
    failures++;
  }
};

// measured 2026-09-15 — the exact candidate rows for the two test clients
const BAR_DEAL: ChainableDoc = { id: "8cc04e28", morning_doc_number: "40326", parent_doc_numbers: ["10333"] };
const BAR_TAX: ChainableDoc = { id: "a4ddad84", morning_doc_number: "50070", parent_doc_numbers: ["40326"] };
const KFIR_DEAL: ChainableDoc = { id: "349532c7", morning_doc_number: "40289", parent_doc_numbers: ["10288"] };

console.log("\n=== the live candidates ===");

check("בר ביצוע: 40326 and 50070 are ONE chain, joined through absent 10333", () => {
  const m = chainIds([BAR_DEAL, BAR_TAX]);
  const a = m.get(BAR_DEAL.id);
  const b = m.get(BAR_TAX.id);
  if (!a || !b) throw new Error("a candidate got no chain at all");
  if (a !== b) throw new Error(`different chains: ${a} vs ${b}`);
});

check("כפיר ארביב: 40289 is a chain of its own", () => {
  const m = chainIds([BAR_DEAL, BAR_TAX, KFIR_DEAL]);
  const kfir = m.get(KFIR_DEAL.id);
  if (kfir === m.get(BAR_DEAL.id)) throw new Error("kfir joined בר ביצוע's chain");
});

check("all three together: exactly two distinct chains", () => {
  const m = chainIds([BAR_DEAL, BAR_TAX, KFIR_DEAL]);
  const distinct = new Set(Array.from(m.values()));
  if (distinct.size !== 2) throw new Error(`${distinct.size} chains, expected 2`);
});

console.log("\n=== the shapes that decide the algorithm ===");

check("siblings: two invoices fathered by ONE order are one chain", () => {
  const m = chainIds([
    { id: "s1", morning_doc_number: "40001", parent_doc_numbers: ["10001"] },
    { id: "s2", morning_doc_number: "40002", parent_doc_numbers: ["10001"] },
  ]);
  if (m.get("s1") !== m.get("s2")) throw new Error("siblings split — the absent parent is not a node");
});

check("a three-link chain collapses to one id", () => {
  const m = chainIds([
    { id: "c1", morning_doc_number: "300", parent_doc_numbers: ["100"] },
    { id: "c2", morning_doc_number: "305", parent_doc_numbers: ["300"] },
    { id: "c3", morning_doc_number: "400", parent_doc_numbers: ["305"] },
  ]);
  if (new Set([m.get("c1"), m.get("c2"), m.get("c3")]).size !== 1) throw new Error("chain did not collapse");
});

check("unrelated documents never share a chain", () => {
  const m = chainIds([
    { id: "u1", morning_doc_number: "40010", parent_doc_numbers: null },
    { id: "u2", morning_doc_number: "40011", parent_doc_numbers: [] },
  ]);
  if (m.get("u1") === m.get("u2")) throw new Error("two parentless documents merged");
});

check("numberless rows do NOT collide under a shared empty key", () => {
  const m = chainIds([
    { id: "n1", morning_doc_number: null, parent_doc_numbers: null },
    { id: "n2", morning_doc_number: "  ", parent_doc_numbers: null },
  ]);
  if (m.get("n1") === m.get("n2")) throw new Error("numberless rows merged");
  if (m.get("n1") !== "n1" || m.get("n2") !== "n2") throw new Error("expected the id as the fallback key");
});

console.log("\n=== degenerate input ===");
check("empty list", () => {
  if (chainIds([]).size !== 0) throw new Error("expected an empty map");
});
check("undefined list", () => {
  if (chainIds(undefined as never).size !== 0) throw new Error("expected an empty map");
});
check("null and blank entries inside parent_doc_numbers", () => {
  const m = chainIds([{ id: "x", morning_doc_number: "1", parent_doc_numbers: [null as never, "", "  "] }]);
  if (m.get("x") !== "1") throw new Error(`got ${m.get("x")}`);
});
check("a cycle does not hang", () => {
  const m = chainIds([
    { id: "y1", morning_doc_number: "A", parent_doc_numbers: ["B"] },
    { id: "y2", morning_doc_number: "B", parent_doc_numbers: ["A"] },
  ]);
  if (m.get("y1") !== m.get("y2")) throw new Error("cycle split");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
