/**
 * E17-3 — the one-time ח.פ backfill from Morning into `clients.tax_id` (0107).
 * Owner decision 11.10. THE OWNER RUNS THIS, not Claude.
 *
 * Run (report only — the default, writes NOTHING):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/backfill_tax_id.ts
 * Run (write the "יתעדכנו" rows, and only those):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/backfill_tax_id.ts --apply
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Morning: ONE read — `listClients()` (POST /clients/search, paginated,
 *     active Morning clients). No write to Morning, in either mode.
 *   · Our DB (via .env.local, service role): reads active, unmerged clients.
 *     With --apply only: `update clients set tax_id = … where id = … and
 *     tax_id is null`, plus one `client_tax_id_backfilled` event per row.
 *
 * The decisions are all in src/lib/clients/taxIdBackfill.ts (pure, tested in
 * scripts/test_tax_id_backfill.ts with a fake Morning). This file only wires
 * them to the network.
 *
 * 🔴 A conflict (one ח.פ for two of our clients, or for a client that already
 * holds another one) is REPORTED and written for nobody — see the header of
 * taxIdBackfill.ts. Resolve those by hand on the client card.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listClients } from "../src/lib/morning/client";
import {
  applyTaxIdBackfill,
  formatTaxIdBackfillReport,
  planTaxIdBackfill,
  type OurClientForBackfill,
} from "../src/lib/clients/taxIdBackfill";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const APPLY = process.argv.includes("--apply");

async function loadOurs(admin: SupabaseClient): Promise<OurClientForBackfill[]> {
  const out: OurClientForBackfill[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("clients")
      .select("id,name,morning_client_id,tax_id")
      .eq("status", "active")
      .is("merged_into", null)
      .order("name")
      .range(from, from + 999);
    if (error) throw new Error(`קריאת הלקוחות נכשלה: ${error.message}`);
    out.push(...((data ?? []) as OurClientForBackfill[]));
    if ((data ?? []).length < 1000) return out;
  }
}

async function main() {
  const admin: SupabaseClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const [ours, morning] = await Promise.all([loadOurs(admin), listClients()]);
  console.log(`נקראו ${ours.length} לקוחות פעילים אצלנו ו-${morning.length} לקוחות במורנינג.\n`);

  const plan = planTaxIdBackfill(
    ours,
    morning.map((m) => ({ id: m.id, name: m.name, taxId: m.taxId ?? null }))
  );
  for (const l of formatTaxIdBackfillReport(plan, APPLY)) console.log(l);

  if (!APPLY) {
    console.log("\nדוח בלבד — שום דבר לא נכתב. להרצה עם כתיבה: הוסף --apply");
    return;
  }

  const res = await applyTaxIdBackfill(admin, plan);
  console.log(`\nנכתבו: ${res.written.length} · דולגו: ${res.skipped.length} · נכשלו: ${res.failed.length}`);
  for (const s of res.skipped) console.log(`  דולג: client ${s.clientId} | ${s.taxId} | ${s.reason}`);
  for (const f of res.failed) console.log(`  נכשל: client ${f.clientId} | ${f.taxId} | ${f.error}`);
  if (res.failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
