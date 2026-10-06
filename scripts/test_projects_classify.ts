/**
 * ═══════════════════════════════════════════════════════════════════════════
 * הסיווג של שורת הפקה ב-/projects נגזר מהצילום שעל ההפקה — לא מתצורת התוכנית
 * כפי שהיא היום.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx scripts/test_projects_classify.ts
 *
 * ⛔ NO DATABASE, NO SERVER, NO NETWORK, NO CLOCK — no Supabase client, no
 * fetch, no Date.now(). F19: the live account holds the very rows this suite
 * describes (the EY episode of 2.8.2026, work order 10302, deal invoice 40306)
 * and it must not go near them. Every fixture below is a literal.
 *
 * ═══ 🔴 THE BUG, AND WHY NO EXISTING TEST COULD HAVE CAUGHT IT ═══
 * `classify()` lived inline in projects/page.tsx, 60 lines of server component
 * away from anything importable, and it asked `shows.billing_mode` — the show's
 * configuration TODAY — about work that happened months ago. `resolveContractName`
 * then walked to the show's CURRENT contract and printed its name.
 *
 * So when EY's show moved to billing_mode='contract' on 4.10, an episode from
 * 2.8 that had already been billed per episode was redrawn as
 * "בחוזה: ey 2026 -2027 חצי ראשון 041026" with no price — a contract that did
 * not exist when the work was done. The production row itself was never wrong:
 * kind='client', contract_id=NULL. Nobody asked it.
 *
 * Both functions now live in src/lib/projects/classify.ts, which has zero
 * imports, which is why the first three sections of this file exist at all.
 *
 * SECTIONS
 *   1. the rule, case by case — the owner's six cases, verbatim
 *   2. the frozen job price, and the bundle it must refuse to read
 *   3. the month cards, BEFORE vs AFTER on one fixture holding every case
 *   4. one source — every consumer reads the same verdict
 *   5. read-only enforcement — this change may not write anything, anywhere
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  classifyProduction,
  contractNameFor,
  soleJobAmounts,
  type BillingClass,
} from "../src/lib/projects/classify";

let failures = 0;
let checks = 0;
/** True when a section could not run (a missing git range). Reported in the
 *  final line so a skipped run can never read as a clean one. */
let skipped = false;
function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const ROOT = join(__dirname, "..");
const EY_CONTRACT = "ey 2026 -2027 חצי ראשון 041026";

// The three show configurations that matter, as they stand TODAY.
const SHOW_CONTRACT = { billing_mode: "contract", active: true };
const SHOW_PER_EPISODE = { billing_mode: "per_episode", active: true };
const SHOW_NONE = { billing_mode: "none", active: true };
const SHOW_INACTIVE = { billing_mode: "per_episode", active: false };

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. הכלל, מקרה-מקרה (ששת המקרים של הבעלים) ===");

// 🔴 THE REPORTED CASE. kind='client' + contract_id NULL on a show that is now
// contract-billed, with a job that froze ₪1,000. This is the EY episode.
{
  const r = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_CONTRACT,
    showPrice: null, // the rate was cleared when the show moved to contract mode
    jobAmount: 1000,
  });
  check("🔴 EY: הפקת client בתוכנית שעכשיו contract → מתומחר", r.billing === "priced", r.billing);
  check("🔴 EY: המחיר הוא זה שה-job הקפיא — 1,000", r.price === 1000, String(r.price));
  // 🔴 AND THE NAME IS REFUSED EVEN THOUGH EVERY FALLBACK WOULD HAVE ANSWERED.
  // The show now has a contract pointing at it AND it is the client's sole
  // active contract — both of the restored steps would name it. kind='client'
  // is the gate, and this is the assertion the owner's ruling turns on.
  check(
    "🔴 EY: אין שם חוזה — למרות שכל הנפילות היו עונות",
    contractNameFor(
      { kind: "client", contract_id: null, show_id: "s-ey", client_id: "cl-ey" },
      { client_id: "cl-ey" },
      [{ id: "c-ey", name: EY_CONTRACT, show_id: "s-ey", client_id: "cl-ey", status: "active" }]
    ) === null
  );
}

// kind='contract' + contract_id X → named, whatever the show says now. The
// "בלי יריה אחת" case: the show was moved OFF contract mode afterwards.
for (const [label, show] of [
  ["contract", SHOW_CONTRACT],
  ["per_episode", SHOW_PER_EPISODE],
  ["none", SHOW_NONE],
] as const) {
  const p = { kind: "contract", contract_id: "c-jaffa" };
  const r = classifyProduction({ production: p, show, showPrice: 2500, jobAmount: null });
  check(`הפקת contract בתוכנית שעכשיו ${label} → חוזה`, r.billing === "contract", r.billing);
  check(`  ...ובלי מחיר פר-פרק (${label})`, r.price === null, String(r.price));
  check(
    `  ...ועם שם החוזה מה-contract_id (${label})`,
    contractNameFor(p, undefined, [{ id: "c-jaffa", name: "מכירת ביפו" }]) === "מכירת ביפו"
  );
}

