/**
 * Owner 22.10 — sending for review safely: the warnings and the confirmation
 * screen, "stuck an hour" with its alert, and "שליחה מחדש". Built from the
 * two real mistakes: המניפה's reel sent to the episode slot (21.10) and The
 * Communicators' EP16 sent to סדרת חינוך (22.10).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_review_send_safety.tsx
 *
 * No database, no network: `global.fetch` answers Google's token endpoint,
 * Drive files.get and the Bunny video read, and fails on anything else.
 * BUNNY_DRY_RUN=true — nothing reaches Bunny's write API in this suite.
 */
import React from "react";
import { generateKeyPairSync } from "node:crypto";
import { renderToString } from "react-dom/server";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "bizi-booking@bizi-podclub.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
process.env.GOOGLE_DRIVE_REVIEW_FOLDER_ID = "ROOTfolder0000000001";
process.env.BUNNY_STREAM_LIBRARY_ID = "776376";
process.env.BUNNY_STREAM_API_KEY = "BUNNY-API-KEY-never-in-a-message";
process.env.BUNNY_STREAM_CDN_HOSTNAME = "vz-test.b-cdn.net";
process.env.BUNNY_DRY_RUN = "true";

import {
  folderWarning,
  nameKindWarning,
  otherShowInName,
  sameFileWarnings,
  showKeys,
  type SameFileRow,
  type ShowForWarn,
} from "../src/lib/review/sendWarnings";
import { resendVersion, sendForReview, type VersionRow, type VersionStore } from "../src/lib/review/versions";
import { runVersionsCron, type StuckAlert } from "../src/lib/review/bunnySync";
import { isStuck, versionLabel } from "../src/lib/review/versionLabel";
import ReviewSendConfirm from "../src/components/ReviewSendConfirm";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail !== undefined ? `\n       ${JSON.stringify(detail)?.slice(0, 600)}` : ""}`);
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── the shows (real names and aliases) ──────────────────────────────────────
const SHOWS: ShowForWarn[] = [
  { id: "s-sedra", name: "סדרת חינוך", aliases: ["אור גיא ומיכאלי", "אור וגיא", "גיא ואור"] },
  { id: "s-comm", name: "הקומוניקטור", aliases: ["עומר חן", "עומר חן - The Communicators", "הקומיוניקייטור"] },
  { id: "s-menifa", name: "המניפה", aliases: ["HAMENIFA"] },
  { id: "s-chai", name: "חי", aliases: [] }, // too short to ever match
];

// ── fake Drive ─────────────────────────────────────────────────────────────
const ROOT = "ROOTfolder0000000001";
const drive = new Map<string, Record<string, unknown>>();
const folder = (id: string, name: string, parent: string) => drive.set(id, { id, name, parents: [parent], mimeType: "application/vnd.google-apps.folder" });
drive.set(ROOT, { id: ROOT, name: "BIZI PODCLUB", parents: [], mimeType: "application/vnd.google-apps.folder" });
folder("F-COMM", "OMER HEN - THE COMMUNICATORS", ROOT);
folder("F-COMM-EP16", "EP16", "F-COMM");
folder("F-SEDRA", "סדרת חינוך - אור מיכאלי וגיא", ROOT);
folder("F-SEDRA-EP13", "EP 13", "F-SEDRA");
const file = (id: string, name: string, parent: string) =>
  drive.set(id, { id, name, size: "6887175502", mimeType: "video/mp4", sha256Checksum: "c".repeat(64), capabilities: { canDownload: true }, parents: [parent], trashed: false });
file("COMMEP16000000000001", "THE COMMUNICATORS - EP16 ROUGH CUT.mp4", "F-COMM-EP16");
file("SEDRAEP1300000000001", "סדרת חינוך פרק 13 v1.mp4", "F-SEDRA-EP13");
file("SEDRAREEL00000000001", "סדרת חינוך - REEL 1.mp4", "F-SEDRA-EP13");

let bunnyVideo: Record<string, unknown> = { guid: "g-stuck", status: 2, encodeProgress: 0 };
const unknown: string[] = [];
global.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.T", expires_in: 3599 }), { status: 200 });
  const dm = url.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?/);
  if (dm) {
    const f = drive.get(decodeURIComponent(dm[1]));
    return f ? new Response(JSON.stringify(f), { status: 200 }) : new Response(JSON.stringify({ error: { message: "nf" } }), { status: 404 });
  }
  if (/^https:\/\/video\.bunnycdn\.com\/library\/776376\/videos\/[0-9a-z-]+$/.test(url) && (init.method ?? "GET") === "GET") {
    return new Response(JSON.stringify(bunnyVideo), { status: 200 });
  }
  unknown.push(`${init.method ?? "GET"} ${url}`);
  return new Response("unknown", { status: 599 });
}) as typeof fetch;

// ── a small in-memory store ────────────────────────────────────────────────
const PROD_SEDRA = "p-sedra";
const ITEM_SEDRA_EP = "i-sedra-ep";
type Row = VersionRow & { media_deleted_at?: string | null };
const vers: Row[] = [];
const events: { type: string; production: string; payload: Record<string, unknown> }[] = [];
let sameRows: SameFileRow[] = [];
const store: VersionStore = {
  async production(id) {
    return id === PROD_SEDRA ? { id, has_episode: true, reels_count: 2 } : null;
  },
  async findItem(p, kind, idx) {
    return p === PROD_SEDRA && kind === "episode" && idx === null ? { id: ITEM_SEDRA_EP } : null;
  },
  async createItem() {
    return { id: "i-new" };
  },
  async activeSameFile() {
    return null;
  },
  async insertVersion() {
    return "ok";
  },
  async attachGuid() {
    return true;
  },
  async update(id, patch) {
    const r = vers.find((v) => v.id === id);
    if (r) Object.assign(r, patch);
  },
  async getVersion(id) {
    return vers.find((v) => v.id === id) ?? null;
  },
  async versionProduction(id) {
    return vers.some((v) => v.id === id) ? PROD_SEDRA : null;
  },
  async assignNumber() {
    return 1;
  },
  async event(type, production, payload) {
    events.push({ type, production, payload });
  },
  async versionByGuid() {
    return null;
  },
  async pendingVersions() {
    return vers.filter((v) => v.bunny_status !== "failed" && v.bunny_status !== "ready").map((row) => ({ row, productionId: PROD_SEDRA }));
  },
  async knownGuids() {
    return new Set();
  },
  async eventExists(type, key, value) {
    return events.some((e) => e.type === type && e.payload[key] === value);
  },
  async systemEvent() {},
  async sendContext() {
    return { showId: "s-sedra", showName: "סדרת חינוך", podcastName: "סדרת חינוך", recordDate: "2026-10-20" };
  },
  async sameDriveFile() {
    return sameRows;
  },
  async warnShows() {
    return SHOWS;
  },
  async itemMaxNumber() {
    return 0;
  },
  async itemOf(itemId) {
    return itemId === ITEM_SEDRA_EP ? { kind: "episode", reel_index: null } : null;
  },
};
const link = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=sharing`;
const send = (fileId: string, extra: Record<string, unknown> = {}) =>
  sendForReview({ productionId: PROD_SEDRA, kind: "episode", reelIndex: null, driveUrl: link(fileId), userId: "u-shahar", ...extra }, { store });

