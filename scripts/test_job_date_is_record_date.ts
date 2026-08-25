/**
 * 0064 — a job is dated to the day the WORK happened, and due_date follows.
 *
 * Run:  npx tsx scripts/test_job_date_is_record_date.ts
 *
 * TOUCHES MORNING: never. Nothing here issues or enqueues anything.
 *
 * The net_30 / eom_60 case does not exist in production data — every client the
 * backfill touched is 'immediate', so due_date == date there and the trigger
 * could appear to work while doing nothing at all. That case is built
 * synthetically on purpose: it is the only shape that can tell "the trigger
 * recomputed due_date" apart from "due_date happened to equal date".
 *
 * Every row created is deleted in the finally block AND the deletion is
 * verified before this script reports success.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

let failed = 0;
const check = (n: string, ok: boolean, d = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
};

const TAG = "ZJOBDATE";
const made = { clients: [] as string[], shows: [] as string[], productions: [] as string[], jobs: [] as string[] };
const today = new Date().toISOString().slice(0, 10);

/** create client + show + production, drive it to הוקלט, return the job the trigger made */
async function runCase(label: string, terms: string, recordDate: string) {
  const cid = randomUUID();
  const { error: ce } = await admin
    .from("clients")
    .insert({ id: cid, name: `${TAG}-${label}`, normalized_name: `${TAG}-${label}`.toLowerCase(), payment_terms: terms });
  if (ce) throw new Error(`client(${label}): ${ce.message}`);
  made.clients.push(cid);

  const sid = randomUUID();
  const { error: se } = await admin.from("shows").insert({ id: sid, name: `${TAG}-${label}`, client_id: cid, default_rate: 500, active: true });
  if (se) throw new Error(`show(${label}): ${se.message}`);
  made.shows.push(sid);

  const pid = randomUUID();
  const { error: pe } = await admin.from("productions").insert({
    id: pid, show_id: sid, client_id: cid, podcast_name: `${TAG}-${label}`,
    record_date: recordDate, kind: "client", legacy: false, status: "עתיד_להתחיל",
  });
  if (pe) throw new Error(`production(${label}): ${pe.message}`);
  made.productions.push(pid);

  // the transition that fires the trigger
  const { error: ue } = await admin.from("productions").update({ status: "הוקלט" }).eq("id", pid);
  if (ue) throw new Error(`advance(${label}): ${ue.message}`);

  const { data: link } = await admin.from("job_productions").select("job_id").eq("production_id", pid).maybeSingle();
  if (!link) return null;
  made.jobs.push(link.job_id as string);
  const { data: job } = await admin.from("jobs").select("id,date,due_date,amount,campaign").eq("id", link.job_id as string).single();
  return job;
}

async function main() {
  // ---------------------------------------------------------------- part 1
  console.log("\n1. A NEW JOB CARRIES THE RECORDING DATE, NOT TODAY");
  const past = "2026-07-22"; // a month back, the shape the backfill exposed
  const j1 = await runCase("immediate", "immediate", past);
  check("the trigger created a job at הוקלט", !!j1);
  if (j1) {
    console.log(`     date=${j1.date}  due_date=${j1.due_date}  (today is ${today})`);
    check("job.date is the recording date", j1.date === past, String(j1.date));
    check("job.date is NOT today", j1.date !== today);
    check("immediate -> due_date = date", j1.due_date === past, String(j1.due_date));
  }

  // ---------------------------------------------------------------- part 2
  console.log("\n2. due_date IS REALLY DERIVED — the case production data cannot show");
  const j2 = await runCase("net30", "net_30", past);
  check("net_30 job created", !!j2);
  if (j2) {
    const expect = "2026-08-21"; // 22.7 + 30 days
    console.log(`     date=${j2.date}  due_date=${j2.due_date}  expected ${expect}`);
    check("net_30 -> due_date = record_date + 30", j2.due_date === expect, String(j2.due_date));
    check("...and NOT today + 30", j2.due_date !== "2026-09-24");
  }

  const j3 = await runCase("eom60", "eom_60", past);
  check("eom_60 job created", !!j3);
  if (j3) {
    const expect = "2026-09-29"; // end of July (31.7) + 60
    console.log(`     date=${j3.date}  due_date=${j3.due_date}  expected ${expect}`);
    check("eom_60 -> due_date = end-of-month(record_date) + 60", j3.due_date === expect, String(j3.due_date));
  }

  // ---------------------------------------------------------------- part 3
  console.log("\n3. THE FALLBACK: a production with no record_date still gets a job");
  const j4 = await runCase("nodate", "immediate", null as unknown as string);
  check("a job is still created", !!j4);
  if (j4) {
    console.log(`     date=${j4.date}  (today ${today})`);
    check("it falls back to today, not null", j4.date === today, String(j4.date));
  }

  // ---------------------------------------------------------------- part 4
  console.log("\n4. THE SCREEN NO LONGER AGES OLD EPISODES FROM TODAY");
  const { data: real } = await admin
    .from("jobs")
    .select("id,date,due_date,campaign,dismissed")
    .in("id", [
      "554dd7fe-9b4c-4b24-bb3e-e2b7eb11f81c", // חתונמיות 22.7 — the oldest
      "f72eb276-4bd6-4888-8d25-7445cdad0814", // חתונמיות 30.7
      "73e3ecee-2464-43ac-8acc-5ce3348481c8", // ברק 2.8
    ]);
  for (const j of real ?? []) {
    const age = Math.round((Date.now() - new Date(j.due_date as string).getTime()) / 86_400_000);
    console.log(`     ${String(j.campaign).slice(0, 18).padEnd(20)} due=${j.due_date}  ageing ${age} days`);
    check(`${String(j.campaign).slice(0, 14)}: ages from the recording, not from 24.8`, age > 1, `${age}d`);
  }
}

main()
  .catch((e) => {
    failed++;
    console.error("\nTHREW:", e instanceof Error ? e.message : e);
  })
  .finally(async () => {
    console.log("\nCLEANUP");
    // children first: job_productions cascades from jobs, but events/stages are
    // anchored on the production and must go before it
    if (made.jobs.length) await admin.from("jobs").delete().in("id", made.jobs);
    if (made.productions.length) {
      await admin.from("events").delete().in("entity_id", made.productions);
      await admin.from("stages").delete().in("production_id", made.productions);
      await admin.from("productions").delete().in("id", made.productions);
    }
    if (made.shows.length) await admin.from("shows").delete().in("id", made.shows);
    if (made.clients.length) await admin.from("clients").delete().in("id", made.clients);

    for (const [table, ids] of [["jobs", made.jobs], ["productions", made.productions], ["shows", made.shows], ["clients", made.clients]] as const) {
      if (!ids.length) continue;
      const { data } = await admin.from(table).select("id").in("id", ids);
      check(`${table}: all ${ids.length} test rows deleted`, (data ?? []).length === 0, `${(data ?? []).length} left`);
    }
    console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  });
