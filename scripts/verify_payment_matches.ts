/**
 * F14 stage B — the payment match engine, tested PURELY. No database, no
 * server, no network. Every row below is built in memory and handed to the
 * real `certainPaymentMatches`.
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/verify_payment_matches.ts
 *
 * ═══ WHY THIS IS THE PURE ONE ═══
 * Same reason `certainBillingMatchIn` was split from its loader: the states
 * that matter here cannot be reached on live data any more. `certain` and
 * `certainPaymentMatches` have both measured 0 four times, P19 removed the one
 * live example this ticket was opened over, and the ambiguity cases were
 * resolved by hand months ago. Reconstructing them in memory is the only way
 * they can ever be asserted again. `verify_c2_guard.ts` is the pattern.
 *
 * Exits 1 on any failure.
 */
import {
  certainPaymentMatches,
  paymentMatchFingerprint,
  type ReconClient,
  type ReconJob,
  type ReconDoc,
} from "../src/lib/documents/reconcile";

const fails: string[] = [];
const ok = (s: string) => console.log("  ✅ " + s);
const bad = (s: string) => {
  fails.push(s);
  console.log("  ❌ " + s);
};
const check = (label: string, cond: boolean, detail = "") =>
  cond ? ok(label) : bad(label + (detail ? `  [${detail}]` : ""));

// ---- row builders -------------------------------------------------------
// Only the fields the engine reads; everything else takes a neutral default,
// so a test row can never accidentally depend on a column nobody named.
let n = 0;
const client = (over: Partial<ReconClient> = {}): ReconClient => ({
  id: `c${++n}`,
  name: `לקוח ${n}`,
  morning_client_id: `m${n}`,
  ...over,
});
const job = (over: Partial<ReconJob> = {}): ReconJob => ({
  id: `j${++n}`,
  client_id: null,
  amount: null,
  invoice_biz: null,
  invoice_tax: null,
  // unpaid is what makes a job need a payment document at all
  paid: "לא",
  date: "2026-06-01",
  due_date: null,
  legacy: false,
  campaign: null,
  ...over,
});
const doc = (over: Partial<ReconDoc> = {}): ReconDoc => ({
  id: `d${++n}`,
  morning_doc_number: String(40000 + n),
  type: 400, // קבלה — the payment type with no preflight gate behind it
  client_id: null,
  morning_client_id: null,
  morning_client_name: null,
  amount: null,
  document_date: "2026-06-01",
  job_id: null,
  production_id: null,
  source: "morning_api",
  ...over,
});

