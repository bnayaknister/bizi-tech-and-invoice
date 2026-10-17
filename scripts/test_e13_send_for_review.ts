/**
 * E13-4 — "שלח לביקורת" (src/lib/review/versions.ts): the send, the guid by
 * title, applyVideoState (forward only, numbering, integrity), refresh, the
 * drawer's labels.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_send_for_review.ts
 *
 * ═══ F19 ═══ No database, no network. `global.fetch` answers for Google's
 * token endpoint, Drive files.get, the Bunny API and the CDN, and fails the
 * suite on any URL it does not know. The store is in memory and enforces the
 * CHECKs this code must respect: 0116's crv_bunny_fields_chk (no guid only
 * while 'uploading' and unnumbered), 0114's ready-needs-original, the Q17
 * index, bunny_video_id unique, and assign_review_version_number's refusal
 * to number a row the CHECK would reject.
 */
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "bizi-booking@bizi-podclub.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
process.env.GOOGLE_DRIVE_REVIEW_FOLDER_ID = "ROOTfolder0000000001";
process.env.BUNNY_STREAM_LIBRARY_ID = "776376";
process.env.BUNNY_STREAM_API_KEY = "BUNNY-API-KEY-never-in-a-message";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_CDN_TOKEN_KEY = "cdn-token-key";
process.env.BUNNY_DRY_RUN = "false";

import {
  GUID_TRIES,
  applyVideoState,
  isFinal,
  publicVersion,
  refreshVersion,
  sendForReview,
  versionTitle,
  type Deps,
  type NewBunnyVersion,
  type VersionPatch,
  type VersionRow,
  type VersionStore,
} from "../src/lib/review/versions";
import { versionLabel } from "../src/lib/review/versionLabel";
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

const TOKEN = "ya29.SECRET-drive-token";
const ROOT = "ROOTfolder0000000001";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PROD = "prod-1";
const NO_EP = "prod-no-episode";
const USER = "user-1";

// ── fake Drive ─────────────────────────────────────────────────────────────
const drive = new Map<string, Record<string, unknown> | number>();
const dfile = (id: string, over: Record<string, unknown> = {}) =>
  drive.set(id, {
    id,
    name: `${id}.mp4`,
    size: "54500000",
    mimeType: "video/mp4",
    sha256Checksum: SHA_A,
    capabilities: { canDownload: true },
    parents: [ROOT],
    trashed: false,
    ...over,
  });
