/**
 * E13-8a — the approvals ledger from now on, its catch-up, B10's revoke, and
 * the shape of migration 0118.
 *   src/lib/review/approvalLedger.ts     what applyResponse writes
 *   src/lib/review/approvalsCatchup.ts   what the catch-up script writes
 *   src/lib/review/clientVersions.ts     latestShownVersionId
 *   src/lib/review/links.ts              the write, as a follow-up
 *   src/app/api/productions/[id]/route.ts  B10 revokes before it resets
 *   supabase/migrations/0118_*.sql + supabase/verify/0118_*.sql
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_approvals_ledger.ts
 *
 * ═══ F19 ═══ No database, no network. The SQL itself was run on a throwaway
 * local Postgres 17 (dryrun → migration → verify, see the 0118 report).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildApprovalLedgerRows } from "../src/lib/review/approvalLedger";
import { planApprovalsCatchup, type CuVersion } from "../src/lib/review/approvalsCatchup";
import { latestShownVersionId, type VersionForClient } from "../src/lib/review/clientVersions";

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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 600)}\n       want: ${w?.slice(0, 600)}`);
  }
}
const ok = (name: string, cond: boolean) => check(name, cond, true);
const section = (t: string) => console.log(`\n── ${t}`);

const IT = "11111111-1111-4111-8111-111111111111";
const IT2 = "22222222-2222-4222-8222-222222222222";
const v = (over: Partial<CuVersion>): CuVersion => ({
  id: "v?",
  item_id: IT,
  number: 1,
  source: "bunny",
  media_link: null,
  bunny_video_id: "aaaaaaaa-0000-4000-8000-000000000001",
  bunny_status: "ready",
  integrity: "hash_match",
  has_original: true,
  is_audio_only: false,
  original_filename: "x.mp4",
  drive_file_id: "D",
  media_deleted_at: null,
  ready_at: "2026-10-10T00:00:00Z",
  ...over,
});
const drive = (over: Partial<CuVersion> = {}) =>
  v({ id: "d1", number: 1, source: "drive", media_link: "https://drive.google.com/file/d/X/view", bunny_video_id: null, bunny_status: null, integrity: null, has_original: null, drive_file_id: null, ready_at: null, ...over });

// ══════════════════════════════════════════════════════════════════════
section("latestShownVersionId — the version a decision is about (E13-6 rules)");
check("Drive v1 + ready Bunny v2 → v2", latestShownVersionId([drive(), v({ id: "b2", number: 2 })] as VersionForClient[]), "b2");
check("Bunny v3 in mismatch is not shown → v2", latestShownVersionId([drive(), v({ id: "b2", number: 2 }), v({ id: "b3", number: 3, integrity: "mismatch" })]), "b2");
check("only Drive history → the latest Drive row (what the page shows)", latestShownVersionId([drive(), drive({ id: "d2", number: 2 })]), "d2");
check("only a Bunny version still processing → the Drive v1 the page still shows", latestShownVersionId([drive(), v({ id: "b2", number: 2, bunny_status: "processing", integrity: null })]), "d1");
check("archived (deleted at Bunny) still counts as shown", latestShownVersionId([drive(), v({ id: "b2", number: 2, media_deleted_at: "2027-01-01T00:00:00Z" })]), "b2");
check("no version rows at all → null", latestShownVersionId([]), null);

// ══════════════════════════════════════════════════════════════════════
section("buildApprovalLedgerRows — what applyResponse writes from now on");
const byItem = new Map<string, VersionForClient[]>([[IT, [drive(), v({ id: "b2", number: 2 })]]]);
const built = buildApprovalLedgerRows(
  [
    { id: IT, response: "approved", note: "ignored on approve" },
    { id: IT2, response: "revisions", note: " fix the end " },
    { id: IT, response: "bogus", note: null },
  ],
  byItem,
  "L1",
  "2026-10-17T20:00:00.000Z"
);
check("an approval names the shown version, link and time; note dropped", built.rows[0], { item_id: IT, version_id: "b2", link_id: "L1", decision: "approved", note: null, decided_at: "2026-10-17T20:00:00.000Z" });
check("an item without any version row → no row, reported (cra_version_chk)", built.withoutVersion, [IT2]);
check("an unknown response is ignored", built.rows.length, 1);
const rev = buildApprovalLedgerRows([{ id: IT, response: "revisions", note: " fix the end " }], byItem, "L1", "t");
check("revisions → a row with the trimmed note", [rev.rows[0].decision, rev.rows[0].note], ["revisions", "fix the end"]);

// ══════════════════════════════════════════════════════════════════════
section("planApprovalsCatchup — the decisions between the backfill and now");
const P = "p1";
const link = { id: "L1", production_id: P, responded_at: "2026-10-12T10:00:00Z", episode_response: null, reels_response: "approved" };
const items = [
  { id: IT, production_id: P, kind: "reel", approved: true },
  { id: IT2, production_id: P, kind: "reel", approved: false },
  { id: "EP", production_id: P, kind: "episode", approved: true },
];
const ev = {
  event_type: "client_review_approved",
  payload: { link_id: "L1", items: [{ id: IT, response: "approved", note: null }, { id: IT2, response: "approved", note: null }] },
};
const versions = [drive(), v({ id: "b2", number: 2, ready_at: "2026-10-11T00:00:00Z" }), v({ id: "b3", number: 3, ready_at: "2026-10-13T00:00:00Z" })];
const plan = planApprovalsCatchup({ links: [link], events: [ev], items, versions, existing: [], nowIso: "2026-10-17T00:00:00Z" });
check("one row per item decision", plan.rows.map((r) => r.item_id), [IT, IT2]);
check("the version shown AT THAT TIME: b3 became ready after the answer → b2", plan.rows[0].version_id, "b2");
check("decided_at = responded_at", plan.rows[0].decided_at, "2026-10-12T10:00:00Z");
check("is_backfill + a unique catch-up key", [plan.rows[0].is_backfill, plan.rows[0].backfill_source], [true, `catchup:link:L1:item:${IT}`]);
check("approved then, not approved today → written already revoked", [plan.rows[1].revoked_at, !!plan.rows[1].revoked_reason], ["2026-10-17T00:00:00Z", true]);
check("approved then and today → valid", plan.rows[0].revoked_at, null);
check("an item without versions → row without a version (allowed only as backfill)", planApprovalsCatchup({ links: [link], events: [ev], items, versions: [], existing: [], nowIso: "n" }).rows[0].version_id, null);
const again = planApprovalsCatchup({ links: [link], events: [ev], items, versions, existing: plan.rows.map((r) => ({ link_id: r.link_id, item_id: r.item_id, backfill_source: r.backfill_source })), nowIso: "n" });
check("a second run writes nothing", [again.rows.length, again.report.skippedExisting], [0, 2]);
const live = planApprovalsCatchup({ links: [link], events: [ev], items, versions, existing: [{ link_id: "L1", item_id: IT, backfill_source: null }], nowIso: "n" });
check("a (link, item) the live write already recorded is skipped", live.rows.map((r) => r.item_id), [IT2]);
const track = planApprovalsCatchup({
  links: [{ ...link, episode_response: "revisions", reels_response: "approved" }],
  events: [{ event_type: "client_review_revisions", payload: { link_id: "L1", episode_note: " shorter " } }],
  items,
  versions: [],
  existing: [],
  nowIso: "n",
});
check("track mode: the episode answer → the episode item, with its note", track.rows.map((r) => [r.item_id, r.decision, r.note]), [["EP", "revisions", "shorter"]]);
check("track mode: a reels answer without per-reel detail is reported, not guessed", track.report.skippedTrackReels, 1);
const noEv = planApprovalsCatchup({ links: [link], events: [], items, versions, existing: [], nowIso: "n" });
check("no response event → counted; the episode answer alone is used", noEv.report.linksWithoutEvent, 1);
const foreign = planApprovalsCatchup({
  links: [link],
  events: [{ event_type: "client_review_approved", payload: { link_id: "L1", items: [{ id: "OTHER", response: "approved" }] } }],
  items: [...items, { id: "OTHER", production_id: "p2", kind: "reel", approved: true }],
  versions,
  existing: [],
  nowIso: "n",
});
check("an item of another production in the payload is ignored", foreign.rows.length, 0);

// ══════════════════════════════════════════════════════════════════════
section("static: the writes in the app");
const root = join(__dirname, "..");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");
const lk = strip(readFileSync(join(root, "src/lib/review/links.ts"), "utf8"));
const iHist = lk.indexOf("responded_at: respondedAt,");
const iLedger = lk.indexOf('.from("client_review_approvals").insert(rows)');
ok("applyResponse writes the ledger AFTER the link history (the decision is recorded first)", iHist > 0 && iLedger > iHist);
ok("…with the same timestamp as responded_at", /buildApprovalLedgerRows\(itemDetail, byItem, link\.id, respondedAt\)/.test(lk));
ok("…as a follow-up: a failure is recordFailure('approval_ledger'), never a thrown response", /await recordFailure\("approval_ledger"/.test(lk));
const b10 = strip(readFileSync(join(root, "src/app/api/productions/[id]/route.ts"), "utf8"));
const iRevoke = b10.indexOf('revoked_reason: "board_rollback"');
const iReset = b10.indexOf('.update({ approved: false, approved_at: null })');
ok("B10 revokes the ledger BEFORE it resets the items", iRevoke > 0 && iReset > iRevoke);
ok("B10: a failed revoke stops the status move (500, like the items reset)", /if \(ledgerErr\) \{\s*return NextResponse\.json\(/.test(b10));
ok("B10: only valid approvals are revoked, nothing deleted", /\.eq\("decision", "approved"\)\s*\.is\("revoked_at", null\)/.test(b10) && !/client_review_approvals"\)\s*\.delete/.test(b10));
const cu = strip(readFileSync(join(root, "scripts/e13_approvals_catchup.ts"), "utf8"));
ok("catch-up script: dry run by default, writes only on --apply", /const APPLY = process\.argv\.includes\("--apply"\)/.test(cu) && /if \(!APPLY\) \{/.test(cu));
ok("catch-up script: its only write is an INSERT into client_review_approvals", (cu.match(/\.insert\(/g) ?? []).length === 1 && !/\.update\(|\.delete\(|\.upsert\(/.test(cu));

// ══════════════════════════════════════════════════════════════════════
section("static: migration 0118 and its dryrun");
const mig = readFileSync(join(root, "supabase/migrations/0118_review_item_comment_reapprove.sql"), "utf8");
const dry = readFileSync(join(root, "supabase/verify/0118_dryrun.sql"), "utf8");
const tests = readFileSync(join(root, "supabase/verify/_0118_dryrun_tests.sql"), "utf8");
const body = mig.slice(mig.indexOf("do $mig$\n") + "do $mig$\n".length, mig.indexOf("end $mig$;")) + "end;\n";
const indented = body.split("\n").map((l) => (l.trim() ? "    " + l : l)).join("\n");
ok("the dryrun carries the migration body WORD FOR WORD (regenerate if this fails)", dry.includes(indented));
ok("…followed by the tests file, verbatim", dry.includes(tests));
ok("the dryrun ends in an exception (zero change left)", /raise exception 'DRYRUN_PASS';/.test(dry) && dry.trim().endsWith("end $dry$;"));
ok("guards: not twice, 0117 first", /0118 כבר רשומה בפנקס/.test(mig) && /0117 טרם הוחלה/.test(mig));
ok("both functions: security definer, search_path pinned", (mig.match(/language plpgsql security definer set search_path = public/g) ?? []).length === 2);
ok("EXECUTE: revoked from sessions, granted to service_role only", /revoke all on function public\.review_item_comment\(uuid, uuid, uuid, text, int, text\) from public, anon, authenticated;/.test(mig) && /grant execute on function public\.review_item_reapprove\(uuid, uuid, uuid\) to service_role;/.test(mig));
ok("a revoke never deletes: revoked_at + client_comment", /set revoked_at = now\(\), revoked_reason = 'client_comment'/.test(mig) && !/delete from public\.client_review_approvals/.test(mig));
ok("re-approve does NOT clear needs_attention (decision 3)", !/review_item_reapprove[\s\S]*needs_attention = false/.test(mig));
ok("re-approve: only after a revoke by comment from this link (decision 2)", /revoked_reason is distinct from 'client_comment'/.test(mig) && /link_id = p_link_id and author_kind = 'client'/.test(mig));
ok("a pin only on a bunny version", /source = 'bunny'\) then\s*raise exception 'review_item_comment: נעץ רק על גרסת Bunny'/.test(mig) || /נעץ רק על גרסת Bunny/.test(mig));
ok("the item row is locked in both (no double revoke / re-approve)", (mig.match(/from public\.client_review_items where id = p_item_id for update/g) ?? []).length === 2);
ok("the ledger row is written last", mig.lastIndexOf("insert into public.schema_ledger") > mig.lastIndexOf("raise notice"));
const ver = readFileSync(join(root, "supabase/verify/0118_verify.sql"), "utf8");
ok("verify is read-only (select only)", /^\s*select/m.test(ver) && !/\b(insert|update|delete|create|alter|drop|grant|revoke)\b/i.test(ver.replace(/--.*$/gm, "").replace(/has_function_privilege/g, "")));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
