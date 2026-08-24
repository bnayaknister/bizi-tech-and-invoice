/**
 * One-off (owner approved 2026-08-24): remove the single job that was created
 * for an episode which had not been recorded.
 *
 * WHICH ONE AND WHY ONLY THIS ONE. 8b67c959 — חתונמיות / דנה ספקטור,
 * record_date 2026-08-24, production still עתיד_להתחיל. It was created by
 * backfill_jobs_accrued_clients.ts a few hours earlier, before migration 0061
 * taught ensure_job_for_production to refuse an unrecorded episode. It is
 * therefore ours, and it is a mistake we can attribute.
 *
 * NINE jobs in total sit on unrecorded productions. The other EIGHT were
 * created 2026-07-12 and 2026-07-30, long before any of this work, and one of
 * them (a55b3269) carries invoice_biz 40217 and paid=כן — deleting that would
 * erase work that was already billed and paid. They are a separate decision
 * and this script must never widen to include them: the id is hard-coded, not
 * discovered by a query.
 *
 * The client_approved_job_created event on the production is deliberately
 * KEPT — it is a true record of what happened. A deletion event is added
 * beside it so the log reads as a correction rather than a disappearance.
 *
 * Run: npx tsx scripts/delete_premature_job_dana.ts          (report only)
 *      npx tsx scripts/delete_premature_job_dana.ts --apply
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
// hard-coded on purpose — see the header. Never derive this from a query.
const JOB_ID = "8b67c959-7ff7-49c6-a0ce-1d6c7141f3eb";

async function main() {
  const { data: job } = await admin
    .from("jobs")
    .select("id,client_id,campaign,amount,date,invoice_biz,invoice_tax,paid,dismissed,notes")
    .eq("id", JOB_ID)
    .maybeSingle();
  if (!job) {
    console.log("job " + JOB_ID + " does not exist — nothing to do (already removed?)");
    return;
  }
  console.log("target job:", JSON.stringify(job, null, 2));

  const { data: links } = await admin
    .from("job_productions")
    .select("job_id,production_id")
    .eq("job_id", JOB_ID);
  const prodId = (links ?? [])[0]?.production_id as string | undefined;
  const { data: prod } = prodId
    ? await admin
        .from("productions")
        .select("id,podcast_name,guest,status,record_date,cancelled_at")
        .eq("id", prodId)
        .maybeSingle()
    : { data: null };
  console.log("linked production:", JSON.stringify(prod));

  // ---- safety: refuse if anything issued points at this job ---------------
  const refs: [string, number][] = [];
  const [d1, d2, p1, p2, inv, ms] = await Promise.all([
    admin.from("documents").select("id").eq("job_id", JOB_ID),
    admin.from("documents").select("id").contains("bundle_job_ids", [JOB_ID]),
    admin.from("pending_documents").select("id").eq("job_id", JOB_ID),
    admin.from("pending_documents").select("id").contains("bundle_job_ids", [JOB_ID]),
    admin.from("invoices").select("id").eq("job_id", JOB_ID),
    admin.from("contract_milestones").select("id").eq("job_id", JOB_ID),
  ]);
  refs.push(["documents.job_id", (d1.data ?? []).length]);
  refs.push(["documents.bundle_job_ids", (d2.data ?? []).length]);
  refs.push(["pending_documents.job_id", (p1.data ?? []).length]);
  refs.push(["pending_documents.bundle_job_ids", (p2.data ?? []).length]);
  refs.push(["invoices.job_id", (inv.data ?? []).length]);
  refs.push(["contract_milestones.job_id", (ms.data ?? []).length]);

  console.log("\nreferences:");
  let blockers = 0;
  for (const [label, n] of refs) {
    if (n) blockers += n;
    console.log("  " + label.padEnd(34) + n + (n ? "   *** BLOCKS ***" : ""));
  }
  const billed = (job.invoice_biz ?? "").toString().trim() || (job.invoice_tax ?? "").toString().trim();
  if (billed) {
    blockers++;
    console.log("  job carries an invoice number      *** BLOCKS ***");
  }
  if (job.paid === "כן") {
    blockers++;
    console.log("  job is marked paid                 *** BLOCKS ***");
  }
  if (prod && !["עתיד_להתחיל", "בהקלטה"].includes(prod.status as string)) {
    blockers++;
    console.log("  production has been recorded (" + prod.status + ")  *** BLOCKS ***");
  }

  if (blockers) {
    console.log("\nREFUSING — " + blockers + " blocker(s). Nothing deleted.");
    process.exitCode = 1;
    return;
  }
  console.log("\nsafe to delete: no issued document references it, not billed, not paid," +
    " production still unrecorded");

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply");
    return;
  }

  console.log("\n=== APPLYING ===");
  // the correction is logged BEFORE the row disappears, so the event carries
  // the facts even if the delete fails
  if (prodId) {
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: prodId,
      event_type: "job_removed_not_recorded",
      actor_id: null,
      payload: {
        production_id: prodId,
        job_id: JOB_ID,
        campaign: job.campaign,
        amount: job.amount,
        production_status: prod?.status ?? null,
        reason:
          "נוצר במילוי אחורה 24.8 על פרק שטרם הוקלט. מיגרציה 0061 מונעת זאת מכאן והלאה; " +
          "העבודה תיווצר מחדש כשהפרק יעבור להוקלט.",
      },
    });
    console.log("  logged job_removed_not_recorded on production " + prodId.slice(0, 8));
  }

  const { error: linkErr } = await admin.from("job_productions").delete().eq("job_id", JOB_ID);
  if (linkErr) {
    console.log("  job_productions delete failed: " + linkErr.message);
    process.exitCode = 1;
    return;
  }
  const { error: jobErr } = await admin.from("jobs").delete().eq("id", JOB_ID);
  if (jobErr) {
    console.log("  jobs delete failed: " + jobErr.message);
    process.exitCode = 1;
    return;
  }

  // ---- verify -------------------------------------------------------------
  const { data: gone } = await admin.from("jobs").select("id").eq("id", JOB_ID);
  const { data: linkGone } = await admin.from("job_productions").select("job_id").eq("job_id", JOB_ID);
  console.log("  job removed, verified:      " + ((gone ?? []).length === 0));
  console.log("  link removed, verified:     " + ((linkGone ?? []).length === 0));

  // the eight historical ones must be exactly where they were
  const HISTORICAL = [
    "a55b3269", "07ea2ec5", "f80d2252", "e9eb2d91",
    "36d2720c", "61a702c0", "466b195c", "644e9d34",
  ];
  const { data: stillThere } = await admin.from("jobs").select("id,campaign,invoice_biz,paid");
  const surviving = (stillThere ?? []).filter((j) => HISTORICAL.some((h) => (j.id as string).startsWith(h)));
  console.log("  historical jobs untouched:  " + surviving.length + "/8");
  for (const s of surviving) {
    console.log("     " + (s.id as string).slice(0, 8) + "  " + (s.campaign ?? "").slice(0, 24).padEnd(25) +
      "biz=" + s.invoice_biz + " paid=" + s.paid);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
