/**
 * E17-3 — the ח.פ backfill's decisions, with a fake Morning. Pure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_tax_id_backfill.ts
 *
 * ═══ F19 ═══
 * No database, no network, no Morning. `global.fetch` throws. Morning is a
 * plain array of the shape `listClients()` returns; the database for the
 * --apply half is a recorder that answers like PostgREST. The script itself
 * (scripts/backfill_tax_id.ts) is NOT run — it is the owner's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTaxIdBackfill,
  formatTaxIdBackfillReport,
  planTaxIdBackfill,
  type MorningClientForBackfill,
  type OurClientForBackfill,
} from "../src/lib/clients/taxIdBackfill";

global.fetch = (() => {
  throw new Error("F19: this suite must not perform any fetch");
}) as unknown as typeof fetch;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

// ── the fake Morning: every bucket at least once ────────────────────────────
const MORNING: MorningClientForBackfill[] = [
  { id: "m-ok", name: "תקין", taxId: "514000001" },
  { id: "m-space", name: "רווחים", taxId: "  514000002 " },
  { id: "m-none", name: "בלי", taxId: "" },
  { id: "m-undef", name: "בלי שדה" },
  { id: "m-short", name: "קצר", taxId: "12345" },
  { id: "m-dash", name: "מקף", taxId: "514-000-003" },
  { id: "m-shared", name: "משותף", taxId: "514000004" },
  { id: "m-twin-a", name: "תאום א", taxId: "514000005" },
  { id: "m-twin-b", name: "תאום ב", taxId: "514000005" },
  { id: "m-held", name: "שמור", taxId: "514000006" },
  { id: "m-same", name: "זהה", taxId: "514000007" },
  { id: "m-diff", name: "שונה", taxId: "514000008" },
];

const OURS: OurClientForBackfill[] = [
  { id: "c-ok", name: "א-תקין", morning_client_id: "m-ok", tax_id: null },
  { id: "c-space", name: "ב-רווחים", morning_client_id: "m-space", tax_id: null },
  { id: "c-none", name: "ג-בלי", morning_client_id: "m-none", tax_id: null },
  { id: "c-undef", name: "ד-בלי שדה", morning_client_id: "m-undef", tax_id: null },
  { id: "c-short", name: "ה-קצר", morning_client_id: "m-short", tax_id: null },
  { id: "c-dash", name: "ו-מקף", morning_client_id: "m-dash", tax_id: null },
  // two of ours mapped to ONE Morning client (legitimate since 0026) → one number, two cards
  { id: "c-shared-1", name: "ז-משותף 1", morning_client_id: "m-shared", tax_id: null },
  { id: "c-shared-2", name: "ח-משותף 2", morning_client_id: "m-shared", tax_id: null },
  // two DIFFERENT Morning clients that carry the same number → still one number, two cards
  { id: "c-twin-a", name: "ט-תאום א", morning_client_id: "m-twin-a", tax_id: null },
  { id: "c-twin-b", name: "י-תאום ב", morning_client_id: "m-twin-b", tax_id: null },
  // the number is free in Morning terms but another of ours already holds it
  { id: "c-held", name: "כ-שמור", morning_client_id: "m-held", tax_id: null },
  { id: "c-holder", name: "ל-מחזיק", morning_client_id: null, tax_id: "514000006" },
  { id: "c-same", name: "מ-זהה", morning_client_id: "m-same", tax_id: "514000007" },
  { id: "c-diff", name: "נ-שונה", morning_client_id: "m-diff", tax_id: "999999999" },
  { id: "c-gone", name: "ס-נעלם", morning_client_id: "m-gone", tax_id: null },
  { id: "c-unmapped", name: "ע-לא ממופה", morning_client_id: null, tax_id: null },
];

async function main() {
  const plan = planTaxIdBackfill(OURS, MORNING);

  console.log("\n── the buckets");
  check("יתעדכנו: the valid ones, trimmed", plan.update.map((u) => [u.clientId, u.taxId]), [
    ["c-ok", "514000001"],
    ["c-space", "514000002"],
  ]);
  check("אין ח.פ במורנינג: empty string and missing field", plan.noTaxId.map((u) => u.clientId), ["c-none", "c-undef"]);
  check("ח.פ לא תקין: short and dashed, raw value kept", plan.invalid.map((u) => [u.clientId, u.raw]), [
    ["c-short", "12345"],
    ["c-dash", "514-000-003"],
  ]);
  check("כבר מעודכן: an equal value is not an update", plan.alreadySet.map((u) => u.clientId), ["c-same"]);
  check("Morning did not return the id", plan.notInMorning.map((u) => u.clientId), ["c-gone"]);
  check("unmapped are counted, not looked up", plan.unmapped, 2);

  console.log("\n── 🔴 conflicts write nobody");
  const byTax = Object.fromEntries(plan.conflict.map((c) => [c.taxId, c]));
  check("shared Morning client → both cards in one conflict", [byTax["514000004"]?.reason, byTax["514000004"]?.clients.map((c) => c.clientId)], [
    "shared_by_our_clients",
    ["c-shared-1", "c-shared-2"],
  ]);
  check("two Morning clients, one number → both cards in one conflict", [byTax["514000005"]?.reason, byTax["514000005"]?.clients.map((c) => c.clientId)], [
    "shared_by_our_clients",
    ["c-twin-a", "c-twin-b"],
  ]);
  check("held by another of ours → names both", [byTax["514000006"]?.reason, byTax["514000006"]?.clients.map((c) => c.clientId)], [
    "held_by_other_client",
    ["c-held", "c-holder"],
  ]);
  check("a different existing value is never overwritten", [byTax["514000008"]?.reason, byTax["514000008"]?.clients[0].existing], [
    "differs_from_existing",
    "999999999",
  ]);
  const updated = new Set(plan.update.map((u) => u.clientId));
  const conflicted = plan.conflict.flatMap((c) => c.clients.map((x) => x.clientId));
  check("no conflicted client is in the update list", conflicted.filter((id) => updated.has(id)), []);
  check("no number is proposed twice", plan.update.length, new Set(plan.update.map((u) => u.taxId)).size);
  check("every mapped client lands in exactly one bucket", (() => {
    const all = [
      ...plan.update.map((u) => u.clientId),
      ...plan.noTaxId.map((u) => u.clientId),
      ...plan.invalid.map((u) => u.clientId),
      ...plan.alreadySet.map((u) => u.clientId),
      ...plan.notInMorning.map((u) => u.clientId),
      ...plan.conflict.flatMap((c) => c.clients.map((x) => x.clientId)).filter((id) => id !== "c-holder"),
    ];
    return [all.length, new Set(all).size];
  })(), [14, 14]);

  console.log("\n── the report");
  const report = formatTaxIdBackfillReport(plan, false);
  check("report mode says nothing is written", report[0].includes("דוח בלבד"), true);
  for (const label of ["יתעדכנו: 2", "אין ח.פ במורנינג: 2", "ח.פ לא תקין: 2", "התנגשות (לא נכתב לאף אחד): 4"]) {
    check(`summary line "${label}"`, report.filter((l) => l === label).length, 1);
  }
  check("apply mode says so", formatTaxIdBackfillReport(plan, true)[0].includes("--apply"), true);

  console.log("\n── --apply writes the update list and nothing else");
  {
    const calls: { table: string; op: string; payload?: unknown; filters: string[] }[] = [];
    // a row that someone filled meanwhile: the guarded update matches nothing
    const filledMeanwhile = new Set(["c-space"]);
    const from = (table: string) => {
      let op = "select";
      let payload: unknown;
      const filters: string[] = [];
      let id = "";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        update: (v: unknown) => ((op = "update"), (payload = v), b),
        insert: (v: unknown) => ((op = "insert"), (payload = v), b),
        eq: (c: string, v: string) => (filters.push(`${c}=${v}`), c === "id" && (id = v), b),
        is: (c: string, v: unknown) => (filters.push(`${c} is ${v}`), b),
        select: () => b,
        then: (res: (v: unknown) => unknown) => {
          calls.push({ table, op, payload, filters });
          const data = op === "update" ? (filledMeanwhile.has(id) ? [] : [{ id }]) : null;
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return b;
    };
    const res = await applyTaxIdBackfill({ from }, plan);
    const updates = calls.filter((c) => c.table === "clients" && c.op === "update");
    check("exactly one UPDATE per planned row", updates.length, plan.update.length);
    check("every UPDATE is guarded by tax_id is null", updates.every((u) => u.filters.includes("tax_id is null")), true);
    check("nothing conflicted was written", updates.filter((u) => conflicted.some((id) => u.filters.includes(`id=${id}`))).length, 0);
    check("written", res.written, [{ clientId: "c-ok", taxId: "514000001" }]);
    check("a row filled meanwhile is skipped, not overwritten", res.skipped.map((s) => s.clientId), ["c-space"]);
    check("one event per WRITTEN row only", calls.filter((c) => c.table === "events").length, 1);
  }

  console.log("\n── the script itself (read, never run)");
  {
    const src = readFileSync(join(__dirname, "backfill_tax_id.ts"), "utf8");
    check("writes only behind --apply", /if \(!APPLY\) \{[\s\S]*?return;/.test(src), true);
    check("the only write path is applyTaxIdBackfill", src.match(/\.(update|insert|upsert|delete)\(/g), null);
    check("reads Morning through listClients only", src.includes("listClients()") && !src.includes("createMorningClient") && !src.includes("updateClient"), true);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