async function main() {
  console.log("\n=== 1. the name of the file vs the slot ===");
  ok("'HAMENIFA - EP 6 - REEL 1 - V1.mp4' to the EPISODE slot -> warning", !!nameKindWarning("HAMENIFA - EP 6 - REEL 1 - V1.mp4", "episode"));
  ok("'…ריל 2.mp4' to the episode slot -> warning", !!nameKindWarning("המניפה פרק 6 ריל 2.mp4", "episode"));
  ok("'HAMENIFA- EP 6 - V2.mp4' to the episode slot -> fine", nameKindWarning("HAMENIFA- EP 6 - V2.mp4", "episode") === null);
  ok("'…REEL 1 v2.mp4' to a reel slot -> fine", nameKindWarning("HAMENIFA - EP 6 - REEL 1 v2.mp4", "reel") === null);
  ok("'HAMENIFA- EP 6 - V2.mp4' to a REEL slot -> warning (looks like an episode)", !!nameKindWarning("HAMENIFA- EP 6 - V2.mp4", "reel"));
  ok("'FREELANCER.mp4' is not 'reel'", nameKindWarning("FREELANCER interview.mp4", "episode") === null);

  console.log("\n=== 2. another show in the name / the folder ===");
  ok("an alias 'A - B' also answers to B ('the communicators')", showKeys(SHOWS[1]).includes("the communicators"));
  ok("a 2-letter name never matches", showKeys(SHOWS[3]).length === 0);
  eq("'THE COMMUNICATORS - EP16 ROUGH CUT.mp4' sent to סדרת חינוך -> names הקומוניקטור", otherShowInName("THE COMMUNICATORS - EP16 ROUGH CUT.mp4", SHOWS, "s-sedra")?.code, "name-other-show");
  ok("…the same file sent to הקומוניקטור itself -> no warning", otherShowInName("THE COMMUNICATORS - EP16 ROUGH CUT.mp4", SHOWS, "s-comm") === null);
  ok("a name with BOTH this show and another -> no warning", otherShowInName("סדרת חינוך - עומר חן מתארח.mp4", SHOWS, "s-sedra") === null);
  eq("folder 'OMER HEN - THE COMMUNICATORS' while sending to סדרת חינוך -> warning", folderWarning(["OMER HEN - THE COMMUNICATORS", "EP16"], SHOWS, "s-sedra")?.code, "folder-other-show");
  ok("…its own folder -> none", folderWarning(["סדרת חינוך - אור מיכאלי וגיא", "EP 13"], SHOWS, "s-sedra") === null);
  ok("…a folder that names no show -> none", folderWarning(["Misc"], SHOWS, "s-sedra") === null);

  console.log("\n=== 3. the same Drive file elsewhere ===");
  const row = (o: Partial<SameFileRow>): SameFileRow => ({ itemId: "x", productionId: "p-other", showId: "s-comm", showName: "הקומוניקטור", kind: "episode", reelIndex: null, recordDate: "2026-10-18", number: 1, ...o });
  const tgt = { productionId: "p-menifa", showId: "s-menifa", itemId: "i-ep" };
  eq("המניפה: the reel's file already on reel 1 of THIS production -> warning", sameFileWarnings([row({ itemId: "i-reel1", productionId: "p-menifa", showId: "s-menifa", kind: "reel", reelIndex: 1 })], tgt).map((w) => w.text), ["אותו קובץ כבר נשלח בהפקה הזאת לריל 1 v1."]);
  eq("a production of ANOTHER show -> warning with its name and date", sameFileWarnings([row({})], tgt).map((w) => w.text), ["אותו קובץ כבר נשלח לתוכנית אחרת: הקומוניקטור 18.10 (פרק v1)."]);
  eq("another production of the SAME show -> no warning", sameFileWarnings([row({ showId: "s-menifa", productionId: "p-menifa-2" })], tgt), []);
  eq("the same item (Q17 refuses it on its own) -> no warning", sameFileWarnings([row({ itemId: "i-ep", productionId: "p-menifa", showId: "s-menifa" })], tgt), []);

  console.log("\n=== 4. sendForReview: preview, hold, send anyway ===");
  sameRows = [];
  const pv = await send("COMMEP16000000000001", { preview: true });
  const p = (pv.body as { preview?: Record<string, unknown> }).preview as { file: { name: string }; folder: string; show: string; target: string; next_version: number; warnings: { code: string }[] } | undefined;
  ok("the Communicators file to סדרת חינוך -> a preview, nothing sent", pv.status === 200 && !!p, pv);
  eq("…what goes where", [p?.file.name, p?.folder, p?.show, p?.target, p?.next_version], ["THE COMMUNICATORS - EP16 ROUGH CUT.mp4", "OMER HEN - THE COMMUNICATORS / EP16", "סדרת חינוך", "פרק מלא", 1]);
  eq("…two warnings: the name and the folder", p?.warnings.map((w) => w.code), ["name-other-show", "folder-other-show"]);
  const held = await send("COMMEP16000000000001");
  eq("send WITHOUT 'send anyway' -> 409 warnings, nothing sent", [held.status, (held.body as { code?: string }).code], [409, "warnings"]);
  const anyway = await send("COMMEP16000000000001", { ackWarnings: true });
  ok("send anyway -> passes the gate (reaches the Bunny dry run)", anyway.status === 200 && (anyway.body as { dryRun?: boolean }).dryRun === true, anyway);
  ok("…and the override is recorded", events.some((e) => e.type === "review_send_warnings_overridden" && JSON.stringify(e.payload.warnings) === JSON.stringify(["name-other-show", "folder-other-show"])));
  const clean = await send("SEDRAEP1300000000001");
  ok("the right file -> no warnings, no acknowledgement needed", clean.status === 200 && (clean.body as { dryRun?: boolean }).dryRun === true, clean);
  const cleanPv = await send("SEDRAEP1300000000001", { preview: true });
  eq("…its preview: own folder, no warnings", [(cleanPv.body as { preview: { folder: string; warnings: unknown[] } }).preview.folder, (cleanPv.body as { preview: { warnings: unknown[] } }).preview.warnings.length], ["סדרת חינוך - אור מיכאלי וגיא / EP 13", 0]);
  const reelPv = await send("SEDRAREEL00000000001", { preview: true });
  eq("a REEL file to the episode slot -> the name-kind warning", (reelPv.body as { preview: { warnings: { code: string }[] } }).preview.warnings.map((w) => w.code), ["name-kind"]);

  console.log("\n=== 5. stuck an hour, and the resend ===");
  const now = new Date();
  ok("processing 2 hours -> stuck", isStuck({ final: false, status: "processing", sent_at: new Date(now.getTime() - 2 * 3600_000).toISOString() }, now));
  ok("processing 30 minutes -> not yet", !isStuck({ final: false, status: "processing", sent_at: new Date(now.getTime() - 30 * 60_000).toISOString() }, now));
  ok("failed / ready / final -> never 'stuck'", ["failed", "ready"].every((st) => !isStuck({ final: false, status: st, sent_at: "2026-01-01T00:00:00Z" }, now)) && !isStuck({ final: true, status: "processing", sent_at: "2026-01-01T00:00:00Z" }, now));
  eq("the label", versionLabel({ source: "bunny", status: "processing", integrity: null, has_guid: true, stuck: true }), { text: "תקוע — מעל שעה", tone: "bad" });

  const v = (id: string, status: Row["bunny_status"], ageMin: number): Row => ({
    id, item_id: ITEM_SEDRA_EP, number: 2, source: "bunny", media_link: null, bunny_video_id: `g-${id}`, bunny_status: status, bunny_status_raw: 2,
    is_audio_only: false, original_filename: "סדרת חינוך פרק 13 v1.mp4", original_size_bytes: 5172526386, drive_file_id: "SEDRAEP1300000000001", drive_sha256: "c".repeat(64),
    drive_size_bytes: 5172526386, integrity: null, ready_at: null, fetch_requested_at: new Date(now.getTime() - ageMin * 60_000).toISOString(), is_backfill: false,
    created_at: new Date(now.getTime() - ageMin * 60_000).toISOString(),
  });
  vers.push(v("stuck", "processing", 120), v("fresh", "processing", 10));

  const alerts: StuckAlert[] = [];
  bunnyVideo = { guid: "g-stuck", status: 2, encodeProgress: 0 };
  await runVersionsCron({ store, onStuck: async (a) => void alerts.push(a) });
  eq("hourly cron: one alert, for the 2-hour one only", alerts.map((a) => a.versionId), ["stuck"]);
  ok("…an event review_encoding_stuck", events.filter((e) => e.type === "review_encoding_stuck").length === 1);
  await runVersionsCron({ store, onStuck: async (a) => void alerts.push(a) });
  eq("…the next hour: no second alert", alerts.length, 1);

  const deleted: string[] = [];
  const del = async (guid: string) => {
    deleted.push(guid);
    return { dryRun: false as const, alreadyGone: false };
  };
  const notStuck = await resendVersion({ productionId: PROD_SEDRA, versionId: "fresh", userId: "u" }, { store, deleteVideo: del });
  eq("resend of a version 10 minutes old -> 409, nothing touched", [notStuck.status, vers.find((x) => x.id === "fresh")?.bunny_status, deleted.length], [409, "processing", 0]);
  const res = await resendVersion({ productionId: PROD_SEDRA, versionId: "stuck", userId: "u" }, { store, deleteVideo: del });
  ok("resend of the stuck one -> the same file sent again (Bunny dry run)", res.status === 200 && (res.body as { dryRun?: boolean }).dryRun === true, res);
  eq("…the stuck version: failed, its Bunny video deleted", [vers.find((x) => x.id === "stuck")?.bunny_status, deleted, !!vers.find((x) => x.id === "stuck")?.media_deleted_at], ["failed", ["g-stuck"], true]);
  ok("…an event review_version_resent", events.some((e) => e.type === "review_version_resent" && e.payload.version_id === "stuck" && e.payload.bunny_delete === "deleted"));
  const other = await resendVersion({ productionId: "p-else", versionId: "stuck", userId: "u" }, { store, deleteVideo: del });
  eq("a version of another production -> 404", other.status, 404);

  console.log("\n=== 6. the confirmation screen ===");
  const html = renderToString(
    <ReviewSendConfirm
      preview={{ file: { name: "THE COMMUNICATORS - EP16 ROUGH CUT.mp4", size_bytes: 6887175502 }, folder: "OMER HEN - THE COMMUNICATORS / EP16", show: "סדרת חינוך", record_date: "2026-10-20", target: "פרק מלא", next_version: 1, warnings: [{ code: "folder-other-show", text: "הקובץ נמצא בתיקייה של תוכנית אחרת" }] }}
      busy={false}
      onConfirm={() => {}}
      onCancel={() => {}}
    />
  ).replace(/<!-- -->/g, "");
  ok("file, folder, show + date, target + version", ["THE COMMUNICATORS - EP16 ROUGH CUT.mp4", "6.89 GB", "OMER HEN - THE COMMUNICATORS / EP16", "סדרת חינוך · 20.10.2026", "פרק מלא · v1"].every((t) => html.includes(t)), html);
  ok("…the warnings in a red box, and the button says 'לשלוח בכל זאת'", html.includes("data-review-send-warnings") && html.includes("לשלוח בכל זאת"));
  const plain = renderToString(
    <ReviewSendConfirm preview={{ file: { name: "x.mp4", size_bytes: null }, folder: null, show: null, record_date: null, target: "ריל 1", next_version: 3, warnings: [] }} busy={false} onConfirm={() => {}} onCancel={() => {}} />
  );
  ok("no warnings -> no red box, the button says 'שליחה'", !plain.includes("data-review-send-warnings") && plain.includes("שליחה") && !plain.includes("בכל זאת"));
  eq("no preview -> nothing", renderToString(<ReviewSendConfirm preview={null} busy={false} onConfirm={() => {}} onCancel={() => {}} />), "");

  eq("no unknown network call", unknown, []);
  console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
