/**
 * checkEligibility + effectivePrice, as pure functions (F6 שלב 2א, 0067).
 *
 * Run:  npx tsx scripts/test_hourly_pricing.ts
 *
 * NO DATABASE, NO SERVER, NO NETWORK — and that is the point. checkEligibility
 * is the one piece of billing logic that is a pure function of its arguments,
 * so the hourly table can be exercised in every combination that matters
 * including the ones live data does not contain yet (no show is per_hour today,
 * so a live-data test of this table would assert nothing at all).
 *
 * Rule 40 does not apply: nothing here can reach Morning. Nothing here can even
 * reach Supabase — there is no client in this file.
 *
 * WHAT IT PINS
 *   • the six rows of the agreed pricing table
 *   • rounding at the point of derivation (the owner's 1.5 × 333.33 case)
 *   • the boundaries that must NOT be treated as "no hours": 0 is not null
 *   • a negative rate/hours produces a negative price rather than a silent zero
 *   • a missing hourly_rate reports the RATE, never the hours
 *   • price_override wins in both models, over both a rate and hours
 *   • an omitted status is the LOUD reading, not the quiet one
 *   • the per_episode path is byte-identical to what it was before 0067
 */
import {
  checkEligibility,
  effectivePrice,
  type ClientForBilling,
  type ProductionForBilling,
  type ShowForBilling,
} from "../src/lib/documents/enqueue";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CLIENT: ClientForBilling = { id: "c1", name: "מכון דוידסון", morning_client_id: "m1" };

const prod = (over: Partial<ProductionForBilling> = {}): ProductionForBilling => ({
  id: "p1",
  kind: "client",
  legacy: false,
  client_id: "c1",
  show_id: "s1",
  podcast_name: "מכון דוידסון",
  record_date: "2026-09-03",
  status: "הוקלט",
  ...over,
});

const hourlyShow = (over: Partial<ShowForBilling> = {}): ShowForBilling => ({
  id: "s1",
  client_id: "c1",
  billing_mode: "per_episode", // an hourly show is still per-episode-billed; only the amount differs
  default_rate: null, // shows_one_rate_per_model forbids both
  pricing_model: "per_hour",
  hourly_rate: 250,
  ...over,
});

const episodeShow = (over: Partial<ShowForBilling> = {}): ShowForBilling => ({
  id: "s1",
  client_id: "c1",
  billing_mode: "per_episode",
  default_rate: 900,
  pricing_model: "per_episode",
  hourly_rate: null,
  ...over,
});

const amountOf = (e: ReturnType<typeof checkEligibility>) => (e.ok ? e.amount : null);
const reasonOf = (e: ReturnType<typeof checkEligibility>) => (e.ok ? "" : e.reason);

// ═══ the six rows of the table ═══════════════════════════════════════════════
console.log("\n=== the agreed pricing table, row by row ===");

// 1. price_override wins — over an hourly rate AND over hours that would
//    otherwise compute a different number
{
  const e = checkEligibility(prod({ price_override: 1200, studio_hours: 3 }), hourlyShow(), CLIENT);
  check("1. override wins on an hourly show", e.ok && e.amount === 1200, `amount=${amountOf(e)}`);
  const e2 = checkEligibility(prod({ price_override: 1200 }), episodeShow(), CLIENT);
  check("1. override wins on a per-episode show", e2.ok && e2.amount === 1200, `amount=${amountOf(e2)}`);
  // the override must beat a show that is otherwise unpriceable, not fall into
  // its block — a hand-priced session is priced
  const e3 = checkEligibility(prod({ price_override: 1200 }), hourlyShow({ hourly_rate: null }), CLIENT);
  check("1. override beats a missing hourly rate", e3.ok && e3.amount === 1200, `amount=${amountOf(e3)}`);
}

// 2. per_hour + hours → round(hours × rate, 2)
{
  const e = checkEligibility(prod({ studio_hours: 3.5 }), hourlyShow({ hourly_rate: 250 }), CLIENT);
  check("2. 3.5 h × 250 = 875", e.ok && e.amount === 875, `amount=${amountOf(e)}`);
}

// 3. per_hour, no hours, not yet recorded → applicable:false (documented silence)
for (const status of ["עתיד_להתחיל", "בהקלטה", "בוטל"]) {
  const e = checkEligibility(prod({ status, studio_hours: null }), hourlyShow(), CLIENT);
  check(
    `3. '${status}' with no hours is silent (applicable:false)`,
    !e.ok && e.applicable === false,
    `applicable=${!e.ok ? e.applicable : "n/a"} · ${reasonOf(e)}`
  );
}