// kind='contract' + contract_id NULL → "חוזה" with no name, and specifically
// NOT the show's current contract.
{
  const p = { kind: "contract", contract_id: null };
  const r = classifyProduction({ production: p, show: SHOW_CONTRACT, showPrice: null, jobAmount: null });
  check("הפקת contract בלי contract_id → חוזה", r.billing === "contract", r.billing);
  // ═══ THE RESTORED WALK, STEP BY STEP (owner ruling 6.10) ═══
  // step 2: a contract pointing AT the show — THE NAME COMES BACK
  check(
    "🔵 contract_id ריק + חוזה שמצביע על התוכנית → השם חוזר",
    contractNameFor(
      { kind: "contract", contract_id: null, show_id: "s-icr", client_id: "cl-icr" },
      undefined,
      [{ id: "c-byshow", name: "icr spotlight", show_id: "s-icr", client_id: "cl-icr", status: "active" }]
    ) === "icr spotlight",
    ""
  );
  // step 3: the client's sole ACTIVE contract — how 27 of the 28 shows resolve
  check(
    "🔵 contract_id ריק + חוזה פעיל יחיד ללקוח → השם חוזר (מכירת ביפו)",
    contractNameFor(
      { kind: "contract", contract_id: null, show_id: "s-bipo", client_id: "cl-bipo" },
      undefined,
      [{ id: "c-umbrella", name: "מכירת ביפו", show_id: null, client_id: "cl-bipo", status: "active" }]
    ) === "מכירת ביפו"
  );
  // step 3 via the SHOW's client, when the production has none of its own
  check(
    "🔵 ...גם כשה-client_id מגיע מהתוכנית ולא מההפקה",
    contractNameFor(
      { kind: "contract", contract_id: null, show_id: "s-bipo", client_id: null },
      { client_id: "cl-bipo" },
      [{ id: "c-umbrella", name: "מכירת ביפו", show_id: null, client_id: "cl-bipo", status: "active" }]
    ) === "מכירת ביפו"
  );
  // and the two ways the walk must still refuse to guess
  check(
    "שני חוזים פעילים ללקוח → בלי שם, לא ניחוש",
    contractNameFor(
      { kind: "contract", contract_id: null, show_id: "s-x", client_id: "cl-x" },
      undefined,
      [
        { id: "c-1", name: "חוזה א", show_id: null, client_id: "cl-x", status: "active" },
        { id: "c-2", name: "חוזה ב", show_id: null, client_id: "cl-x", status: "active" },
      ]
    ) === null
  );
  check(
    "חוזה הלקוח אינו פעיל → בלי שם",
    contractNameFor(
      { kind: "contract", contract_id: null, show_id: "s-x", client_id: "cl-x" },
      undefined,
      [{ id: "c-1", name: "חוזה שפג", show_id: null, client_id: "cl-x", status: "ended" }]
    ) === null
  );
  check("אין שום שם אפשרי → null, והמסך יאמר \"מחויב בחוזה\"", r.billing === "contract" && contractNameFor(p, undefined, []) === null);
}

// ⚠️ THE GATE, ASKED ONCE MORE FROM THE OTHER SIDE: the exact same facts that
// name a contract row must name NOTHING on a client or internal row. Only `kind`
// differs between these three calls.
{
  const facts = [{ id: "c-u", name: "מכירת ביפו", show_id: "s-1", client_id: "cl-1", status: "active" }];
  const base = { contract_id: null, show_id: "s-1", client_id: "cl-1" };
  check("אותן עובדות: kind='contract' → שם", contractNameFor({ ...base, kind: "contract" }, undefined, facts) === "מכירת ביפו");
  check("אותן עובדות: kind='client' → בלי שם", contractNameFor({ ...base, kind: "client" }, undefined, facts) === null);
  check("אותן עובדות: kind='internal' → בלי שם", contractNameFor({ ...base, kind: "internal" }, undefined, facts) === null);
  check("אותן עובדות: kind חסר → בלי שם", contractNameFor(base, undefined, facts) === null);
}

// kind='internal' on a per_episode show that HAS a rate — אילון.
{
  const r = classifyProduction({
    production: { kind: "internal", contract_id: null },
    show: SHOW_PER_EPISODE,
    showPrice: 1800,
    jobAmount: null,
  });
  check("הפקת internal בתוכנית per_episode → פנימי", r.billing === "internal", r.billing);
  check("  ...ובלי מחיר: הפקה פנימית אינה מחויבת לאף אחד", r.price === null, String(r.price));
}

// kind='client', no job, no rate → missing_rate, exactly as today.
{
  const r = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_PER_EPISODE,
    showPrice: null,
    jobAmount: null,
  });
  check("הפקת client בלי job ובלי תעריף → חסר תעריף", r.billing === "missing_rate", r.billing);
}

// regression: the ordinary per_episode show, untouched.
{
  const r = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_PER_EPISODE,
    showPrice: 1200,
    jobAmount: null,
  });
  check("רגרסיה: client בתוכנית per_episode עם תעריף → מתומחר, 1,200", r.billing === "priced" && r.price === 1200);
}

