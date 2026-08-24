/**
 * One-off (owner decision 2026-08-24): give a job to every episode currently
 * ACCRUED for the three monthly/every_n clients, so the September redemption
 * can convert its consolidated work order into a deal invoice.
 *
 * WHY THESE WERE HELD BACK BEFORE. The 0060 backfill skipped them: each client
 * owns unlinked jobs at a matching amount, and creating a job over one that
 * already represented the same episode would double-bill. The owner has now
 * resolved it: whatever sits in /documents/accrued is unpaid by definition —
 * the old paid jobs belong to earlier episodes that were already redeemed and
 * are not in the accrued set. Verified before this ran: no accrued episode
 * carries a paid or billed job, and every paid job of these clients is either
 * an orphan or linked to a production outside the accrued set.
 *
 * SAME MECHANISM. Every job is created by public.ensure_job_for_production —
 * the function the trigger calls. No INSERT into jobs or job_productions here.
 * Its duplicate guard makes this safe to re-run and makes סטימצקי (already
 * given a job by the 0060 backfill) a no-op.
 *
 * Run: npx tsx scripts/backfill_jobs_accrued_clients.ts          (report only)
 *      npx tsx scripts/backfill_jobs_accrued_clients.ts --apply
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
const CLIENT_FRAGMENTS = ["חתונמיות", "ברק", "סטימצקי"];

async function main() {
  const { data: clients } = await admin.from("clients").select("id,name,billing_cadence");
  const { data: jp } = await admin.from("job_productions").select("job_id,production_id");
  const linkedProd = new Set((jp ?? []).map((r) => r.production_id));

  const targets: { cid: string; cname: string; prodId: string; label: string; status: string; amount: number }[] = [];

  for (const frag of CLIENT_FRAGMENTS) {
    const c = (clients ?? []).find((x) => (x.name as string).includes(frag));
    if (!c) {
      console.log("!! client not found: " + frag);
      continue;
    }
    const { data: acc } = await admin
      .from("pending_documents")
      .select("id,production_id,amount")
      .eq("doc_type", "work_order")
      .eq("status", "accrued")
      .eq("client_id", c.id);
    for (const a of acc ?? []) {
      if (!a.production_id) continue;
      const { data: p } = await admin
        .from("productions")
        .select("id,podcast_name,guest,status,record_date,cancelled_at,merged_into,kind")
        .eq("id", a.production_id)
        .single();
      targets.push({
        cid: c.id as string,
        cname: c.name as string,
        prodId: a.production_id as string,
        label: ((p?.podcast_name as string) ?? "") + (p?.guest ? " / " + p.guest : "") + "  " + (p?.record_date ?? ""),
        status: (p?.status as string) ?? "?",
        amount: Number(a.amount ?? 0),
      });
    }
  }

  console.log("accrued episodes across the three clients: " + targets.length);
  console.log("\n%-24s %-40s %-20s %-7s %s".replace(/%-?\d*s/g, (m) => m), "");
  for (const t of targets) {
    const already = linkedProd.has(t.prodId);
    console.log("  " + t.cname.slice(0, 20).padEnd(21) + t.label.slice(0, 38).padEnd(39) +
      t.status.padEnd(20) + String(t.amount).padEnd(6) +
      (already ? "ALREADY HAS A JOB -> guard makes it a no-op" : "will create"));
  }

  if (!APPLY) {
    console.log("\ndry run — nothing written. Re-run with --apply");
    return;
  }

  console.log("\n=== APPLYING (via ensure_job_for_production) ===");
  for (const t of targets) {
    const { data, error } = await admin.rpc("ensure_job_for_production", {
      p_id: t.prodId,
      p_reason: "accrued_prep_2026_09",
    });
    if (error) {
      console.log("  ERROR " + t.label + ": " + error.message);
      continue;
    }
    console.log("  " + (data ? "job " + String(data) : "no-op (guard)  ") + "  <- " + t.label.slice(0, 44));
  }

  // ---- verify --------------------------------------------------------------
  console.log("\n=== VERIFY ===");
  const { data: jp2 } = await admin.from("job_productions").select("job_id,production_id");
  const byProd = new Map<string, string[]>();
  for (const r of jp2 ?? []) byProd.set(r.production_id, [...(byProd.get(r.production_id) ?? []), r.job_id]);

  let bad = 0;
  for (const t of targets) {
    const links = byProd.get(t.prodId) ?? [];
    if (links.length !== 1) {
      bad++;
      console.log("  FAIL " + t.label + ": " + links.length + " job links (expected exactly 1)");
    }
  }
  console.log(bad === 0 ? "  every accrued episode has exactly ONE linked job" : "  *** " + bad + " PROBLEMS ***");

  const dupes: string[] = [];
  byProd.forEach((v, k) => {
    if (v.length > 1) dupes.push(k + " -> " + JSON.stringify(v));
  });
  console.log(dupes.length === 0
    ? "  no production in the DB holds more than one job"
    : "  pre-existing duplicates (not created here): " + JSON.stringify(dupes));

  // the old paid jobs must be exactly where they were
  console.log("\n  old paid/billed jobs of these clients — unchanged?");
  for (const frag of CLIENT_FRAGMENTS) {
    const c = (clients ?? []).find((x) => (x.name as string).includes(frag));
    if (!c) continue;
    const { data: js } = await admin
      .from("jobs")
      .select("id,campaign,amount,invoice_biz,paid,notes")
      .eq("client_id", c.id);
    for (const j of js ?? []) {
      const isNew = (j.notes ?? "").includes("accrued_prep_2026_09");
      if (isNew) continue;
      const linkedTo = (jp2 ?? []).filter((r) => r.job_id === j.id).map((r) => r.production_id);
      const touchesAccrued = linkedTo.some((p) => targets.some((t) => t.prodId === p));
      console.log("    " + (c.name as string).slice(0, 14).padEnd(15) + (j.campaign ?? "").slice(0, 22).padEnd(23) +
        "paid=" + String(j.paid).padEnd(9) + "biz=" + String(j.invoice_biz).padEnd(8) +
        (touchesAccrued ? "*** NOW ON AN ACCRUED EPISODE ***" : "untouched"));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
