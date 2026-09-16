/**
 * Rule (d) verification — READ ONLY. Runs the REAL findBilledEvidence against
 * the live database and prints what it would answer. Writes nothing.
 *
 * Run:  npx tsx scripts/verify_merge_guard.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { findBilledEvidence } from "../src/lib/documents/enqueue";

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

const DUP = "94d4a7ea-19cb-4ea8-b46a-e42821c02c6f";

async function probe(label: string, productionId: string) {
  const { data: p } = await admin
    .from("productions")
    .select("id,podcast_name,record_date,status,merged_into,clients(name)")
    .eq("id", productionId)
    .maybeSingle();
  const row = p as Record<string, unknown> | null;
  const res = await findBilledEvidence(admin, productionId);
  const client = (row?.clients as { name?: string } | null)?.name ?? "—";
  console.log(
    `\n── ${label}\n   ${productionId.slice(0, 8)} · ${client} · ${row?.podcast_name} · ${row?.record_date} · ${row?.status} · merged_into=${row?.merged_into ?? "NULL"}`
  );
  console.log(`   → ${res ? `BLOCK rule=${res.rule} · ${res.evidence}` : "null (no evidence — would queue)"}`);
  if (res) console.log(`   detail: ${JSON.stringify(res.detail)}`);
  return res;
}

(async () => {
  await probe("1. הכפילות שהמיזוג שלה בוטל (94d4a7ea)", DUP);

  // ---- productions with NO duplicate history ------------------------------
  // Drawn from client productions that carry no production_merged_duplicate
  // event. A rule a/b/c/c2 block on some of these is CORRECT behaviour and not
  // a failure of this test — the claim under test is narrower and exact:
  // rule (d) fires on NONE of them.
  const { data: mergeEvents } = await admin
    .from("events")
    .select("entity_id")
    .eq("event_type", "production_merged_duplicate");
  const known = new Set((mergeEvents ?? []).map((e) => e.entity_id as string));

  const { data: all } = await admin
    .from("productions")
    .select("id,podcast_name,record_date,status,clients(name)")
    .eq("kind", "client")
    .is("merged_into", null)
    .is("cancelled_at", null);
  const pool = ((all ?? []) as unknown as Array<Record<string, unknown>>).filter(
    (p) => !known.has(p.id as string)
  );
  // deterministic "random": every 7th row, so a re-run reports the same set
  const sample = pool.filter((_, i) => i % 7 === 0).slice(0, 10);

  console.log(`\n\n═══ 10 productions with no duplicate history (pool: ${pool.length}) ═══`);
  let ruleD = 0;
  for (const p of sample) {
    const res = await findBilledEvidence(admin, p.id as string);
    const client = (p.clients as { name?: string } | null)?.name ?? "—";
    if (res?.rule === "d") ruleD++;
    console.log(
      `  ${(p.id as string).slice(0, 8)} · ${client} · ${p.record_date} → ${res ? `rule=${res.rule} · ${res.evidence}` : "null"}`
    );
  }
  console.log(`\n  rule d fired on ${ruleD} / ${sample.length}  ${ruleD === 0 ? "✓" : "✗ UNEXPECTED"}`);
})();