// ════════════════════════════════════════════════════════════════════════
console.log("\n1. a unique pair appears");
{
  const c = client();
  const j = job({ client_id: c.id, amount: 1013 });
  const d = doc({ client_id: c.id, amount: 1013 });
  const m = certainPaymentMatches([c], [j], [d]);
  check("one match", m.length === 1, `got ${m.length}`);
  check("it is the seeded pair", m[0]?.doc.id === d.id && m[0]?.job.id === j.id);
  check("basis is pre-VAT (doc equals the job amount)", m[0]?.amountBasis === "pre", m[0]?.amountBasis);
  check("both degrees are 1", m[0]?.jobDegree === 1 && m[0]?.docDegree === 1);
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n2. a SECOND document at the same client+amount makes it vanish");
{
  const c = client();
  const j = job({ client_id: c.id, amount: 1013 });
  const d1 = doc({ client_id: c.id, amount: 1013 });
  const d2 = doc({ client_id: c.id, amount: 1013 });

  const before = certainPaymentMatches([c], [j], [d1]);
  check("with one document: 1 match", before.length === 1, `got ${before.length}`);

  const after = certainPaymentMatches([c], [j], [d1, d2]);
  // The job now has degree 2, so confidenceOf drops to "medium" for BOTH
  // edges — not just the new one. Ambiguity removes the whole pairing from the
  // list rather than picking a winner: "לא ודאי → אל תנחש".
  check("with two documents: 0 matches", after.length === 0, `got ${after.length}`);
}
{
  // and the mirror image — a second JOB, same client and amount
  const c = client();
  const j1 = job({ client_id: c.id, amount: 1013 });
  const j2 = job({ client_id: c.id, amount: 1013 });
  const d = doc({ client_id: c.id, amount: 1013 });
  check("a second matching JOB also removes it", certainPaymentMatches([c], [j1, j2], [d]).length === 0);
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n3. rule 55 — a narrowed graph manufactures a fake 'high'");
{
  // One client, one unpaid job at ₪1,013. Two documents at that amount:
  // a receipt (400, a PAYMENT type) and a deal invoice (300, a BILLING type
  // that is NOT a payment type). The job is purple (not billed), so it needs
  // both: the 300 as a bill, the 400 as proof of payment.
  const c = client();
  const j = job({ client_id: c.id, amount: 1013 });
  const receipt = doc({ client_id: c.id, amount: 1013, type: 400 });
  const dealInvoice = doc({ client_id: c.id, amount: 1013, type: 300 });

  // THE FULL GRAPH — what the real function builds. The job's degree is 2
  // (both documents are candidates), so nothing is unique and nothing is
  // certain.
  const full = certainPaymentMatches([c], [j], [receipt, dealInvoice]);
  check("full graph (all BILLING_TYPES): 0 matches", full.length === 0, `got ${full.length}`);

  // THE NARROW GRAPH — what a "cheaper" confirm-time query that asked only
  // about payment documents would build. The 300 is invisible, the job's
  // degree is 1, and the receipt comes back as a certain match.
  const narrow = certainPaymentMatches([c], [j], [receipt]);
  check("narrow graph (payment docs only): 1 FAKE match", narrow.length === 1, `got ${narrow.length}`);
  check(
    "⚠️ the two disagree — this is exactly what rule 55 forbids",
    full.length !== narrow.length,
    "if these ever agree, the demonstration has stopped demonstrating"
  );
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n4. the 60160 / d39c2148 case, reconstructed (F14's own example)");
{
  // Two chains of סבטלנה ניקסון that collided on ₪1,416 and nothing else:
  //   60160 (320, ₪1,416, 23.06) — the May-June chain 10248 → 40249 → 60160
  //   d39c2148 (אסתטיטוקס, ₪1,200 net) — the August chain 10307 → 40305,
  //     where 40305 is still status=0, which is WHY the job is unpaid.
  // ₪1,200 × 1.18 = ₪1,416, so the amount matches on the VAT basis. The engine
  // cannot tell the chains apart: it has no date window, by decision
  // (reconcile.ts:874-881), and that decision stands.
  const svetlana = client({ name: "סבטלנה ניקסון" });
  // the job date is set so the gap reproduces the 54 days the ticket measured
  // on live data — the figure that proved the ONLY thing blocking this pair
  // from the auto-link set was `54 > 45`. Nine days.
  const august = job({ client_id: svetlana.id, amount: 1200, date: "2026-08-16", campaign: "אסתטיטוקס" });
  const d60160 = doc({
    client_id: svetlana.id,
    amount: 1416,
    type: 320,
    morning_doc_number: "60160",
    document_date: "2026-06-23",
  });

  const m = certainPaymentMatches([svetlana], [august], [d60160]);
  check("the engine DOES propose this pair", m.length === 1, `got ${m.length}`);
  check("on the VAT basis", m[0]?.amountBasis === "vat", m[0]?.amountBasis);
  check("the gap reproduces the measured 54 days", m[0]?.dateGapDays === 54, String(m[0]?.dateGapDays));
  check("which is past AUTO_DATE_WINDOW — disclosed, never filtered", (m[0]?.dateGapDays ?? 0) > 45);
  console.log(
    `      → this is the row a human must reject on the screen: ` +
      `#${m[0]?.doc.morning_doc_number} (${m[0]?.doc.amount}₪, ${m[0]?.doc.document_date}) ` +
      `vs job ${m[0]?.job.amount}₪ ${m[0]?.job.date} · ${m[0]?.dateGapDays} יום פער`
  );
  // The whole point of stage B: the engine still PROPOSES it, and that is
  // correct — the date decision stands. What changed is that proposing is no
  // longer linking.
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n5. נטע צמח — three identical ₪708 receipts stay out");
{
  const neta = client({ name: "נטע צמח" });
  const jobs = [
    job({ client_id: neta.id, amount: 708 }),
    job({ client_id: neta.id, amount: 708 }),
    job({ client_id: neta.id, amount: 708 }),
  ];
  const docs = [
    doc({ client_id: neta.id, amount: 708, type: 400 }),
    doc({ client_id: neta.id, amount: 708, type: 400 }),
    doc({ client_id: neta.id, amount: 708, type: 400 }),
  ];
  check("3×3 identical: 0 matches", certainPaymentMatches([neta], jobs, docs).length === 0);
  // and it is the ambiguity doing it, not the amount: one of each pairs fine
  check(
    "the same ₪708 with one job and one receipt: 1 match",
    certainPaymentMatches([neta], [jobs[0]], [docs[0]]).length === 1
  );
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n6. the fingerprint");
{
  const c = client();
  const j = job({ client_id: c.id, amount: 1013 });
  const d = doc({ client_id: c.id, amount: 1013 });
  const [m] = certainPaymentMatches([c], [j], [d]);
  const fp = paymentMatchFingerprint(m);

  check("stable across calls", fp === paymentMatchFingerprint(certainPaymentMatches([c], [j], [d])[0]));
  check("16 hex chars", /^[0-9a-f]{16}$/.test(fp), fp);

  // THE CASE IT ACTUALLY CATCHES: an amount edited inside the tolerance. The
  // pair stays an edge, stays unique, stays "high" — and stops being the row
  // the operator approved.
  const nudged = doc({ ...d, amount: 1018 }); // +₪5, inside max(₪2, 1%) = ₪10.13
  const [m2] = certainPaymentMatches([c], [j], [nudged]);
  check("a nudged amount is still a match", !!m2, "if this fails the tolerance moved, not the test");
  check("…but the fingerprint differs", !!m2 && paymentMatchFingerprint(m2) !== fp);

  // 1200 vs 1200.0 must not be two signatures
  const [same] = certainPaymentMatches([c], [job({ ...j, amount: 1013.0 })], [doc({ ...d, amount: 1013.0 })]);
  check("trailing-zero amounts sign identically", paymentMatchFingerprint(same) === fp);
}

// ════════════════════════════════════════════════════════════════════════
console.log("\n7. the type boundary — only payment documents are proposed");
{
  const c = client();
  const j = job({ client_id: c.id, amount: 1013 });
  // a 305 (חשבונית מס) answers a RED job, never an unpaid one, and is not a
  // payment type either way
  check("a lone 305 proposes nothing", certainPaymentMatches([c], [j], [doc({ client_id: c.id, amount: 1013, type: 305 })]).length === 0);
  check("a lone 300 proposes nothing", certainPaymentMatches([c], [j], [doc({ client_id: c.id, amount: 1013, type: 300 })]).length === 0);
  check("a 320 proposes", certainPaymentMatches([c], [j], [doc({ client_id: c.id, amount: 1013, type: 320 })]).length === 1);
  check("a 400 proposes", certainPaymentMatches([c], [j], [doc({ client_id: c.id, amount: 1013, type: 400 })]).length === 1);
  check(
    "an already-paid job proposes nothing",
    certainPaymentMatches([c], [job({ client_id: c.id, amount: 1013, paid: "כן" })], [doc({ client_id: c.id, amount: 1013 })]).length === 0
  );
  check(
    "an already-linked document proposes nothing",
    certainPaymentMatches([c], [j], [doc({ client_id: c.id, amount: 1013, job_id: "someotherjob" })]).length === 0
  );
}

console.log("\n" + "=".repeat(70));
if (fails.length) {
  console.log(`FAILED — ${fails.length}`);
  for (const f of fails) console.log("  · " + f);
  process.exit(1);
}
console.log("ALL PASS — pure, no database touched");
