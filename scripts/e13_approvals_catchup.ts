/**
 * E13-8a — catch-up of the approvals ledger: decisions made through a link
 * between the 16.10 backfill and the deploy of E13-8a (when applyResponse
 * started writing client_review_approvals). THE OWNER RUNS THIS, not Claude.
 *
 * Run (report only — the default, writes NOTHING):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_approvals_catchup.ts
 * Run (write exactly what the report listed):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_approvals_catchup.ts --apply
 * Optional: --since=2026-10-16T15:21:00Z (default: the newest backfill row of
 * client_review_approvals, i.e. the moment the 16.10 backfill ran).
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Bunny, Drive: NOTHING.
 *   · Our DB (via .env.local, service role): READS responded client_review_links
 *     since --since, their client_review_approved / _revisions events,
 *     client_review_items, client_review_versions, and the rows already in
 *     client_review_approvals. With --apply only: INSERT into
 *     client_review_approvals. No UPDATE, no DELETE, nothing else.
 *
 * Every rule is in src/lib/review/approvalsCatchup.ts (pure, tested offline in
 * scripts/test_e13_approvals_ledger.ts). Re-running after --apply writes
 * nothing: each row carries backfill_source `catchup:link:<link>:item:<item>`
 * (unique in 0114), and any (link, item) already in the ledger is skipped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTypedAdminClient } from "../src/lib/supabase/admin";
import { CLIENT_VERSION_SELECT } from "../src/lib/review/clientVersions";
import { planApprovalsCatchup, type CuEvent, type CuVersion } from "../src/lib/review/approvalsCatchup";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#") || !t.includes("=")) continue;
  const i = t.indexOf("=");
  if (!process.env[t.slice(0, i).trim()]) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const APPLY = process.argv.includes("--apply");
const SINCE_ARG = process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length) ?? null;

async function main() {
  const admin = createTypedAdminClient();

  // 0. the ledger exists, and the cut-off
  const { data: lastBf, error: bfErr } = await admin
    .from("client_review_approvals")
    .select("created_at")
    .eq("is_backfill", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (bfErr) throw new Error(`client_review_approvals: ${bfErr.message}`);
  const since = SINCE_ARG ?? lastBf?.created_at ?? null;
  if (!since || Number.isNaN(Date.parse(since))) throw new Error("אין נקודת התחלה: העבר --since=<ISO> (אין שורות backfill בטבלה)");

  // 1. reads
  const { data: links, error: lErr } = await admin
    .from("client_review_links")
    .select("id,production_id,responded_at,episode_response,reels_response")
    .gt("responded_at", since)
    .order("responded_at");
  if (lErr) throw new Error(`client_review_links: ${lErr.message}`);
  const answered = (links ?? []).filter((l): l is typeof l & { responded_at: string } => !!l.responded_at);
  const prodIds = Array.from(new Set(answered.map((l) => l.production_id)));

  const { data: items, error: iErr } = prodIds.length
    ? await admin.from("client_review_items").select("id,production_id,kind,approved").in("production_id", prodIds)
    : { data: [], error: null };
  if (iErr) throw new Error(`client_review_items: ${iErr.message}`);
  const itemIds = (items ?? []).map((i) => i.id);

  const { data: versions, error: vErr } = itemIds.length
    ? await admin.from("client_review_versions").select(`${CLIENT_VERSION_SELECT},ready_at`).in("item_id", itemIds)
    : { data: [], error: null };
  if (vErr) throw new Error(`client_review_versions: ${vErr.message}`);

  const { data: events, error: eErr } = prodIds.length
    ? await admin
        .from("events")
        .select("event_type,payload")
        .eq("entity_type", "production")
        .in("entity_id", prodIds)
        .in("event_type", ["client_review_approved", "client_review_revisions"])
        .gt("created_at", since)
    : { data: [], error: null };
  if (eErr) throw new Error(`events: ${eErr.message}`);

  const { data: existing, error: xErr } = itemIds.length
    ? await admin.from("client_review_approvals").select("link_id,item_id,backfill_source").in("item_id", itemIds)
    : { data: [], error: null };
  if (xErr) throw new Error(`client_review_approvals: ${xErr.message}`);

  // 2. the plan
  const { rows, report } = planApprovalsCatchup({
    links: answered,
    events: (events ?? []) as CuEvent[],
    items: items ?? [],
    versions: (versions ?? []) as unknown as CuVersion[],
    existing: existing ?? [],
    nowIso: new Date().toISOString(),
  });

  console.log(`נקודת התחלה: ${since}`);
  console.log(
    `קישורים שנענו מאז: ${report.links} (בלי אירוע תשובה: ${report.linksWithoutEvent})\n` +
      `שורות לכתיבה: ${report.rows} — ${report.approved} אישורים, ${report.revisions} תיקונים; ` +
      `מתוך האישורים ${report.revokedNow} נכתבים מבוטלים (הפריט אינו מאושר היום); ${report.withoutVersion} בלי גרסה\n` +
      `כבר ביומן (לא ייכתבו): ${report.skippedExisting} · תשובת רילז בלי פירוט לפריטים (דולגה): ${report.skippedTrackReels}`
  );
  for (const r of rows) {
    console.log(`  ${r.decided_at}  link ${r.link_id.slice(0, 8)}  item ${r.item_id.slice(0, 8)}  ${r.decision}${r.revoked_at ? " (מבוטל)" : ""}  גרסה ${r.version_id ? r.version_id.slice(0, 8) : "—"}`);
  }

  if (!APPLY) {
    console.log("\ndry run — לא נכתב דבר. להרצה אמיתית: --apply");
    return;
  }
  if (!rows.length) {
    console.log("\n--apply: אין מה לכתוב.");
    return;
  }
  const { error: insErr } = await admin.from("client_review_approvals").insert(rows);
  if (insErr) throw new Error(`הכתיבה נכשלה, לא נכתב דבר: ${insErr.message}`);
  console.log(`\n✅ נכתבו ${rows.length} שורות ל-client_review_approvals.`);
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
