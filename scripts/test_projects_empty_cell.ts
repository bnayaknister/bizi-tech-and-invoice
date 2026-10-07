/**
 * E10 — the empty-cell decision, as a pure function. No database, no network,
 * no server, no Supabase client. F19 is open and nothing here goes near it.
 *
 * Run: npx tsx scripts/test_projects_empty_cell.ts
 *
 * ═══ WHAT THIS SUITE IS REALLY GUARDING ═══
 * Every rule of 7.10 is an ABSENCE: the accruing 300 must NOT invite a click,
 * the empty 100 must NOT, two open parents must NOT, a closed parent must
 * NOT. An absence is exactly what a test that only checks the happy path
 * cannot see — so each one is asserted as `active === false` together with
 * the sentence the cell shows instead, and the active cases are asserted as
 * a counted whole (§1) so a rule that silently darkens everything fails here
 * rather than in front of the bookkeeper.
 */
import { emptyCellAction, type CellDoc, type EmptyCellInput } from "../src/lib/projects/emptyCellAction";
import { MORNING_DOC_CODE } from "../src/lib/morning/types";
import { ALLOWED_CHILDREN } from "../src/lib/documents/taxFromParent";

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

const ORDER = MORNING_DOC_CODE.order; // 100
const DEAL = MORNING_DOC_CODE.deal_invoice; // 300
const TAXINV = MORNING_DOC_CODE.tax_invoice; // 305
const TAXREC = MORNING_DOC_CODE.tax_receipt; // 320
const RECEIPT = MORNING_DOC_CODE.receipt; // 400

const doc = (type: number, over: Partial<CellDoc> = {}): CellDoc => ({
  type,
  number: `${type}-1`,
  status: 0, // OPEN in Morning
  cancelled: false,
  ...over,
});

const input = (over: Partial<EmptyCellInput> = {}): EmptyCellInput => ({
  source: "production",
  docType: DEAL,
  docs: [doc(ORDER)],
  cadence: "per_episode",
  ...over,
});

console.log("\n=== 0. the codes this suite rests on, verified not assumed ===");
check("100 / 300 / 305 / 320 / 400", [ORDER, DEAL, TAXINV, TAXREC, RECEIPT], [100, 300, 305, 320, 400]);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n=== 1. the active cells, exactly the three rungs E10 declares ===");
{
  // 300 ← an open 100
  const d300 = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { number: "10311" })] }));
  check("300 on an open 100 → active", d300.active, true);
  check("...and it targets that order's own registry row", d300.href, "/documents/registry?tab=work_order&q=10311");
  check("...and says what it will do", d300.reason, "להנפקה על סמך 10311 — נפתח ברג'יסטרי");

  // 305 ← an open 300
  const d305 = emptyCellAction(input({ docType: TAXINV, docs: [doc(ORDER), doc(DEAL, { number: "40310" })] }));
  check("305 on an open 300 → active", d305.active, true);
  check("...targeting the deal-invoice tab", d305.href, "/documents/registry?tab=deal_invoice&q=40310");

  // 320 ← an open 300 (same parent as 305)
  const d320 = emptyCellAction(input({ docType: TAXREC, docs: [doc(ORDER), doc(DEAL, { number: "40310" })] }));
  check("320 on an open 300 → active", d320.active, true);
  check("...same parent, same target as 305", d320.href, d305.href);

  // 400 ← an open 305
  const d400 = emptyCellAction(input({ docType: RECEIPT, docs: [doc(TAXINV, { number: "40399" })] }));
  check("400 on an open 305 → active", d400.active, true);
  check("...targeting the tax-invoice tab", d400.href, "/documents/registry?tab=tax_invoice&q=40399");

  // and the whole set at once: exactly four active cells across the five columns
  const all = [ORDER, DEAL, TAXINV, TAXREC, RECEIPT].map((t) =>
    emptyCellAction(input({ docType: t, docs: [doc(ORDER), doc(DEAL), doc(TAXINV)] }))
  );
  check(
    "across all five columns on a row holding an open 100+300+305: which are active",
    all.map((d) => d.active),
    // 100 occupied · 300 occupied · 305 OCCUPIED · 320 ← the open 300 · 400 ← the open 305
    [false, false, false, true, true]
  );

  // the same five columns on a row that holds ONLY an open 100 — the state
  // E10's own example describes, where exactly one cell should light up
  const onlyOrder = [ORDER, DEAL, TAXINV, TAXREC, RECEIPT].map((t) =>
    emptyCellAction(input({ docType: t, docs: [doc(ORDER)] }))
  );
  check(
    "a row with only an open 100: the 300 cell alone is active",
    onlyOrder.map((d) => d.active),
    [false, true, false, false, false]
  );
}

