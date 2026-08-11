/**
 * Registry action-cell expectations — stage 4 stop point (owner 2026-08-11).
 *
 * Run:  npx tsx scripts/report_registry_buttons.ts
 *
 * READ-ONLY: no insert/update/delete, no Morning. Replays the exact logic
 * registry/page.tsx runs server-side — the same mapper (imported, not
 * re-implemented), the same pending-wins rule, the same job pre-checks, in
 * the same order — and prints the action-cell state every open 300 should
 * show. The owner compares this against the real screen.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { mapPullDocToSource, type PullDocRow } from "../src/lib/documents/pullSource";

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
  // every open 300 the screen will show, all sources — same filters as the page
  const { data: docs } = await admin
    .from("documents")
    .select("id,morning_doc_id,morning_doc_number,type,source,client_id,job_id,amount,cancelled_at,archived_at,raw,clients(name)")
    .eq("type", 300)
    .eq("status", 0)
    .is("cancelled_at", null)
    .is("archived_at", null)
    .order("morning_doc_number");
  const rows = (docs ?? []) as unknown as (PullDocRow & { clients: { name: string } | null })[];

  const { data: parentRows } = await admin
    .from("pending_documents")
    .select("id,morning_doc_id")
    .in("doc_type", ["work_order", "deal_invoice", "tax_invoice"])
    .eq("status", "issued")
    .not("morning_doc_id", "is", null);
  const pendingIdByMorningId = new Map<string, string>();
  for (const p of (parentRows ?? []) as { id: string; morning_doc_id: string }[]) {
    pendingIdByMorningId.set(p.morning_doc_id, p.id);
  }

  const jobIds = Array.from(new Set(rows.map((r) => r.job_id).filter(Boolean))) as string[];
  const taxedByJob = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobRows } = await admin.from("jobs").select("id,invoice_tax").in("id", jobIds);
    for (const j of (jobRows ?? []) as { id: string; invoice_tax: string | null }[]) {
      if (j.invoice_tax && String(j.invoice_tax).trim()) taxedByJob.set(j.id, String(j.invoice_tax));
    }
  }

  const counts = { pending: 0, raw: 0, blocked: 0 };
  console.log(`מסמכי 300 פתוחים במסך: ${rows.length}\n`);

  for (const d of rows) {
    const name = `#${d.morning_doc_number} | ${d.clients?.name ?? "—"} | ברוטו ${ils(d.amount)}`;
    if (d.morning_doc_id && pendingIdByMorningId.has(d.morning_doc_id)) {
      counts.pending++;
      console.log(`🟢 דלוק (pending) ${name}`);
      continue;
    }
    if (d.source !== "pull") {
      console.log(`⚪ ללא כפתור ${name} | source=${d.source} בלי שורת תור`);
      continue;
    }
    const res = mapPullDocToSource(d);
    if (!res.ok) {
      counts.blocked++;
      console.log(`🔒 מושבת ${name}`);
      console.log(`     tooltip: ${res.error}`);
      continue;
    }
    if (!d.job_id) {
      counts.blocked++;
      console.log(`🔒 מושבת ${name}`);
      console.log(`     tooltip: יש לשייך את המסמך לעבודה לפני יצירת חשבונית מס — כפתור "שייך ל-job" כאן בשורה`);
      continue;
    }
    const taxed = taxedByJob.get(d.job_id);
    if (taxed) {
      counts.blocked++;
      console.log(`🔒 מושבת ${name}`);
      console.log(`     tooltip: העבודה המקושרת כבר נושאת חשבונית מס ${taxed} — בדקי ברישום לפני הנפקה נוספת`);
      continue;
    }
    counts.raw++;
    console.log(`🟢 דלוק (raw) ${name} | במודל: סכום נטו ${ils(res.source.amount)} (ברוטו ${ils(d.amount)})`);
  }

  console.log("\n— סיכום —");
  console.log(`דלוקים מתור האישורים (pending): ${counts.pending}`);
  console.log(`דלוקים מהמשיכה (raw): ${counts.raw}`);
  console.log(`מושבתים עם הסבר: ${counts.blocked}`);
}

main().catch((e) => {
  console.error("report failed:", e);
  process.exit(1);
});
