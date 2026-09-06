/**
 * resolveParentWorkOrderLink — the five gates, against live rows.
 *
 * Run:  npx tsx scripts/test_parent_work_order_link.ts
 *
 * TOUCHES MORNING: never.
 * READ-ONLY: no writes of any kind.
 *
 * The resolver decides whether a deal invoice may be issued "on the basis of"
 * its production's work order, which is what makes Morning close that order.
 * Its only caller is issuePendingDocument, and the only way to reach these
 * gates through that caller is to issue a document — so the decision is
 * testable in isolation or not at all. Hence the export, and hence this script.
 *
 * It creates nothing and therefore cleans up nothing: the resolver runs three
 * SELECTs (pending_documents by production, pending_documents by
 * consolidated_into, documents by morning_doc_id) and returns a verdict. The
 * fixtures are real production ids surveyed on 2026-09-06, one or two per
 * reachable category.
 *
 * ⚠️ Because the fixtures are live rows and not seeded ones, a FAIL here can
 * mean the resolver broke OR that the row moved on — a work order closed in
 * Morning since the survey, a redemption folded another episode. The expected
 * value of each fixture is printed beside the actual so the two are told apart
 * by reading, not by guessing.
 *
 * Six of the eleven verdicts are NOT reachable this way; they are listed at the
 * end of the run rather than left to be discovered as a coverage gap later.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveParentWorkOrderLink, type ParentLink } from "../src/lib/documents/issue";

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
// fixtures — live production ids, surveyed 2026-09-06
// ---------------------------------------------------------------------------
type Case = {
  label: string;
  productionId: string;
  note: string;
  /** null = expect linked:true; a string = expect that skip_reason */
  expectSkip: string | null;
  /** checked only when set, against ParentLink.detail */
  expectDetail?: string;
  /** checked only when set, against the linked order's Morning number */
  expectWorkOrder?: string;
};

const CASES: Case[] = [
  // ---- 1. the whole point: an open order, linkable -------------------------
  {
    label: "LINKED · מישל רילז",
    productionId: "0542bb00-77df-4a6b-a61a-04da0f4cda06",
    note: "work order 10313, open in Morning (status 0)",
    expectSkip: null,
    expectWorkOrder: "10313",
  },
  {
    label: "LINKED · ואם נחיה לנצח (מלי)",
    productionId: "56109613-e255-4db9-b268-1474e508ce6b",
    note: "work order 10315, open in Morning (status 0)",
    expectSkip: null,
    expectWorkOrder: "10315",
  },

  // ---- 2. gate 5, BOTH branches -------------------------------------------
  // 1 = נסגר אוטומטית, 2 = נסגר ידנית. Both must refuse, and the detail must
  // carry which — "closed" alone would not tell the bookkeeper who closed it.
  {
    label: "CLOSED(2) · אולמדיה",
    productionId: "1beacaa2-1aef-4db5-805e-cb76090ee1b6",
    note: "work order 10293, closed by hand in Morning",
    expectSkip: "work_order_closed_in_morning",
    expectDetail: "2",
  },
  {
    label: "CLOSED(1) · עופר גולן",
    productionId: "25198c70-acc1-4adb-be0f-9b5026c7453a",
    note: "work order 10314, closed automatically by its own linked invoice",
    expectSkip: "work_order_closed_in_morning",
    expectDetail: "1",
  },

  // ---- 3. THE CRITICAL GATE ------------------------------------------------
  // A folded episode. Its order was consolidated into 10323, which covers four
  // episodes. Linking one episode's invoice there would close all four.
  {
    label: "CONSOLIDATED · חתונמיות",
    productionId: "2a4b6ee6-abc6-4612-8b97-7cc45ef38570",
    note: "own order folded into consolidated 10323 (4 episodes)",
    expectSkip: "work_order_consolidated",
  },
  {
    label: "CONSOLIDATED · חתונמיות",
    productionId: "5a95ffb6-3173-4158-bc7b-83802c0715ec",
    note: "own order folded into consolidated 10323 (4 episodes)",
    expectSkip: "work_order_consolidated",
  },

  // ---- 4. never issued -----------------------------------------------------
  {
    label: "NOT_ISSUED(accrued) · ברק",
    productionId: "2cad08c8-7031-4a06-9125-3abc6645b9f4",
    note: "monthly client, order frozen until redemption — no morning_doc_id",
    expectSkip: "work_order_not_issued",
    expectDetail: "accrued",
  },
  {
    label: "NOT_ISSUED(cancelled)",
    productionId: "1928ca57-c0df-486f-8b3b-42a38b6aeb14",
    note: "order cancelled, never reached Morning",
    expectSkip: "work_order_not_issued",
    expectDetail: "cancelled",
  },

  // ---- 5. no order at all --------------------------------------------------
  {
    label: "NO_WORK_ORDER · סופרסונאס",
    productionId: "283c93fc-aa3a-478d-9c93-e4cb83fd2c8b",
    note: "future episode, nothing queued yet",
    expectSkip: "no_work_order",
  },
];