console.log("\n=== 2. 🔴 decision 3 — an empty 100 is never active, in any state ===");
{
  const bare = emptyCellAction(input({ docType: ORDER, docs: [] }));
  check("no docs at all → inactive", bare.active, false);
  check("the approved sentence", bare.reason, "חסרה הזמנת עבודה — חריג");
  check("and nowhere to click", bare.href, null);

  // even when everything else on the row would have lit it
  const rich = emptyCellAction(input({ docType: ORDER, docs: [doc(DEAL), doc(TAXINV)] }));
  check("a row with a 300 and a 305 but no 100 → still inactive", rich.active, false);
  check("...same sentence", rich.reason, "חסרה הזמנת עבודה — חריג");
}

console.log("\n=== 3. 🔴 decision 1 — an accruing client's 300 is waiting, not missing ===");
{
  const monthly = emptyCellAction(input({ docType: DEAL, cadence: "monthly" }));
  check("monthly → inactive even though the 100 is wide open", monthly.active, false);
  check("...and points at the redemption screen", monthly.href, "/documents/accrued");
  check("...with the rhythm named", monthly.reason, "לקוח בחיוב חודשי — חשבון העסקה ייצא בפדיון בסוף החודש, ממסך הפדיון");

  const everyN = emptyCellAction(input({ docType: DEAL, cadence: "every_n" }));
  check("every_n → inactive", everyN.active, false);
  check("...same destination", everyN.href, "/documents/accrued");
  check("...its own sentence", everyN.reason, "לקוח בחיוב מצטבר — חשבון העסקה ייצא כשהאגד יתמלא, ממסך הפדיון");

  check("per_episode → unaffected, still active", emptyCellAction(input({ docType: DEAL, cadence: "per_episode" })).active, true);
  check("cadence null (a source with no rhythm) → unaffected", emptyCellAction(input({ docType: DEAL, cadence: null })).active, true);

  // ⚠️ the brake is about the 300 rung only — a 305 on an accruing client is
  // a different question and the cadence has no say in it
  check(
    "a 305 on a monthly client is NOT silenced by cadence",
    emptyCellAction(input({ docType: TAXINV, cadence: "monthly", docs: [doc(DEAL)] })).active,
    true
  );
}

console.log("\n=== 4. 🔴 decision 2 — two open parents: the registry bundles, the cell does not pick ===");
{
  const two = emptyCellAction(
    input({ docType: DEAL, docs: [doc(ORDER, { number: "10311" }), doc(ORDER, { number: "10312" })] })
  );
  check("two open 100s → inactive", two.active, false);
  check("...the count is in the sentence", two.reason, "יש 2 מסמכי אב פתוחים — להנפיק מאוגד ממסך הרג'יסטרי");
  check("...and it points at the tab, NOT at one of them", two.href, "/documents/registry?tab=work_order");

  const three = emptyCellAction(
    input({ docType: DEAL, docs: [doc(ORDER), doc(ORDER), doc(ORDER)] })
  );
  check("three → same rule, counted", three.reason, "יש 3 מסמכי אב פתוחים — להנפיק מאוגד ממסך הרג'יסטרי");

  // one open + one CLOSED is not ambiguous: there is exactly one parent that
  // can bear a child, so the cell stays a shortcut to it
  const oneOpenOneClosed = emptyCellAction(
    input({ docType: DEAL, docs: [doc(ORDER, { number: "10311" }), doc(ORDER, { number: "10312", status: 1 })] })
  );
  check("one open + one closed → active on the open one", oneOpenOneClosed.active, true);
  check("...targeting the open order", oneOpenOneClosed.href, "/documents/registry?tab=work_order&q=10311");
}

