/**
 * The September redemption, simulated — before it can happen.
 *
 * Run:  npx tsx scripts/simulate_bundle.ts
 * Reads nothing, writes nothing. Pure in-memory exercise of
 * resolveProductionDocuments against hand-built rows.
 *
 * ═══ WHY THIS EXISTS ═══
 * The bundle route in forProduction.ts matches ZERO live rows today, because no
 * accrued client has been redeemed yet. The moment one is — חתונמיות with 5
 * episodes, ברק with 4 — a single deal invoice will have to appear on five
 * separate production rows, each tagged "מאוגד", and be counted ONCE in the
 * month's total. There is no live row that can prove that works, so the shape
 * is reconstructed here from the two files that actually write it:
 *
 *   bundle.ts:176/468/549  the consolidated queue row is built with
 *                          production_id: null and bundle_job_ids: [the N jobs]
 *   issue.ts:302           primaryJobId = bundleJobs.length === 1
 *                                           ? bundleJobs[0] : null
 *                          → a 5-job bundle is written with job_id NULL
 *   issue.ts:319-335       the registry row copies production_id (null) and
 *                          bundle_job_ids from the queue row
 *   issue.ts:~440          the SAME invoice_biz is stamped on all N jobs
 *
 * So for a real bundle: production_id null, job_id null. Routes 1 and 2 are
 * both dead and route 3 is the only thing holding the invoice to its episodes.
 * That is the claim under test.
 */
import {
  resolveProductionDocuments,
  distinctDocuments,
  type DocumentRow,
} from "../src/lib/documents/forProduction";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const doc = (over: Partial<DocumentRow> & { id: string; type: number }): DocumentRow => ({
  morning_doc_id: `m-${over.id}`,
  morning_doc_number: null,
  amount: null,
  document_date: null,
  pdf_url: null,
  production_id: null,
  job_id: null,
  bundle_job_ids: null,
  cancelled_at: null,
  archived_at: null,
  ...over,
});

// ── the scenario: 5 episodes, 5 jobs, ONE deal invoice ────────────────────
const prodIds = ["p1", "p2", "p3", "p4", "p5"];
const jobIds = ["j1", "j2", "j3", "j4", "j5"];
const jobLinks = prodIds.map((p, i) => ({ job_id: jobIds[i], production_id: p }));

// every job carries the same invoice_biz — issue.ts stamps the bundle number
// on all N of them, which is what lets one payment close them all
const jobs = jobIds.map((id) => ({ id, invoice_biz: "40301", invoice_tax: null }));

const bundleInvoice = doc({
  id: "d-bundle",
  type: 300,
  morning_doc_number: "40301",
  morning_doc_id: "m-40301",
  amount: 15000,
  document_date: "2026-09-03",
  production_id: null, // bundle.ts:468 — consolidated row has no production
  job_id: null, // issue.ts:302 — 5 jobs ⇒ primaryJobId is null
  bundle_job_ids: [...jobIds],
});

// plus one per-episode work order, so precedence is exercised alongside it
const workOrders = prodIds.map((p, i) =>
  doc({
    id: `d-wo-${i + 1}`,
    type: 100,
    morning_doc_number: `801${i + 1}`,
    morning_doc_id: `m-wo-${i + 1}`,
    production_id: p,
    document_date: "2026-08-30",
    amount: 3000,
  })
);

console.log("\n=== 1. a 5-episode bundle reaches all five productions ===");
const resolved = resolveProductionDocuments({
  productionIds: prodIds,
  jobLinks,
  jobs,
  documents: [bundleInvoice, ...workOrders],
});

const holders = prodIds.filter((p) => (resolved.get(p) ?? []).some((r) => r.id === "d-bundle"));
check("all 5 production rows show the bundled invoice", holders.length === 5, `${holders.length}/5`);

const paths = new Set(
  prodIds.flatMap((p) => (resolved.get(p) ?? []).filter((r) => r.id === "d-bundle").map((r) => r.path))
);
check("reached via the bundle route (not production/job)", paths.size === 1 && paths.has("bundle"), Array.from(paths).join(","));

const allShared = prodIds.every(
  (p) => (resolved.get(p) ?? []).find((r) => r.id === "d-bundle")?.shared === true
);
check('tagged "מאוגד" on every row', allShared);

const woNotShared = prodIds.every(
  (p) => (resolved.get(p) ?? []).find((r) => r.type === 100)?.shared === false
);
check("the per-episode work orders are NOT tagged bundled", woNotShared);

console.log("\n=== 2. the summary counts it once ===");
const distinct = distinctDocuments(resolved);
const naive = prodIds.flatMap((p) => resolved.get(p) ?? []).filter((r) => r.type === 300);
const naiveSum = naive.reduce((t, r) => t + (r.amount ?? 0), 0);
const correctSum = Array.from(distinct.values()).filter((r) => r.type === 300).reduce((t, r) => t + (r.amount ?? 0), 0);
check("distinct total is 15,000", correctSum === 15000, `got ${correctSum}`);
check("the naive row-walk would have said 75,000", naiveSum === 75000, `got ${naiveSum}`);
check("distinct map holds 6 documents (1 bundle + 5 orders)", distinct.size === 6, `got ${distinct.size}`);

