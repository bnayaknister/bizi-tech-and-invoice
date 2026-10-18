/**
 * E13-6 — the client's versions, player, picker and download.
 * src/lib/review/clientVersions.ts (what is shown, who may play/download),
 * src/app/r/[token]/ReviewPlayer.tsx and its place in ReviewClient, the two
 * public routes (static), and the page's rule-38 fallback.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_e13_client_player.tsx
 *
 * ═══ F19 ═══ No database, no network, no keys: signing is injected.
 * Renders the client components themselves (the "SSR 200 is not a render
 * check" lesson), including with missing fields.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  clientVersionsForItem,
  driveDownloadUrl,
  gateDownloadForLink,
  gateVersionForLink,
  isPlayableBunny,
  itemInLinkScope,
  type VersionForClient,
} from "../src/lib/review/clientVersions";
import ReviewPlayer, { type ClientVersionView } from "../src/app/r/[token]/ReviewPlayer";
import ReviewClient from "../src/app/r/[token]/ReviewClient";

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
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond && detail) console.log(`       ${detail.slice(0, 400)}`);
  check(name, cond, true);
};
const section = (t: string) => console.log(`\n── ${t}`);

const ITEM = "11111111-1111-4111-8111-111111111111";
const sign = (guid: string) => ({ url: `https://cdn.test/bcdn_token=T/${guid}/playlist.m3u8`, expires: 1_900_000_000 });
let n = 0;
const v = (over: Partial<VersionForClient>): VersionForClient => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  item_id: ITEM,
  number: 1,
  source: "bunny",
  media_link: null,
  bunny_video_id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
  bunny_status: "ready",
  integrity: "hash_match",
  has_original: true,
  is_audio_only: false,
  original_filename: "reel01 v2.mp4",
  drive_file_id: "DRIVEFILE",
  media_deleted_at: null,
  ...over,
});
const drive1 = () => v({ number: 1, source: "drive", media_link: "https://drive.google.com/file/d/X/view", bunny_video_id: null, bunny_status: null, integrity: null, has_original: null, drive_file_id: null, original_filename: null });

function render(el: React.ReactElement): string {
  try {
    return renderToString(el);
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ══════════════════════════════════════════════════════════════════════
section("what the client is shown (plan §9.2 E13-6 (a); Q14; owner 17.10)");
check("only Drive history → nothing changes (empty: the page keeps today's view)", clientVersionsForItem([drive1()], sign), []);
const ready = v({ number: 2 });
const both = clientVersionsForItem([drive1(), ready], sign);
check("v1 Drive + v2 ready → both, oldest first, v2 is the current one", both.map((x) => [x.number, x.kind]), [[1, "drive"], [2, "bunny"]]);
check("the bunny entry carries the signed playlist URL", both[1].kind === "bunny" && both[1].playbackUrl, sign(ready.bunny_video_id!).url);
for (const [label, over] of [
  ["mismatch", { integrity: "mismatch" }],
  ["unchecked", { integrity: "unchecked" }],
  ["no integrity yet", { integrity: null }],
  ["still processing", { bunny_status: "processing", integrity: null }],
  ["failed", { bunny_status: "failed" }],
  ["no original kept", { has_original: false }],
  ["unnumbered", { number: null }],
] as const) {
  const hidden = v({ number: 3, ...over });
  const list = clientVersionsForItem([drive1(), ready, hidden], sign);
  check(`v3 ${label} → not shown, the client still sees v2 as current (no notice)`, list.map((x) => x.number), [1, 2]);
}
const onlyHidden = clientVersionsForItem([drive1(), v({ number: 2, integrity: "mismatch" })], sign);
// owner 18.10: "שלח לביקורת" now points the item's media_link at the NEW file at send time,
// so a pending version falls back to the Drive HISTORY, never to media_link (decision 14)
check("v2 in mismatch, nothing else from Bunny → the Drive history v1 (not the item's link, which now points at v2)", onlyHidden.map((x) => [x.number, x.kind]), [[1, "drive"]]);
check("v2 still processing → the Drive history v1", clientVersionsForItem([drive1(), v({ number: 2, bunny_status: "processing", integrity: null })], sign).map((x) => [x.number, x.kind]), [[1, "drive"]]);
check("v2 failed → as before: empty, today's view", clientVersionsForItem([drive1(), v({ number: 2, bunny_status: "failed" })], sign), []);
check("v2 pending with NO Drive history → empty (nothing earlier to show)", clientVersionsForItem([v({ number: 2, bunny_status: "processing", integrity: null })], sign), []);
const archived = clientVersionsForItem([drive1(), v({ number: 2, media_deleted_at: "2027-01-20T00:00:00Z", drive_file_id: "ORIG123" })], sign);
check("v2 deleted at Bunny (E13-10) → archived: the download button, no player", archived.map((x) => x.kind), ["drive", "archived"]);
check("the archived entry carries no Drive id or URL to the page (the route resolves it)", Object.keys(archived[1]).sort(), ["fileName", "id", "isAudio", "kind", "number"]);
check("bunny with a Drive id → downloadable", both[1].kind === "bunny" && both[1].downloadable, true);
const noDrive = clientVersionsForItem([v({ number: 2, drive_file_id: null })], sign);
check("bunny without a Drive id → still plays, not downloadable", noDrive[0].kind === "bunny" && noDrive[0].downloadable, false);
check("Drive direct-download address (owner 17.10: from Drive, not the view page)", driveDownloadUrl("ORIG123"), "https://drive.usercontent.google.com/download?id=ORIG123&export=download&confirm=t");
check("the Drive id is URL-encoded", driveDownloadUrl("a&b"), "https://drive.usercontent.google.com/download?id=a%26b&export=download&confirm=t");
const audio = clientVersionsForItem([v({ number: 2, is_audio_only: true, integrity: "size_match", original_filename: "DLP - V1.mp3" })], sign);
check("audio with size_match → shown, flagged as audio", audio[0].kind === "bunny" && [audio[0].isAudio, audio[0].fileName], [true, "DLP - V1.mp3"]);
check("isPlayableBunny refuses a Drive row", isPlayableBunny(drive1()), false);

// ══════════════════════════════════════════════════════════════════════
section("who may renew playback / who may download");
const PROD = "22222222-2222-4222-8222-222222222222";
const linkAll = { production_id: PROD, scope: "all" as const };
const ep = { id: ITEM, production_id: PROD, kind: "episode" };
const reel = { id: ITEM, production_id: PROD, kind: "reel" };
check("episode item, scope all → in scope", itemInLinkScope(linkAll, ep, true), true);
check("reel item, scope episode → out of scope", itemInLinkScope({ ...linkAll, scope: "episode" }, reel, true), false);
check("reel item, scope reels but reels not required → out (same rule as the page)", itemInLinkScope({ ...linkAll, scope: "reels" }, reel, false), false);
check("item of ANOTHER production → out", itemInLinkScope(linkAll, { ...ep, production_id: "33333333-3333-4333-8333-333333333333" }, true), false);
check("ready version in scope → ok", gateVersionForLink(linkAll, true, ep, ready), { ok: true });
check("version of a different item → not_in_scope", gateVersionForLink(linkAll, true, ep, { ...ready, item_id: "44444444-4444-4444-8444-444444444444" }), { ok: false, reason: "not_in_scope" });
check("mismatch version → not_playable (no download of a file that failed integrity)", gateVersionForLink(linkAll, true, ep, v({ integrity: "mismatch" })), { ok: false, reason: "not_playable" });
check("deleted version → not_playable", gateVersionForLink(linkAll, true, ep, v({ media_deleted_at: "2027-01-01T00:00:00Z" })), { ok: false, reason: "not_playable" });
check("Drive version → not_playable (nothing of ours to sign)", gateVersionForLink(linkAll, true, ep, drive1()), { ok: false, reason: "not_playable" });
check("download: ready version in scope → ok, with ITS Drive file", gateDownloadForLink(linkAll, true, ep, ready), { ok: true, driveFileId: "DRIVEFILE" });
const deleted = v({ media_deleted_at: "2027-01-01T00:00:00Z", drive_file_id: "ORIG9" });
check("download: deleted at Bunny → still ok, from Drive (before AND after deletion)", gateDownloadForLink(linkAll, true, ep, deleted), { ok: true, driveFileId: "ORIG9" });
check("download: deleted at Bunny → playback refused", gateVersionForLink(linkAll, true, ep, deleted).ok, false);
check("download: out of scope → not_in_scope", gateDownloadForLink({ ...linkAll, scope: "episode" }, true, reel, ready), { ok: false, reason: "not_in_scope" });
check("download: mismatch → refused (a version the client is not shown)", gateDownloadForLink(linkAll, true, ep, v({ integrity: "mismatch" })), { ok: false, reason: "not_downloadable" });
check("download: still processing → refused", gateDownloadForLink(linkAll, true, ep, v({ bunny_status: "processing", integrity: null })), { ok: false, reason: "not_downloadable" });
check("download: no Drive id → refused", gateDownloadForLink(linkAll, true, ep, v({ drive_file_id: null })), { ok: false, reason: "not_downloadable" });
check("download: Drive history row → refused (it keeps today's iframe + open-in-Drive)", gateDownloadForLink(linkAll, true, ep, drive1()), { ok: false, reason: "not_downloadable" });

// ══════════════════════════════════════════════════════════════════════
section("ReviewPlayer renders (server render, no hls.js on the server)");
const views = both as ClientVersionView[];
const driveStub = (l: string) => <div data-drive={l}>DRIVE-VIEW</div>;
const cur = render(<ReviewPlayer token="tok" versions={views} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("current = v2: a <video>, a download link to OUR route, the file name", cur.includes("<video") && cur.includes("/api/r/tok/download/" + ready.id) && cur.includes("reel01 v2.mp4"), cur);
const chipText = (html: string, k: number) => new RegExp(`>v(<!-- -->)?${k}<`).test(html);
ok("picker shows v1 and v2, labelled 'הגרסה הנוכחית'", chipText(cur, 1) && chipText(cur, 2) && cur.includes("הגרסה הנוכחית"), cur);
ok("the signed playlist URL is NOT in the HTML (set by the effect, in the browser)", !cur.includes("bcdn_token"), cur);
const old = render(<ReviewPlayer token="tok" versions={views} selectedId={views[0].id} onSelect={() => {}} renderDrive={driveStub} />);
ok("v1 selected → today's Drive view, labelled 'לצפייה בלבד', no download button", old.includes("DRIVE-VIEW") && old.includes("לצפייה בלבד") && !old.includes("/download/"), old);
const one = render(<ReviewPlayer token="tok" versions={[views[1]]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("a single version → no picker", !chipText(one, 2) && one.includes("<video"), one);
const aud = render(<ReviewPlayer token="tok" versions={audio as ClientVersionView[]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("audio → <audio controls>, not <video>", aud.includes("<audio") && !aud.includes("<video"), aud);
const arch = render(<ReviewPlayer token="tok" versions={archived as ClientVersionView[]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("archived → the download button through OUR route, no player, no 'פנו לצוות'", arch.includes("הורדת הקובץ המקורי") && arch.includes("/api/r/tok/download/") && !arch.includes("<video") && !arch.includes("פנו"), arch);
const nd = render(<ReviewPlayer token="tok" versions={noDrive as ClientVersionView[]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("bunny without a Drive id → player, no download button", nd.includes("<video") && !nd.includes("/download/"), nd);
const noName = render(<ReviewPlayer token="tok" versions={[{ ...(views[1] as Extract<ClientVersionView, { kind: "bunny" }>), fileName: null }]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />);
ok("missing file name → renders, no crash", !noName.startsWith("THREW") && noName.includes("הורדת הקובץ המקורי"), noName);
const strayId = render(<ReviewPlayer token="tok" versions={views} selectedId="not-a-real-id" onSelect={() => {}} renderDrive={driveStub} />);
ok("a selected id that no longer exists → falls back to the current version", strayId.includes("<video") && strayId.includes("הגרסה הנוכחית"), strayId);
check("no versions → renders nothing", render(<ReviewPlayer token="tok" versions={[]} selectedId={null} onSelect={() => {}} renderDrive={driveStub} />), "");

// ══════════════════════════════════════════════════════════════════════
section("ReviewClient: the player appears only where Bunny was reached");
const base = {
  token: "tok",
  showName: "אסתטיטוקס",
  episodeLabel: "הפרק המלא",
  recordDate: "2026-07-20",
  episodeIncluded: true,
  reelsIncluded: true,
  episodeApproved: false,
  reelsApproved: false,
  episodeLink: null,
  reelsLink: null,
  addons: [],
};
const REEL1 = ITEM;
const EPI = "55555555-5555-4555-8555-555555555555";
const items = [
  { id: EPI, kind: "episode" as const, reel_index: null, media_link: "https://drive.google.com/file/d/EPISODE/view", approved: false },
  { id: REEL1, kind: "reel" as const, reel_index: 1, media_link: "https://drive.google.com/file/d/REEL/view", approved: false },
];
const page = render(<ReviewClient {...base} items={items} versionsByItem={{ [REEL1]: views }} />);
ok("reel 1 (reached Bunny) → our <video> + download", page.includes("<video") && page.includes(`/api/r/tok/download/${ready.id}`), page);
ok("the episode (Drive only) → today's iframe, untouched", page.includes("drive.google.com/file/d/EPISODE/preview"), page);
ok("response buttons still on both items (current version selected)", (page.match(/✓ מאשר/g) ?? []).length === 2, page);
const legacy = render(<ReviewClient {...base} items={items} />);
ok("no versionsByItem at all (older server / failed read) → today's page, no player", !legacy.includes("<video") && legacy.includes("REEL/preview"), legacy);
const noItems = render(<ReviewClient {...base} episodeLink="https://drive.google.com/file/d/TRACK/view" items={[]} versionsByItem={{ [REEL1]: views }} />);
ok("track-level layout (no items) → unchanged", !noItems.startsWith("THREW") && noItems.includes("TRACK/preview") && !noItems.includes("<video"), noItems);
const approvedPage = render(<ReviewClient {...base} items={[{ ...items[1], approved: true }]} versionsByItem={{ [REEL1]: views }} />);
ok("an approved reel still shows its player and download (download always, owner 16.10)", approvedPage.includes("<video") && approvedPage.includes("/download/") && approvedPage.includes("✓ אושר"), approvedPage);

// ══════════════════════════════════════════════════════════════════════
section("static: the routes and the page");
const root = join(__dirname, "..");
const dl = readFileSync(join(root, "src/app/api/r/[token]/download/[versionId]/route.ts"), "utf8");
ok("download: resolveLink, then the download gate, then a 302", /resolveLink\(/.test(dl) && /gateDownloadForLink\(/.test(dl) && /status: 302/.test(dl));
ok("download: to Drive's direct download, nothing from Bunny (owner 17.10)", /driveDownloadUrl\(gate\.driveFileId\)/.test(dl) && !/signedOriginalUrl|\/original|@\/lib\/bunny/.test(dl.replace(/^\s*\/\/.*$/gm, "")));
ok("download: not a proxy (no fetch of the file)", !/await fetch\(|=\s*fetch\(/.test(dl));
ok("download: leaves a client_review_download event", /client_review_download/.test(dl));
const pb = readFileSync(join(root, "src/app/api/r/[token]/playback/route.ts"), "utf8");
ok("playback: resolveLink + the shared gate + a 4-hour signature", /resolveLink\(/.test(pb) && /gateVersionForLink\(/.test(pb) && /PLAYBACK_TTL_SECONDS/.test(pb));
const pg = readFileSync(join(root, "src/app/r/[token]/page.tsx"), "utf8");
ok("page: loadClientVersions inside try/catch (rule 38 — a failure keeps today's page)", /try \{\s*versionsByItem = await loadClientVersions/.test(pg) && /catch \(e\)/.test(pg));
const pl = readFileSync(join(root, "src/app/r/[token]/ReviewPlayer.tsx"), "utf8");
ok("player: hls.js is loaded lazily (dynamic import), never in the main bundle", /import\("hls\.js"\)/.test(pl) && !/^import .*hls\.js/m.test(pl));
ok("player: native HLS first (Safari / iOS)", /application\/vnd\.apple\.mpegurl/.test(pl));
ok("player: on a fatal error it re-signs through /playback and resumes from the same second", /\/playback\?version=/.test(pl) && /el\.currentTime = at/.test(pl));
const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
check("hls.js pinned to an exact version", /^\d+\.\d+\.\d+$/.test(pj.dependencies["hls.js"] ?? ""), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
