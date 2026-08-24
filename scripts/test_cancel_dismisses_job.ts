/**
 * Cancelling a recorded episode hides its job — unless the job was billed or
 * paid (owner 2026-08-25).
 *
 * Exercises the logic in productions/[id]/cancel/route.ts directly against the
 * DB rather than over HTTP: the route's own permission gate is covered by
 * test_cancel_permissions.py with real identities, and what needs proving here
 * is the job-side behaviour and its guard.
 *
 * Every row is synthetic and removed in `finally`, LIFO, verified. No real
 * production is cancelled and no real job is touched.
 *
 * Run: npx tsx scripts/test_cancel_dismisses_job.ts
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

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    failures.push(name + (detail ? " -- " + detail : ""));
    console.log("  FAIL  " + name + (detail ? "  -- " + detail : ""));
  }
}

const createdProductions: string[] = [];
const createdJobs: string[] = [];
const createdShows: string[] = [];
const createdClients: string[] = [];

async function fixture(label: string, jobOpts: { invoice_biz?: string; paid?: string } = {}) {
  const cname = "ZTESTCX client " + label + " " + Math.floor(performance.now() * 1000);
  const { data: c } = await admin
    .from("clients")
    .insert({ name: cname, normalized_name: cname.toLowerCase() })
    .select("id")
    .single();
  createdClients.push(c!.id);
  const { data: s } = await admin
    .from("shows")
    .insert({ name: "ZTESTCX show " + label, client_id: c!.id, default_rate: 600 })
    .select("id")
    .single();
  createdShows.push(s!.id);
  const { data: p } = await admin
    .from("productions")
    .insert({
      podcast_name: "ZTESTCX " + label, client_id: c!.id, show_id: s!.id,
      kind: "client", record_date: "2026-08-25", status: "הוקלט",
    })
    .select("id")
    .single();
  createdProductions.push(p!.id);
  const { data: j } = await admin
    .from("jobs")
    .insert({
      client_id: c!.id, campaign: "ZTESTCX " + label, amount: 600, date: "2026-08-25",
      ...jobOpts,
    })
    .select("id")
    .single();
  createdJobs.push(j!.id);
  await admin.from("job_productions").insert({ job_id: j!.id, production_id: p!.id });
  return { prodId: p!.id, jobId: j!.id };
}

/** the route's job-side logic, run as the service role (as the route does) */
async function cancelJobSide(prodId: string, reason: string) {
  const { data: links } = await admin.from("job_productions").select("job_id").eq("production_id", prodId);
  const ids = (links ?? []).map((r) => r.job_id as string);
  let dismissedJobs = 0;
  let orphanedJobs = 0;
  if (ids.length) {
    const { data: rows } = await admin
      .from("jobs")
      .select("id,campaign,amount,invoice_biz,invoice_tax,paid,dismissed")
      .in("id", ids);
    for (const j of rows ?? []) {
      const billed = !!(j.invoice_biz ?? "").trim() || !!(j.invoice_tax ?? "").trim();
      if (billed || j.paid === "כן") {
        orphanedJobs++;
        await admin.from("events").insert({
          entity_type: "job", entity_id: j.id, event_type: "job_orphaned_by_cancel", actor_id: null,
          payload: { production_id: prodId, campaign: j.campaign, amount: j.amount, reason },
        });
        continue;
      }
      if (j.dismissed) continue;
      await admin.from("jobs").update({
        dismissed: true, dismiss_reason: `ההפקה בוטלה: ${reason}`, dismissed_at: new Date().toISOString(),
      }).eq("id", j.id);
      dismissedJobs++;
      await admin.from("events").insert({
        entity_type: "job", entity_id: j.id, event_type: "job_dismissed", actor_id: null,
        payload: { reason: `ההפקה בוטלה: ${reason}`, amount: j.amount, via: "production_cancel", production_id: prodId },
      });
    }
  }
  return { dismissedJobs, orphanedJobs };
}