// verdicts this script cannot reach, and why. Printed on every run so the gap
// is a documented fact rather than something rediscovered later.
const UNCOVERED: [string, string][] = [
  ["work_order_dry_run", "0 rows carry a 'dry-' morning_doc_id in this database"],
  [
    "work_order_is_consolidation_parent",
    "UNREACHABLE BY CONSTRUCTION — a fold parent carries production_id NULL, so the resolver's own query can never return one. Belt-and-braces gate; only synthetic rows can exercise it",
  ],
  ["work_order_without_morning_id", "every issued order in this database has one"],
  ["work_order_status_unknown", "0 documents rows with status NULL today"],
  ["work_order_not_in_registry", "every issued order has a documents row"],
  ["multiple_issued_work_orders", "0025's partial unique index forbids it; needs injection"],
  ["lookup_failed", "requires a DB fault"],
  ["consolidation_lookup_failed", "requires a DB fault"],
  ["registry_lookup_failed", "requires a DB fault"],
  ["lookup_threw", "requires the resolver to throw, which it is written not to do"],
];

// ---------------------------------------------------------------------------
const describe = (r: ParentLink): string =>
  r.linked
    ? `linked=true  work_order=${r.work_order_number ?? "—"}  morning_doc_id=${r.morning_doc_id}`
    : `linked=false skip_reason=${r.skip_reason}` +
      (r.detail ? `  detail="${r.detail}"` : "") +
      (r.morning_doc_id ? `  morning_doc_id=${r.morning_doc_id}` : "");

async function main() {
  console.log("resolveParentWorkOrderLink — live gate check");
  console.log("TOUCHES MORNING: never · READ-ONLY: no writes of any kind\n");

  let pass = 0;
  const failures: string[] = [];

  for (const c of CASES) {
    const got = await resolveParentWorkOrderLink(admin, c.productionId);

    const reasons: string[] = [];
    if (c.expectSkip === null) {
      if (!got.linked) reasons.push(`expected linked=true, got skip_reason=${got.skip_reason}`);
      else if (c.expectWorkOrder && got.work_order_number !== c.expectWorkOrder) {
        reasons.push(`expected work order ${c.expectWorkOrder}, got ${got.work_order_number ?? "—"}`);
      } else if (!got.morning_doc_id) {
        reasons.push("linked but carries no morning_doc_id");
      }
    } else {
      if (got.linked) reasons.push(`expected skip_reason=${c.expectSkip}, got linked=true`);
      else {
        if (got.skip_reason !== c.expectSkip) {
          reasons.push(`expected skip_reason=${c.expectSkip}, got ${got.skip_reason}`);
        }
        if (c.expectDetail !== undefined && got.detail !== c.expectDetail) {
          reasons.push(`expected detail="${c.expectDetail}", got "${got.detail ?? ""}"`);
        }
      }
    }

    const ok = reasons.length === 0;
    if (ok) pass++;
    else failures.push(`${c.label} — ${reasons.join("; ")}`);

    console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${c.label}`);
    console.log(`         production_id : ${c.productionId}`);
    console.log(`         fixture       : ${c.note}`);
    console.log(
      `         expected      : ${
        c.expectSkip === null
          ? `linked=true${c.expectWorkOrder ? ` work_order=${c.expectWorkOrder}` : ""}`
          : `linked=false skip_reason=${c.expectSkip}${
              c.expectDetail !== undefined ? ` detail="${c.expectDetail}"` : ""
            }`
      }`
    );
    console.log(`         actual        : ${describe(got)}`);
    for (const r of reasons) console.log(`         ⚠ ${r}`);
    console.log();
  }

  console.log("─".repeat(72));
  console.log(`RESULT: ${pass}/${CASES.length} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ❌ ${f}`);

  console.log("\nNOT COVERED by this script — verdicts no live row can reach:");
  for (const [verdict, why] of UNCOVERED) console.log(`  · ${verdict}\n      ${why}`);
  console.log(
    `\n  ${UNCOVERED.length} of ${UNCOVERED.length + 5} verdicts remain unexercised. The one that matters` +
      "\n  is work_order_is_consolidation_parent: it guards the irreversible case and" +
      "\n  cannot be reached through the resolver's own query shape."
  );

  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
