/**
 * E13-10 — Bunny media deleted 90 days after approval (owner 18.10, (ה) 1–7) + B29's purge alerts.
 *   src/lib/review/purge.ts                 the checks, report vs live, the cap, failures, alerts
 *   src/lib/review/itemComments.ts          archive: no comment / pin / re-approval (server)
 *   src/app/r/[token]/ReviewClient.tsx      archive: no box, no "מאשר שוב" (page), old comments + Drive stay
 *   src/modules/radar/alerts.ts             the two purge alerts, from the LAST run event
 *   + static checks on the cron route and vercel.json
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_10_purge.tsx
 *
 * ═══ F19 ═══ No database, no network: every dependency is a fake.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  ALERT_REASONS,
  PURGE_FAIL_EVENT_AT,
  driveVerdict,
  itemSkipReason,
  liveLinkCovers,
  preDriveSkip,
  purgeTargets,
  runPurge,
  summaryPayload,
  type DeleteOutcome,
  type DriveMetaResult,
  type DueRow,
  type LiveLink,
  type PurgeDeps,
  type PurgeVersion,
} from "../src/lib/review/purge";
import type { DriveAvailability } from "../src/lib/review/driveAvailability";
import { checkAgainstVersions, ARCHIVED_ERROR, type VersionWithDuration } from "../src/lib/review/itemComments";
import ReviewClient from "../src/app/r/[token]/ReviewClient";
import type { ClientVersionView, ClientCommentView } from "../src/app/r/[token]/ReviewPlayer";
import { EVENT_LABEL } from "../src/lib/events/labels";

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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 700)}\n       want: ${w?.slice(0, 700)}`);
  }
}
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond && detail) console.log(`       ${detail.slice(0, 500)}`);
  check(name, cond, true);
};
const section = (t: string) => console.log(`\n── ${t}`);
const root = join(__dirname, "..");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

const NOW = Date.parse("2027-01-20T02:45:00Z");
const PAST = "2027-01-15T10:00:00Z";
const FUTURE = "2027-02-01T10:00:00Z";

// ══════════════════════════════════════════════════════════════════════
section("item checks (re-read right before deleting)");
const due = (over: Partial<DueRow> = {}): DueRow => ({ item_id: "I1", approval_id: "A1", purge_after: PAST, latest_version_id: "V2", upload_pending: false, ...over });
const link = (over: Partial<LiveLink> = {}): LiveLink => ({ scope: "reels", expires_at: FUTURE, superseded: false, responded_at: null, ...over });
const isr = (d: DueRow | null, links: LiveLink[] = [], kind = "reel", sel: string | null = "V2") => itemSkipReason({ due: d, selectedLatest: sel, kind, links, nowMs: NOW });
check("all clear → null", isr(due()), null);
check("no valid approval (revoked since the list) → approval_revoked", isr(null), "approval_revoked");
check("upload in progress → upload_pending", isr(due({ upload_pending: true, purge_after: null })), "upload_pending");
check("date moved to the future (re-approved / new ready) → not_due", isr(due({ purge_after: FUTURE })), "not_due");
check("no date at all → not_due", isr(due({ purge_after: null })), "not_due");
check("a newer version since the list → new_version", isr(due({ latest_version_id: "V3" })), "new_version");
check("live unanswered reels link on a reel → live_link", isr(due(), [link()]), "live_link");
check("…an 'all' link covers an episode too", isr(due(), [link({ scope: "all" })], "episode"), "live_link");
check("…an episode link does not cover a reel", isr(due(), [link({ scope: "episode" })], "reel"), null);
check("…answered / superseded / expired links are not live", [link({ responded_at: PAST }), link({ superseded: true }), link({ expires_at: PAST })].map((l) => liveLinkCovers([l], "reel", NOW)), [false, false, false]);

section("version checks");
const ver = (over: Partial<PurgeVersion> = {}): PurgeVersion => ({
  id: "V2", item_id: "I1", number: 2, source: "bunny", bunny_video_id: "g2", bunny_status: "ready", integrity: "hash_match",
  drive_file_id: "F2", drive_size_bytes: 1000, drive_sha256: "abc", media_deleted_at: null, delete_attempts: 0, ...over,
});
check("targets: Bunny with a guid, not deleted; Drive rows and deleted ones out; by number",
  purgeTargets([ver({ id: "b", number: 2 }), ver({ id: "a", number: 1 }), ver({ id: "d", source: "drive", bunny_video_id: null }), ver({ id: "x", media_deleted_at: PAST }), ver({ id: "n", bunny_video_id: null })]).map((v) => v.id),
  ["a", "b"]);
check("integrity not OK → integrity_not_ok", [preDriveSkip(ver({ integrity: "mismatch" })), preDriveSkip(ver({ integrity: null }))], ["integrity_not_ok", "integrity_not_ok"]);
check("no Drive file id → no_drive_file", preDriveSkip(ver({ drive_file_id: null })), "no_drive_file");
check("a FAILED Bunny version (never shown) → no pre-check", preDriveSkip(ver({ bunny_status: "failed", integrity: null, drive_file_id: null })), null);
const metaOk: DriveMetaResult = { ok: true, trashed: false, size: 1000, sha256: "ABC" };
const probeOk: DriveAvailability = { state: "ok" };
check("Drive same size + sha (case-insensitive) + anonymous OK → delete", driveVerdict(ver(), metaOk, probeOk), null);
check("Drive 404 → drive_missing", driveVerdict(ver(), { ok: false, notFound: true }, probeOk), "drive_missing");
check("Drive read error (not 404) → drive_unverified", driveVerdict(ver(), { ok: false, notFound: false }, probeOk), "drive_unverified");
check("trashed → drive_missing", driveVerdict(ver(), { ...metaOk, trashed: true }, probeOk), "drive_missing");
check("other size → drive_incomplete", driveVerdict(ver(), { ...metaOk, size: 999 }, probeOk), "drive_incomplete");
check("no size → drive_incomplete", driveVerdict(ver(), { ...metaOk, size: null }, probeOk), "drive_incomplete");
check("other sha256 → drive_incomplete", driveVerdict(ver(), { ...metaOk, sha256: "zzz" }, probeOk), "drive_incomplete");
check("anonymous probe: gone / not shared / unknown", [
  driveVerdict(ver(), metaOk, { state: "unavailable", reason: "missing", httpStatus: 404 }),
  driveVerdict(ver(), metaOk, { state: "unavailable", reason: "not_shared", httpStatus: 403 }),
  driveVerdict(ver(), metaOk, { state: "unknown", detail: "timeout" }),
], ["drive_missing", "drive_not_shared", "drive_unverified"]);
check("alert reasons = the ones the team must fix; 'unverified' only retries", ["drive_missing", "drive_incomplete", "drive_not_shared", "integrity_not_ok", "no_drive_file", "drive_unverified"].map((r) => ALERT_REASONS.has(r)), [true, true, true, true, true, false]);

// ══════════════════════════════════════════════════════════════════════
async function main() {
section("runPurge — report vs live, failures, the cap");
type Calls = { deletes: string[]; marked: string[]; failures: string[]; events: { type: string; payload: Record<string, unknown>; dedupe?: unknown }[] };
function fake(opts: {
  live: boolean;
  limit?: number;
  dueRows: DueRow[];
  fresh?: Record<string, DueRow | null>;
  versions: Record<string, PurgeVersion[]>;
  links?: LiveLink[];
  meta?: (id: string) => DriveMetaResult;
  probe?: (id: string) => DriveAvailability;
  del?: (guid: string) => DeleteOutcome;
}): { deps: PurgeDeps; calls: Calls } {
  const calls: Calls = { deletes: [], marked: [], failures: [], events: [] };
  const deps: PurgeDeps = {
    nowMs: NOW,
    live: opts.live,
    limit: opts.limit ?? 20,
    listDue: async () => opts.dueRows,
    dueFor: async (id) => (opts.fresh && id in opts.fresh ? opts.fresh[id] : opts.dueRows.find((r) => r.item_id === id) ?? null),
    item: async (id) => ({ id, production_id: `P-${id}`, kind: "reel" }),
    versions: async (id) => opts.versions[id] ?? [],
    liveLinks: async () => opts.links ?? [],
    driveMeta: async (id) => (opts.meta ? opts.meta(id) : metaOk),
    driveProbe: async (id) => (opts.probe ? opts.probe(id) : probeOk),
    deleteAtBunny: async (g) => {
      calls.deletes.push(g);
      return opts.del ? opts.del(g) : { kind: "deleted", alreadyGone: false };
    },
    markDeleted: async (id) => {
      calls.marked.push(id);
      return true;
    },
    recordFailure: async (v) => {
      calls.failures.push(v.id);
      return v.delete_attempts + 1;
    },
    event: async (_p, type, payload, dedupe) => {
      calls.events.push({ type, payload, dedupe });
    },
  };
  return { deps, calls };
}
const two = { I1: [ver({ id: "V1", number: 1, bunny_video_id: "g1", drive_file_id: "F1" }), ver()] };

{
  const { deps, calls } = fake({ live: false, dueRows: [due()], versions: two });
  const s = await runPurge(deps);
  check("REPORT: both versions would be deleted, NOTHING sent to Bunny, nothing marked", [s.mode, s.would_delete.map((e) => e.version_id), calls.deletes, calls.marked], ["report", ["V1", "V2"], [], []]);
  check("REPORT: no event besides alerts (none here)", calls.events.length, 0);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: two });
  const s = await runPurge(deps);
  check("LIVE: deleted at Bunny, then marked, one review_media_deleted each", [s.deleted.map((e) => e.version_id), calls.deletes, calls.marked, calls.events.map((e) => e.type)], [["V1", "V2"], ["g1", "g2"], ["V1", "V2"], ["review_media_deleted", "review_media_deleted"]]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: two, del: () => ({ kind: "bunny_dry_run" }) });
  const s = await runPurge(deps);
  check("LIVE under BUNNY_DRY_RUN: nothing marked deleted", [s.bunny_dry_run.length, calls.marked], [2, []]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: { I1: [ver({ delete_attempts: PURGE_FAIL_EVENT_AT - 1 })] }, del: () => ({ kind: "failed", error: "Bunny delete נכשל (500)" }) });
  const s = await runPurge(deps);
  check("a failure: recorded, NOT marked deleted, event at the 5th attempt", [s.failed.map((f) => [f.version_id, f.attempts]), calls.marked, calls.events.map((e) => e.type)], [[["V2", 5]], [], ["review_media_delete_failed"]]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: { I1: [ver({ delete_attempts: 1 })] }, del: () => ({ kind: "failed", error: "x" }) });
  await runPurge(deps);
  check("…an earlier failure (2nd attempt): no event yet", calls.events.length, 0);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: two, meta: (id) => (id === "F1" ? { ok: false, notFound: true } : metaOk) });
  const s = await runPurge(deps);
  check("Drive missing for v1: v1 kept + alert + event (deduped per version+reason); v2 still deleted", [s.alerts.map((a) => [a.version_id, a.reason]), s.deleted.map((e) => e.version_id), calls.deletes], [[["V1", "drive_missing"]], ["V2"], ["g2"]]);
  check("…the skip event carries the dedupe key", calls.events.find((e) => e.type === "review_media_purge_skipped")?.dedupe, { version_id: "V1", reason: "drive_missing" });
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: two, probe: () => ({ state: "unknown", detail: "timeout" }) });
  const s = await runPurge(deps);
  check("Drive could not be checked: skipped quietly (no alert, no event), retried tomorrow", [s.skipped_versions.map((v) => v.reason), s.alerts.length, calls.events.length, calls.deletes], [["drive_unverified", "drive_unverified"], 0, 0, []]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: { I1: [ver({ id: "VF", number: null, bunny_status: "failed", integrity: null, drive_file_id: null, bunny_video_id: "gf" }), ver()] } });
  const s = await runPurge(deps);
  check("a failed Bunny version is deleted without a Drive check", [s.deleted.map((e) => e.version_id), calls.deletes], [["V2", "VF"], ["g2", "gf"]]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], versions: two, links: [link()] });
  const s = await runPurge(deps);
  check("live unanswered link → the whole item skipped, nothing deleted", [s.skipped_items, calls.deletes], [[{ item_id: "I1", reason: "live_link" }], []]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], fresh: { I1: null }, versions: two });
  const s = await runPurge(deps);
  check("approval revoked between the list and the item → skipped", [s.skipped_items.map((x) => x.reason), calls.deletes], [["approval_revoked"], []]);
}
{
  const { deps, calls } = fake({ live: true, dueRows: [due()], fresh: { I1: due({ latest_version_id: "V3" }) }, versions: two });
  await runPurge(deps);
  check("a new version since the list → skipped", calls.deletes, []);
}
{
  const many: Record<string, PurgeVersion[]> = {};
  const rows: DueRow[] = [];
  for (let i = 0; i < 15; i++) {
    const id = `I${i}`;
    rows.push(due({ item_id: id, latest_version_id: `${id}v2`, purge_after: `2027-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }));
    many[id] = [ver({ id: `${id}v1`, item_id: id, number: 1, bunny_video_id: `${id}g1` }), ver({ id: `${id}v2`, item_id: id, number: 2, bunny_video_id: `${id}g2` })];
  }
  const { deps, calls } = fake({ live: true, dueRows: [...rows].reverse(), versions: many });
  const s = await runPurge(deps);
  check("cap: 20 versions per run, oldest purge date first, flagged capped", [calls.deletes.length, calls.deletes[0], s.capped], [20, "I0g1", true]);
  const one = fake({ live: true, limit: 1, dueRows: rows, versions: many });
  await runPurge(one.deps);
  check("?limit=1 (the first live run) → exactly one", one.calls.deletes, ["I0g1"]);
  const big = fake({ live: true, limit: 500, dueRows: rows, versions: many });
  await runPurge(big.deps);
  check("a limit over 20 is still 20", big.calls.deletes.length, 20);
}
{
  const { deps } = fake({ live: false, dueRows: [], versions: {} });
  const s = await runPurge(deps);
  const p = summaryPayload(s) as { mode: string; due_items: number; counts: Record<string, number> };
  check("nothing due (today: no approval is 90 days old) → report, 0 everywhere", [p.mode, p.due_items, Object.values(p.counts).every((n) => n === 0)], ["report", 0, true]);
}

// ══════════════════════════════════════════════════════════════════════
section("archive: no comment, no pin, no re-approval — server");
const vrow = (over: Partial<VersionWithDuration> = {}): VersionWithDuration =>
  ({
    id: "V2", item_id: "I1", number: 2, source: "bunny", media_link: null, bunny_video_id: "g2", bunny_status: "ready", integrity: "hash_match",
    has_original: true, is_audio_only: false, original_filename: "reel01 v2.mp4", drive_file_id: "F2", media_deleted_at: null, duration_ms: 30000, ...over,
  }) as VersionWithDuration;
const archivedRows = [vrow({ media_deleted_at: PAST })];
check("comment on an archived latest → 409 archive", checkAgainstVersions({ action: "comment", versionId: "V2", body: "x" } as never, archivedRows), { ok: false, status: 409, error: ARCHIVED_ERROR });
check("re-approve on an archived latest → 409 archive", checkAgainstVersions({ action: "approve", versionId: "V2" } as never, archivedRows), { ok: false, status: 409, error: ARCHIVED_ERROR });
check("pin on an archived latest → 409 archive", checkAgainstVersions({ action: "pin", versionId: "V2", timeMs: 1000, body: "x" } as never, archivedRows), { ok: false, status: 409, error: ARCHIVED_ERROR });
check("…naming another version does not get around it", checkAgainstVersions({ action: "comment", versionId: null, body: "x" } as never, archivedRows), { ok: false, status: 409, error: ARCHIVED_ERROR });
check("not archived → as before (comment OK)", checkAgainstVersions({ action: "comment", versionId: "V2", body: "x" } as never, [vrow()]), { ok: true });
check("an archived OLD version under a playable latest → still OK on the latest", checkAgainstVersions({ action: "comment", versionId: "V3", body: "x" } as never, [vrow({ media_deleted_at: PAST }), vrow({ id: "V3", number: 3, bunny_video_id: "g3" })]), { ok: true });

section("archive — the client's page");
const IT = "I1";
const views: ClientVersionView[] = [{ id: "V2", number: 2, kind: "archived", isAudio: false, fileName: "reel01 v2.mp4" }];
const comments: Record<string, ClientCommentView[]> = { [IT]: [{ id: "c1", version_id: "V2", kind: "pin", pin_number: 1, time_ms: 4442, body: "הערה ישנה", created_at: "t", resolved: true }] };
const base = {
  token: "tok", showName: "אסתטיטוקס", episodeLabel: "הפרק המלא", recordDate: "2026-07-20", episodeIncluded: true, reelsIncluded: true,
  episodeApproved: false, reelsApproved: false, episodeLink: null, reelsLink: null, addons: [],
  items: [{ id: IT, kind: "reel" as const, reel_index: 1, media_link: "https://drive.google.com/file/d/R/view", approved: false }],
  versionsByItem: { [IT]: views },
};
const page = renderToString(<ReviewClient {...base} respondedAt="2026-10-17T10:00:00Z" comments={comments} currentVersion={{ [IT]: "V2" }} reapprovable={{ [IT]: true }} />);
ok("the old comment and the Drive download are there", page.includes("הערה ישנה") && page.includes("הורדת הקובץ המקורי") && page.includes("/download/V2"), page);
ok("no 'יש לי עוד הערה', no '✓ מאשר שוב', no player", !page.includes("יש לי עוד הערה") && !page.includes("מאשר שוב") && !page.includes("<video"), page);
const live = renderToString(<ReviewClient {...base} comments={comments} currentVersion={{ [IT]: "V2" }} />);
ok("live link on an archived item: no pin button", !live.includes("הערה בנקודת זמן") && !live.includes("הוסף עוד הערה"), live);

// ══════════════════════════════════════════════════════════════════════
section("static: the cron, the switch, /radar, labels");
const cron = strip(readFileSync(join(root, "src/app/api/cron/purge-review-media/route.ts"), "utf8"));
ok("cron: CRON_SECRET, like the others", /authorization"\) !== `Bearer \$\{cronSecret\}`/.test(cron));
ok("cron: live only with REVIEW_PURGE_LIVE and no ?report=1; ?limit capped at 20", /isPurgeLive\(\) && url\.searchParams\.get\("report"\) !== "1"/.test(cron) && /Math\.min\(asked, PURGE_MAX_PER_RUN\)/.test(cron));
ok("cron: every run writes its event", /writeRunEvent\(admin, summary\)/.test(cron));
const purgeSrc = readFileSync(join(root, "src/lib/review/purge.ts"), "utf8");
ok("the switch must be exactly 'true' (unset / typo = report)", /process\.env\.REVIEW_PURGE_LIVE === "true"/.test(purgeSrc));
ok("media_deleted_at only in markDeleted, guarded on still-null", (purgeSrc.match(/media_deleted_at: atIso/g) ?? []).length === 1 && /media_deleted_at: atIso[\s\S]{0,120}\.is\("media_deleted_at", null\)/.test(purgeSrc));
ok("no row is deleted from our tables", !/\.delete\(\)/.test(purgeSrc));
const vj = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
check("vercel.json: nightly", vj.crons.find((c) => c.path === "/api/cron/purge-review-media")?.schedule, "45 2 * * *");
const radar = strip(readFileSync(join(root, "src/modules/radar/alerts.ts"), "utf8"));
ok("/radar: reads the LAST purge run event", /\.eq\("entity_type", PURGE_ENTITY\)[\s\S]{0,80}\.eq\("event_type", PURGE_RUN_EVENT\)[\s\S]{0,120}\.limit\(1\)/.test(radar));
ok("/radar: one alert for delete failures, one for Drive problems", /key: "review_purge_failed"[^}]*count: purgeFailed/.test(radar) && /key: "review_purge_drive"[^}]*count: purgeDriveAlerts/.test(radar));
ok("every purge event has a Hebrew label", ["review_media_deleted", "review_media_delete_failed", "review_media_purge_skipped", "review_media_purge_run"].every((t) => !!EVENT_LABEL[t]));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
}
void main();