async function main() {
  console.log("\n=== 1. a CLEAN job is dismissed, with the cancellation reason ===");
  const clean = await fixture("clean");
  const r1 = await cancelJobSide(clean.prodId, "הלקוח ביטל את הפרק");
  check("counted as dismissed", r1.dismissedJobs === 1 && r1.orphanedJobs === 0, JSON.stringify(r1));
  const { data: j1 } = await admin
    .from("jobs")
    .select("dismissed,dismiss_reason,dismissed_at")
    .eq("id", clean.jobId)
    .single();
  check("job.dismissed = true", j1!.dismissed === true, JSON.stringify(j1));
  check("reason inherits the cancellation reason",
    (j1!.dismiss_reason as string).includes("הלקוח ביטל את הפרק"), String(j1!.dismiss_reason));
  const { data: e1 } = await admin
    .from("events")
    .select("event_type,payload")
    .eq("entity_id", clean.jobId)
    .eq("event_type", "job_dismissed");
  check("a job_dismissed event was written, tagged via=production_cancel",
    (e1 ?? []).length === 1 && (e1 ?? [])[0].payload?.via === "production_cancel", JSON.stringify(e1));

  console.log("\n=== 2. a BILLED job is NOT touched, only flagged ===");
  const billed = await fixture("billed", { invoice_biz: "40997" });
  const r2 = await cancelJobSide(billed.prodId, "בוטל אחרי חיוב");
  check("counted as orphaned, not dismissed", r2.orphanedJobs === 1 && r2.dismissedJobs === 0, JSON.stringify(r2));
  const { data: j2 } = await admin
    .from("jobs")
    .select("dismissed,invoice_biz")
    .eq("id", billed.jobId)
    .single();
  check("job.dismissed stays FALSE — the debt remains visible", j2!.dismissed === false, JSON.stringify(j2));
  check("invoice_biz untouched", j2!.invoice_biz === "40997", String(j2!.invoice_biz));
  const { data: e2 } = await admin
    .from("events")
    .select("event_type")
    .eq("entity_id", billed.jobId)
    .eq("event_type", "job_orphaned_by_cancel");
  check("job_orphaned_by_cancel written instead", (e2 ?? []).length === 1, JSON.stringify(e2));

  console.log("\n=== 3. a PAID job is NOT touched either ===");
  const paid = await fixture("paid", { paid: "כן" });
  const r3 = await cancelJobSide(paid.prodId, "בוטל אחרי תשלום");
  check("counted as orphaned", r3.orphanedJobs === 1 && r3.dismissedJobs === 0, JSON.stringify(r3));
  const { data: j3 } = await admin.from("jobs").select("dismissed,paid").eq("id", paid.jobId).single();
  check("still visible and still paid", j3!.dismissed === false && j3!.paid === "כן", JSON.stringify(j3));

  console.log("\n=== 4. an ALREADY-dismissed job is left alone (no double event) ===");
  const twice = await fixture("twice");
  await cancelJobSide(twice.prodId, "פעם ראשונה");
  const r4 = await cancelJobSide(twice.prodId, "פעם שנייה");
  check("second pass counts nothing", r4.dismissedJobs === 0 && r4.orphanedJobs === 0, JSON.stringify(r4));
  const { data: e4 } = await admin
    .from("events")
    .select("id")
    .eq("entity_id", twice.jobId)
    .eq("event_type", "job_dismissed");
  check("exactly one job_dismissed event", (e4 ?? []).length === 1, String((e4 ?? []).length));

  console.log("\n=== 5. the 15 real cancelled productions were not touched ===");
  const { data: realDead } = await admin
    .from("productions")
    .select("id")
    .not("cancelled_at", "is", null);
  const realIds = (realDead ?? []).map((p) => p.id).filter((id) => !createdProductions.includes(id));
  const { data: realLinks } = realIds.length
    ? await admin.from("job_productions").select("job_id,production_id").in("production_id", realIds)
    : { data: [] };
  const realJobIds = (realLinks ?? []).map((r) => r.job_id as string);
  const { data: realJobs } = realJobIds.length
    ? await admin.from("jobs").select("id,dismissed,dismiss_reason").in("id", realJobIds)
    : { data: [] };
  console.log("     real cancelled productions: " + realIds.length +
    ", their jobs: " + (realJobs ?? []).length);
  const touched = (realJobs ?? []).filter((j) => (j.dismiss_reason ?? "").includes("ההפקה בוטלה:"));
  check("no real job carries a reason written by this run", touched.length === 0,
    JSON.stringify(touched));
}

main()
  .catch((e) => {
    failures.push("THREW: " + (e as Error).message);
    console.error(e);
  })
  .finally(async () => {
    console.log("\n=== CLEANUP (LIFO) ===");
    for (const id of [...createdJobs].reverse()) {
      await admin.from("job_productions").delete().eq("job_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("jobs").delete().eq("id", id);
    }
    for (const id of [...createdProductions].reverse()) {
      await admin.from("job_productions").delete().eq("production_id", id);
      await admin.from("stages").delete().eq("production_id", id);
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("productions").delete().eq("id", id);
    }
    for (const id of [...createdShows].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("shows").delete().eq("id", id);
    }
    for (const id of [...createdClients].reverse()) {
      await admin.from("events").delete().eq("entity_id", id);
      await admin.from("clients").delete().eq("id", id);
    }
    let leaked = 0;
    for (const [table, ids] of [
      ["jobs", createdJobs], ["productions", createdProductions],
      ["shows", createdShows], ["clients", createdClients],
    ] as [string, string[]][]) {
      if (!ids.length) continue;
      const { data } = await admin.from(table).select("id").in("id", ids);
      if ((data ?? []).length) {
        leaked += (data ?? []).length;
        console.log("  LEAKED in " + table + ": " + (data ?? []).length);
      }
    }
    console.log(leaked === 0 ? "  all test rows deleted, verified" : "  *** " + leaked + " ROWS LEAKED ***");
    console.log("\n=== RESULT ===");
    console.log("passed: " + pass + ", failed: " + failures.length);
    for (const f of failures) console.log("  - " + f);
    process.exit(failures.length || leaked ? 1 : 0);
  });