// 4. per_hour, no hours, recorded or later → applicable:true + the hours sentence
for (const status of ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח", 'אושר_ע"י_לקוח', "הופץ"]) {
  const e = checkEligibility(prod({ status, studio_hours: null }), hourlyShow(), CLIENT);
  check(
    `4. '${status}' with no hours is a 🟡`,
    !e.ok && e.applicable === true && e.reason.includes("לא הוזנו שעות ההקלטה"),
    reasonOf(e)
  );
}

// 5. per_hour, no hourly_rate → applicable:true, and a DIFFERENT sentence
{
  const e = checkEligibility(prod({ studio_hours: 3 }), hourlyShow({ hourly_rate: null }), CLIENT);
  check("5. no hourly rate is a 🟡", !e.ok && e.applicable === true, reasonOf(e));
  check("5. ...and it names the RATE", !e.ok && e.reason.includes("לא הוגדר תעריף שעתי"), reasonOf(e));
  // the two sentences must not be confusable: a technician sent to enter hours
  // that are already entered will dismiss the flag as noise
  check("5. ...and never the hours", !e.ok && !e.reason.includes("לא הוזנו שעות"), reasonOf(e));
}
{
  // rate missing AND hours missing: the RATE wins the report, because it is the
  // one that can be fixed without a session having happened
  const e = checkEligibility(prod({ studio_hours: null }), hourlyShow({ hourly_rate: null }), CLIENT);
  check("5. rate beats hours when both are missing", !e.ok && e.reason.includes("תעריף שעתי"), reasonOf(e));
}

// 6. anything else → default_rate ?? blocked (exactly as before 0067)
{
  const e = checkEligibility(prod(), episodeShow({ default_rate: 900 }), CLIENT);
  check("6. per_episode uses default_rate", e.ok && e.amount === 900, `amount=${amountOf(e)}`);
  const e2 = checkEligibility(prod(), episodeShow({ default_rate: null }), CLIENT);
  check(
    "6. per_episode with no rate is a 🟡 (moved out of enqueueDocument)",
    !e2.ok && e2.applicable === true && e2.reason.includes("אין מחיר ברירת מחדל"),
    reasonOf(e2)
  );
  // a show with no pricing_model at all — the shape every caller minted before
  // 0067 — must read as per_episode, not as an unpriced hourly show
  const e3 = checkEligibility(prod(), { id: "s1", client_id: "c1", billing_mode: "per_episode", default_rate: 900 }, CLIENT);
  check("6. an absent pricing_model reads as per_episode", e3.ok && e3.amount === 900, `amount=${amountOf(e3)}`);
}

// ═══ rounding ════════════════════════════════════════════════════════════════
console.log("\n=== rounding at the point of derivation ===");
{
  // the owner's case, and the reason round() is in the SQL too (0067 §7)
  const e = checkEligibility(prod({ studio_hours: 1.5 }), hourlyShow({ hourly_rate: 333.33 }), CLIENT);
  check("1.5 × 333.33 = 500 (not 499.995)", e.ok && e.amount === 500, `amount=${amountOf(e)}`);
  const raw = 1.5 * 333.33;
  check("...and the unrounded product really does carry three decimals", raw !== 500, String(raw));
}
{
  // float noise that only appears after multiplication
  const e = checkEligibility(prod({ studio_hours: 2.4 }), hourlyShow({ hourly_rate: 0.1 }), CLIENT);
  check("2.4 × 0.1 = 0.24 exactly", e.ok && e.amount === 0.24, `amount=${amountOf(e)}`);
}
{
  const e = checkEligibility(prod({ studio_hours: 0.25 }), hourlyShow({ hourly_rate: 333.33 }), CLIENT);
  check("0.25 × 333.33 = 83.33 (rounded down)", e.ok && e.amount === 83.33, `amount=${amountOf(e)}`);
}
{
  // two decimals in, two decimals out — never a third
  for (const [h, r] of [
    [1.25, 199.99],
    [3.75, 266.67],
    [7.5, 133.33],
  ] as [number, number][]) {
    const e = checkEligibility(prod({ studio_hours: h }), hourlyShow({ hourly_rate: r }), CLIENT);
    const a = amountOf(e) ?? 0;
    check(`${h} × ${r} carries at most 2 decimals`, Number(a.toFixed(2)) === a, `amount=${a}`);
  }
}