console.log("\n=== 5. the parent must be OPEN — parentOpenness is the anchor, verbatim ===");
{
  const closedAuto = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { status: 1 })] }));
  check("status 1 → inactive", closedAuto.active, false);
  check("...the anchor's own label", closedAuto.reason, "המסמך האב נסגר אוטומטית במורנינג — לא ניתן להנפיק על סמכו");

  const closedManual = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { status: 2 })] }));
  check("status 2 → inactive, its own label", closedManual.reason, "המסמך האב נסגר ידנית במורנינג — לא ניתן להנפיק על סמכו");

  // the measured status=4 of 2026-08-11: an unrecognised code fails CLOSED
  const weird = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { status: 4 })] }));
  check("an unrecognised status (4, measured on five 305s) → inactive", weird.active, false);
  check("...labelled plainly closed", weird.reason, "המסמך האב סגור במורנינג — לא ניתן להנפיק על סמכו");

  // ⚠️ null = never pulled. parentOpenness calls that OPEN, and so does this.
  const notPulled = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { status: null, number: "10311" })] }));
  check("status null (app-issued, not yet pulled) → ACTIVE, following parentOpenness", notPulled.active, true);
  check("...and it still targets the row", notPulled.href, "/documents/registry?tab=work_order&q=10311");
}

console.log("\n=== 6. 400 comes from 305, never from 320 ===");
{
  check(
    "400 with only a 320 on the row → inactive",
    emptyCellAction(input({ docType: RECEIPT, docs: [doc(TAXREC)] })).active,
    false
  );
  check(
    "...because a 320 is not its parent at all",
    emptyCellAction(input({ docType: RECEIPT, docs: [doc(TAXREC)] })).reason,
    "אין מסמך אב ברשימה שאפשר להנפיק על סמכו"
  );
  check(
    "400 with a 305 → active",
    emptyCellAction(input({ docType: RECEIPT, docs: [doc(TAXINV)] })).active,
    true
  );
  // and the allow-list agrees that 320 fathers nothing — read, not restated
  check("ALLOWED_CHILDREN has no entry for tax_receipt", ALLOWED_CHILDREN.tax_receipt, undefined);
}

console.log("\n=== 7. a source with no door — milestone rows ===");
{
  const m = emptyCellAction(input({ source: "milestone", docType: DEAL, docs: [doc(ORDER)] }));
  check("milestone → inactive even with an open 100 on the row", m.active, false);
  check("...and the reason names the real door", m.reason, "אבן דרך מחויבת ממסך החוזים, לפי אבן הדרך עצמה");
  check("...pointing at /contracts", m.href, "/contracts");

  check(
    "every column on a milestone row is inactive",
    [ORDER, DEAL, TAXINV, TAXREC, RECEIPT].map((t) => emptyCellAction(input({ source: "milestone", docType: t, docs: [doc(ORDER), doc(DEAL), doc(TAXINV)] })).active),
    [false, false, false, false, false]
  );

  // the other three sources all reach the registry door the same way
  check(
    "production / bundle / misc / import all behave alike on the 300 rung",
    (["production", "bundle", "misc", "import"] as const).map((s) => emptyCellAction(input({ source: s, docType: DEAL })).active),
    [true, true, true, true]
  );
}

console.log("\n=== 8. the cell is only a cell when it is EMPTY ===");
{
  check(
    "a live 300 already there → inert, no sentence, no link",
    emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER), doc(DEAL)] })),
    { active: false, reason: null, href: null }
  );
  check(
    "a CANCELLED 300 does not occupy the cell — the row still needs one",
    emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { number: "10311" }), doc(DEAL, { cancelled: true })] })).active,
    true
  );
  check(
    "...but a cancelled parent is no parent",
    emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { cancelled: true })] })).reason,
    "אין מסמך אב ברשימה שאפשר להנפיק על סמכו"
  );
}

console.log("\n=== 9. a parent with no Morning number cannot be found by the registry's search ===");
{
  const noNum = emptyCellAction(input({ docType: DEAL, docs: [doc(ORDER, { number: null })] }));
  check("inactive rather than a link to an unfiltered tab", noNum.active, false);
  check("...and it says why", noNum.reason, "למסמך האב עוד אין מספר ממורנינג — לא ניתן לאתר אותו ברג'יסטרי");
  check("...with nothing to click", noNum.href, null);
}

console.log("\n=== 10. purity — same input, same answer, and no hidden clock ===");
{
  const a = emptyCellAction(input());
  const b = emptyCellAction(input());
  check("called twice, identical", a, b);
  const frozen = input();
  const snapshot = JSON.stringify(frozen);
  emptyCellAction(frozen);
  check("the input is not mutated", JSON.stringify(frozen), snapshot);
}

console.log(failed === 0 ? `\n✅  ${passed}/${passed} assertions passed\n` : `\n❌  ${passed}/${passed + failed} assertions passed, ${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
