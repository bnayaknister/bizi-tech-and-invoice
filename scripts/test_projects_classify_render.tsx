/**
 * ═══════════════════════════════════════════════════════════════════════════
 * מה בדיוק מופיע על המסך אחרי התיקון — ובמיוחד כמה פעמים מופיע "בחוזה".
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_projects_classify_render.tsx
 *
 * ⛔ Reads nothing, writes nothing, needs no dev server and no database. The
 * component is rendered to a string and the string is counted.
 *
 * ═══ WHY A RENDER SUITE AND NOT ONLY THE PURE ONE ═══
 * The owner's report is about four words on a screen: "בחוזה: ey 2026 -2027".
 * test_projects_classify.ts proves the RULE now answers `priced`, which is the
 * fix — and proves nothing about whether those words still reach the HTML. They
 * are assembled in ProjectsClient from two fields that arrive separately
 * (`billing` and `contractName`), and a row classified correctly with a stale
 * contract name beside it would still print the sentence the owner complained
 * about.
 *
 * That gap is not hypothetical here: this screen has already shipped a bug that
 * every string-matching HTTP suite passed (see the header of
 * test_projects_render.tsx, and the "SSR 200 is not a render check" rule). So
 * these assertions count OCCURRENCES IN THE RENDERED OUTPUT, which is the only
 * place the complaint can be settled.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import ProjectsClient, { type MonthBucket } from "../src/app/projects/ProjectsClient";
import type { UnifiedRow } from "../src/lib/projects/unified";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const EY_CONTRACT = "ey 2026 -2027 חצי ראשון 041026";

const row = (over: Partial<UnifiedRow> = {}): UnifiedRow => ({
  key: "production:p1",
  source: "production",
  month: "2026-08",
  date: "2026-08-02",
  dateMeaning: "record",
  client: "EY",
  show: "ey",
  description: "אורח",
  amount: null,
  billing: "priced",
  contractName: null,
  emptyReasonText: null,
  prodStatus: { label: "הופץ", color: "var(--dim)" },
  billStatus: { state: "blue", label: "ממתין לתשלום", color: "var(--cyan)" },
  docs: [],
  open: { kind: "entity", type: "production", id: "p1" },
  jobIds: [],
  excludedFromMoney: false,
  cancelled: false,
  stuckSentences: [],
  ...over,
});

const bucket = (work: UnifiedRow[], summary: Partial<MonthBucket["summary"]> = {}): MonthBucket[] => [
  {
    key: "2026-08",
    label: "אוגוסט 2026",
    rows: [],
    milestones: [],
    work,
    summary: {
      expected: 0,
      expectedPriced: 0,
      expectedPerEpisode: 0,
      expectedTotalRows: work.length,
      missingRateCount: 0,
      missingRateShows: [],
      contractCount: 0,
      contractItems: [],
      inactiveCount: 0,
      inactiveShows: [],
      noBillingCount: 0,
      billed: 0,
      billedCount: 0,
      incoming: 0,
      incomingCount: 0,
      ...summary,
    },
  },
];

const html = (work: UnifiedRow[], summary: Partial<MonthBucket["summary"]> = {}) =>
  renderToString(
    React.createElement(ProjectsClient, {
      buckets: bucket(work, summary),
      initialMonth: "2026-08",
      userId: "u1",
      today: "2026-10-06",
    })
  );
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 🔴 המקרה שדווח: הפקת EY מ-2.8 שחויבה פר-פרק ===");
{
  // what the server now hands the client for that row: priced, ₪1,000, and NO
  // contract name — because productions.contract_id is NULL
  const out = html([row({ billing: "priced", amount: 1000, contractName: null })]);
  check("המחיר 1,000 מופיע על המסך", out.includes("1,000"), "");
  check('🔴 אפס מופעים של "בחוזה"', count(out, "בחוזה") === 0, String(count(out, "בחוזה")));
  check('🔴 אפס מופעים של "מחויב בחוזה"', count(out, "מחויב בחוזה") === 0);
  check("🔴 שם החוזה של EY אינו מופיע בשום מקום", count(out, EY_CONTRACT) === 0);
  check('אין "חסר תעריף" על שורה שיש לה מחיר', count(out, "חסר תעריף") === 0);
}

// ⚠️ AND THE OPPOSITE MISTAKE, which is the one a half-fix would make: the row
// classified right but the show's current contract still travelling beside it.
// If `contractName` ever arrives non-null on a priced row, the screen must not
// print it as a billing statement.
{
  const out = html([row({ billing: "priced", amount: 1000, contractName: EY_CONTRACT })]);
  check(
    '⚠️ גם אם שם חוזה דלף לשורה מתומחרת — אין "בחוזה:" ליד הסכום',
    count(out, "בחוזה:") === 0,
    String(count(out, "בחוזה:"))
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== הפקה שאכן מחויבת בחוזה ===");
{
  // kind='contract' + contract_id → the name, and the name is the point
  const out = html([row({ show: "בלי יריה אחת", billing: "contract", amount: null, contractName: "מכירת ביפו" })]);
  check('"בחוזה: מכירת ביפו" מופיע', out.includes("בחוזה: מכירת ביפו"), "");
  check("  ...פעם אחת בלבד", count(out, "בחוזה: מכירת ביפו") === 1, String(count(out, "בחוזה: מכירת ביפו")));
  check("  ...ובלי סכום פר-פרק לידו", count(out, "2,500") === 0);
}
{
  // kind='contract' + contract_id NULL → "חוזה" with no name
  const out = html([row({ billing: "contract", amount: null, contractName: null })]);
  check('בלי contract_id: מופיע "מחויב בחוזה"', out.includes("מחויב בחוזה"), "");
  check('  ...ובלי "בחוזה:" — כלומר בלי שם', count(out, "בחוזה:") === 0);
  check("  ...ובלי שם החוזה הנוכחי של התוכנית", count(out, EY_CONTRACT) === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== הפקה פנימית ===");
{
  const out = html([row({ show: "אילון", billing: "internal", amount: null, contractName: null })]);
  check('"הפקה פנימית" מופיע', out.includes("הפקה פנימית"), "");
  check('ואין "חסר תעריף" — אין מה להשלים', count(out, "חסר תעריף") === 0);
  check('ואין "בחוזה"', count(out, "בחוזה") === 0);
  check("ואין סכום של התוכנית", count(out, "1,800") === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== רגרסיה: הוורדיקטים שלא נגענו בהם ===");
{
  const out = html([row({ billing: "missing_rate", amount: null })]);
  check('missing_rate → "חסר תעריף", כמו היום', out.includes("חסר תעריף"));
}
{
  const out = html([row({ billing: "inactive", amount: null })]);
  check('inactive → "תוכנית לא פעילה", כמו היום', out.includes("תוכנית לא פעילה"));
}
{
  const out = html([row({ billing: "no_billing", amount: 700 })]);
  check("no_billing עם תעריף → הסכום מוצג, כמו היום", out.includes("700"));
}
{
  const out = html([row({ billing: "no_billing", amount: null })]);
  check('no_billing בלי תעריף → "חיוב מושתק", כמו היום', out.includes("חיוב מושתק"));
}
{
  // the ordinary month: a priced row and a genuinely contract-billed row side by
  // side. Exactly one "בחוזה" in the whole table — not zero, not two.
  const out = html([
    row({ billing: "priced", amount: 1200 }),
    row({ key: "production:p2", show: "מאצ׳ אפ", billing: "contract", amount: null, contractName: "מכירת ביפו" }),
  ]);
  check("חודש מעורב: בדיוק מופע אחד של \"בחוזה\"", count(out, "בחוזה") === 1, String(count(out, "בחוזה")));
  check("  ...והמחיר הפר-פרקי מופיע", out.includes("1,200"));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 🔵 הכרעת הבעלים 6.10: השמות חוזרים לשורות החוזה ===");
/**
 * 8febad1 named a contract row only from `productions.contract_id`, which is
 * set on 1 production in 765 — so 27 of the 28 contract-mode shows lost their
 * name and read "מחויב בחוזה". The owner rejected that. The fallbacks are back
 * behind a `kind='contract'` gate, and these assertions are about what the
 * SCREEN shows now: the name on a contract row, and still nothing on EY's.
 *
 * The server resolves the name (contractNameFor, proven case by case in
 * test_projects_classify.ts) and hands it down as `contractName`. Here it
 * arrives already resolved, which is exactly how the component sees it.
 */
{
  // the ביפו case: contract_id NULL, named through the client's sole active
  // contract — the step that was deleted and is now restored
  const out = html([row({ show: "מאצ׳ אפ", billing: "contract", amount: null, contractName: "מכירת ביפו" })]);
  check('🔵 "בחוזה: מכירת ביפו" חזר למסך', out.includes("בחוזה: מכירת ביפו"), "");
  check("  ...פעם אחת", count(out, "בחוזה: מכירת ביפו") === 1, String(count(out, "בחוזה: מכירת ביפו")));
  check('  ...ובלי "מחויב בחוזה" חסר-השם לידו', count(out, "מחויב בחוזה") === 0);
}
{
  // and the one that must still be nameless: no contract_id, no contract on the
  // show, no sole active client contract
  const out = html([row({ billing: "contract", amount: null, contractName: null })]);
  check('בלי שום שם אפשרי → "מחויב בחוזה" פעם אחת', count(out, "מחויב בחוזה") === 1, String(count(out, "מחויב בחוזה")));
  check('  ...ובלי "בחוזה:"', count(out, "בחוזה:") === 0);
}
{
  // 🔴 THE REPORTED ROW, RE-ASKED AFTER THE FALLBACKS CAME BACK. This is the
  // assertion that proves the restoration did not resurrect the bug: the server
  // hands this row contractName=null because kind='client' gates the walk, so
  // the name appears NOWHERE — not as a label, and not beside the show name in
  // the "תוכנית / עבודה" column, which prints any name it is given.
  const out = html([row({ billing: "priced", amount: 1000, contractName: null })]);
  check("🔴 EY אחרי החזרת הנפילות: 0 מופעים של \"בחוזה\"", count(out, "בחוזה") === 0, String(count(out, "בחוזה")));
  check("🔴 EY: 0 מופעים של שם החוזה", count(out, EY_CONTRACT) === 0);
  check("🔴 EY: המחיר 1,000 מופיע", out.includes("1,000"));
}
{
  // internal: no contract label by any route
  const out = html([row({ show: "אילון", billing: "internal", amount: null, contractName: null })]);
  check("internal: 0 תווית חוזה", count(out, "בחוזה") === 0 && count(out, "מחויב בחוזה") === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== contractItems בכרטיס החודש ===");
{
  // the card's own list of "show (בחוזה: contract)" — it lost its names in
  // 8febad1 along with the rows, and comes back with them
  const out = html(
    [row({ show: "מאצ׳ אפ", billing: "contract", amount: null, contractName: "מכירת ביפו" })],
    {
      contractCount: 1,
      contractItems: [{ show: "מאצ׳ אפ", contract: "מכירת ביפו" }],
    }
  );
  check("🔵 הכרטיס מציג 'מאצ׳ אפ (בחוזה: מכירת ביפו)'", out.includes("מאצ׳ אפ (בחוזה: מכירת ביפו)"), "");
  // the count is a separate JSX text node, so SSR puts a <!-- --> between it and
  // the label — the two halves are asserted separately rather than as one string
  check("  ...ושורת עבודת החוזה מופיעה", out.includes("עבודת חוזה") && out.includes("ללא מחיר פר-פרק"));
}
{
  // a contract item with no resolvable name still lists the show, with no
  // parenthetical — the pre-existing fallback in the card, unchanged
  const out = html([row({ billing: "contract", amount: null, contractName: null })], {
    contractCount: 1,
    contractItems: [{ show: "תוכנית ללא שם חוזה", contract: null }],
  });
  check("פרק חוזה בלי שם → התוכנית לבדה בכרטיס, בלי סוגריים", out.includes("תוכנית ללא שם חוזה") && count(out, "(בחוזה:") === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== אין קריסה על ורדיקט חדש בצ'אנק ישן (version skew) ===");
/**
 * `internal` is a NEW BillingClass value. A browser holding the previous JS
 * chunk will be handed it by the new server, and a `Record<BillingClass,string>`
 * lookup that misses returns undefined — the exact class of failure that took
 * this screen down on 2026-08-27. Both directions are checked: the new value in
 * an old-shaped payload, and an unknown value in the new one.
 */
const noThrow = (label: string, fn: () => void) => {
  checks++;
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
  }
};

noThrow("billing שאינו מוכר — לא קורס", () =>
  html([row({ billing: "something_new" as unknown as UnifiedRow["billing"], amount: null })]));
noThrow("billing undefined — לא קורס", () =>
  html([row({ billing: undefined as unknown as UnifiedRow["billing"], amount: null })]));
noThrow("contractName undefined על שורת חוזה — לא קורס", () =>
  html([row({ billing: "contract", contractName: undefined as unknown as null, amount: null })]));

console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
