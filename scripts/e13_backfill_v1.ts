/**
 * E13-2 — backfill v1: existing review media, decisions and notes into the
 * 0114 tables as READ-ONLY HISTORY (plan §7). THE OWNER RUNS THIS, not Claude.
 *
 * Prerequisite: migration 0114 applied (the script refuses otherwise).
 *
 * Run (report only — the default, writes NOTHING):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_backfill_v1.ts
 * Run (write exactly what the report listed):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_backfill_v1.ts --apply
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Bunny: NOTHING. These are Drive history rows; no file moves anywhere.
 *   · Our DB (via .env.local, service role): reads client_review_items,
 *     responded client_review_links, the client_review_approved/revisions
 *     events, and the backfill rows already in the 0114 tables. With --apply
 *     only: INSERT into client_review_versions, client_review_approvals,
 *     client_review_comments. No UPDATE, no DELETE, nothing in any older table.
 *
 * Every decision is in src/lib/review/backfillV1.ts (pure, tested offline in
 * scripts/test_e13_backfill_v1.ts). Re-running after --apply writes nothing:
 * each row carries a backfill_source / (item, v1) key and existing keys are
 * left out of the plan.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatBackfillReport,
  planBackfillV1,
  type BfEvent,
  type BfItem,
  type BfLink,
} from "../src/lib/review/backfillV1";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;

async function all<T>(admin: SupabaseClient, table: string, cols: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = admin.from(table).select(cols).order("id").range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) return out;
  }
}

async function main() {
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { data: ledger, error: lErr } = await admin.from("schema_ledger").select("version").eq("version", "0114").maybeSingle();
  if (lErr) throw new Error(`schema_ledger: ${lErr.message}`);
  if (!ledger) throw new Error("0114 טרם הוחלה — הרץ את המיגרציה קודם");

  const items = await all<BfItem>(admin, "client_review_items", "id,production_id,kind,reel_index,media_link,approved,approved_at");
  const links = await all<BfLink>(
    admin,
    "client_review_links",
    "id,production_id,responded_at,episode_response,reels_response,episode_note,reels_note",
    (q) => q.not("responded_at", "is", null)
  );
  const events = await all<BfEvent & { id: string }>(admin, "events", "id,event_type,created_at,payload", (q) =>
    q.in("event_type", ["client_review_approved", "client_review_revisions"])
  );
  const v1 = await all<{ id: string; item_id: string }>(admin, "client_review_versions", "id,item_id", (q) => q.eq("number", 1));
  const apprSrc = await all<{ id: string; backfill_source: string }>(admin, "client_review_approvals", "id,backfill_source", (q) =>
    q.not("backfill_source", "is", null)
  );
  const comSrc = await all<{ id: string; backfill_source: string }>(admin, "client_review_comments", "id,backfill_source", (q) =>
    q.not("backfill_source", "is", null)
  );

  const runAt = new Date().toISOString();
  const plan = planBackfillV1(
    items,
    links,
    events,
    {
      v1ItemIds: new Set(v1.map((r) => r.item_id)),
      v1IdByItem: new Map(v1.map((r) => [r.item_id, r.id])),
      approvalSources: new Set(apprSrc.map((r) => r.backfill_source)),
      commentSources: new Set(comSrc.map((r) => r.backfill_source)),
    },
    runAt
  );

  console.log(formatBackfillReport(plan));

  if (!APPLY) {
    console.log("\ndry run — לא נכתב דבר. להרצה אמיתית: --apply");
    return;
  }

  // 1. versions — one statement
  if (plan.versions.length) {
    const { error } = await admin.from("client_review_versions").insert(plan.versions);
    if (error) throw new Error(`versions: ${error.message} — לא נכתבו החלטות והערות; הרץ שוב אחרי בירור`);
  }
  // 2. resolve each item's v1 id (new + pre-existing)
  const v1Now = await all<{ id: string; item_id: string }>(admin, "client_review_versions", "id,item_id", (q) => q.eq("number", 1));
  const v1Id = new Map(v1Now.map((r) => [r.item_id, r.id]));

  // 3. approvals — one statement
  if (plan.approvals.length) {
    const rows = plan.approvals.map(({ v1_of_item, ...a }) => ({ ...a, version_id: v1_of_item ? v1Id.get(v1_of_item) ?? null : null }));
    const { error } = await admin.from("client_review_approvals").insert(rows);
    if (error) throw new Error(`approvals: ${error.message} — הגרסאות נכתבו; הרצה חוזרת תשלים את השאר`);
  }
  // 4. comments — one statement
  if (plan.comments.length) {
    const { error } = await admin.from("client_review_comments").insert(plan.comments);
    if (error) throw new Error(`comments: ${error.message} — גרסאות והחלטות נכתבו; הרצה חוזרת תשלים את השאר`);
  }

  const { error: evErr } = await admin.from("events").insert({
    entity_type: "system",
    entity_id: null,
    event_type: "review_backfill_v1_applied",
    payload: { run_at: runAt, versions: plan.versions.length, approvals: plan.approvals.length, comments: plan.comments.length },
  });
  if (evErr) console.log(`⚠️ האירוע לא נכתב: ${evErr.message} (הנתונים עצמם נכתבו)`);
  console.log(`\n✅ נכתב: ${plan.versions.length} גרסאות · ${plan.approvals.length} החלטות · ${plan.comments.length} הערות`);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
