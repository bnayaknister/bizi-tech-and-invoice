/**
 * jobPatchForDocument — what an issued document does to a linked job.
 *
 * Run:  npx tsx scripts/test_auto_paid.ts
 *
 * TOUCHES NOTHING: no Supabase, no Morning, no dev server. The function is
 * pure, and that is deliberate — this is the ONLY way these rules can be
 * verified at all. A dry run no longer reaches the jobs write (issue.ts,
 * 2026-08-22) and there is no Morning sandbox, so an end-to-end path through
 * issuance cannot exist. The rules are the risk; the UPDATE is not.
 *
 * The rule under test (owner spec 2026-08-22): a 320 (חשבונית מס-קבלה) is an
 * invoice AND a receipt — the review route's payment gate refuses to issue one
 * without a payment block summing to the parent's gross, so by issuance time
 * the money is already declared received. It flips paid. A 305 declares a debt
 * and must not.
 *
 * The half that matters most is what does NOT flip: 'ללא חיוב' is a decision
 * that no money is coming, 'לא ידוע' is an admission that nobody knows. Both
 * would be destroyed by a `!present()` test, and both are asserted below.
 */
import { jobPatchForDocument } from "../src/lib/documents/issue";
import type { PendingDocType } from "../src/lib/morning/types";

let failures = 0;
const NUM = "847213"; // a plausible Morning number

function check(label: string, ok: boolean, detail = "") {
  console.log((ok ? "PASS  " : "FAIL  ") + label + (!ok && detail ? `  [${detail}]` : ""));
  if (!ok) failures++;
}

const job = (over: Partial<{ invoice_biz: unknown; invoice_tax: unknown; paid: unknown }> = {}) => ({
  invoice_biz: null,
  invoice_tax: null,
  paid: "לא",
  ...over,
});

const patchFor = (docType: PendingDocType, over = {}) =>
  jobPatchForDocument({ docType, docNumber: NUM, job: job(over) });

const j = (v: unknown) => JSON.stringify(v);

console.log("--- 320 (tax_receipt): the automation ---");
{
  const p = patchFor("tax_receipt");
  check("320 flips paid to 'כן'", p.paid === "כן", j(p));
  check("320 stamps invoice_tax in the same patch (so the job closes, never lands red)",
    p.invoice_tax === NUM, j(p));
  check("320 does not touch invoice_biz", p.invoice_biz === undefined, j(p));
}

console.log("\n--- 305 (tax_invoice): declares a debt, not money ---");
{
  const p = patchFor("tax_invoice");
  check("305 does NOT flip paid", p.paid === undefined, j(p));
  check("305 still stamps invoice_tax", p.invoice_tax === NUM, j(p));
}

console.log("\n--- the other types ---");
{
  const p = patchFor("deal_invoice");
  check("300 stamps invoice_biz only, never paid", p.invoice_biz === NUM && p.paid === undefined, j(p));
  const w = patchFor("work_order");
  check("100 does nothing at all", Object.keys(w).length === 0, j(w));
}

console.log("\n--- 400 (receipt): money and nothing else ---");
{
  const p = patchFor("receipt");
  check("400 flips paid to 'כן'", p.paid === "כן", j(p));
  check("400 writes NO invoice_tax — a receipt carries no tax-invoice number, "
    + "that number belongs to the 305 above it", p.invoice_tax === undefined, j(p));
  check("400 writes no invoice_biz either", p.invoice_biz === undefined, j(p));

  const noCharge = patchFor("receipt", { paid: "ללא חיוב" });
  check("'ללא חיוב' survives a 400 too", noCharge.paid === undefined, j(noCharge));
  const unknown = patchFor("receipt", { paid: "לא ידוע" });
  check("'לא ידוע' survives a 400 too", unknown.paid === undefined, j(unknown));
  const already = patchFor("receipt", { paid: "כן" });
  check("already-paid job → EMPTY patch from a 400", Object.keys(already).length === 0, j(already));

  // the anomaly branch: issue.ts flips anyway and events it, leaving the job
  // RED (money in, no tax invoice) — the correct state, not one to suppress
  const noTax = patchFor("receipt", { invoice_tax: null });
  check("a job with no invoice_tax still flips (issue.ts events the anomaly)",
    noTax.paid === "כן" && noTax.invoice_tax === undefined, j(noTax));
}

console.log("\n--- paid flips ONLY from the exact string 'לא' ---");
{
  const noCharge = patchFor("tax_receipt", { paid: "ללא חיוב" });
  check("'ללא חיוב' SURVIVES a 320 — a decision that no money is coming",
    noCharge.paid === undefined, j(noCharge));

  const unknown = patchFor("tax_receipt", { paid: "לא ידוע" });
  check("'לא ידוע' SURVIVES a 320 — nobody knows, so do not invent an answer",
    unknown.paid === undefined, j(unknown));

  const already = patchFor("tax_receipt", { paid: "כן", invoice_tax: NUM });
  check("already paid + already stamped → EMPTY patch (a re-issue is silent)",
    Object.keys(already).length === 0, j(already));

  const alreadyPaidNoTax = patchFor("tax_receipt", { paid: "כן" });
  check("already paid, no tax number → stamps the number, no paid key",
    alreadyPaidNoTax.invoice_tax === NUM && alreadyPaidNoTax.paid === undefined, j(alreadyPaidNoTax));

  for (const weird of [null, undefined, "", "  ", "כן ", "Yes", "לא "]) {
    const p = patchFor("tax_receipt", { paid: weird });
    check(`paid=${j(weird)} does not flip (only the exact 'לא' does)`, p.paid === undefined, j(p));
  }
}

console.log("\n--- existing numbers are never clobbered ---");
{
  const p = patchFor("tax_receipt", { invoice_tax: "111111" });
  check("a real invoice_tax is left alone, but paid still flips",
    p.invoice_tax === undefined && p.paid === "כן", j(p));
  const d = patchFor("deal_invoice", { invoice_biz: "222222" });
  check("a real invoice_biz is left alone", d.invoice_biz === undefined, j(d));
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
