/**
 * relabelDocDescription vs. a HAND-WRITTEN title (owner question 2026-09-02).
 *
 * Run:  npx tsx scripts/test_relabel_manual_title.ts
 *
 * TOUCHES MORNING: never. TOUCHES THE DATABASE: never. This is a pure function
 * exercised in memory — no server, no cookie, no rows.
 *
 * WHY IT EXISTS. The bookkeeper is about to be handed a title field on a
 * multi-line 320 and will type a sentence of her own ("הפקת חומרים שיווקיים
 * אוגוסט"). The review route runs relabelDocDescription on EVERY tax approval
 * (review/route.ts:523), so the question that decides whether the new field is
 * safe is: does the normalizer leave a human's sentence alone, on every
 * approval, forever? The answer must be proven, not assumed — a 320 cannot be
 * corrected after it is issued.
 *
 * The claim under test: a description that does not match one of the two shapes
 * the BUILDER produces returns ok:false, which the route reads as "leave it
 * exactly as written" and logs as document_description_not_relabeled.
 */
import {
  relabelDocDescription,
  docDescriptionLabel,
  type PendingDocType,
} from "../src/lib/morning/types";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (!ok && detail ? `   [${detail}]` : ""));
  if (!ok) failures++;
}

const TAX_INVOICE: PendingDocType = "tax_invoice"; // 305
const TAX_RECEIPT: PendingDocType = "tax_receipt"; // 320
const L305 = docDescriptionLabel(TAX_INVOICE);
const L320 = docDescriptionLabel(TAX_RECEIPT);
console.log(`labels: 305="${L305}"  320="${L320}"\n`);

// ---------------------------------------------------------------------------
// 1. THE ONE THAT MATTERS — Shiri's own sentence, approved as 320
// ---------------------------------------------------------------------------
const MANUAL = "הפקת חומרים שיווקיים אוגוסט";
const r1 = relabelDocDescription(MANUAL, TAX_RECEIPT);
check("1. a hand-written title returns ok:false (= leave it alone)", r1.ok === false, JSON.stringify(r1));

// approving the same row again must reach the same verdict — the route is
// re-entered on every attempt, including after a failed issue
const r1again = relabelDocDescription(MANUAL, TAX_RECEIPT);
check("2. still ok:false on a second approval (no drift over retries)", r1again.ok === false);

// and as a 305, in case the variant is never flipped
check("3. still ok:false when approved as 305", relabelDocDescription(MANUAL, TAX_INVOICE).ok === false);

// a hand-written title that happens to CONTAIN the label, but not at the head
check(
  "4. hand-written title containing the label mid-sentence is left alone",
  relabelDocDescription(`הפקה עבור ${L320} של אוגוסט`, TAX_RECEIPT).ok === false
);

// a hand-written title that STARTS with the label but has a human remainder —
// the builder never produces this shape (no separator), so it is a person's
check(
  "5. label at the head without the builder's separator is left alone",
  relabelDocDescription(`${L305} עבור אוגוסט`, TAX_RECEIPT).ok === false
);

// ---------------------------------------------------------------------------
// 2. The builder's own shapes still normalize — the fix must not break the
//    thing the function exists for
// ---------------------------------------------------------------------------
const BUILT_305 = `${L305} — ברק הרשקוביץ`;
const r6 = relabelDocDescription(BUILT_305, TAX_RECEIPT);
check("6. a builder 305 title relabels to the 320 label", r6.ok === true && r6.changed === true, JSON.stringify(r6));
check(
  "7. ...and only the label moved — the remainder is verbatim",
  r6.ok === true && r6.description === `${L320} — ברק הרשקוביץ`,
  r6.ok ? r6.description : "not ok"
);

const BUILT_BUNDLE = `${L305} מאוגד — ברק הרשקוביץ (5 מסמכי מקור)`;
const r8 = relabelDocDescription(BUILT_BUNDLE, TAX_RECEIPT);
check(
  "8. the bundled builder shape relabels too",
  r8.ok === true && r8.description === `${L320} מאוגד — ברק הרשקוביץ (5 מסמכי מקור)`,
  JSON.stringify(r8)
);

// idempotent: already carrying the right label = ok but unchanged
const r9 = relabelDocDescription(`${L320} — ברק הרשקוביץ`, TAX_RECEIPT);
check("9. already-correct label reports changed:false (nothing written)", r9.ok === true && r9.changed === false);

// ---------------------------------------------------------------------------
// 3. Degenerate inputs
// ---------------------------------------------------------------------------
check("10. empty string -> ok:false", relabelDocDescription("", TAX_RECEIPT).ok === false);
check("11. whitespace only -> ok:false", relabelDocDescription("   ", TAX_RECEIPT).ok === false);
check("12. null -> ok:false", relabelDocDescription(null, TAX_RECEIPT).ok === false);
check("13. undefined -> ok:false", relabelDocDescription(undefined, TAX_RECEIPT).ok === false);

console.log("\n" + (failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`));
process.exit(failures === 0 ? 0 : 1);
