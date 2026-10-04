/**
 * Bundling PULLED deal invoices into one tax document (owner 2026-10-04).
 *
 * Run:  npx tsx scripts/test_tax_bundle_pulled.ts
 *
 * NO DATABASE, NO SERVER, NO NETWORK — there is no Supabase client in this
 * file, and F19 is why that matters: the case this exists for is כפיר ארביב
 * אחזקות 40283 + 40289, two live documents carrying real money, and nothing
 * here may touch them. Everything below is the pure selection module, the pure
 * pull mapper, and two STATIC READS of files.
 *
 * ═══ WHY TWO SOURCE READS ARE TESTS HERE ═══
 * Two of the owner's requirements are properties of the CODE, not of any return
 * value: the route must no longer cap `documentIds` at one, and it must refuse
 * an over-ceiling member of a bundle with the approved sentence. The route is
 * DB-coupled (createAdminClient at module scope of its call path), so invoking
 * it would mean a database. Reading it is honest and cannot be satisfied by
 * accident.
 *
 * ═══ WHAT IS *NOT* TESTED HERE, AND SHOULD BE READ AS SUCH ═══
 * `createTaxFromParents`' own gates — the same-client gate included — take a
 * SupabaseClient and are not reachable without one. The same-client case below
 * tests the two things that ARE pure: that the mapper gives each pulled source
 * its Morning client id, and that the gate's exact expression
 * (`new Set(ids).size !== 1`) separates the two documents. The gate itself was
 * verified by reading taxFromParent.ts:381-389 and is unchanged by this work.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleNet,
  bundleRequestBody,
  dealSelectable,
  doorOf,
  isMixedSelection,
  sumSourceNet,
  taxSelectable,
  type SelectableRow,
} from "../src/lib/documents/registrySelection";
import { PULL_NET_CEILING, mapPullDocToSource, type PullDocRow } from "../src/lib/documents/pullSource";
import { MORNING_DOC_CODE, TAX_BUNDLE_NOTICE } from "../src/lib/morning/types";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── the rows, as the registry builds them ──────────────────────────────────
// A PULLED deal invoice: no queue row, so buildable 'raw', pending_id null,
// and the mapper's proven NET in net_amount. 40283/40289 are ₪590 gross = ₪500.
const raw = (over: Partial<SelectableRow> = {}): SelectableRow => ({
  id: "doc-40283",
  status: 0,
  buildable: "raw",
  pending_id: null,
  pending_amount: null,
  net_amount: 500,
  over_ceiling: null,
  child_actions: ["tax"],
  ...over,
});
// An APP-ISSUED deal invoice: a queue row exists, so buildable 'pending' and
// the net lives on pending_amount. This is the ידידיה shape.
const pending = (over: Partial<SelectableRow> = {}): SelectableRow => ({
  id: "doc-40301",
  status: 0,
  buildable: "pending",
  pending_id: "pd-40301",
  pending_amount: 500,
  net_amount: null,
  over_ceiling: null,
  child_actions: ["tax"],
  ...over,
});

console.log("\n── two pulled rows: the כפיר ארביב case ──");

const kfir = [raw({ id: "doc-40283" }), raw({ id: "doc-40289" })];

check(
  "both are selectable",
  kfir.every((r) => taxSelectable(r, true)),
  `${kfir.filter((r) => taxSelectable(r, true)).length}/2`
);

check("the selection is homogeneous", !isMixedSelection(kfir));
check("both go through the raw door", kfir.every((r) => doorOf(r) === "raw"));

check(
  "the request body is documentIds of length 2 — and no sourceIds at all",
  (() => {
    const b = bundleRequestBody(kfir) as { documentIds?: string[]; sourceIds?: string[] };
    return (
      Array.isArray(b.documentIds) &&
      b.documentIds.length === 2 &&
      b.documentIds[0] === "doc-40283" &&
      b.documentIds[1] === "doc-40289" &&
      b.sourceIds === undefined
    );
  })(),
  JSON.stringify(bundleRequestBody(kfir))
);

check("the bar's total is the two proven nets, ₪1,000", sumSourceNet(kfir) === 1000);
check("a pulled row's net comes from net_amount", bundleNet(kfir[0]) === 500);

console.log("\n── two queue rows: the ידידיה path, unchanged (regression) ──");

const yedidya = [pending({ id: "doc-a", pending_id: "pd-a" }), pending({ id: "doc-b", pending_id: "pd-b" })];

check("both are selectable", yedidya.every((r) => taxSelectable(r, true)));
check("the selection is homogeneous", !isMixedSelection(yedidya));

check(
  "the request body is sourceIds of the PENDING ids — not the row ids",
  (() => {
    const b = bundleRequestBody(yedidya) as { documentIds?: string[]; sourceIds?: (string | null)[] };
    return (
      Array.isArray(b.sourceIds) &&
      b.sourceIds.length === 2 &&
      b.sourceIds[0] === "pd-a" &&
      b.sourceIds[1] === "pd-b" &&
      b.documentIds === undefined
    );
  })(),
  JSON.stringify(bundleRequestBody(yedidya))
);

check("a queue row's net comes from pending_amount", bundleNet(yedidya[0]) === 500);
check("the bar's total is ₪1,000 here too", sumSourceNet(yedidya) === 1000);

check(
  "one queue row alone still sends the same single-element array it always did",
  (() => {
    const b = bundleRequestBody([yedidya[0]]) as { sourceIds?: (string | null)[] };
    return b.sourceIds?.length === 1 && b.sourceIds[0] === "pd-a";
  })()
);

console.log("\n── a mixed selection ──");

const mixed = [raw(), pending()];

check("each row is selectable on its own", mixed.every((r) => taxSelectable(r, true)));
check("but the SET is refused as mixed", isMixedSelection(mixed));
check("the two rows answer different doors", doorOf(mixed[0]) !== doorOf(mixed[1]));
check(
  "order does not matter",
  isMixedSelection([pending(), raw()]) && isMixedSelection([raw(), pending(), raw()])
);
check("a single row is never mixed", !isMixedSelection([raw()]) && !isMixedSelection([pending()]));
check("an empty selection is never mixed", !isMixedSelection([]));

console.log("\n── the ceiling: out of bundles, single-row path untouched ──");

const big = raw({ id: "doc-big", net_amount: 42000, over_ceiling: { net: 42000, ceiling: PULL_NET_CEILING } });

check("an over-ceiling pulled row gets NO checkbox", !taxSelectable(big, true));
check(
  "so it can never be in a selection beside another row",
  [raw(), big].filter((r) => taxSelectable(r, true)).length === 1
);
check(
  "and the ceiling is the ONLY thing stopping it — clear the flag and it is selectable again",
  taxSelectable(raw({ id: "doc-big", net_amount: 42000 }), true)
);

console.log("\n── the rest of taxSelectable, unchanged ──");

check("no permission → not selectable", !taxSelectable(raw(), false));
check("a closed parent (status 1) → not selectable", !taxSelectable(raw({ status: 1 }), true));
check("a manually closed parent (status 2) → not selectable", !taxSelectable(raw({ status: 2 }), true));
check("an unrecognised status fails safe → not selectable", !taxSelectable(raw({ status: 4 }), true));
check("never pulled (status null) → selectable, flagged by the server", taxSelectable(raw({ status: null }), true));
check("no tax child in the allow-list → not selectable", !taxSelectable(raw({ child_actions: [] }), true));
check(
  "buildable null (neither door) → not selectable",
  !taxSelectable(raw({ buildable: null }), true)
);
check(
  "a pending row with no pending_id → not selectable (it has nothing to send)",
  !taxSelectable(pending({ pending_id: null }), true)
);

console.log("\n── the deal door is untouched by any of this ──");

const order = (over: Partial<SelectableRow> = {}): SelectableRow => ({
  id: "doc-10311",
  status: 0,
  buildable: null, // a work order with no job stamped offers no tax child
  pending_id: "pd-10311",
  pending_amount: 1000,
  net_amount: null,
  over_ceiling: null,
  child_actions: ["deal_invoice"],
  ...over,
});

check("a work order with buildable null is still deal-selectable", dealSelectable(order(), true));
check("it is NOT tax-selectable", !taxSelectable(order(), true));
check("one with a live deal child is not selectable", !dealSelectable(order({ has_live_deal_child: true }), true));
check("work orders all answer the pending door", doorOf(order()) === "pending");
check("two of them are therefore never mixed", !isMixedSelection([order(), order({ id: "x" })]));

console.log("\n── the same-client gate, over the PURE mapper ──");

// The three arithmetic layers of mapPullIncome all have to be satisfiable, so
// the fixture carries every field a REAL Morning raw carries: the line proves
// price×quantity+vat = amountTotal, raw.amountExcludeVat is the independent
// derivation of the net, and raw.amount is the gross both sides must agree on.
// Built from the NET so the numbers are exact — 40283 is ₪500 + ₪90 = ₪590.
const rawDoc = (id: string, morningClientId: string, net: number): PullDocRow => {
  const vat = Math.round(net * 0.18 * 100) / 100;
  const gross = Math.round((net + vat) * 100) / 100;
  return {
    id,
    morning_doc_id: `m-${id}`,
    morning_doc_number: id.replace("doc-", ""),
    type: MORNING_DOC_CODE.deal_invoice,
    source: "pull",
    client_id: `local-${morningClientId}`,
    job_id: `job-${id}`,
    amount: gross,
    cancelled_at: null,
    archived_at: null,
    raw: {
      client: { id: morningClientId },
      vatType: 0,
      currency: "ILS",
      ref: [MORNING_DOC_CODE.tax_invoice, MORNING_DOC_CODE.tax_receipt],
      amount: gross,
      amountExcludeVat: net,
      vat,
      income: [
        {
          description: "פרק",
          quantity: 1,
          price: net,
          vat,
          amountTotal: gross,
          currency: "ILS",
          vatType: 0,
        },
      ],
    },
  } as unknown as PullDocRow;
};

const mapped = ["doc-40283", "doc-40289"].map((id) =>
  mapPullDocToSource(rawDoc(id, "kfir-morning", 500), MORNING_DOC_CODE.tax_invoice)
);

check(
  "both of כפיר's documents map cleanly",
  mapped.every((m) => m.ok),
  mapped.map((m) => (m.ok ? "ok" : m.error)).join(" · ")
);

check(
  "each carries the SAME Morning client id, so the builder's gate sees one client",
  (() => {
    if (!mapped.every((m) => m.ok)) return false;
    const ids = new Set(mapped.map((m) => (m.ok ? m.source.morning_client_id : null)));
    return ids.size === 1; // taxFromParent.ts:381-385's exact expression
  })()
);

check(
  "two documents of DIFFERENT clients give the gate two ids — it would refuse",
  (() => {
    const a = mapPullDocToSource(rawDoc("doc-1", "kfir-morning", 500), MORNING_DOC_CODE.tax_invoice);
    const b = mapPullDocToSource(rawDoc("doc-2", "other-morning", 500), MORNING_DOC_CODE.tax_invoice);
    if (!a.ok || !b.ok) return false;
    return new Set([a.source.morning_client_id, b.source.morning_client_id]).size !== 1;
  })()
);

check(
  "the mapper proves the NET rather than trusting the gross: 590 → 500",
  (() => {
    const m = mapPullDocToSource(rawDoc("doc-40283", "kfir-morning", 500), MORNING_DOC_CODE.tax_invoice);
    return m.ok && m.source.amount === 500;
  })()
);

check(
  "a document above the ceiling is refused by the mapper, with overCeiling on the refusal",
  (() => {
    const m = mapPullDocToSource(
      rawDoc("doc-big", "kfir-morning", PULL_NET_CEILING + 1000),
      MORNING_DOC_CODE.tax_invoice
    );
    return !m.ok && !!m.overCeiling && m.overCeiling.ceiling === PULL_NET_CEILING;
  })()
);

console.log("\n── the route, read as text ──");

const routeSrc = readFileSync(join(process.cwd(), "src/app/api/documents/tax/route.ts"), "utf8");
const routeCode = routeSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

check(
  "the one-document cap is gone",
  !routeCode.includes("מסמך נמשך אחד לבקשה") &&
    !/documentIds\.length\s*>\s*1\s*\)\s*\{\s*return NextResponse\.json\(\s*\{\s*error:\s*"מסמך/.test(routeCode)
);

check(
  "documentIds of length ≥1 reaches the builder",
  /createTaxFromParents\(admin, sourceIds, user\.id, undefined, \{\s*\.\.\.\(documentIds\.length \? \{ documentIds \} : \{\}\),/.test(
    routeCode
  )
);

check(
  "an over-ceiling member of a bundle is refused with the approved sentence",
  /probe\.overCeiling && documentIds\.length > 1/.test(routeCode) &&
    routeCode.includes("TAX_BUNDLE_NOTICE.over_ceiling_in_bundle")
);

check(
  "that refusal comes BEFORE the generic over-ceiling handling",
  routeCode.indexOf("documentIds.length > 1") <
    routeCode.indexOf("if (!probe.ok && !(probe.overCeiling && mayOverride))")
);

check(
  "an admin override is refused on a bundle, so the ticket is never bound to an arbitrary member",
  (() => {
    const block = routeCode.slice(
      routeCode.indexOf("mayOverride = true") - 1500,
      routeCode.indexOf("mayOverride = true")
    );
    return /documentIds\.length > 1/.test(block);
  })()
);

check("the two-door mixture is still refused", routeCode.includes("sourceIds.length && documentIds.length"));

check(
  "the approved sentences are imported, not retyped",
  routeSrc.includes('from "@/lib/morning/types"') &&
    !routeSrc.includes("אחד המסמכים מעל תקרת הסכום ולכן לא נכנס לאיגוד")
);

console.log("\n── the ceiling overwrite in fetchPullSources (the defused mine) ──");

const pullSrc = readFileSync(join(process.cwd(), "src/lib/documents/pullSource.ts"), "utf8");
const pullCode = pullSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

check(
  "a second over-ceiling source in one request is refused, never silently overwritten",
  /if \(overCeiling\) \{\s*return \{/.test(pullCode)
);

console.log("\n── the approved copy ──");

check(
  "mixed_sources is the owner's sentence",
  TAX_BUNDLE_NOTICE.mixed_sources ===
    "אי אפשר לאגד יחד מסמכים שהונפקו במערכת ומסמכים שנוצרו במורנינג. סמנו רק סוג אחד."
);
check(
  "over_ceiling_in_bundle is the owner's sentence",
  TAX_BUNDLE_NOTICE.over_ceiling_in_bundle ===
    "אחד המסמכים מעל תקרת הסכום ולכן לא נכנס לאיגוד. הוציאו אותו בנפרד."
);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