console.log("\n=== 3. route 4 (shared invoice_biz) carries it alone ===");
// same scenario with bundle_job_ids stripped — a bundle issued before 0044, or
// a registry row whose array never got written. The number route must hold it.
const noArray = { ...bundleInvoice, bundle_job_ids: null };
const viaNumber = resolveProductionDocuments({
  productionIds: prodIds,
  jobLinks,
  jobs,
  documents: [noArray, ...workOrders],
});
const numHolders = prodIds.filter((p) => (viaNumber.get(p) ?? []).some((r) => r.id === "d-bundle"));
check("still reaches all 5 via invoice_biz → morning_doc_number", numHolders.length === 5, `${numHolders.length}/5`);
const numPath = (viaNumber.get("p3") ?? []).find((r) => r.id === "d-bundle")?.path;
check('route recorded as "number"', numPath === "number", String(numPath));
const stillShared = prodIds.every((p) => (viaNumber.get(p) ?? []).find((r) => r.id === "d-bundle")?.shared);
check('still tagged "מאוגד"', !!stillShared);

console.log("\n=== 4. precedence: strongest evidence wins ===");
// the same document reachable three ways at once must report the strongest
const overlap = doc({
  id: "d-multi",
  type: 305,
  morning_doc_number: "50099",
  morning_doc_id: "m-50099",
  production_id: "p1",
  job_id: "j1",
  bundle_job_ids: ["j1"],
});
const prec = resolveProductionDocuments({
  productionIds: ["p1"],
  jobLinks: [{ job_id: "j1", production_id: "p1" }],
  jobs: [{ id: "j1", invoice_biz: null, invoice_tax: "50099" }],
  documents: [overlap],
});
check('production_id beats job/bundle/number', prec.get("p1")?.[0]?.path === "production", String(prec.get("p1")?.[0]?.path));
check("and appears exactly once", (prec.get("p1") ?? []).length === 1, `${(prec.get("p1") ?? []).length}`);

console.log("\n=== 5. the receipt walk: 400 → 305 → job → production ===");
const taxInvoice = doc({
  id: "d-305",
  type: 305,
  morning_doc_id: "m-50068",
  morning_doc_number: "50068",
  job_id: "j1",
  document_date: "2026-08-10",
});
const receipt = doc({
  id: "d-400",
  type: 400,
  morning_doc_id: "m-80062",
  morning_doc_number: "80062",
  amount: 3000,
  document_date: "2026-08-11",
  // a receipt points at nothing of its own — this is the whole difficulty
});
const withReceipt = resolveProductionDocuments({
  productionIds: ["p1"],
  jobLinks: [{ job_id: "j1", production_id: "p1" }],
  jobs: [{ id: "j1", invoice_biz: null, invoice_tax: "50068" }],
  documents: [taxInvoice, receipt],
  receiptLinks: [{ morning_doc_id: "m-80062", linked_document_ids: ["m-50068"] }],
});
const got = (withReceipt.get("p1") ?? []).map((r) => `${r.type}:${r.path}`);
check("the receipt reaches the production", got.includes("400:receipt"), got.join(" "));
check("the parent 305 is there too", got.includes("305:job"), got.join(" "));

// and without the link, it must NOT appear — no guessing
const noLink = resolveProductionDocuments({
  productionIds: ["p1"],
  jobLinks: [{ job_id: "j1", production_id: "p1" }],
  jobs: [{ id: "j1", invoice_biz: null, invoice_tax: "50068" }],
  documents: [taxInvoice, receipt],
});
check(
  "a pulled receipt with no parent link stays absent",
  !(noLink.get("p1") ?? []).some((r) => r.type === 400)
);

console.log("\n=== 6. a bundled receipt spanning two episodes ===");
// one receipt raised on two tax invoices belonging to two different episodes
const tax2 = doc({ id: "d-305b", type: 305, morning_doc_id: "m-50069", morning_doc_number: "50069", job_id: "j2" });
const bigReceipt = doc({
  id: "d-400b",
  type: 400,
  morning_doc_id: "m-80070",
  morning_doc_number: "80070",
  amount: 6000,
  document_date: "2026-09-05",
});
const twoEp = resolveProductionDocuments({
  productionIds: ["p1", "p2"],
  jobLinks: [
    { job_id: "j1", production_id: "p1" },
    { job_id: "j2", production_id: "p2" },
  ],
  jobs: [
    { id: "j1", invoice_biz: null, invoice_tax: "50068" },
    { id: "j2", invoice_biz: null, invoice_tax: "50069" },
  ],
  documents: [taxInvoice, tax2, bigReceipt],
  receiptLinks: [{ morning_doc_id: "m-80070", linked_document_ids: ["m-50068", "m-50069"] }],
});
const rHolders = ["p1", "p2"].filter((p) => (twoEp.get(p) ?? []).some((r) => r.id === "d-400b"));
check("both episodes show the receipt", rHolders.length === 2, `${rHolders.length}/2`);
check(
  'and it is tagged "מאוגד"',
  ["p1", "p2"].every((p) => (twoEp.get(p) ?? []).find((r) => r.id === "d-400b")?.shared === true)
);
const rDistinct = Array.from(distinctDocuments(twoEp).values()).filter((r) => r.type === 400);
check("counted once, at 6,000", rDistinct.length === 1 && rDistinct[0].amount === 6000);

console.log("\n=== 7. archived and cancelled ===");
const arch = resolveProductionDocuments({
  productionIds: ["p1"],
  jobLinks: [{ job_id: "j1", production_id: "p1" }],
  jobs: [{ id: "j1", invoice_biz: null, invoice_tax: null }],
  documents: [
    doc({ id: "d-arch", type: 300, production_id: "p1", archived_at: "2026-08-01T00:00:00Z" }),
    doc({ id: "d-canc", type: 300, production_id: "p1", cancelled_at: "2026-08-02T00:00:00Z" }),
  ],
});
const archRows = arch.get("p1") ?? [];
check("archived is dropped", !archRows.some((r) => r.id === "d-arch"));
check("cancelled is kept, flagged", archRows.some((r) => r.id === "d-canc" && r.cancelled));

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