drive.set(ROOT, { id: ROOT, parents: [], mimeType: "application/vnd.google-apps.folder" });
drive.set("OTHERfolder000000001", { id: "OTHERfolder000000001", parents: [], mimeType: "application/vnd.google-apps.folder" });
dfile("REEL0000000000000001");
dfile("REELnewSHA0000000001", { sha256Checksum: SHA_B }); // same id reused below with a new sha
dfile("MP3file0000000000001", { name: "פרק 8.mp3", mimeType: "audio/mpeg", size: "77000000", sha256Checksum: SHA_B });
dfile("APPLEDOUBLE000000001", { name: "._2_COMBO-2.wav", mimeType: "audio/wav", size: "4096" });
dfile("EMPTY0000000000000001".slice(0, 20), { size: "0" });
dfile("OUTSIDE0000000000001", { parents: ["OTHERfolder000000001"] });
dfile("FAILCASE000000000001");
dfile("FAILFOUND00000000001");
dfile("TWIN0000000000000001");
dfile("EPISODE0000000000001", { size: "7135800000" });
const link = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=sharing`;

// ── fake Bunny ─────────────────────────────────────────────────────────────
type FetchMode = "ok" | "fail_none" | "fail_but_created" | "ok_twin";
let fetchMode: FetchMode = "ok";
let listDelay = 1; // how many list calls before a new video shows up
const videos = new Map<string, BunnyVideo & { listedAfter: number }>();
let listCalls = 0;
let fetchPosts: { url: string; title: string; headers?: Record<string, string> }[] = [];
let headLength: number | "fail" = 0;
const PULL_ZONE_REFERER = "https://bizi-tech-and-invoice.vercel.app/";
const cdnReferers: (string | null)[] = [];
let guidSeq = 0;
const newGuid = () => `00000000-0000-4000-8000-${String(++guidSeq).padStart(12, "0")}`;
const mkVideo = (title: string, over: Partial<BunnyVideo> = {}) => {
  const guid = newGuid();
  videos.set(guid, { guid, title, status: 0, dateUploaded: `2026-10-16T10:00:${String(guidSeq).padStart(2, "0")}Z`, listedAfter: listCalls + listDelay, ...over });
  return guid;
};
const setVideo = (guid: string, over: Partial<BunnyVideo>) => videos.set(guid, { ...videos.get(guid)!, ...over });

let unknown: string[] = [];
global.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  const method = (init.method ?? "GET").toUpperCase();
  if (url === "https://oauth2.googleapis.com/token") {
    return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3599 }), { status: 200 });
  }
  const dm = url.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?/);
  if (dm) {
    const f = drive.get(decodeURIComponent(dm[1]));
    if (f === undefined) return new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 });
    if (typeof f === "number") return new Response("{}", { status: f });
    return new Response(JSON.stringify(f), { status: 200 });
  }
  if (url.startsWith("https://video.bunnycdn.com/library/776376/videos/fetch") && method === "POST") {
    const b = JSON.parse(String(init.body));
    fetchPosts.push(b);
    if (fetchMode === "fail_none") return new Response(JSON.stringify({ success: false, message: "boom" }), { status: 500 });
    mkVideo(b.title);
    if (fetchMode === "ok_twin") mkVideo(b.title);
    if (fetchMode === "fail_but_created") return new Response(JSON.stringify({ success: false, message: "boom" }), { status: 500 });
    return new Response(JSON.stringify({ success: true, message: "OK" }), { status: 200 });
  }
  const lm = url.match(/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\?search=([^&]+)/);
  if (lm && method === "GET") {
    listCalls++;
    const q = decodeURIComponent(lm[1]);
    const items = Array.from(videos.values()).filter((v) => listCalls > v.listedAfter && (v.title ?? "").includes(q));
    return new Response(JSON.stringify({ items }), { status: 200 });
  }
  const gm = url.match(/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\/([0-9a-f-]+)$/);
  if (gm && method === "GET") {
    const v = videos.get(gm[1]);
    return v ? new Response(JSON.stringify(v), { status: 200 }) : new Response("{}", { status: 404 });
  }
  if (url.startsWith("https://vz-test.b-cdn.net/") && method === "HEAD") {
    // the real pull zone (16.10): Allowed Referrers — no Referer from our domain → 403, token or not
    const ref = new Headers(init.headers).get("referer");
    cdnReferers.push(ref);
    if (ref !== PULL_ZONE_REFERER) return new Response(null, { status: 403 });
    if (headLength === "fail") return new Response(null, { status: 500 });
    return new Response(null, { status: 200, headers: { "content-length": String(headLength) } });
  }
  unknown.push(`${method} ${url}`);
  return new Response("unknown", { status: 599 });
}) as typeof fetch;

// ── in-memory store with the real CHECKs ───────────────────────────────────
type Item = { id: string; production_id: string; kind: string; reel_index: number | null; approved: boolean };
type Ver = VersionRow & { has_original: boolean | null; original_sha256: string | null; media_deleted_at: string | null; integrity_at: string | null };
const items: Item[] = [];
const vers: Ver[] = [];
const events: { type: string; production: string; payload: Record<string, unknown> }[] = [];
const prods: Record<string, { id: string; has_episode: boolean; reels_count: number }> = {
  [PROD]: { id: PROD, has_episode: true, reels_count: 3 },
  [NO_EP]: { id: NO_EP, has_episode: false, reels_count: 1 },
};
let itemSeq = 0;
let violations: string[] = [];

function checkRow(v: Ver, where: string) {
  if (!v.bunny_video_id && !(v.bunny_status === "uploading" && v.number === null)) violations.push(`${where}: crv_bunny_fields_chk (no guid while ${v.bunny_status}, number ${v.number})`);
  if (v.bunny_status === "ready" && !(v.has_original === true && v.original_sha256)) violations.push(`${where}: crv_ready_needs_original_chk`);
  if (v.bunny_status === "ready" && !v.ready_at) violations.push(`${where}: crv_ready_at_chk`);
  if ((v.integrity === null) !== (v.integrity_at === null)) violations.push(`${where}: integrity/integrity_at together`);
}
const q17Clash = (v: Ver) =>
  !!v.drive_sha256 &&
  vers.some(
    (o) => o.id !== v.id && o.item_id === v.item_id && o.drive_file_id === v.drive_file_id && o.drive_sha256 === v.drive_sha256 && o.bunny_status !== "failed" && !o.media_deleted_at
  );

const store: VersionStore = {
  async production(id) {
    return prods[id] ?? null;
  },
  async findItem(p, kind, idx) {
    const it = items.find((i) => i.production_id === p && i.kind === kind && i.reel_index === idx);
    return it ? { id: it.id } : null;
  },
  async createItem(p, kind, idx) {
    const it = { id: `item-${++itemSeq}`, production_id: p, kind, reel_index: idx, approved: false };
    items.push(it);
    return { id: it.id };
  },
  async activeSameFile(itemId, fileId, sha) {
    const v = vers.find((o) => o.item_id === itemId && o.drive_file_id === fileId && o.drive_sha256 === sha && o.bunny_status !== "failed" && !o.media_deleted_at);
    return v ? { id: v.id, number: v.number } : null;
  },
  async insertVersion(row: NewBunnyVersion) {
    const v: Ver = {
      id: row.id, item_id: row.item_id, number: null, source: "bunny", media_link: null, bunny_video_id: row.bunny_video_id,
      bunny_status: row.bunny_status, bunny_status_raw: null, is_audio_only: row.is_audio_only, original_filename: row.original_filename,
      original_size_bytes: row.original_size_bytes, drive_file_id: row.drive_file_id, drive_sha256: row.drive_sha256,
      drive_size_bytes: row.drive_size_bytes, integrity: null, ready_at: null, fetch_requested_at: row.fetch_requested_at,
      is_backfill: false, created_at: row.fetch_requested_at, has_original: null, original_sha256: null, media_deleted_at: null, integrity_at: null,
    };
    if (q17Clash(v)) return "duplicate";
    checkRow(v, "insert");
    vers.push(v);
    return "ok";
  },
  async attachGuid(id, guid) {
    const v = vers.find((o) => o.id === id);
    if (!v || v.bunny_video_id) return false;
    if (vers.some((o) => o.bunny_video_id === guid)) return false;
    v.bunny_video_id = guid;
    return true;
  },
  async update(id, patch: VersionPatch) {
    const v = vers.find((o) => o.id === id)!;
    Object.assign(v, patch);
    checkRow(v, `update ${JSON.stringify(Object.keys(patch))}`);
  },
  async getVersion(id) {
    const v = vers.find((o) => o.id === id);
    return v ? { ...v } : null;
  },
  async versionProduction(id) {
    const v = vers.find((o) => o.id === id);
    return v ? items.find((i) => i.id === v.item_id)?.production_id ?? null : null;
  },
  async assignNumber(id) {
    const v = vers.find((o) => o.id === id)!;
    if (v.number !== null) return v.number;
    if (!v.bunny_video_id) throw new Error("assign_review_version_number: the CHECK refuses a number without a guid");
    v.number = Math.max(0, ...vers.filter((o) => o.item_id === v.item_id && o.number !== null).map((o) => o.number!)) + 1;
    return v.number;
  },
  async event(type, production, payload) {
    events.push({ type, production, payload });
  },
  // E13-5 methods — exercised in scripts/test_e13_webhook_cron.ts
  async versionByGuid(guid) {
    const v = vers.find((o) => o.bunny_video_id === guid);
    return v ? { ...v } : null;
  },
  async pendingVersions() {
    return [];
  },
  async knownGuids(guids) {
    return new Set(vers.flatMap((v) => (v.bunny_video_id && guids.includes(v.bunny_video_id) ? [v.bunny_video_id] : [])));
  },
  async eventExists(type, key, value) {
    return events.some((e) => e.type === type && String(e.payload[key]) === value);
  },
  async systemEvent(type, payload) {
    events.push({ type, production: "system", payload });
  },
};

let ids = 0;
const deps: Deps = { store, sleep: async () => {}, newId: () => `10000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` };
const send = (kind: unknown, reelIndex: unknown, driveUrl: unknown, productionId = PROD) =>
  sendForReview({ productionId, kind, reelIndex, driveUrl, userId: USER }, deps);
const evs = (type: string) => events.filter((e) => e.type === type);
const ver = (id: string) => vers.find((v) => v.id === id)!;
const reset = () => {
  fetchPosts = [];
  fetchMode = "ok";
  listDelay = 1;
};

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("drawer labels (plan §9.2)");
  const L = (source: "drive" | "bunny", status: Parameters<typeof versionLabel>[0]["status"], integrity: Parameters<typeof versionLabel>[0]["integrity"] = null, has_guid = true) =>
    versionLabel({ source, status, integrity, has_guid }).text;
  check("uploading, no guid → נשלח", L("bunny", "uploading", null, false), "נשלח");
  check("uploading with guid / created → Bunny מושך", [L("bunny", "uploading"), L("bunny", "created")], ["Bunny מושך", "Bunny מושך"]);
  check("processing / playable → בקידוד", [L("bunny", "processing"), L("bunny", "playable")], ["בקידוד", "בקידוד"]);
  check("ready + hash/size match → מוכן ✓", [L("bunny", "ready", "hash_match"), L("bunny", "ready", "size_match")], ["מוכן ✓", "מוכן ✓"]);
  check("ready + mismatch → אי-התאמה", L("bunny", "ready", "mismatch"), "אי-התאמה");
  check("ready, not checked yet → בבדיקת שלמות", [L("bunny", "ready", null), L("bunny", "ready", "unchecked")], ["בבדיקת שלמות", "בבדיקת שלמות"]);
  check("failed → נכשל", L("bunny", "failed"), "נכשל");
  check("Drive backfill → history", L("drive", null), "Drive (היסטוריה)");

  // ══════════════════════════════════════════════════════════════════════
  section("input refusals — nothing reaches Drive or Bunny");
  check("unknown kind → 400", (await send("trailer", null, link("REEL0000000000000001"))).status, 400);
  check("reel 4 of 3 → 400", (await send("reel", 4, link("REEL0000000000000001"))).status, 400);
  check("reel 0 → 400", (await send("reel", 0, link("REEL0000000000000001"))).status, 400);
  check("episode on a production without one → 400", (await send("episode", null, link("EPISODE0000000000001"), NO_EP)).status, 400);
  check("empty link → 400", (await send("reel", 1, "  ")).status, 400);
  check("unknown production → 404", (await send("reel", 1, link("REEL0000000000000001"), "nope")).status, 404);

  // ══════════════════════════════════════════════════════════════════════
  section("the Drive gate — 422 with the technician's message, nothing written");
  reset();
  const ad = await send("reel", 1, link("APPLEDOUBLE000000001"));
  check("._ file → 422 system_file", [ad.status, ad.body.code], [422, "system_file"]);
  check("…with the owner's message", ad.body.error, "זה קובץ מערכת של Mac ולא הקובץ עצמו. בחר את הקובץ בלי ._ בתחילת השם");
  const em = await send("reel", 1, link("EMPTY000000000000000"));
  check("empty (0-byte) file → 422 no_size", [em.status, em.body.code], [422, "no_size"]);
  const out = await send("reel", 1, link("OUTSIDE0000000000001"));
  check("file outside BIZI PODCLUB → 422 outside_folder", [out.status, out.body.code], [422, "outside_folder"]);
  const fold = await send("reel", 1, "https://drive.google.com/drive/folders/ROOTfolder0000000001");
  check("a folder link → 422 bad_link", [fold.status, fold.body.code], [422, "bad_link"]);
  check("no Bunny request, no item, no version after any refusal", [fetchPosts.length, items.length, vers.length], [0, 0, 0]);

  // ══════════════════════════════════════════════════════════════════════
  section("dry run (BUNNY_DRY_RUN) — checks run, nothing sent, nothing written");
  process.env.BUNNY_DRY_RUN = "true";
  const dry = await send("reel", 1, link("REEL0000000000000001"));
  process.env.BUNNY_DRY_RUN = "false";
  check("200 + dryRun", [dry.status, dry.body.dryRun], [200, true]);
  check("what would be sent: Drive media URL, ASCII title, Authorization redacted", dry.body.wouldSend, {
    url: "https://www.googleapis.com/drive/v3/files/REEL0000000000000001?alt=media&supportsAllDrives=true",
    title: versionTitle("10000000-0000-4000-8000-000000000001"),
    headers: { Authorization: "<redacted>" },
  });
  check("the item would be created (none yet) — and was not", [dry.body.item, items.length], ["would_be_created", 0]);
  check("no Bunny request, no version", [fetchPosts.length, vers.length], [0, 0]);
  ok("the Drive token is nowhere in the dry-run answer", !JSON.stringify(dry.body).includes(TOKEN));
  process.env.BUNNY_DRY_RUN = "";
  const dryDefault = await send("reel", 1, link("REEL0000000000000001"));
  process.env.BUNNY_DRY_RUN = "false";
  check("BUNNY_DRY_RUN unset → still a dry run (rule 40)", [dryDefault.body.dryRun, fetchPosts.length], [true, 0]);

  // ══════════════════════════════════════════════════════════════════════
  section("a real send — reel 1, no item yet (Q6)");
  reset();
  listDelay = 1; // the video shows up on the 2nd listing
  const s1 = await send("reel", 1, link("REEL0000000000000001"));
  check("200", s1.status, 200);
  check("exactly ONE Fetch Video", fetchPosts.length, 1);
  const v1id = (s1.body.version as { id: string }).id;
  check("its title is bizi-<version id>", fetchPosts[0].title, versionTitle(v1id));
  check("Bunny pulls the Drive media URL with the service account's Bearer", [fetchPosts[0].url, fetchPosts[0].headers], [
    "https://www.googleapis.com/drive/v3/files/REEL0000000000000001?alt=media&supportsAllDrives=true",
    { Authorization: `Bearer ${TOKEN}` },
  ]);
  check("Q6: the item was created with approved=false", items.map((i) => [i.kind, i.reel_index, i.approved]), [["reel", 1, false]]);
  const r1 = ver(v1id);
  check("the row: Drive facts kept, guid found by title on a later listing", [r1.drive_file_id, r1.drive_sha256, r1.drive_size_bytes, r1.original_filename, !!r1.bunny_video_id], [
    "REEL0000000000000001", SHA_A, 54500000, "REEL0000000000000001.mp4", true,
  ]);
  check("status 0 (Created) → created, no number yet (Q11)", [r1.bunny_status, r1.number], ["created", null]);
  check("event review_version_fetch_requested, item_created=true", evs("review_version_fetch_requested").map((e) => e.payload.item_created), [true]);
  ok("the answer carries no guid and no token", !JSON.stringify(s1.body).includes(r1.bunny_video_id!) && !JSON.stringify(s1.body).includes(TOKEN));
  ok("events carry no token", !JSON.stringify(events).includes(TOKEN));

  // ══════════════════════════════════════════════════════════════════════
  section("refresh → upload confirmed → numbered → ready → hash_match");
  const g1 = r1.bunny_video_id!;
  setVideo(g1, { status: 1 });
  let rf = await refreshVersion(PROD, v1id, deps);
  check("Uploaded → v1 assigned, still not final", [ver(v1id).number, (rf.body.version as { final: boolean }).final], [1, false]);
  setVideo(g1, { status: 3, availableResolutions: "240p,720p" });
  await refreshVersion(PROD, v1id, deps);
  check("Transcoding with resolutions → playable", ver(v1id).bunny_status, "playable");
  setVideo(g1, { status: 2, availableResolutions: "" });
  await refreshVersion(PROD, v1id, deps);
  check("forward only: a later 'Processing' read does not move playable back", ver(v1id).bunny_status, "playable");
  setVideo(g1, { status: 4, hasOriginal: true, originalHash: SHA_A.toUpperCase(), length: 61.5 });
  rf = await refreshVersion(PROD, v1id, deps);
  check("Finished + original kept → ready, ready_at set, hash_match (case-insensitive)", [ver(v1id).bunny_status, !!ver(v1id).ready_at, ver(v1id).integrity], ["ready", true, "hash_match"]);
  check("duration from Bunny's length", (ver(v1id) as unknown as { duration_ms: number }).duration_ms, 61500);
  check("event review_version_ready with v1 + hash_match", evs("review_version_ready").map((e) => [e.payload.number, e.payload.integrity]), [[1, "hash_match"]]);
  check("final now — the drawer stops polling it", (rf.body.version as { final: boolean }).final, true);
  const listBefore = listCalls;
  const fetchesBefore = unknown.length;
  await refreshVersion(PROD, v1id, deps);
  check("refresh of a final version makes no Bunny call", [listCalls - listBefore, unknown.length - fetchesBefore], [0, 0]);
  check("refresh scoped to the production in the URL → 404 elsewhere", (await refreshVersion("other-prod", v1id, deps)).status, 404);

  // ══════════════════════════════════════════════════════════════════════
  section("Q17 — the same file, unchanged, is not sent twice");
  reset();
  const dup = await send("reel", 1, link("REEL0000000000000001"));
  check("409 duplicate, naming v1", [dup.status, dup.body.code, /v1/.test(String(dup.body.error))], [409, "duplicate", true]);
  check("…and no Bunny request", fetchPosts.length, 0);
  // the file replaced in Drive under the SAME id → a new sha256 → a new version
  dfile("REEL0000000000000001", { sha256Checksum: SHA_B });
  const s2 = await send("reel", 1, link("REEL0000000000000001"));
  check("same file id, new sha256 → accepted", [s2.status, fetchPosts.length], [200, 1]);
  const v2id = (s2.body.version as { id: string }).id;
  setVideo(ver(v2id).bunny_video_id!, { status: 1 });
  await refreshVersion(PROD, v2id, deps);
  check("…numbered v2 on the same item", [ver(v2id).number, ver(v2id).item_id === ver(v1id).item_id], [2, true]);
  check("no second item for reel 1", items.length, 1);

  // ══════════════════════════════════════════════════════════════════════
  section("integrity mismatch (video) — never 'מוכן'");
  setVideo(ver(v2id).bunny_video_id!, { status: 4, hasOriginal: true, originalHash: "c".repeat(64) });
  await refreshVersion(PROD, v2id, deps);
  check("ready but mismatch", [ver(v2id).bunny_status, ver(v2id).integrity], ["ready", "mismatch"]);
  check("event review_integrity_mismatch (hash)", evs("review_integrity_mismatch").map((e) => e.payload.kind), ["hash"]);
  check("label → אי-התאמה", versionLabel(publicVersion(ver(v2id))).text, "אי-התאמה");

  // ══════════════════════════════════════════════════════════════════════
  section("audio — size of /original, not Bunny's hash (decision 4)");
  reset();
  const a = await send("reel", 2, link("MP3file0000000000001"));
  const aid = (a.body.version as { id: string }).id;
  check("mp3 → is_audio_only from Drive's mime", ver(aid).is_audio_only, true);
  const ag = ver(aid).bunny_video_id!;
  headLength = "fail";
  setVideo(ag, { status: 4, hasOriginal: true, originalHash: "d".repeat(64) }); // Bunny's hash never matches an mp3
  const failRf = await refreshVersion(PROD, aid, deps);
  check("HEAD fails → unchecked, not final, label בבדיקת שלמות", [ver(aid).integrity, isFinal(ver(aid)), versionLabel(publicVersion(ver(aid))).text], ["unchecked", false, "בבדיקת שלמות"]);
  check("…and the refresh answer carries a log line with the reason", failRf.log, { version_id: aid, production_id: PROD, integrity: "unchecked", detail: "HEAD /original → HTTP 500" });
  ok("the log is NOT in the body the browser gets", !("log" in failRf.body) && !JSON.stringify(failRf.body).includes("HTTP 500"));
  // 16.10 live: the pull zone 403s a server request without our Referer
  process.env.BUNNY_CDN_REFERER = "https://somewhere-else.example/";
  headLength = 77000000;
  const refRf = await refreshVersion(PROD, aid, deps);
  delete process.env.BUNNY_CDN_REFERER;
  check("a wrong Referer → 403 → still unchecked, and the log says 403", [ver(aid).integrity, refRf.log?.detail], ["unchecked", "HEAD /original → HTTP 403"]);
  ok("the log never carries the signed URL or its token", !/token=|b-cdn\.net|expires=/.test(JSON.stringify([failRf.log, refRf.log])));
  const okRf = await refreshVersion(PROD, aid, deps);
  check("next refresh retries (with the pull zone's Referer) → size_match (hash ignored for audio)", ver(aid).integrity, "size_match");
  check("a match leaves no log line", okRf.log, undefined);
  ok("every CDN HEAD the code sent carried a Referer", cdnReferers.length > 0 && cdnReferers.every((r) => typeof r === "string" && r.length > 0));
  check("…the pull zone's domain by default", cdnReferers.at(-1), PULL_ZONE_REFERER);
  reset();
  const a2 = await send("reel", 3, link("MP3file0000000000001"));
  const a2id = (a2.body.version as { id: string }).id;
  headLength = 76999999;
  setVideo(ver(a2id).bunny_video_id!, { status: 4, hasOriginal: true, originalHash: "e".repeat(64) });
  const mmRf = await refreshVersion(PROD, a2id, deps);
  check("audio of another size → mismatch (size)", [ver(a2id).integrity, evs("review_integrity_mismatch").at(-1)?.payload.kind], ["mismatch", "size"]);
  check("…logged with both sizes", mmRf.log?.detail, "size 76999999 ≠ Drive 77000000");

  // ══════════════════════════════════════════════════════════════════════
  section("Bunny reports failure; original missing");
  reset();
  const f = await send("episode", null, link("EPISODE0000000000001"));
  const fid = (f.body.version as { id: string }).id;
  setVideo(ver(fid).bunny_video_id!, { status: 5 });
  await refreshVersion(PROD, fid, deps);
  check("status 5 → failed, never numbered (Q11)", [ver(fid).bunny_status, ver(fid).number], ["failed", null]);
  check("event review_version_failed", evs("review_version_failed").length, 1);
  setVideo(ver(fid).bunny_video_id!, { status: 4, hasOriginal: true, originalHash: SHA_A });
  await refreshVersion(PROD, fid, deps);
  check("failed is final — a later read does not revive it", ver(fid).bunny_status, "failed");
  reset();
  const resend = await send("episode", null, link("EPISODE0000000000001"));
  check("the same file after a failure may be sent again (Q17 skips failed rows)", [resend.status, fetchPosts.length], [200, 1]);
  const rid = (resend.body.version as { id: string }).id;
  setVideo(ver(rid).bunny_video_id!, { status: 4, hasOriginal: false, originalHash: null });
  await refreshVersion(PROD, rid, deps);
  await refreshVersion(PROD, rid, deps);
  check("Finished without the original → processing, review_original_missing once", [ver(rid).bunny_status, evs("review_original_missing").length], ["processing", 1]);

  // ══════════════════════════════════════════════════════════════════════
  section("the fetch request itself fails");
  reset();
  fetchMode = "fail_none";
  const itemsBefore = items.length;
  const versBefore = vers.length;
  const ff = await send("reel", 3, link("FAILCASE000000000001"));
  check("502, sent ONCE (never retried), and NO row", [ff.status, fetchPosts.length, vers.length - versBefore], [502, 1, 0]);
  check("no item created for a send that wrote nothing", items.length - itemsBefore, 0);
  check("event review_version_fetch_failed", evs("review_version_fetch_failed").length, 1);
  ok("the API key is not in the message", !String(ff.body.error).includes("BUNNY-API-KEY"));
  reset();
  fetchMode = "fail_but_created";
  listDelay = 0;
  const fc = await send("reel", 3, link("FAILFOUND00000000001"));
  const fcid = (fc.body.version as { id: string }).id;
  check("request failed but Bunny made the video → found by title, row written WITH its guid", [fc.status, fetchPosts.length, !!ver(fcid)?.bunny_video_id], [200, 1, true]);

  // ══════════════════════════════════════════════════════════════════════
  section("guid not listed yet; two videos with one title");
  reset();
  listDelay = 100; // Bunny lists it only much later
  const slow = await send("reel", 2, link("REELnewSHA0000000001"));
  const sid = (slow.body.version as { id: string }).id;
  check(`send still answers 200 after ${GUID_TRIES} searches, row 'uploading' without a guid`, [slow.status, ver(sid).bunny_status, ver(sid).bunny_video_id], [200, "uploading", null]);
  check("label → נשלח", versionLabel(publicVersion(ver(sid))).text, "נשלח");
  for (const v of Array.from(videos.values())) if (v.title === versionTitle(sid)) v.listedAfter = 0;
  await refreshVersion(PROD, sid, deps);
  check("refresh finds the guid later and reads the status", [!!ver(sid).bunny_video_id, ver(sid).bunny_status], [true, "created"]);
  reset();
  fetchMode = "ok_twin";
  listDelay = 0;
  const tw = await send("reel", 1, link("TWIN0000000000000001"));
  const twid = (tw.body.version as { id: string }).id;
  const twins = Array.from(videos.values()).filter((v) => v.title === versionTitle(twid)).sort((x, y) => String(x.dateUploaded).localeCompare(String(y.dateUploaded)));
  check("two videos with the title → the earliest is linked", ver(twid).bunny_video_id, twins[0].guid);
  check("event review_fetch_duplicate names the other", evs("review_fetch_duplicate").at(-1)?.payload.other_guids, [twins[1].guid]);

  // ══════════════════════════════════════════════════════════════════════
  section("applyVideoState directly — guards");
  const drv: VersionRow = { ...ver(v1id), id: "drive-v1", source: "drive", bunny_video_id: null, bunny_status: null };
  const updatesBefore = JSON.stringify(vers);
  await applyVideoState(drv, { guid: "x", status: 4 }, PROD, deps);
  ok("a Drive (history) version is never touched", JSON.stringify(vers) === updatesBefore);

  // ══════════════════════════════════════════════════════════════════════
  section("the store never saw a row its CHECKs would refuse; no unknown URL");
  check("CHECK violations", violations, []);
  check("unknown URLs", unknown, []);

  // ══════════════════════════════════════════════════════════════════════
  section("static");
  const src = readFileSync(join(__dirname, "../src/lib/review/versions.ts"), "utf8");
  ok("no console.* in lib/review/versions.ts (no token, no key in logs)", !/console\./.test(src));
  ok("the Fetch Video call appears once, outside any loop over attempts", (src.match(/fetchVideoFromUrl\(/g) ?? []).length === 1);
  const store_src = readFileSync(join(__dirname, "../src/lib/review/versionStore.ts"), "utf8");
  ok("createItem writes approved: false (Q6)", /insert\(\{ production_id: productionId, kind, reel_index: reelIndex, approved: false \}\)/.test(store_src));
  ok("no DELETE anywhere in the store", !/\.delete\(/.test(store_src));
  // 16.10: every SERVER request to the CDN must send the pull zone's Referer.
  // Any fetch in src/ to a signed CDN URL without `Referer:` beside it fails here.
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
    });
  // A file that only SIGNS a URL and hands it to the browser (the E13-6 player
  // and download routes) is fine: the browser sends our origin itself. The
  // trap is a SERVER fetch() of a signed CDN URL — that one must add it.
  const cdnCallers = walk(join(__dirname, "../src"))
    .filter((f) => !f.endsWith("lib/bunny/sign.ts"))
    .filter((f) => !/\.tsx$/.test(f)) // client components: the browser fetches, with its own Referer
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      return /signedOriginalUrl\(|signedPlaybackUrl\(/.test(src) && /(await|=)\s*fetch\(/.test(src);
    });
  const missing = cdnCallers.filter((f) => !/Referer:\s*bunnyCdnReferer\(\)/.test(readFileSync(f, "utf8")));
  check("every src/ file that FETCHES a signed CDN URL from the server sends Referer: bunnyCdnReferer()", missing.map((f) => f.split("/src/")[1]), []);
  ok("…and versions.ts (the integrity HEAD) is one of them", cdnCallers.some((f) => f.endsWith("lib/review/versions.ts")));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
