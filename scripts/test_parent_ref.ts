/**
 * parentRef.ts verification — READ ONLY, and it never reaches Morning.
 *
 * Run:  MORNING_DRY_RUN=true npx tsx scripts/test_parent_ref.ts
 *
 * Writes NOTHING: the only functions called are `buildParentRef` (pure) and
 * `resolveWorkOrdersForJobs` (three SELECTs per job). `recordParentRefusal` is
 * deliberately NOT called — the refusal event belongs to a real refusal, not to
 * a test that merely asks what one would say.
 *
 * Part A proves the three migrated builders produce a byte-identical parent
 * reference to the expression each of them carried before, by running the OLD
 * expression and the NEW one side by side on live rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildParentRef, resolveWorkOrdersForJobs, refusalMessage } from "../src/lib/documents/parentRef";
import { sourceRemark, MORNING_DOC_CODE, DOC_TYPE_TO_MORNING_CODE } from "../src/lib/morning/types";
import { isDryRun } from "../src/lib/morning/client";

for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  const k = t.slice(0, i).trim();
  if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// Rule 40, asserted rather than assumed: this script must never run in a
// context that could reach Morning. It does not call createDocument at all,
// but the flag is checked anyway so a future edit cannot quietly make it able.
console.log(`MORNING_DRY_RUN → isDryRun() = ${isDryRun()}${isDryRun() ? "" : "   ⚠️  refusing"}`);
if (!isDryRun()) {
  console.error("refusing to run outside dry-run (rule 40)");
  process.exit(1);
}

type Row = { morning_doc_id: string | null; morning_doc_number: string | null };
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

(async () => {
  // ═══ A. bit-identical output for the three migrated builders ═══════════
  console.log("\n═══ A. before/after on live rows (must be identical) ═══");

  const cases: { name: string; ids: string[]; child: "deal_invoice" | "tax_receipt" | "receipt"; parentCode: number }[] = [
    { name: "bundle.ts        100→300", ids: ["10303", "10304", "10305"], child: "deal_invoice", parentCode: MORNING_DOC_CODE.order },
    { name: "taxFromParent.ts 300→320", ids: ["40309", "40313", "40315"], child: "tax_receipt", parentCode: DOC_TYPE_TO_MORNING_CODE["deal_invoice"] },
    { name: "receiptFrom…     305→400", ids: ["50068"], child: "receipt", parentCode: DOC_TYPE_TO_MORNING_CODE["tax_invoice"] },
  ];

  for (const c of cases) {
    const { data } = await admin
      .from("documents")
      .select("morning_doc_id,morning_doc_number")
      .in("morning_doc_number", c.ids);
    // preserve the caller's own order, which is what the old code did
    const rows = c.ids
      .map((n) => (data ?? []).find((d) => String(d.morning_doc_number) === n))
      .filter(Boolean) as Row[];
    if (rows.length !== c.ids.length) {
      check(c.name, false, `only ${rows.length}/${c.ids.length} rows found`);
      continue;
    }

    // ---- exactly what each file used to compute ----
    const oldIds = rows.map((r) => r.morning_doc_id as string);
    const oldNumbers = rows.map((r) => String(r.morning_doc_number));
    const oldRemark = sourceRemark(c.child, c.parentCode, oldNumbers);

    // ---- what it computes now ----
    const ref = buildParentRef({
      childType: c.child,
      parentCode: c.parentCode,
      parents: rows.map((r) => ({
        morning_doc_id: r.morning_doc_id as string,
        morning_doc_number: r.morning_doc_number,
      })),
    });

    const same = eq(oldIds, ref.linkedDocumentIds) && oldRemark === ref.remarks && eq(oldNumbers, ref.parentNumbers);
    check(c.name, same, same ? `remarks: "${ref.remarks}"` : `OLD=${oldRemark} NEW=${ref.remarks}`);
  }

  // ═══ B. the payloads each route would send ════════════════════════════
  console.log("\n═══ B. payload fragments (what would reach Morning) ═══");

  // --- B1: converting TWO work orders (the multi-parent case) ---
  const { data: two } = await admin
    .from("documents")
    .select("morning_doc_id,morning_doc_number")
    .in("morning_doc_number", ["10303", "10304"]);
  const twoRows = ["10303", "10304"]
    .map((n) => (two ?? []).find((d) => String(d.morning_doc_number) === n))
    .filter(Boolean) as Row[];
  const twoRef = buildParentRef({
    childType: "deal_invoice",
    parentCode: MORNING_DOC_CODE.order,
    parents: twoRows.map((r) => ({ morning_doc_id: r.morning_doc_id as string, morning_doc_number: r.morning_doc_number })),
  });
  console.log("\n  B1 · registry conversion, two orders:");
  console.log("     linkedDocumentIds:", JSON.stringify(twoRef.linkedDocumentIds));
  console.log("     remarks:", JSON.stringify(twoRef.remarks));
  check("two parents both linked", twoRef.linkedDocumentIds.length === 2);
  check("remarks names both", (twoRef.remarks ?? "").includes("10303") && (twoRef.remarks ?? "").includes("10304"));

  // --- B2: /finance bundle, every job resolvable ---
  const GOOD = ["3a8ba213-0a5b-4b0e-8f6e-8f7d64e9f6bb"]; // placeholder, resolved below
  const { data: omerJobs } = await admin
    .from("jobs")
    .select("id,campaign,date")
    .in("id", await (async () => {
      const { data } = await admin
        .from("pending_documents")
        .select("job_id")
        .in("morning_doc_number", ["10303", "10304", "10305"]);
      return (data ?? []).map((r) => r.job_id as string).filter(Boolean);
    })());
  const goodIds = (omerJobs ?? []).map((j) => j.id as string);
  void GOOD;
  console.log(`\n  B2 · /finance bundle, ${goodIds.length} jobs of עומר חן:`);
  const okRes = await resolveWorkOrdersForJobs(admin, goodIds);
  check("resolves", okRes.ok, okRes.ok ? `${okRes.workOrderIds.length} orders` : JSON.stringify(okRes.failures));

  // --- B3: /finance bundle with a job whose order is not issued ---
  const NO_ORDER = "f78be4bb-22a5-411d-a65e-0b9f6162dd45"; // ידידיה 16.9 — order still 'pending'
  console.log("\n  B3 · /finance bundle including a job with no ISSUED order:");
  const badRes = await resolveWorkOrdersForJobs(admin, [...goodIds, NO_ORDER]);
  check("refuses the whole set", !badRes.ok);
  if (!badRes.ok) {
    console.log("\n" + refusalMessage(badRes.failures, goodIds.length + 1).split("\n").map((l) => "     " + l).join("\n"));
  }

  // --- B4: a consolidated (partially covered) order ---
  // חתונמיות 13.8 — its own order was folded into consolidated order 10323,
  // so a deal invoice for this job alone would cover one of 10323's four jobs.
  const CONSOLIDATED_JOB = "06d03050-7256-4a2c-8a35-680a6e504b12";
  const { data: cj } = await admin.from("jobs").select("id").eq("id", CONSOLIDATED_JOB).maybeSingle();
  console.log("\n  B4 · job whose order was folded into a consolidated one (10323):");
  if (cj) {
    const consRes = await resolveWorkOrdersForJobs(admin, [cj.id as string]);
    check("refuses", !consRes.ok);
    if (!consRes.ok) check("reason is the consolidation gate", consRes.failures[0].skip_reason === "work_order_consolidated", consRes.failures[0].skip_reason);
    if (!consRes.ok) console.log("\n" + refusalMessage(consRes.failures, 1).split("\n").map((l) => "     " + l).join("\n"));
  } else {
    check("fixture found", false, "job not found");
  }

  // --- B5: the queue path (issue.ts) — remarks now present ---
  console.log("\n  B5 · queue issuance (issue.ts), the 40321 shape:");
  const { data: wo } = await admin
    .from("pending_documents")
    .select("morning_doc_id,morning_doc_number")
    .eq("morning_doc_number", "10332")
    .maybeSingle();
  if (wo?.morning_doc_id) {
    const ref = buildParentRef({
      childType: "deal_invoice",
      parentCode: MORNING_DOC_CODE.order,
      parents: [{ morning_doc_id: wo.morning_doc_id as string, morning_doc_number: wo.morning_doc_number }],
    });
    console.log("     linkedDocumentIds:", JSON.stringify(ref.linkedDocumentIds));
    console.log("     remarks:", JSON.stringify(ref.remarks));
    check("remarks present (was missing on 40321)", !!ref.remarks);
    check("wording matches the registry path", ref.remarks === `חשבון עסקה עבור הזמנה ${wo.morning_doc_number}`);
  } else {
    check("fixture found", false);
  }

  console.log(`\n═══ ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ═══`);
  process.exit(failures === 0 ? 0 : 1);
})();
