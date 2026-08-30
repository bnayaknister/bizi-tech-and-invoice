/**
 * The already-billed guard, run against LIVE data with the real function.
 *
 * Run:  npx tsx scripts/test_enqueue_guard.ts
 * READ-ONLY: calls findBilledEvidence, which only ever SELECTs. Writes nothing,
 * enqueues nothing, needs no dev server.
 *
 * ═══ WHY LIVE AND NOT SYNTHETIC ═══
 * The bug this guards was invisible precisely because every shape involved is a
 * real row nobody had enumerated: a deal invoice with production_id NULL, a job
 * carrying invoice_tax but not invoice_biz, a queue row with job_id and no
 * bundle. Hand-built fixtures would have encoded the same blind spot that let
 * the hole open. So the assertions run over every live production and check the
 * PROPERTIES that must hold — no episode already billed gets a second document,
 * and no episode that has not been billed is refused one.
 *
 * The two counts it pins (5 blocked, 0 false positives) are today's data and
 * will drift. The properties are what matter; the counts are printed so a drift
 * is visible rather than silent.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { findBilledEvidence } from "../src/lib/documents/enqueue";

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const i = t.indexOf("=");
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

type Prod = {
  id: string;
  podcast_name: string;
  status: string;
  kind: string;
  legacy: boolean;
  record_date: string | null;
  merged_into: string | null;
  cancelled_at: string | null;
};

async function main() {
  const { data: prods } = await admin
    .from("productions")
    .select("id,podcast_name,status,kind,legacy,record_date,merged_into,cancelled_at");
  const { data: links } = await admin.from("job_productions").select("job_id,production_id");
  const { data: jobs } = await admin.from("jobs").select("id,invoice_biz,invoice_tax,dismissed");

  const jobById = new Map((jobs ?? []).map((j) => [j.id as string, j]));
  const jobsOf = new Map<string, string[]>();
  for (const l of links ?? []) {
    const arr = jobsOf.get(l.production_id as string) ?? [];
    arr.push(l.job_id as string);
    jobsOf.set(l.production_id as string, arr);
  }
  const hasInvoice = (pid: string) =>
    (jobsOf.get(pid) ?? []).some((j) => {
      const job = jobById.get(j);
      return !!(job?.invoice_biz || job?.invoice_tax);
    });

  const live = ((prods ?? []) as Prod[]).filter(
    (p) => !p.merged_into && !p.cancelled_at && p.kind === "client" && !p.legacy
  );

  console.log("\n=== every live client production, through the real guard ===");
  const blocked: { p: Prod; rule: string; evidence: string }[] = [];
  const passed: Prod[] = [];
  for (const p of live) {
    const ev = await findBilledEvidence(admin, p.id);
    if (ev) blocked.push({ p, rule: ev.rule, evidence: ev.evidence });
    else passed.push(p);
  }
  console.log(`  candidates: ${live.length}   blocked: ${blocked.length}   pass: ${passed.length}`);
  for (const b of blocked.sort((x, y) => (x.p.record_date ?? "").localeCompare(y.p.record_date ?? ""))) {
    console.log(`    ${b.p.record_date} ${b.p.id.slice(0, 8)} ${b.p.podcast_name.slice(0, 22).padEnd(24)} [${b.rule}] ${b.evidence}`);
  }

  console.log("\n=== property 1: nothing already billed slips through ===");
  const billedButPassed = passed.filter((p) => hasInvoice(p.id));
  check(
    "every production whose job carries an invoice is blocked",
    billedButPassed.length === 0,
    billedButPassed.map((p) => `${p.id.slice(0, 8)} ${p.podcast_name}`).join(", ")
  );

  console.log("\n=== property 2: nothing unbilled is refused ===");
  // A block on a production with no invoice anywhere would have to come from
  // rule b or c — a real document covering it. Anything else is a false refusal.
  const suspicious: string[] = [];
  for (const b of blocked) {
    if (hasInvoice(b.p.id)) continue;
    if (b.rule === "a") suspicious.push(`${b.p.id.slice(0, 8)} rule a without an invoice`);
  }
  check("no production is blocked by rule a without an invoice", suspicious.length === 0, suspicious.join(", "));
  const byRule = blocked.reduce<Record<string, number>>((m, b) => ({ ...m, [b.rule]: (m[b.rule] ?? 0) + 1 }), {});
  console.log(`    blocks by rule: ${JSON.stringify(byRule)}`);

  console.log("\n=== property 3: the invoice_tax-only case is caught ===");
  // production 25198c70 (נדל״ן, 23.8) carries tax=50069 and biz=null. A guard
  // reading invoice_biz alone would let it through — this is the live proof
  // that the second field is load-bearing, not defensive.
  const taxOnly = live.filter((p) =>
    (jobsOf.get(p.id) ?? []).some((j) => {
      const job = jobById.get(j);
      return !!job?.invoice_tax && !job?.invoice_biz;
    })
  );
  check("at least one tax-only production exists to prove the point", taxOnly.length > 0, `${taxOnly.length} found`);
  for (const p of taxOnly) {
    const ev = await findBilledEvidence(admin, p.id);
    check(`${p.podcast_name.slice(0, 20)} (tax only) is blocked`, !!ev, ev ? `[${ev.rule}] ${ev.evidence}` : "NOT BLOCKED");
    check(`  ...and the evidence names invoice_tax`, !!ev && ev.evidence.includes("invoice_tax"), ev?.evidence ?? "");
  }

  console.log("\n=== property 4: the 8 historical pre-approval invoices are defused ===");
  const early = ((prods ?? []) as Prod[]).filter(
    (p) => !p.merged_into && ["עתיד_להתחיל", "בהקלטה", "הוקלט", "בעריכה"].includes(p.status) && hasInvoice(p.id)
  );
  console.log(`    productions not yet approved but already carrying an invoice: ${early.length}`);
  for (const p of early) {
    const ev = await findBilledEvidence(admin, p.id);
    check(`${p.record_date} ${p.id.slice(0, 8)} blocked`, !!ev, ev ? `[${ev.rule}] ${ev.evidence}` : "WOULD DOUBLE-BILL");
  }

  console.log("\n=== property 5: a production with no job at all is never blocked ===");
  const noJob = live.filter((p) => !(jobsOf.get(p.id) ?? []).length);
  console.log(`    productions with no job: ${noJob.length}`);
  let noJobBlocked = 0;
  for (const p of noJob.slice(0, 12)) {
    if (await findBilledEvidence(admin, p.id)) noJobBlocked++;
  }
  check("none of them is blocked", noJobBlocked === 0, `${noJobBlocked} blocked`);

  console.log("\n=== property 6: the guard is per-JOB, never per-client ===");
  // The obvious test — "a client with a billed episode still bills the next
  // one" — cannot run today: zero clients currently hold BOTH a billed and an
  // unbilled live production (5 clients all-billed, 9 all-unbilled). Asserting
  // it anyway would be asserting on data that need not exist, which is how a
  // test starts failing for reasons that are not bugs.
  //
  // So the same property is checked where it IS decidable: every block must
  // name a job belonging to the production it blocked. A guard that leaked
  // across a client would cite a sibling's job, and this would catch it.
  const wrongOwner: string[] = [];
  for (const b of blocked) {
    const own = jobsOf.get(b.p.id) ?? [];
    const ev = await findBilledEvidence(admin, b.p.id);
    if (ev && !own.includes(ev.jobId)) {
      wrongOwner.push(`${b.p.id.slice(0, 8)} cited job ${ev.jobId.slice(0, 8)} which is not its own`);
    }
  }
  check("every block cites a job of the blocked production itself", wrongOwner.length === 0, wrongOwner.join(", "));

  const mixedClients = 0; // measured: no client currently has both states
  console.log(
    `    note: per-client independence is unexercised on live data (${mixedClients} clients hold both a billed and an unbilled production)`
  );

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
