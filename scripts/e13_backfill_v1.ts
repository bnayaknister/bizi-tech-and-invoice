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
 *     events, the versions already in client_review_versions (any version an
 *     item already has blocks its v1 — E13-3), and the backfill rows already
 *     in the 0114 tables. With --apply
 *     only: INSERT into client_review_versions, client_review_approvals,
 *     client_review_comments. No UPDATE, no DELETE, nothing in any older table.
 *
 * Every decision is in src/lib/review/backfillV1.ts (pure, tested offline in
 * scripts/test_e13_backfill_v1.ts). Re-running after --apply writes nothing:
 * each row carries a backfill_source / (item, v1) key and existing keys are
 * left out of the plan.
 *
 * TYPED CLIENT (createTypedAdminClient): every .select() / .insert() here is
 * checked against database.types.ts, and no cast sits between a query and the
 * field access — a cast would erase that check (lib/supabase/admin.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTypedAdminClient } from "../src/lib/supabase/admin";
import type { Json } from "../src/lib/supabase/database.types";
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

type Admin = ReturnType<typeof createTypedAdminClient>;

/** Pages through a typed query; R is inferred from the query, never asserted. */
async function pages<R>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: R[] | null; error: { message: string } | null }>
): Promise<R[]> {
  const out: R[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// ── Json → the planner's shapes, by inspection (no casts) ──────────────────
const obj = (j: Json | undefined): { [k: string]: Json | undefined } | null =>
  j !== null && j !== undefined && typeof j === "object" && !Array.isArray(j) ? j : null;
const str = (j: Json | undefined): string | null => (typeof j === "string" ? j : null);

type EventItem = NonNullable<NonNullable<BfEvent["payload"]>["items"]>[number];

function toPayload(j: Json): BfEvent["payload"] {
  const o = obj(j);
  if (!o) return null;
  const items: EventItem[] = [];
  if (Array.isArray(o.items)) {
    for (const it of o.items) {
      const r = obj(it);
      const id = str(r?.id);
      const kind = str(r?.kind);
      const response = str(r?.response);
      if (!r || !id || !kind || !response) continue;
      items.push({ id, kind, reel_index: typeof r.reel_index === "number" ? r.reel_index : null, response, note: str(r.note) });
    }
  }
  return { link_id: str(o.link_id) ?? undefined, items };
}

async function loadItems(admin: Admin): Promise<BfItem[]> {
  const rows = await pages("client_review_items", (f, t) =>
    admin
      .from("client_review_items")
      .select("id,production_id,kind,reel_index,media_link,approved,approved_at")
      .order("id")
      .range(f, t)
  );
  return rows.map((r) => {
    if (r.kind !== "episode" && r.kind !== "reel") throw new Error(`client_review_items ${r.id}: kind לא צפוי "${r.kind}"`);
    return {
      id: r.id,
      production_id: r.production_id,
      kind: r.kind,
      reel_index: r.reel_index,
      media_link: r.media_link,
      approved: r.approved,
      approved_at: r.approved_at,
    };
  });
}

async function loadLinks(admin: Admin): Promise<BfLink[]> {
  const rows = await pages("client_review_links", (f, t) =>
    admin
      .from("client_review_links")
      .select("id,production_id,responded_at,episode_response,reels_response,episode_note,reels_note")
      .not("responded_at", "is", null)
      .order("id")
      .range(f, t)
  );
  return rows.map((r) => ({
    id: r.id,
    production_id: r.production_id,
    responded_at: r.responded_at,
    episode_response: r.episode_response,
    reels_response: r.reels_response,
    episode_note: r.episode_note,
    reels_note: r.reels_note,
  }));
}

async function loadEvents(admin: Admin): Promise<BfEvent[]> {
  const rows = await pages("events", (f, t) =>
    admin
      .from("events")
      .select("id,event_type,created_at,payload")
      .in("event_type", ["client_review_approved", "client_review_revisions"])
      .order("id")
      .range(f, t)
  );
  return rows.map((r) => ({ event_type: r.event_type, created_at: r.created_at, payload: toPayload(r.payload) }));
}

/**
 * All versions, split in two (E13-3): the backfill v1 rows (number 1,
 * is_backfill) and the items that have any OTHER version. Only backfill v1
 * rows count as "v1 present" and only they are linked to approvals — a Bunny
 * version numbered 1 is not the Drive history this script writes.
 */
async function loadVersions(admin: Admin) {
  const rows = await pages("client_review_versions", (f, t) =>
    admin.from("client_review_versions").select("id,item_id,number,is_backfill").order("id").range(f, t)
  );
  const v1 = rows.filter((r) => r.number === 1 && r.is_backfill);
  const v1Items = new Set(v1.map((r) => r.item_id));
  const other = new Set(rows.filter((r) => !(r.number === 1 && r.is_backfill) && !v1Items.has(r.item_id)).map((r) => r.item_id));
  return { v1, other };
}

async function loadSources(admin: Admin) {
  const appr = await pages("client_review_approvals", (f, t) =>
    admin.from("client_review_approvals").select("id,backfill_source").not("backfill_source", "is", null).order("id").range(f, t)
  );
  const com = await pages("client_review_comments", (f, t) =>
    admin.from("client_review_comments").select("id,backfill_source").not("backfill_source", "is", null).order("id").range(f, t)
  );
  const keys = (rows: { backfill_source: string | null }[]) =>
    new Set(rows.flatMap((r) => (r.backfill_source ? [r.backfill_source] : [])));
  return { approvalSources: keys(appr), commentSources: keys(com) };
}

async function main() {
  const admin = createTypedAdminClient();

  const { data: ledger, error: lErr } = await admin.from("schema_ledger").select("version").eq("version", "0114").maybeSingle();
  if (lErr) throw new Error(`schema_ledger: ${lErr.message}`);
  if (!ledger) throw new Error("0114 טרם הוחלה — הרץ את המיגרציה קודם");

  const items = await loadItems(admin);
  const links = await loadLinks(admin);
  const events = await loadEvents(admin);
  const { v1, other } = await loadVersions(admin);
  const { approvalSources, commentSources } = await loadSources(admin);

  const runAt = new Date().toISOString();
  const plan = planBackfillV1(
    items,
    links,
    events,
    {
      v1ItemIds: new Set(v1.map((r) => r.item_id)),
      v1IdByItem: new Map(v1.map((r) => [r.item_id, r.id])),
      otherVersionItemIds: other,
      approvalSources,
      commentSources,
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
  const v1Id = new Map((await loadVersions(admin)).v1.map((r) => [r.item_id, r.id]));

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
    // events.entity_id is NOT NULL; system events use the zero uuid (registration/approve.ts)
    entity_id: "00000000-0000-0000-0000-000000000000",
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
