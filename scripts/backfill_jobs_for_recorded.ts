/**
 * One-off backfill (owner approved 2026-08-24): give a job to the productions
 * that were already past הוקלט when migration 0060 landed.
 *
 * SAME MECHANISM, NOT A MANUAL INSERT. Every job here is created by calling
 * public.ensure_job_for_production(uuid, text) — the exact function the
 * trigger calls. No INSERT into jobs, no INSERT into job_productions, no
 * status nudging. That function owns the amount rule, the notes, the
 * job_productions link, the event, and the duplicate guard; this script only
 * decides WHICH productions to call it for.
 *
 * SCOPE IS THE APPROVED "CLEAN FIX" LIST ONLY. The 10 productions whose
 * client also owns an unlinked job at a matching amount are deliberately NOT
 * touched — creating a job there could double-bill work that was already
 * recorded by hand. They wait for a per-episode decision.
 *
 * Re-running is safe: the function's job_productions guard turns a second call
 * into a no-op that writes a client_approved_already_billed event.
 *
 * Run: npx tsx scripts/backfill_jobs_for_recorded.ts          (report only)
 *      npx tsx scripts/backfill_jobs_for_recorded.ts --apply  (create the jobs)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const admin: SupabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const APPLY = process.argv.includes("--apply");

// statuses at or after הוקלט. Listed literally — 'בוטל' is the LAST value of
// the enum, so any ordinal comparison would sweep cancelled work into billing.
const AT_OR_AFTER = ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח", 'אושר_ע"י_לקוח', "הופץ"];

type Prod = {
  id: string; podcast_name: string | null; client_id: string | null; show_id: string | null;
  status: string; kind: string; record_date: string | null; price_override: number | null;
  cancelled_at: string | null; merged_into: string | null; legacy: boolean;
};

async function main() {
  const { data: prods } = await admin
    .from("productions")
    .select("id,podcast_name,client_id,show_id,status,kind,record_date,price_override,cancelled_at,merged_into,legacy");
  const { data: jp } = await admin.from("job_productions").select("job_id,production_id");
  const { data: jobs } = await admin
    .from("jobs")
    .select("id,client_id,campaign,amount,invoice_biz,invoice_tax,paid,dismissed");
  const { data: shows } = await admin.from("shows").select("id,default_rate");
  const { data: addons } = await admin.from("production_addons").select("production_id,status,total");
  const { data: clients } = await admin.from("clients").select("id,name");

  const linkedProd = new Set((jp ?? []).map((r) => r.production_id));
  const linkedJob = new Set((jp ?? []).map((r) => r.job_id));
  const rateOf = new Map((shows ?? []).map((s) => [s.id, s.default_rate as number | null]));
  const nameOf = new Map((clients ?? []).map((c) => [c.id, c.name as string]));
  const addonOf = new Map<string, number>();
  for (const a of addons ?? []) {
    if (a.status === "approved" && a.total !== null) {
      addonOf.set(a.production_id, (addonOf.get(a.production_id) ?? 0) + Number(a.total));
    }
  }
  const orphanJobs = (jobs ?? []).filter((j) => !linkedJob.has(j.id) && !j.dismissed);

  const stuck = ((prods ?? []) as Prod[]).filter(
    (p) =>
      AT_OR_AFTER.includes(p.status) && p.kind === "client" &&
      !p.cancelled_at && !p.merged_into && !linkedProd.has(p.id)
  );

  const clean: Prod[] = [];
  const holdBack: { p: Prod; why: string }[] = [];
  for (const p of stuck) {
    const base = p.price_override ?? rateOf.get(p.show_id ?? "") ?? null;
    const amt = base !== null ? Number(base) + (addonOf.get(p.id) ?? 0) : null;
    // an unlinked job of the same client at a matching amount may already BE
    // this episode, recorded by hand — never create a second one over it
    const suspects = orphanJobs.filter((j) => {
      if (j.client_id !== p.client_id) return false;
      if (amt === null || j.amount === null) return amt === null && j.amount === null;
      return Math.abs(Number(j.amount) - amt) <= Math.max(2, amt * 0.01);
    });
    if (suspects.length) holdBack.push({ p, why: `${suspects.length} unlinked job(s) match the amount` });
    else clean.push(p);
  }

  console.log("stuck productions: " + stuck.length +
    "  |  clean: " + clean.length + "  |  held back: " + holdBack.length);
  console.log("\n--- WILL " + (APPLY ? "CREATE" : "(dry run) create") + " a job for these ---");
  for (const p of clean) {
    console.log("  " + p.id + "  " + (nameOf.get(p.client_id ?? "") ?? "?").slice(0, 24).padEnd(25) +
      (p.podcast_name ?? "").slice(0, 30).padEnd(31) + p.status);
  }
  console.log("\n--- HELD BACK, untouched ---");
  for (const h of holdBack) {
    console.log("  " + (nameOf.get(h.p.client_id ?? "") ?? "?").slice(0, 24).padEnd(25) +
      (h.p.podcast_name ?? "").slice(0, 30).padEnd(31) + h.why);
  }

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply");
    return;
  }

  console.log("\n=== APPLYING ===");
  const created: { prod: Prod; jobId: string | null }[] = [];
  for (const p of clean) {
    const { data, error } = await admin.rpc("ensure_job_for_production", { p_id: p.id, p_reason: "backfill_0060" });
    if (error) {
      console.log("  ERROR " + p.podcast_name + ": " + error.message);
      created.push({ prod: p, jobId: null });
      continue;
    }
    console.log("  job " + String(data) + "  <- " + (p.podcast_name ?? "").slice(0, 34));
    created.push({ prod: p, jobId: (data as string) ?? null });
  }

  // ---- verification -------------------------------------------------------
  console.log("\n=== VERIFY ===");
  let bad = 0;
  const { data: jp2 } = await admin.from("job_productions").select("job_id,production_id");
  const byProd = new Map<string, string[]>();
  for (const r of jp2 ?? []) {
    byProd.set(r.production_id, [...(byProd.get(r.production_id) ?? []), r.job_id]);
  }
  for (const { prod, jobId } of created) {
    const links = byProd.get(prod.id) ?? [];
    if (links.length !== 1) {
      bad++;
      console.log("  FAIL " + prod.podcast_name + ": " + links.length + " job links (expected exactly 1)");
    } else if (jobId && links[0] !== jobId) {
      bad++;
      console.log("  FAIL " + prod.podcast_name + ": linked to " + links[0] + ", created " + jobId);
    }
  }
  console.log(bad === 0
    ? "  every backfilled production has exactly ONE job, correctly linked"
    : "  *** " + bad + " PROBLEMS ***");

  // no production anywhere holds two jobs
  const dupes: [string, string[]][] = [];
  byProd.forEach((v, k) => {
    if (v.length > 1) dupes.push([k, v]);
  });
  console.log(dupes.length === 0
    ? "  no production in the whole DB holds more than one job"
    : "  *** DUPLICATES: " + JSON.stringify(dupes) + " ***");

  // the held-back ones stayed untouched
  const stillUnlinked = holdBack.filter((h) => !byProd.has(h.p.id)).length;
  console.log("  held-back productions still without a job: " + stillUnlinked + "/" + holdBack.length +
    (stillUnlinked === holdBack.length ? "  (untouched, correct)" : "  *** ONE WAS TOUCHED ***"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
