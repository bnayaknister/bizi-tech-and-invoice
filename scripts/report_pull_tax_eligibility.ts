/**
 * Pull -> tax eligibility report — stage 1 stop point (owner spec 2026-08-11).
 *
 * Run:  npx tsx scripts/report_pull_tax_eligibility.ts
 *
 * READ-ONLY BY CONSTRUCTION: this script holds no insert/update/delete and
 * never touches Morning — it reads `documents` and `jobs` from Supabase and
 * judges each row with the REAL mapper (src/lib/documents/pullSource.ts),
 * imported, not re-implemented. That import is the point: a Python replica of
 * the gates would test the replica; this tests the code that will ship.
 *
 * What it answers, per open deal invoice (type 300, status 0, not
 * cancelled/archived — ALL sources, so the source gate is exercised too):
 *   • does the mapper accept it, and on what grounds does it refuse
 *   • the mapped income lines, and the computed net vs Morning's own
 *     amountExcludeVat (the two independent derivations that must agree)
 *   • whether a job is linked — the builder's jobs gate will demand one, and
 *     the modal will disable the button up front rather than serve a 409
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mapPullDocToSource, PULL_NET_CEILING, type PullDocRow } from "../src/lib/documents/pullSource";

// ---------------------------------------------------------------------------
// env + client (same pattern as test_tax_from_parent.ts)
// ---------------------------------------------------------------------------
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

const ils = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : `${n.toLocaleString("he-IL")} ₪`;

async function main() {
  // every open 300, all sources — the app-issued one should be refused by the
  // source gate, which is itself part of what this report verifies
  const { data: docs, error } = await admin
    .from("documents")
    .select("id,morning_doc_id,morning_doc_number,type,source,client_id,job_id,amount,cancelled_at,archived_at,raw,clients(name)")
    .eq("type", 300)
    .eq("status", 0)
    .is("cancelled_at", null)
    .is("archived_at", null)
    .order("morning_doc_number");
  if (error) throw new Error(error.message);
  const rows = (docs ?? []) as unknown as (PullDocRow & { clients: { name: string } | null })[];

  const jobIds = rows.map((r) => r.job_id).filter(Boolean) as string[];
  const jobs = new Map<string, { campaign: string | null; amount: number | null; invoice_biz: string | null; invoice_tax: string | null; paid: string | null }>();
  if (jobIds.length) {
    const { data: jobRows } = await admin
      .from("jobs")
      .select("id,campaign,amount,invoice_biz,invoice_tax,paid")
      .in("id", jobIds);
    for (const j of jobRows ?? []) jobs.set(j.id as string, j as never);
  }

  let eligible = 0;
  let awaitingJob = 0;
  let refused = 0;

  console.log(`מסמכי 300 פתוחים: ${rows.length} (תקרת מסלול: ${ils(PULL_NET_CEILING)} נטו)\n`);

  for (const d of rows) {
    const clientName = d.clients?.name ?? "—";
    const head = `#${d.morning_doc_number} | ${clientName} | ברוטו ${ils(d.amount)} | source=${d.source}`;
    const res = mapPullDocToSource(d);

    if (!res.ok) {
      refused++;
      console.log(`✗ ${head}`);
      console.log(`    נדחה: ${res.error}\n`);
      continue;
    }

    const s = res.source;
    const aev = (d.raw as { amountExcludeVat?: number } | null)?.amountExcludeVat;
    const job = s.job_id ? jobs.get(s.job_id) : null;
    const verdict = s.job_id ? "✓ כשיר" : "◌ ממתין לשיוך job";
    if (s.job_id) eligible++;
    else awaitingJob++;

    console.log(`${verdict} ${head}`);
    console.log(`    נטו ממופה ${ils(s.amount)} | amountExcludeVat של מורנינג ${ils(aev)} | לקוח מורנינג ${s.morning_client_id}`);
    for (const l of s.income) {
      console.log(`    · ${l.description} | qty ${l.quantity} × ${ils(l.price)} | vatType ${l.vatType}`);
    }
    if (job) {
      console.log(`    job: ${job.campaign ?? "—"} | סכום ${ils(job.amount)} | biz=${job.invoice_biz ?? "—"} | tax=${job.invoice_tax ?? "—"} | שולם: ${job.paid ?? "—"}`);
    } else if (!s.job_id) {
      console.log(`    יש לשייך את המסמך לעבודה לפני יצירת חשבונית מס (כפתור "שייך ל-job" ברישום)`);
    }
    console.log("");
  }

  console.log("— סיכום —");
  console.log(`כשירים מיידית: ${eligible}`);
  console.log(`ממתינים לשיוך job: ${awaitingJob}`);
  console.log(`נדחו בשערים: ${refused}`);
}

main().catch((e) => {
  console.error("report failed:", e);
  process.exit(1);
});
