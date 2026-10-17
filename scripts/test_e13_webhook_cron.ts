/**
 * E13-5 — Bunny's webhook and the two backup crons (src/lib/review/bunnySync.ts,
 * src/lib/bunny/webhookSignature.ts), plus the static walls around them.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_webhook_cron.ts
 *
 * ═══ F19 ═══ No database, no network. `global.fetch` answers for the Bunny
 * API and the CDN and fails the suite on any URL it does not know. The store
 * is in memory and enforces the CHECKs as of 0117: a guid-less Bunny row only
 * in 'uploading' or 'failed' and never numbered; ready needs the original;
 * integrity and integrity_at together; Q17 skipping failed rows.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.BUNNY_STREAM_LIBRARY_ID = "776376";
process.env.BUNNY_STREAM_API_KEY = "BUNNY-API-KEY-never-in-a-message";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_CDN_TOKEN_KEY = "cdn-token-key";
process.env.BUNNY_DRY_RUN = "true"; // the webhook and the crons only READ Bunny: they must work in dry run
const RO_KEY = "readonly-key-of-library-776376";
process.env.BUNNY_STREAM_READONLY_KEY = RO_KEY;

import { handleBunnyWebhook, runOrphanSweep, runVersionsCron, CRON_BATCH } from "../src/lib/review/bunnySync";
import { verifyBunnySignature } from "../src/lib/bunny/webhookSignature";
import { isFinal, type Deps, type NewBunnyVersion, type VersionPatch, type VersionRow, type VersionStore } from "../src/lib/review/versions";
import type { BunnyVideo } from "../src/lib/bunny/status";

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
const ok = (name: string, cond: boolean) => check(name, cond, true);
const section = (t: string) => console.log(`\n── ${t}`);

const SHA = "a".repeat(64);
const REFERER = "https://bizi-tech-and-invoice.vercel.app/";
const NOW = new Date("2026-10-17T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let seq = 0;
// real hex uuids — the code validates the guid shape, as Bunny's are hex
const HEX: Record<string, string> = { ver: "a0000000", item: "b0000000", vid: "c0000000", gone: "d0000000", fill: "e0000000" };
const uuid = (kind: string) => `${HEX[kind] ?? "f0000000"}-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ── fake Bunny ─────────────────────────────────────────────────────────────
const videos = new Map<string, BunnyVideo>();
let headLength: number | "fail" = 0;
let getVideoCalls = 0;
let brokenGuid = "";
let unknown: string[] = [];
global.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") unknown.push(`WRITE ${method} ${url}`); // nothing here may write to Bunny
  const page = url.match(/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\?page=(\d+)&itemsPerPage=(\d+)/);
  if (page && method === "GET") {
    const all = Array.from(videos.values());
    const p = Number(page[1]);
    const n = Number(page[2]);
    return new Response(JSON.stringify({ items: all.slice((p - 1) * n, p * n), totalItems: all.length }), { status: 200 });
  }
  const search = url.match(/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\?search=([^&]+)/);
  if (search && method === "GET") {
    const q = decodeURIComponent(search[1]);
    return new Response(JSON.stringify({ items: Array.from(videos.values()).filter((v) => (v.title ?? "").includes(q)) }), { status: 200 });
  }
  const one = url.match(/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\/([0-9a-f-]+)$/);
  if (one && method === "GET") {
    getVideoCalls++;
    if (one[1] === brokenGuid) return new Response("boom", { status: 500 });
    const v = videos.get(one[1]);
    return v ? new Response(JSON.stringify(v), { status: 200 }) : new Response("{}", { status: 404 });
  }
  if (url.startsWith("https://vz-test.b-cdn.net/") && method === "HEAD") {
    if (new Headers(init.headers).get("referer") !== REFERER) return new Response(null, { status: 403 });
    if (headLength === "fail") return new Response(null, { status: 500 });
    return new Response(null, { status: 200, headers: { "content-length": String(headLength) } });
  }
  unknown.push(`${method} ${url}`);
  return new Response("unknown", { status: 599 });
}) as typeof fetch;

// ── in-memory store, CHECKs as of 0117 ─────────────────────────────────────
type Ver = VersionRow & { has_original: boolean | null; original_sha256: string | null; media_deleted_at: string | null; integrity_at: string | null; production: string };
const vers: Ver[] = [];
const events: { type: string; production: string; payload: Record<string, unknown> }[] = [];
const violations: string[] = [];
let lastPendingLimit = 0;

function checkRow(v: Ver, where: string) {
  if (!v.bunny_video_id && !((v.bunny_status === "uploading" || v.bunny_status === "failed") && v.number === null)) {
    violations.push(`${where}: crv_bunny_fields_chk (0117) — no guid while ${v.bunny_status}, number ${v.number}`);
  }
  if (v.bunny_status === "ready" && !(v.has_original === true && v.original_sha256)) violations.push(`${where}: ready needs original`);
  if ((v.integrity === null) !== (v.integrity_at === null)) violations.push(`${where}: integrity/integrity_at`);
}

function seed(over: Partial<Ver> & { production?: string }): Ver {
  const id = uuid("ver");
  const v: Ver = {
    id, item_id: uuid("item"), number: null, source: "bunny", media_link: null, bunny_video_id: null, bunny_status: "uploading",
    bunny_status_raw: null, is_audio_only: false, original_filename: "x.mp4", original_size_bytes: 1000, drive_file_id: "F",
    drive_sha256: SHA, drive_size_bytes: 1000, integrity: null, ready_at: null, fetch_requested_at: hoursAgo(1), is_backfill: false,
    created_at: hoursAgo(1), has_original: null, original_sha256: null, media_deleted_at: null, integrity_at: null, production: "prod-1",
    ...over,
  };
  checkRow(v, "seed");
  vers.push(v);
  return v;
}
const ver = (id: string) => vers.find((v) => v.id === id)!;

const store: VersionStore = {
  async production() { return null; },
  async findItem() { return null; },
  async createItem() { throw new Error("not in E13-5"); },
  async activeSameFile() { return null; },
  async insertVersion(_row: NewBunnyVersion) { return "ok"; },
  async attachGuid(id, guid) {
    const v = vers.find((o) => o.id === id);
    if (!v || v.bunny_video_id || vers.some((o) => o.bunny_video_id === guid)) return false;
    v.bunny_video_id = guid;
    return true;
  },
  async update(id, patch: VersionPatch) {
    const v = ver(id);
    Object.assign(v, patch);
    checkRow(v, `update ${Object.keys(patch).join(",")}`);
  },
  async getVersion(id) {
    const v = vers.find((o) => o.id === id);
    return v ? { ...v } : null;
  },
  async versionProduction(id) {
    return vers.find((o) => o.id === id)?.production ?? null;
  },
  async assignNumber(id) {
    const v = ver(id);
    if (v.number !== null) return v.number;
    if (!v.bunny_video_id) throw new Error("CHECK: no number without a guid");
    v.number = Math.max(0, ...vers.filter((o) => o.item_id === v.item_id && o.number !== null).map((o) => o.number!)) + 1;
    return v.number;
  },
  async event(type, production, payload) { events.push({ type, production, payload }); },
  async versionByGuid(guid) {
    const v = vers.find((o) => o.bunny_video_id === guid);
    return v ? { ...v } : null;
  },
  async pendingVersions(limit) {
    lastPendingLimit = limit;
    return vers
      .filter((v) => v.source === "bunny" && !v.media_deleted_at && !isFinal(v))
      .sort((a, b) => String(a.fetch_requested_at).localeCompare(String(b.fetch_requested_at)))
      .slice(0, limit)
      .map((v) => ({ row: { ...v }, productionId: v.production }));
  },
  async knownGuids(guids) {
    return new Set(vers.flatMap((v) => (v.bunny_video_id && guids.includes(v.bunny_video_id) ? [v.bunny_video_id] : [])));
  },
  async eventExists(type, key, value) {
    return events.some((e) => e.type === type && String(e.payload[key]) === value);
  },
  async systemEvent(type, payload) { events.push({ type, production: "system", payload }); },
};
const deps: Deps = { store, now: () => NOW, sleep: async () => {} };
const evs = (type: string) => events.filter((e) => e.type === type);

// ── signing like Bunny ─────────────────────────────────────────────────────
const sign = (raw: string, key = RO_KEY) => createHmac("sha256", key).update(Buffer.from(raw, "utf8")).digest("hex");
function hdrs(raw: string, over: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    "x-bunnystream-signature-version": "v1",
    "x-bunnystream-signature-algorithm": "hmac-sha256",
    "x-bunnystream-signature": sign(raw),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) delete base[k];
    else base[k] = v;
  }
  return new Headers(base);
}
const body = (guid: string, status = 3, library: unknown = 776376) => JSON.stringify({ VideoLibraryId: library, VideoGuid: guid, Status: status });
const hook = (raw: string, h = hdrs(raw)) => handleBunnyWebhook(raw, h, deps);

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("signature (bunny.net/docs/stream-webhook)");
  const g0 = uuid("vid");
  const raw0 = body(g0);
  check("valid → ok", verifyBunnySignature(raw0, hdrs(raw0), RO_KEY), { ok: true });
  check("no signature header → 401 no_signature", (await hook(raw0, hdrs(raw0, { "x-bunnystream-signature": null }))).log?.reason, "no_signature");
  check("Version ≠ v1 → bad_version", verifyBunnySignature(raw0, hdrs(raw0, { "x-bunnystream-signature-version": "v2" }), RO_KEY), { ok: false, reason: "bad_version" });
  check("Algorithm ≠ hmac-sha256 → bad_algorithm", verifyBunnySignature(raw0, hdrs(raw0, { "x-bunnystream-signature-algorithm": "hmac-sha1" }), RO_KEY), { ok: false, reason: "bad_algorithm" });
  check("not 64 hex → malformed", verifyBunnySignature(raw0, hdrs(raw0, { "x-bunnystream-signature": "abc" }), RO_KEY), { ok: false, reason: "malformed_signature" });
  check("upper-case hex (Bunny sends lower-case) → malformed", verifyBunnySignature(raw0, hdrs(raw0, { "x-bunnystream-signature": sign(raw0).toUpperCase() }), RO_KEY), { ok: false, reason: "malformed_signature" });
  check("signed with another key → mismatch", verifyBunnySignature(raw0, hdrs(raw0, { "x-bunnystream-signature": sign(raw0, "other-key") }), RO_KEY), { ok: false, reason: "mismatch" });
  const tampered = raw0.replace('"Status":3', '"Status":4');
  check("body changed after signing (one byte) → mismatch", verifyBunnySignature(tampered, hdrs(raw0), RO_KEY), { ok: false, reason: "mismatch" });
  const spaced = JSON.stringify(JSON.parse(raw0), null, 1);
  check("the SAME json re-serialised → mismatch (raw bytes are what is signed)", verifyBunnySignature(spaced, hdrs(raw0), RO_KEY), { ok: false, reason: "mismatch" });
  const heb = JSON.stringify({ VideoLibraryId: 776376, VideoGuid: g0, Status: 3, Note: "פרק 8" });
  check("non-ASCII body signed over its UTF-8 bytes → ok", verifyBunnySignature(heb, hdrs(heb), RO_KEY), { ok: true });
  const r401 = await hook(raw0, hdrs(raw0, { "x-bunnystream-signature": sign(raw0, "x") }));
  check("rejected call: 401, an empty-ish body that names no reason", [r401.status, r401.body], [401, { ok: false }]);
  delete process.env.BUNNY_STREAM_READONLY_KEY;
  const r503 = await hook(raw0);
  process.env.BUNNY_STREAM_READONLY_KEY = RO_KEY;
  check("key not configured → 503, never 'accept everything'", [r503.status, r503.log?.reason], [503, "no_readonly_key"]);

  // ══════════════════════════════════════════════════════════════════════
  section("body shape and library");
  const notJson = "not json";
  check("signed but not JSON → 400", (await hook(notJson)).status, 400);
  const noGuid = JSON.stringify({ VideoLibraryId: 776376, Status: 3 });
  check("signed but no guid → 400", (await hook(noGuid)).status, 400);
  const before = getVideoCalls;
  const other = await hook(body(g0, 3, 999));
  check("another library → 200 ignored, Bunny not even asked", [other.status, other.log?.reason, getVideoCalls - before], [200, "other_library", 0]);

  // ══════════════════════════════════════════════════════════════════════
  section("a known guid: the webhook's Status is a nudge, the video object decides");
  const gA = uuid("vid");
  const vA = seed({ bunny_video_id: gA, bunny_status: "created", fetch_requested_at: hoursAgo(1) });
  videos.set(gA, { guid: gA, title: `bizi-${vA.id}`, status: 4, hasOriginal: true, originalHash: SHA.toUpperCase(), length: 59 });
  const rA = await hook(body(gA, 5)); // webhook says 5 (Failed in the WEBHOOK enum) — must not be read as a status
  check("200 synced", [rA.status, rA.log?.result], [200, "synced"]);
  check("the video object (4 = Finished, original kept) → ready + hash_match, numbered", [ver(vA.id).bunny_status, ver(vA.id).integrity, ver(vA.id).number], ["ready", "hash_match", 1]);
  check("one review_version_ready", evs("review_version_ready").length, 1);
  setVideo(gA, { status: 3 });
  await hook(body(gA, 3));
  await hook(body(gA, 3));
  check("duplicate / late webhooks: still ready, no second event", [ver(vA.id).bunny_status, evs("review_version_ready").length], ["ready", 1]);

  // ══════════════════════════════════════════════════════════════════════
  section("a guid we do not carry yet");
  const vB = seed({ fetch_requested_at: hoursAgo(0.1) }); // sent, title search found nothing yet
  const gB = uuid("vid");
  videos.set(gB, { guid: gB, title: `bizi-${vB.id}`, status: 1, availableResolutions: "" });
  const rB = await hook(body(gB, 1));
  check("webhook beat the title search → linked and synced", [rB.log?.result, ver(vB.id).bunny_video_id, ver(vB.id).bunny_status, ver(vB.id).number], ["linked", gB, "processing", 1]);

  const gDup = uuid("vid");
  videos.set(gDup, { guid: gDup, title: `bizi-${vB.id}`, status: 4 });
  const d1 = await hook(body(gDup));
  const d2 = await hook(body(gDup));
  check("a second video with the same title → duplicate, reported ONCE, not linked", [d1.log?.result, d2.log?.result, evs("review_fetch_duplicate").length, ver(vB.id).bunny_video_id], ["duplicate_reported", "duplicate_known", 1, gB]);

  const orphanVersion = uuid("gone");
  const gO = uuid("vid");
  videos.set(gO, { guid: gO, title: `bizi-${orphanVersion}`, status: 4, dateUploaded: hoursAgo(5), storageSize: 123 });
  const o1 = await hook(body(gO));
  const o2 = await hook(body(gO));
  check("bizi-<uuid> with no row → orphan, reported ONCE as a system event", [o1.log?.result, o2.log?.result, evs("review_orphan_video").length, evs("review_orphan_video")[0]?.production], ["orphan_reported", "orphan_known", 1, "system"]);
  check("the orphan event carries guid, title and version id", [evs("review_orphan_video")[0]?.payload.guid, evs("review_orphan_video")[0]?.payload.version_id], [gO, orphanVersion]);

  const gF = uuid("vid");
  videos.set(gF, { guid: gF, title: "test from the dashboard", status: 4 });
  const fz = await hook(body(gF));
  check("a title that is not bizi-<uuid> → ignored, no event", [fz.log?.reason, evs("review_orphan_video").length], ["not_a_bizi_title", 1]);
  const gGone = uuid("vid");
  check("a guid Bunny no longer knows → 200 ignored", (await hook(body(gGone))).log?.reason, "unknown_guid_gone_at_bunny");

  // ══════════════════════════════════════════════════════════════════════
  section("hourly cron — versions that are not final");
  // (a) no guid for 25h, Bunny lists nothing → failed (0117) + review_fetch_stuck
  const vStuck = seed({ fetch_requested_at: hoursAgo(25), drive_file_id: "STUCKFILE" });
  // (b) no guid for 2h → left alone
  const vYoung = seed({ fetch_requested_at: hoursAgo(2) });
  // (c) a guid Bunny lost → failed + review_video_missing
  const gLost = uuid("vid");
  const vLost = seed({ bunny_video_id: gLost, bunny_status: "processing", fetch_requested_at: hoursAgo(3) });
  // (d) audio ready but unchecked for 4 days, HEAD keeps failing → review_integrity_stuck once
  const gAud = uuid("vid");
  const vAud = seed({ bunny_video_id: gAud, bunny_status: "ready", is_audio_only: true, drive_sha256: null, drive_size_bytes: 777, has_original: true, original_sha256: "e".repeat(64), number: 1, integrity: "unchecked", integrity_at: hoursAgo(1), ready_at: hoursAgo(4 * 24), fetch_requested_at: hoursAgo(4 * 24 + 1) });
  videos.set(gAud, { guid: gAud, title: `bizi-${vAud.id}`, status: 4, hasOriginal: true, originalHash: "e".repeat(64) });
  // (e) one whose read throws — must not stop the others
  const gBroken = uuid("vid");
  const vBroken = seed({ bunny_video_id: gBroken, bunny_status: "created", fetch_requested_at: hoursAgo(26) });
  videos.set(gBroken, { guid: gBroken, title: `bizi-${vBroken.id}`, status: 0 });
  brokenGuid = gBroken;
  headLength = "fail";

  const c1 = await runVersionsCron(deps);
  check(`batch size passed to the store is ${CRON_BATCH}`, lastPendingLimit, CRON_BATCH);
  check("(a) 25h without a guid → failed, guid still null, event once", [ver(vStuck.id).bunny_status, ver(vStuck.id).bunny_video_id, evs("review_fetch_stuck").length], ["failed", null, 1]);
  check("(b) 2h without a guid → still uploading", ver(vYoung.id).bunny_status, "uploading");
  check("(c) a video Bunny lost → failed + review_video_missing", [ver(vLost.id).bunny_status, evs("review_video_missing").length], ["failed", 1]);
  check("(d) HEAD still failing → unchecked, and review_integrity_stuck written", [ver(vAud.id).integrity, evs("review_integrity_stuck").length], ["unchecked", 1]);
  check("(e) one broken read → counted as an error, the rest still ran", [c1.errors, ver(vBroken.id).bunny_status], [1, "created"]);
  ok("the summary carries a detail line for the unchecked version (reason, no URL)", JSON.stringify(c1.details).includes("HTTP 500") && !JSON.stringify(c1.details).includes("token="));
  brokenGuid = "";
  await runVersionsCron(deps);
  check("second run: no second stuck / missing / integrity_stuck event", [evs("review_fetch_stuck").length, evs("review_video_missing").length, evs("review_integrity_stuck").length], [1, 1, 1]);
  check("(e) the version whose read broke is processed normally on the next run", ver(vBroken.id).bunny_status, "created");
  headLength = 777;
  await runVersionsCron(deps);
  check("(d) once the HEAD works → size_match, final", [ver(vAud.id).integrity, isFinal(ver(vAud.id))], ["size_match", true]);
  check("failed versions drop out of the cron", (await store.pendingVersions(50)).some((p) => p.row.id === vStuck.id || p.row.id === vLost.id), false);

  // ══════════════════════════════════════════════════════════════════════
  section("daily cron — orphans in the library (paged, read-only)");
  for (let i = 0; i < 140; i++) {
    const g = uuid("fill");
    videos.set(g, { guid: g, title: `manual upload ${i}`, status: 4, dateUploaded: hoursAgo(48) });
  }
  const gNewOrphan = uuid("vid");
  videos.set(gNewOrphan, { guid: gNewOrphan, title: `bizi-${uuid("gone")}`, status: 4, dateUploaded: hoursAgo(3) });
  const gYoungOrphan = uuid("vid");
  videos.set(gYoungOrphan, { guid: gYoungOrphan, title: `bizi-${uuid("gone")}`, status: 0, dateUploaded: hoursAgo(0.2) });
  // a version still waiting without a guid whose video is in the library
  const vWait = seed({ fetch_requested_at: hoursAgo(1.5) });
  const gWait = uuid("vid");
  videos.set(gWait, { guid: gWait, title: `bizi-${vWait.id}`, status: 1, dateUploaded: hoursAgo(1.5) });
  const sw = await runOrphanSweep(deps);
  check("read every page (2 pages of 100)", [sw.pages, sw.videos_in_library], [2, videos.size]);
  check("new orphan reported, the one younger than an hour skipped", [evs("review_orphan_video").some((e) => e.payload.guid === gNewOrphan), evs("review_orphan_video").some((e) => e.payload.guid === gYoungOrphan)], [true, false]);
  check("the earlier orphan (webhook) is not reported twice", evs("review_orphan_video").filter((e) => e.payload.guid === gO).length, 1);
  check("a waiting version gets its guid from the sweep", ver(vWait.id).bunny_video_id, gWait);
  const ev0 = events.length;
  await runOrphanSweep(deps);
  check("second sweep writes no new event", events.length - ev0, 0);

  // ══════════════════════════════════════════════════════════════════════
  section("the store never saw a row its CHECKs would refuse; nothing wrote to Bunny");
  check("CHECK violations", violations, []);
  check("unknown URLs / writes to Bunny", unknown, []);

  // ══════════════════════════════════════════════════════════════════════
  section("static");
  const root = join(__dirname, "..");
  const route = readFileSync(join(root, "src/app/api/bunny/webhook/route.ts"), "utf8");
  ok("the webhook route reads request.text() (raw bytes), never request.json()", /request\.text\(\)/.test(route) && !/request\.json\(\)/.test(route));
  ok("…and reads it before anything else", route.indexOf("request.text()") < route.indexOf("handleBunnyWebhook(raw"));
  const sync = readFileSync(join(root, "src/lib/review/bunnySync.ts"), "utf8");
  ok("bunnySync never calls a Bunny write (create / fetch / delete)", !/createVideo\(|fetchVideoFromUrl\(|fetchVideoRaw\(|deleteVideo\(/.test(sync));
  ok("no console.* in bunnySync / webhookSignature (routes log, the logic does not)", !/console\./.test(sync) && !/console\./.test(readFileSync(join(root, "src/lib/bunny/webhookSignature.ts"), "utf8")));
  const sig = readFileSync(join(root, "src/lib/bunny/webhookSignature.ts"), "utf8");
  ok("the signature compare is timingSafeEqual after a length check", /given\.length !== expected\.length \|\| !timingSafeEqual/.test(sig));
  const vj = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
  check("vercel.json: versions hourly, orphans daily", [vj.crons.find((c) => c.path === "/api/cron/review-versions")?.schedule, vj.crons.find((c) => c.path === "/api/cron/review-orphans")?.schedule], ["0 * * * *", "15 1 * * *"]);
  ok("middleware lets /api/bunny/ through", readFileSync(join(root, "src/lib/supabase/middleware.ts"), "utf8").includes('path.startsWith("/api/bunny/")'));
  for (const p of ["src/app/api/cron/review-versions/route.ts", "src/app/api/cron/review-orphans/route.ts"]) {
    ok(`${p.split("/").slice(-2, -1)[0]}: gated by Bearer CRON_SECRET`, /authorization"\) !== `Bearer \$\{cronSecret\}`/.test(readFileSync(join(root, p), "utf8")));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

function setVideo(guid: string, over: Partial<BunnyVideo>) {
  videos.set(guid, { ...videos.get(guid)!, ...over });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
