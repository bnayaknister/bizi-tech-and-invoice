/**
 * B38-4 — the cut-over day (owner decision 6, 21.10).
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/b38_cutover.ts           # DRY RUN: lists, writes nothing
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/b38_cutover.ts --apply   # ⚠️ cancels the listed rows
 *
 * ⚠️ PRODUCTION DATABASE, through .env.local (service role). Run it right AFTER
 * WORK_ORDER_ON_RECORDED=true is live (set in Vercel + redeployed): from then
 * the sync queues no new per_episode orders, and this clears the ones it queued
 * before the switch for recordings that have not happened yet.
 *
 * What --apply does, and nothing else: for each listed row, pending_documents
 * status 'pending' -> 'cancelled' (the guard `status = 'pending'` is in the
 * UPDATE itself, so a row Shiri approved in the meantime is not touched), and
 * one event `document_cancelled_b38_cutover`. Nothing in Morning. Nothing on
 * productions or jobs. Each order is born again when its recording is marked
 * done (a 'cancelled' order counts as no order).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planCutover, type CutoverProduction, type CutoverRow } from "../src/lib/documents/b38Cutover";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^"|"$/g, "");
}

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
  const { data: rows, error } = await admin
    .from("pending_documents")
    .select("id,doc_type,status,production_id,amount")
    .eq("doc_type", "work_order")
    .eq("status", "pending");
  if (error) throw new Error(`קריאת התור נכשלה: ${error.message}`);
  const prodIds = Array.from(new Set((rows ?? []).map((r) => r.production_id).filter(Boolean))) as string[];
  const { data: prods, error: pErr } = prodIds.length
    ? await admin.from("productions").select("id,kind,status,cancelled_at,merged_into,podcast_name,record_date").in("id", prodIds)
    : { data: [], error: null };
  if (pErr) throw new Error(`קריאת ההפקות נכשלה: ${pErr.message}`);

  const plan = planCutover((rows ?? []) as CutoverRow[], (prods ?? []) as CutoverProduction[]);
  console.log(`B38-4 ${APPLY ? "APPLY" : "DRY RUN"} — הזמנות עבודה ממתינות בתור: ${(rows ?? []).length}`);
  console.log(`  לבטל (הקלטה שעוד לא סומנה "הוקלט"): ${plan.toCancel.length} · נשארות: ${plan.kept}`);
  for (const r of plan.toCancel) {
    console.log(`  · ${r.id}  ${r.production.podcast_name ?? "—"}  ${r.production.record_date ?? ""}  סטטוס הפקה: ${r.production.status}  סכום: ${r.amount}`);
  }
  if (!APPLY) {
    console.log("\n  הרצה יבשה — לא נכתב דבר. להחלה: --apply");
    return;
  }
  let done = 0;
  for (const r of plan.toCancel) {
    const { data: upd, error: uErr } = await admin
      .from("pending_documents")
      .update({ status: "cancelled" })
      .eq("id", r.id)
      .eq("status", "pending")
      .select("id");
    if (uErr) {
      console.error(`  ❌ ${r.id}: ${uErr.message}`);
      continue;
    }
    if (!upd || upd.length === 0) {
      console.log(`  ↷ ${r.id}: כבר לא 'pending' — לא נגעתי`);
      continue;
    }
    await admin.from("events").insert({
      entity_type: "pending_document",
      entity_id: r.id,
      event_type: "document_cancelled_b38_cutover",
      payload: { production_id: r.production_id, production_status: r.production.status, amount: r.amount },
    });
    done++;
  }
  console.log(`\n  בוטלו: ${done} / ${plan.toCancel.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