// ═══ the boundaries ══════════════════════════════════════════════════════════
console.log("\n=== 0, negatives, and the difference between them and null ===");
{
  // 0 IS NOT NULL. productions_studio_hours_positive (0067 §3) makes 0
  // unreachable through the column and the hours route refuses it before that —
  // but if it ever arrives, it must price as 0, never be mistaken for "no hours
  // entered". A `!production.studio_hours` test would have read it as absent
  // and raised the missing-hours 🟡 on a session that HAD an answer.
  const e = checkEligibility(prod({ studio_hours: 0 }), hourlyShow({ hourly_rate: 250 }), CLIENT);
  check("0 hours prices at 0, and is not read as 'no hours'", e.ok && e.amount === 0, `amount=${amountOf(e)}`);
}
{
  // same test, one level down
  const b = effectivePrice(prod({ studio_hours: 0 }), hourlyShow());
  check("effectivePrice: 0 hours is not 'no_hours'", b.amount === 0 && b.blocked === null, JSON.stringify(b));
  const b0 = effectivePrice(prod({ studio_hours: null }), hourlyShow());
  check("effectivePrice: null hours IS 'no_hours'", b0.blocked === "no_hours", JSON.stringify(b0));
}
{
  // a 0 RATE is a real (free) rate, not a missing one — the same distinction on
  // the other factor
  const e = checkEligibility(prod({ studio_hours: 3 }), hourlyShow({ hourly_rate: 0 }), CLIENT);
  check("a 0 rate prices at 0, and is not read as 'no rate'", e.ok && e.amount === 0, `amount=${amountOf(e)}`);
}
{
  // Negative input is not defended against here and that is deliberate: the DB
  // constraint refuses negative hours and the route refuses them first. What
  // this pins is that a negative does NOT silently become 0 or null — it comes
  // out negative and visible, where the balance gate and a human will both see
  // it. Silent coercion is how a credit turns into a charge.
  const e = checkEligibility(prod({ studio_hours: -2 }), hourlyShow({ hourly_rate: 250 }), CLIENT);
  check("negative hours stay negative (never coerced to 0/null)", e.ok && e.amount === -500, `amount=${amountOf(e)}`);
  const e2 = checkEligibility(prod({ studio_hours: 2 }), hourlyShow({ hourly_rate: -250 }), CLIENT);
  check("a negative rate stays negative too", e2.ok && e2.amount === -500, `amount=${amountOf(e2)}`);
}

// ═══ the status default ══════════════════════════════════════════════════════
console.log("\n=== an omitted status is the loud reading ===");
{
  const p = prod({ studio_hours: null });
  delete p.status;
  const e = checkEligibility(p, hourlyShow(), CLIENT);
  check(
    "no status + no hours → applicable:true (a caller's omission never buys silence)",
    !e.ok && e.applicable === true,
    reasonOf(e)
  );
  const p2 = prod({ studio_hours: null, status: null });
  const e2 = checkEligibility(p2, hourlyShow(), CLIENT);
  check("null status behaves the same as an omitted one", !e2.ok && e2.applicable === true, reasonOf(e2));
}
{
  // an unrecognised status must not be read as "not yet recorded" either
  const e = checkEligibility(prod({ status: "משהו_חדש", studio_hours: null }), hourlyShow(), CLIENT);
  check("an unknown status is loud, not silent", !e.ok && e.applicable === true, reasonOf(e));
}

// ═══ the gates above the price still run first ═══════════════════════════════
console.log("\n=== the eligibility gates are unchanged and still come first ===");
{
  // an hourly show that is internal / legacy / non-client is still silence, and
  // the hours never get a chance to raise anything
  const e = checkEligibility(prod({ legacy: true, studio_hours: null }), hourlyShow(), CLIENT);
  check("legacy is still silent on an hourly show", !e.ok && e.applicable === false, reasonOf(e));
  const e2 = checkEligibility(prod({ kind: "internal", studio_hours: null }), hourlyShow(), CLIENT);
  check("kind<>'client' is still silent", !e2.ok && e2.applicable === false, reasonOf(e2));
  const e3 = checkEligibility(prod({ studio_hours: 3 }), hourlyShow({ billing_mode: "none" }), CLIENT);
  check("billing_mode='none' is still silent", !e3.ok && e3.applicable === false, reasonOf(e3));
  const e4 = checkEligibility(prod({ studio_hours: 3 }), hourlyShow(), { ...CLIENT, morning_client_id: null });
  check("an unmapped client still blocks before the price", !e4.ok && e4.reason.includes("מורנינג"), reasonOf(e4));
  // a contract show is decided by the contract branch, never by the hours
  const e5 = checkEligibility(prod({ studio_hours: null }), hourlyShow({ billing_mode: "contract" }), CLIENT, {
    id: "k1",
    name: "חוזה",
    milestoneCount: 3,
  });
  check("a contract show never reaches the hours branch", !e5.ok && e5.applicable === false, reasonOf(e5));
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
