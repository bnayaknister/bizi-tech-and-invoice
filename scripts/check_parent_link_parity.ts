/**
 * Parity between the TWO parsers that write documents.parent_doc_numbers.
 *
 * Run:  npx tsx scripts/check_parent_link_parity.ts
 *
 * TOUCHES MORNING: never.
 * READ-ONLY: no writes of any kind. It reads every row of `documents` and
 * compares, in memory, what the shipped parser WOULD write against what is
 * actually stored.
 *
 * ---------------------------------------------------------------------------
 * WHEN TO RUN IT: any time either regex is touched — in
 * src/lib/documents/parentLink.ts, or in
 * supabase/migrations/0075_document_parent_links.sql. Both, or neither.
 *
 * WHAT IT PROVES, and why the risk is real enough to keep a script for.
 *
 * The same three patterns exist twice: once in PL/pgSQL, where 0075's backfill
 * used them to populate 1,094 existing rows, and once in TypeScript, where the
 * daily pull uses them on every row it upserts. They are not shared code and
 * cannot be — one runs in Postgres, one in Node.
 *
 * ONE CHARACTER ALREADY DIFFERS BY NECESSITY: Postgres spells the word boundary
 * `\y`, JavaScript spells it `\b`. So "identical" was never available; the only
 * available claim is "equivalent on the real corpus", and that is a measurement,
 * not something a reader can check by eye.
 *
 * The failure this guards against is silent and destructive, not merely a miss.
 * The pull re-parses and re-writes these columns on EVERY run (registry.ts
 * overwrites `raw` too, so the columns are derived, never edited). A regex that
 * drifts in the TypeScript copy therefore does not just stop finding new links —
 * it OVERWRITES, once a day, the links the SQL backfill got right, and nothing
 * anywhere raises an error. The numbers below are the tripwire.
 *
 * A FAIL means one of two things, and they are told apart by the divergence
 * list this prints: either a regex was edited on one side only, or the data
 * genuinely moved (Morning reworded a remark, a new document shape appeared).
 * The second is legitimate — but it means the expected counts here are stale
 * and must be re-measured deliberately, not adjusted until the script passes.
 *
 * Expected values measured 2026-09-09, immediately after 0075 was applied and
 * verified in production.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseParentLink } from "../src/lib/documents/parentLink";

// ---------------------------------------------------------------------------
// env + client
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

// ---------------------------------------------------------------------------
// the corpus — EVERY row, paginated
//
// PostgREST caps a response at 1,000 rows and says so in no way the caller can
// feel. Reading the default page would compare 1,000 of 1,094 documents and
// then report counts that are short — a FAIL that looks like a regex bug and is
// not one. Hence the explicit ranges, and the count assertion under them.
// ---------------------------------------------------------------------------
type Row = {
  morning_doc_number: string | null;
  source: string;
  remarks: string | null;
  parent_doc_numbers: string[] | null;
  parent_relation: string | null;
};

const PAGE = 1000;

async function main() {
const rows: Row[] = [];
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin
    .from("documents")
    .select("morning_doc_number,source,raw,parent_doc_numbers,parent_relation")
    .order("morning_doc_id")
    .range(from, from + PAGE - 1);
  if (error) throw new Error(`טעינת המסמכים נכשלה: ${error.message}`);
  if (!data?.length) break;
  for (const d of data) {
    const raw = d.raw as { remarks?: unknown } | null;
    rows.push({
      morning_doc_number: d.morning_doc_number as string | null,
      source: d.source as string,
      remarks: typeof raw?.remarks === "string" ? raw.remarks : null,
      parent_doc_numbers: d.parent_doc_numbers as string[] | null,
      parent_relation: d.parent_relation as string | null,
    });
  }
  if (data.length < PAGE) break;
}

const { count: liveCount } = await admin
  .from("documents")
  .select("*", { count: "exact", head: true });
if (liveCount != null && liveCount !== rows.length) {
  throw new Error(`נטענו ${rows.length} שורות מתוך ${liveCount} — הדפדוף לא הושלם, אל תסמוך על התוצאה`);
}

// ---------------------------------------------------------------------------
// the comparison — unchanged from the run that verified 0075 on 2026-09-09
// ---------------------------------------------------------------------------
let same = 0;
const diffs: { num: string | null; remarks: string | null; db: unknown; parsed: unknown }[] = [];
let derived = 0, derPull = 0, derApp = 0, cancel = 0, multi = 0;

for (const r of rows) {
  const p = parseParentLink(r.remarks);

  if (p) {
    if (p.parent_relation === "derived") {
      derived++;
      if (r.source === "pull") derPull++;
      if (r.source === "app") derApp++;
    } else cancel++;
    if (p.parent_doc_numbers.length > 1) multi++;
  }

  const dbNums = r.parent_doc_numbers === null ? null : JSON.stringify(r.parent_doc_numbers);
  const psNums = p === null ? null : JSON.stringify(p.parent_doc_numbers);
  const dbRel = r.parent_relation ?? null;
  const psRel = p?.parent_relation ?? null;

  if (dbNums === psNums && dbRel === psRel) same++;
  else diffs.push({ num: r.morning_doc_number, remarks: r.remarks, db: { dbNums, dbRel }, parsed: { psNums, psRel } });
}

console.log(`rows compared            : ${rows.length}`);
console.log(`identical to the backfill: ${same}`);
console.log(`ROWS THAT WOULD CHANGE   : ${diffs.length}`);
console.log("");
console.log(`derived   : ${derived}   (expected 640)`);
console.log(`  · pull  : ${derPull}   (expected 619)`);
console.log(`  · app   : ${derApp}   (expected 21)`);
console.log(`cancellation: ${cancel} (expected 5)`);
console.log(`multi-parent: ${multi}  (expected 23)`);

const ok =
  diffs.length === 0 && derived === 640 && derPull === 619 && derApp === 21 && cancel === 5 && multi === 23;
console.log("");
console.log(ok ? "PASS — parser reproduces the backfill exactly" : "FAIL");

if (diffs.length) {
  console.log("\nfirst 10 divergences:");
  for (const d of diffs.slice(0, 10)) console.log("  ", JSON.stringify(d, null, 1));
}
process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