// regression: the two show-level answers that were deliberately left alone.
{
  const silenced = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_NONE,
    showPrice: 900,
    jobAmount: 900,
  });
  check("רגרסיה: billing_mode='none' → חיוב מושתק, כמו היום", silenced.billing === "no_billing", silenced.billing);
  // the tooltip-vs-amount detail that today's screen already has: a silenced
  // show carrying a rate shows that ₪, and the label only appears when there is
  // no number. Unchanged on purpose — see the note at that branch in classify.ts.
  check("  ...והמחיר נשאר תעריף התוכנית, בדיוק כמו היום", silenced.price === 900, String(silenced.price));

  const inactive = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_INACTIVE,
    showPrice: null,
    jobAmount: null,
  });
  check("רגרסיה: תוכנית לא פעילה בלי תעריף → inactive, כמו היום", inactive.billing === "inactive", inactive.billing);
}

// the price precedence, stated on its own: the frozen number beats the live one
{
  const r = classifyProduction({
    production: { kind: "client", contract_id: null },
    show: SHOW_PER_EPISODE,
    showPrice: 1200,
    jobAmount: 1000,
  });
  check("מחיר ה-job קודם לתעריף התוכנית — 1,000 ולא 1,200", r.price === 1000, String(r.price));
}

// a defensive row: kind absent (never happens — the column is NOT NULL — but a
// stale payload or a hand-made row must not crash or invent a verdict)
{
  const r = classifyProduction({
    production: {},
    show: SHOW_PER_EPISODE,
    showPrice: 500,
    jobAmount: null,
  });
  check("kind חסר → נופל למסלול התצורה, בלי ורדיקט חדש", r.billing === "priced" && r.price === 500);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 1ב. זהות מול resolveContractName המקורי (לפני 8febad1) ===");
/**
 * THE QUESTION THE OWNER ASKED, ANSWERED AS A TEST AND NOT AS AN OPINION:
 * are contract names now identical to what they were before 8febad1, on every
 * row that genuinely is kind='contract'?
 *
 * The original function is re-spelled below VERBATIM from projects/page.tsx at
 * 23feaca — the only copy of it left anywhere — and both are run over the same
 * matrix. For kind='contract' the outputs must agree on every single case; for
 * kind='client' and 'internal' the new one must return null wherever the old one
 * answered, and those are exactly the rows the fix is about.
 */
function originalResolveContractName(
  production: { contract_id?: string | null; show_id: string | null; client_id: string | null },
  show: { client_id?: string | null } | undefined,
  contracts: { id: string; name: string; client_id: string | null; show_id: string | null; status: string }[]
): string | null {
  if (production.contract_id) {
    const exact = contracts.find((c) => c.id === production.contract_id);
    if (exact) return exact.name;
  }
  const byShow = contracts.filter((c) => c.show_id && c.show_id === production.show_id);
  if (byShow.length === 1) return byShow[0].name;

  const clientId = production.client_id ?? show?.client_id ?? null;
  if (!clientId) return null;
  const byClient = contracts.filter((c) => c.client_id === clientId && c.status === "active");
  return byClient.length === 1 ? byClient[0].name : null;
}

{
  // every shape of contracts table that matters, including the ones measured on
  // 2026-08-27: contract_id set (1 of 765), show_id set (1 of 3 contracts),
  // the umbrella with show_id NULL (מכירת ביפו), two actives, and an ended one
  const TABLES: { label: string; contracts: { id: string; name: string; client_id: string | null; show_id: string | null; status: string }[] }[] = [
    { label: "ריקה", contracts: [] },
    { label: "חוזה מדויק לפי contract_id", contracts: [{ id: "c-exact", name: "icr spotlight", client_id: "cl-1", show_id: null, status: "active" }] },
    { label: "חוזה שמצביע על התוכנית", contracts: [{ id: "c-byshow", name: "icr spotlight", client_id: "cl-1", show_id: "s-1", status: "active" }] },
    { label: "חוזה גג פעיל יחיד (ביפו)", contracts: [{ id: "c-umb", name: "מכירת ביפו", client_id: "cl-1", show_id: null, status: "active" }] },
    { label: "שני חוזים פעילים", contracts: [
      { id: "c-a", name: "חוזה א", client_id: "cl-1", show_id: null, status: "active" },
      { id: "c-b", name: "חוזה ב", client_id: "cl-1", show_id: null, status: "active" },
    ] },
    { label: "חוזה שפג", contracts: [{ id: "c-old", name: "חוזה שפג", client_id: "cl-1", show_id: null, status: "ended" }] },
    { label: "חוזה של לקוח אחר", contracts: [{ id: "c-other", name: "חוזה זר", client_id: "cl-9", show_id: "s-9", status: "active" }] },
    { label: "גג פעיל + חוזה לפי show", contracts: [
      { id: "c-umb", name: "מכירת ביפו", client_id: "cl-1", show_id: null, status: "active" },
      { id: "c-byshow", name: "icr spotlight", client_id: "cl-1", show_id: "s-1", status: "active" },
    ] },
  ];
  const PRODUCTIONS = [
    { label: "contract_id מוגדר", contract_id: "c-exact", show_id: "s-1", client_id: "cl-1" },
    { label: "contract_id ריק", contract_id: null, show_id: "s-1", client_id: "cl-1" },
    { label: "contract_id ריק, בלי client על ההפקה", contract_id: null, show_id: "s-1", client_id: null },
    { label: "contract_id ריק, בלי show", contract_id: null, show_id: null, client_id: "cl-1" },
    { label: "contract_id שמצביע לחוזה שלא קיים", contract_id: "c-missing", show_id: "s-1", client_id: "cl-1" },
  ];
  const SHOWS = [
    { label: "תוכנית עם לקוח", show: { client_id: "cl-1" } },
    { label: "תוכנית בלי לקוח", show: { client_id: null } },
    { label: "בלי תוכנית", show: undefined },
  ];

  let compared = 0;
  let mismatches = 0;
  let namesRescued = 0;
  let namesWithheld = 0;
  for (const t of TABLES) {
    for (const pr of PRODUCTIONS) {
      for (const sh of SHOWS) {
        const before = originalResolveContractName(pr, sh.show, t.contracts);

        // kind='contract' — MUST be identical, case by case
        const after = contractNameFor({ ...pr, kind: "contract" }, sh.show, t.contracts);
        compared++;
        if (before !== after) {
          mismatches++;
          console.log(`  FAIL  שונה: ${t.label} / ${pr.label} / ${sh.label} — לפני=${before} אחרי=${after}`);
        }
        if (before !== null) namesRescued++;

        // kind='client' / 'internal' — MUST be null, and that is the fix
        for (const kind of ["client", "internal"]) {
          const gated = contractNameFor({ ...pr, kind }, sh.show, t.contracts);
          if (gated !== null) {
            mismatches++;
            console.log(`  FAIL  שם דלף ל-kind='${kind}': ${t.label} / ${pr.label} — ${gated}`);
          }
          if (before !== null && gated === null) namesWithheld++;
        }
      }
    }
  }
  check(
    `🔵 ${compared} מקרים: שמות החוזים על שורות kind='contract' זהים לחלוטין למה שהיה לפני 8febad1`,
    mismatches === 0,
    `${mismatches} פערים`
  );
  console.log(`  מתוכם ${namesRescued} מקרים שבהם היה שם — וכולם חזרו`);
  console.log(`  ובמקביל ${namesWithheld} מקרים שבהם שם נמנע מ-client/internal — זה התיקון`);
  check("לפחות מקרה אחד באמת החזיר שם (אחרת ההשוואה ריקה)", namesRescued > 0, String(namesRescued));
  check("ולפחות אחד באמת נמנע", namesWithheld > 0, String(namesWithheld));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 2. המחיר שה-job הקפיא, והחבילה שאסור לקרוא ===");
{
  // p1 has one job covering it alone → its amount is usable.
  // p2 and p3 share a bundled job → NEITHER may read it.
  // p4 has two jobs → ambiguous, no frozen price.
  // p5's only job is dismissed → the caller never passes it in.
  const links = [
    { job_id: "j-solo", production_id: "p1" },
    { job_id: "j-bundle", production_id: "p2" },
    { job_id: "j-bundle", production_id: "p3" },
    { job_id: "j-a", production_id: "p4" },
    { job_id: "j-b", production_id: "p4" },
    { job_id: "j-dismissed", production_id: "p5" },
    // the bundle's third leg sits BELOW the July floor and is invisible on
    // screen — the reason this function must see the full table
    { job_id: "j-halfhidden", production_id: "p6" },
    { job_id: "j-halfhidden", production_id: "p-june" },
  ];
  const live = new Map<string, number | null>([
    ["j-solo", 1000],
    ["j-bundle", 9000],
    ["j-a", 500],
    ["j-b", 500],
    ["j-halfhidden", 4000],
    ["j-noamount", null],
  ]);
  const amounts = soleJobAmounts(links, live);
  check("job יחיד על הפקה יחידה → המחיר נקרא", amounts.get("p1") === 1000, String(amounts.get("p1")));
  check("⚠️ job מאוגד על שתי הפקות → לא נקרא (p2)", !amounts.has("p2"));
  check("⚠️ job מאוגד על שתי הפקות → לא נקרא (p3)", !amounts.has("p3"));
  check("שני jobs על הפקה אחת → לא נקרא", !amounts.has("p4"));
  check("job שנדחה (dismissed) → אינו ברשימה החיה, לא נקרא", !amounts.has("p5"));
  check(
    "⚠️ job שהרגל השנייה שלו מתחת לרצפת יולי → עדיין חבילה, לא נקרא",
    !amounts.has("p6"),
    String(amounts.get("p6"))
  );
  check("job בלי סכום → לא נקרא", !amounts.has("p-noamount"));
  check("אין הפקות נוספות במפה", amounts.size === 1, String(amounts.size));

  // and the whole point: if the bundle total HAD been read, the expected card
  // would have counted ₪9,000 twice
  const wouldHaveBeen = ["p2", "p3"].reduce((t, id) => t + (live.get("j-bundle") ?? 0), 0);
  check("  ...מה שהיה מכפיל 9,000 לכדי 18,000 בכרטיס הצפוי", wouldHaveBeen === 18000);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 3. כרטיסי החודש — לפני/אחרי על fixture שמכיל את כל המקרים ===");
/**
 * ⚠️ THE OLD RULE IS RE-SPELLED HERE, ONCE, ON PURPOSE.
 *
 * It no longer exists anywhere in the source — that is the change. To prove the
 * cards move ONLY where the classification was fixed, the baseline has to come
 * from somewhere, so the deleted function is reproduced verbatim as `oldWay`
 * (projects/page.tsx at 23feaca) and both verdicts are poured through ONE
 * summariser. A difference in any row that was not misclassified would be a
 * difference the summariser cannot hide.
 */
function oldWay(show: { billing_mode?: string | null; active?: boolean | null } | undefined, price: number | null): BillingClass {
  if (show?.billing_mode === "contract") return "contract";
  if (show?.billing_mode === "none") return "no_billing";
  if (price != null) return "priced";
  if (show && show.active === false) return "inactive";
  return "missing_rate";
}

type Fix = {
  id: string;
  kind: string;
  contract_id: string | null;
  show: { billing_mode?: string | null; active?: boolean | null };
  showPrice: number | null;
  jobAmount: number | null;
  cancelled?: boolean;
  show_name: string;
};
const fixture: Fix[] = [
  // 🔴 the reported row: per-episode work on a show that has since gone contract
  { id: "ey-2.8", kind: "client", contract_id: null, show: SHOW_CONTRACT, showPrice: null, jobAmount: 1000, show_name: "ey" },
  // a genuinely contract-billed episode, named
  { id: "jaffa-1", kind: "contract", contract_id: "c-jaffa", show: SHOW_CONTRACT, showPrice: null, jobAmount: null, show_name: "מאצ׳ אפ" },
  // a genuinely contract-billed episode on a show since moved OFF contract mode
  { id: "noshot-1", kind: "contract", contract_id: "c-jaffa", show: SHOW_PER_EPISODE, showPrice: 2500, jobAmount: null, show_name: "בלי יריה אחת" },
  // internal, on a show that carries a rate
  { id: "eilon-1", kind: "internal", contract_id: null, show: SHOW_PER_EPISODE, showPrice: 1800, jobAmount: null, show_name: "אילון" },
  // the ordinary per-episode rows
  { id: "plain-1", kind: "client", contract_id: null, show: SHOW_PER_EPISODE, showPrice: 1200, jobAmount: null, show_name: "רגיל" },
  { id: "plain-2", kind: "client", contract_id: null, show: SHOW_PER_EPISODE, showPrice: 1200, jobAmount: 1200, show_name: "רגיל" },
  // the real defect, still a defect
  { id: "norate-1", kind: "client", contract_id: null, show: SHOW_PER_EPISODE, showPrice: null, jobAmount: null, show_name: "חסר תעריף" },
  // silenced, and switched off
  { id: "silent-1", kind: "client", contract_id: null, show: SHOW_NONE, showPrice: 700, jobAmount: null, show_name: "מושתק" },
  { id: "off-1", kind: "client", contract_id: null, show: SHOW_INACTIVE, showPrice: null, jobAmount: null, show_name: "כבויה" },
  // cancelled: out of the arithmetic either way
  { id: "cx-1", kind: "client", contract_id: null, show: SHOW_CONTRACT, showPrice: null, jobAmount: 3000, cancelled: true, show_name: "מבוטלת" },
];

/** The /projects month-card arithmetic, copied from page.tsx and NOT changed. */
function summarise(rows: { billing: BillingClass; price: number | null; internal: boolean; cancelled: boolean }[]) {
  const billable = rows.filter((r) => !r.internal && !r.cancelled);
  const of = (c: BillingClass) => billable.filter((r) => r.billing === c);
  const priced = of("priced");
  return {
    expected: priced.reduce((t, r) => t + (r.price ?? 0), 0),
    expectedPriced: priced.length,
    expectedPerEpisode: priced.length + of("missing_rate").length + of("inactive").length,
    expectedTotalRows: rows.length,
    missingRateCount: of("missing_rate").length,
    contractCount: of("contract").length,
    inactiveCount: of("inactive").length,
    noBillingCount: of("no_billing").length,
  };
}

const before = summarise(
  fixture.map((f) => {
    // the old pairing: price computed from the show, class computed beside it
    const price = f.showPrice;
    return {
      billing: oldWay(f.show, price),
      price,
      internal: f.kind === "internal",
      cancelled: !!f.cancelled,
    };
  })
);
const after = summarise(
  fixture.map((f) => {
    const r = classifyProduction({
      production: { kind: f.kind, contract_id: f.contract_id },
      show: f.show,
      showPrice: f.showPrice,
      jobAmount: f.jobAmount,
    });
    return { billing: r.billing, price: r.price, internal: f.kind === "internal", cancelled: !!f.cancelled };
  })
);
console.log(`  לפני:  ${JSON.stringify(before)}`);
console.log(`  אחרי:  ${JSON.stringify(after)}`);

// WHICH rows were misclassified, named one by one. Everything the cards do
// differently must be explained by exactly these.
const fixed = fixture.filter((f) => {
  const price = f.showPrice;
  const o = oldWay(f.show, price);
  const n = classifyProduction({
    production: { kind: f.kind, contract_id: f.contract_id },
    show: f.show,
    showPrice: f.showPrice,
    jobAmount: f.jobAmount,
  });
  return o !== n.billing || price !== n.price;
});
check(
  "השורות שהסיווג או המחיר שלהן תוקנו הן בדיוק ארבע, ובשמן",
  fixed.map((f) => f.id).sort().join(",") === ["ey-2.8", "noshot-1", "eilon-1", "cx-1"].sort().join(","),
  fixed.map((f) => f.id).join(",")
);
// plain-2 carries a job whose amount EQUALS the show's rate — the ordinary case
// after a job exists. It must not appear above: reading the frozen number
// instead of the live one changed nothing, and a row that did not move must not
// be reported as moved.
check("שורה שה-job שלה מסכים עם התעריף — לא זזה", !fixed.some((f) => f.id === "plain-2"));

check("expectedTotalRows לא זז — אף שורה לא נעלמה ולא נוספה", before.expectedTotalRows === after.expectedTotalRows);

// 🔴 THE NET MOVEMENT, AND IT IS DOWNWARD. Two corrections in opposite
// directions, and the second is the larger: EY's ₪1,000 enters the per-episode
// sum, and "בלי יריה אחת"'s ₪2,500 LEAVES it. That second one is a genuinely
// contract-billed episode whose show was moved off contract mode afterwards —
// the old rule read the show's current per-episode rate and added it to a total
// that the contract's milestones already account for. It was a double count,
// and it is exactly the double count the deleted comment said could not happen
// ("313 productions sit on contract-mode shows and NONE of them has a job") —
// true of the shows that are STILL in contract mode, and silent about the ones
// that left.
check("🔴 expected ירד נטו ב-1,500", before.expected - after.expected === 1500, `${before.expected} → ${after.expected}`);
check("  ...מתוכו: EY נכנסה עם 1,000", after.expected === before.expected - 2500 + 1000);
check(
  '  ...ו"בלי יריה אחת" יצאה עם 2,500',
  oldWay(SHOW_PER_EPISODE, 2500) === "priced" &&
    classifyProduction({
      production: { kind: "contract", contract_id: "c-jaffa" },
      show: SHOW_PER_EPISODE,
      showPrice: 2500,
      jobAmount: null,
    }).price === null
);
check("expectedPriced לא זז — אחת נכנסה ואחת יצאה", before.expectedPriced === after.expectedPriced, `${before.expectedPriced} → ${after.expectedPriced}`);
check("contractCount לא זז — EY יצאה, 'בלי יריה אחת' נכנסה", before.contractCount === after.contractCount, `${before.contractCount} → ${after.contractCount}`);
check("expectedPerEpisode לא זז", before.expectedPerEpisode === after.expectedPerEpisode, `${before.expectedPerEpisode} → ${after.expectedPerEpisode}`);
check("missingRateCount לא זז", before.missingRateCount === after.missingRateCount, `${before.missingRateCount} → ${after.missingRateCount}`);
check("inactiveCount לא זז", before.inactiveCount === after.inactiveCount);
check("noBillingCount לא זז", before.noBillingCount === after.noBillingCount);

// the two rows that were reclassified OUTSIDE the arithmetic, proven inert
check(
  "אילון סווּגה מחדש ל-internal — ואפס כרטיסים זזו בגללה",
  fixed.some((f) => f.id === "eilon-1") &&
    summarise([{ billing: "priced", price: 1800, internal: true, cancelled: false }]).expected === 0
);
check(
  "שורה מבוטלת שסיווגה התחלף — אפס השפעה על הסכומים",
  fixed.some((f) => f.id === "cx-1") &&
    summarise([{ billing: "priced", price: 3000, internal: false, cancelled: true }]).expected === 0
);

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. מקור יחיד — כל הצרכנים קוראים את אותו ורדיקט ===");
{
  const page = readFileSync(join(ROOT, "src/app/projects/page.tsx"), "utf8");
  const client = readFileSync(join(ROOT, "src/app/projects/ProjectsClient.tsx"), "utf8");
  const stuck = readFileSync(join(ROOT, "src/lib/projects/stuck.ts"), "utf8");
  const unified = readFileSync(join(ROOT, "src/lib/projects/unified.ts"), "utf8");

  check("אין classify( מקומי ב-page.tsx", !/function classify\s*\(/.test(page));
  check("אין resolveContractName מקומי ב-page.tsx", !page.includes("function resolveContractName"));
  check("page.tsx מייבא את הכלל", page.includes('from "@/lib/projects/classify"'));
  check("page.tsx קורא ל-classifyProduction", page.includes("classifyProduction({"));
  check("page.tsx קורא ל-contractNameFor", page.includes("contractNameFor(p, show as"));

  // the ordering that IS the fix — kind before billing_mode
  const rule = readFileSync(join(ROOT, "src/lib/projects/classify.ts"), "utf8");
  const iKind = rule.indexOf('kind === "contract"');
  const iMode = rule.indexOf('billing_mode === "none"');
  check("🔴 הכלל בודק kind לפני billing_mode", iKind > 0 && iMode > iKind, `${iKind} / ${iMode}`);
  check("אין בדיקת billing_mode === \"contract\" בכלל", !rule.includes('billing_mode === "contract"'));
  // 🔵 THE FALLBACKS ARE BACK — and the assertion is now that they EXIST and
  // that they sit BEHIND the kind gate. 8febad1 asserted their absence; the
  // owner's ruling of 6.10 reversed that, so the test reverses with it.
  check("🔵 נפילת contracts.show_id קיימת", rule.includes("c.show_id === production.show_id"));
  check("🔵 נפילת החוזה הפעיל היחיד קיימת", rule.includes('c.status === "active"'));
  const iGate = rule.indexOf('if (production.kind !== "contract") return null;');
  check("🔴 והשער קודם לשתיהן", iGate > 0 && iGate < rule.indexOf("c.show_id === production.show_id"), String(iGate));
  check(
    "  ...והוא השורה הראשונה בפונקציה, לא בדיקה אחרי נפילה",
    rule.slice(rule.indexOf("export function contractNameFor"), iGate).split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length <= 6
  );

  // and page.tsx no longer asks the show whether an episode is contract-billed
  check(
    '🔴 page.tsx אינו שואל billing_mode === "contract" עוד',
    !page.includes('billing_mode === "contract"')
  );

  // exactly ONE place computes the class; everything else reads r.billing
  const callSites = (page.match(/classifyProduction\(/g) ?? []).length;
  check("classifyProduction נקראת פעם אחת בלבד", callSites === 1, String(callSites));
  check("unified.ts קורא את billing מהשורה, לא מחשב", unified.includes("billing: p.billing") && !unified.includes("billing_mode"));
  check("ProjectsClient קורא את billing מהשורה", client.includes("r.billing as BillingClass | null") && !client.includes("billing_mode ==="));

  // the vocabulary has one home and every consumer covers all of it
  check("BillingClass מוגדר ב-classify.ts", /export type BillingClass/.test(rule));
  check("ProjectsClient מייצא אותו מחדש ואינו מגדיר מחדש", client.includes("export type { BillingClass }") && !/export type BillingClass =/.test(client));
  for (const label of ["NO_PRICE_LABEL", "NO_PRICE_NOTE"]) {
    const body = client.slice(client.indexOf(`const ${label}`), client.indexOf("};", client.indexOf(`const ${label}`)));
    check(`${label} מכסה גם internal`, /\binternal:/.test(body));
  }
  check("stuck.ts מכיר את internal בשתי החתימות", (stuck.match(/\| "internal";/g) ?? []).length === 2);
  check("stuck.ts נשאר בלי imports", stuck.split("\n").filter((l) => /^\s*import\b/.test(l)).length === 0);

  // the rule module stays pure
  const imports = rule.split("\n").filter((l) => /^\s*import\b/.test(l));
  check("classify.ts אינו מייבא דבר", imports.length === 0, imports.join(" | "));
  for (const w of ["fetch(", "createClient", "process.env", "Date.now", "new Date("]) {
    check(`classify.ts אפס ${w}`, !rule.includes(w));
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 5. אכיפת קריאה-בלבד ===");
/**
 * The ticket's hard constraint: תצוגה בלבד — zero writes, zero change to
 * document paths, jobs or triggers, and no migration. Enforced by reading the
 * TEXT of what the change actually did, so the constraint cannot be satisfied
 * by intent alone.
 *
 * 🔴 THIS SECTION WAS PINNED TO TWO COMMITS ON 2026-10-06, AND THE REF IT USED
 * TO ASK WAS THE BUG.
 *
 * It ran `git diff --name-only origin/main`, which was true for exactly as long
 * as HEAD was the branch carrying the fix. The moment the fix was merged and
 * HEAD moved on to unrelated work (stage 3ג-1), the same question returned 3ג-1's
 * 24 files — and the section reported 26 failures saying things like
 * "src/lib/booking/title.ts is not in the allowed list". Which is true, and
 * about nothing: `title.ts` was never in this change's scope, and this suite has
 * no business judging it.
 *
 * ⚠️ IT ALSO INFLATED THE COUNT, AND THAT IS THE QUIETER HALF OF THE BUG. The
 * per-file loop below runs once per changed file, so the suite's TOTAL moved
 * with whatever HEAD happened to carry — 118 checks on the fix branch, 136 once
 * 3ג-1 was on top. A test whose denominator depends on unrelated commits cannot
 * be read as a number at all.
 *
 * THE FIX: ask about the two commits this section was written to police, by
 * their own hashes, and never about a moving ref. The range is immutable, so
 * the answer is the same on every branch, on every machine, forever.
 *
 * Note for whoever extends this: the other three suites born in the same week
 * (test_accrual_counter, test_projects_unified, test_contract_quota) enforce the
 * same kind of constraint by `readFileSync` on the SHIPPED FILES, with no git at
 * all — and none of them went stale. That is the better default. The git range
 * survives here only because this section asks something file text cannot: what
 * the change ADDED, as opposed to what the file now holds.
 *
 * `git diff` is a local read. No network, no database.
 */
{
  /**
   * The two commits this section polices, and the base they were built on.
   *
   *   23feaca  origin/main at the time — the parent of the first fix commit
   *   8febad1  classify by the production's snapshot (the first commit)
   *   9258124  restore the contract-name fallbacks behind a kind gate (the second)
   *
   * BASE..TIP is therefore exactly the two-commit change, with no third party in
   * it. Hashes and not refs: a ref is a question about today.
   */
  const BASE = "23feaca";
  const TIP = "9258124";
  const EXPECTED_COMMITS = 2;

  /**
   * Does this clone actually hold the range? A shallow clone (CI with
   * `fetch-depth: 1`) holds neither commit, and a `git diff` against a missing
   * object throws.
   *
   * 🔴 A MISSING RANGE SKIPS LOUDLY — it does not pass, and it does not fail.
   * Passing silently would turn the whole section into decoration the day CI
   * clones shallow; failing would paint an unrelated branch red for a condition
   * that says nothing about the code. So it prints what is missing and what was
   * therefore NOT checked, and `skipped` is reported in the final line so the
   * number can never be mistaken for a clean run.
   */
  const have = (rev: string) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const ancestor = (a: string, b: string) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: ROOT, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  const missing = [BASE, TIP].filter((r) => !have(r));
  if (missing.length) {
    skipped = true;
    console.log(`  ⏭️  הודלג — הטווח אינו ב-clone הזה: ${missing.join(", ")} חסר${missing.length > 1 ? "ים" : ""}.`);
    console.log("     (clone רדוד? הריצו git fetch --unshallow)");
    console.log("     לא נבדקו: רשימת הקבצים המותרת, היעדר מיגרציה, ופועלי כתיבה בשורות שנוספו.");
    console.log("     הבדיקות שקוראות את הקבצים עצמם כן רצו — ראו למטה.");
  } else {
    // the range is real, and it is the range we think it is
    check(`הטווח תקין: ${BASE} הוא אב של ${TIP}`, ancestor(BASE, TIP));
    const range = execFileSync("git", ["rev-list", "--count", `${BASE}..${TIP}`], { cwd: ROOT, encoding: "utf8" }).trim();
    check(
      `והוא מכיל בדיוק ${EXPECTED_COMMITS} קומיטים — ולא עבודה של מישהו אחר`,
      range === String(EXPECTED_COMMITS),
      range
    );

    const changed = execFileSync("git", ["diff", "--name-only", BASE, TIP], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    console.log(`  קבצים ששונו ב-${BASE}..${TIP}: ${changed.join(", ") || "(none)"}`);

    const ALLOWED = [
      "src/app/projects/page.tsx",
      "src/app/projects/ProjectsClient.tsx",
      "src/lib/projects/classify.ts",
      "src/lib/projects/stuck.ts",
      "scripts/test_projects_classify.ts",
      "scripts/test_projects_classify_render.tsx",
    ];
    // ⚠️ the denominator is now FIXED, because `changed` is fixed: six files,
    // the same six on every branch. The loop can no longer grow with HEAD.
    check(`הטווח נוגע ב-${ALLOWED.length} קבצים בלבד`, changed.length === ALLOWED.length, String(changed.length));
    for (const f of changed) {
      check(`${f} נמצא ברשימת הקבצים המותרת`, ALLOWED.includes(f));
    }
    check("⛔ אין מיגרציה", !changed.some((f) => f.startsWith("supabase/")), changed.filter((f) => f.startsWith("supabase/")).join(","));
    check("⛔ אין שינוי בנתיבי מסמכים", !changed.some((f) => f.startsWith("src/lib/documents/")));
    check("⛔ אין שינוי ב-API routes", !changed.some((f) => f.startsWith("src/app/api/")));
    check("⛔ אין שינוי בטריגרים או בסקריפטים חיים", !changed.some((f) => f.startsWith("scripts/") && !f.startsWith("scripts/test_projects_classify")));

    // the added lines themselves: no write verb, no RPC, no fetch
    const added = execFileSync("git", ["diff", "--unified=0", BASE, TIP, "--", ...ALLOWED.slice(0, 4)], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n");
    check("הדיף אינו ריק — יש שורות שנוספו לבדוק", added.length > 0, String(added.length));
    for (const verb of [".insert(", ".upsert(", ".update(", ".delete(", ".rpc(", "fetch(", "revalidate"]) {
      check(`⛔ אף שורה שנוספה בטווח אינה מכילה ${verb}`, !added.includes(verb), verb);
    }
  }

  /**
   * AND THE SHIPPED FILES, UNCONDITIONALLY.
   *
   * Outside the range guard on purpose: this half asks "what does the file hold
   * NOW", which needs no git and therefore cannot be skipped. It is the half
   * that still protects the constraint on a shallow clone, and it is the pattern
   * the three sibling suites use throughout.
   */
  for (const f of [
    "src/app/projects/page.tsx",
    "src/app/projects/ProjectsClient.tsx",
    "src/lib/projects/classify.ts",
    "src/lib/projects/stuck.ts",
  ]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const verb of [".insert(", ".upsert(", ".update(", ".delete("]) {
      check(`${f} אפס ${verb}`, !text.includes(verb));
    }
  }
}

console.log(
  `\n${failures === 0 ? (skipped ? "⚠️" : "✅") : "❌"}  ${checks - failures}/${checks}` +
    (skipped ? "  · סעיף אחד הודלג (ראו למעלה)" : "")
);
process.exit(failures === 0 ? 0 : 1);
