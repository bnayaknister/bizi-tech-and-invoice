/**
 * E13-3 — src/lib/google/drive.ts: the gate before a Bunny fetch (plan §5.2,
 * owner decision 3 of 16.10). Link parsing, files.get, the mime / download /
 * size / trash refusals, the walk up to the review folder (depth, cycles,
 * folders the service account cannot see), and the service-account token.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_google_drive.ts
 *
 * ═══ F19 ═══ No database, no network. `global.fetch` answers from the fake
 * Drive tree below and fails the suite on any URL it does not know. The
 * service-account key is generated here.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DRIVE_READONLY,
  DriveError,
  REVIEW_FOLDER_MAX_DEPTH,
  checkReviewFile,
  driveFileMeta,
  extractDriveFileId,
  isInsideFolder,
  reviewFolderId,
  serviceAccountToken,
} from "../src/lib/google/drive";

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

const TOKEN = "ya29.SECRET-should-never-appear-in-a-message";
const ROOT = "ROOTfolder0000000001"; // "BIZI PODCLUB"
const SHA = "AB".repeat(32); // Drive answers hex; upper-case here to prove the lower-casing

// ── the fake Drive ─────────────────────────────────────────────────────────
type Node = { status?: number; body?: Record<string, unknown> };
const tree = new Map<string, Node>();
const folder = (id: string, parents: string[]) => tree.set(id, { body: { id, parents, mimeType: "application/vnd.google-apps.folder" } });
const file = (id: string, over: Record<string, unknown> = {}) =>
  tree.set(id, {
    body: {
      id,
      name: `${id}.mp4`,
      size: "7135800000",
      mimeType: "video/mp4",
      sha256Checksum: SHA,
      md5Checksum: "m",
      capabilities: { canDownload: true },
      parents: [ROOT],
      trashed: false,
      ...over,
    },
  });

folder(ROOT, ["MYDRIVEroot000000001"]);
tree.set("MYDRIVEroot000000001", { status: 404 }); // above the shared folder: not visible
folder("SUBfolder00000000001", [ROOT]);
folder("SUBSUBfolder00000001", ["SUBfolder00000000001"]);
folder("OTHERvisible00000001", []); // a folder the account sees, but not under ROOT
tree.set("OTHERhidden000000001", { status: 404 });
folder("CYCLEa00000000000001", ["CYCLEb00000000000001"]);
folder("CYCLEb00000000000001", ["CYCLEa00000000000001"]);
folder("FLAKYfolder000000001", [ROOT]);
tree.set("FLAKYfolder000000001", { status: 503 });
// a chain: CHAIN1 → CHAIN2 → … → CHAIN9, CHAIN9's parent is ROOT
for (let i = 1; i <= 9; i++) folder(`CHAIN${i}`.padEnd(20, "0"), [i === 9 ? ROOT : `CHAIN${i + 1}`.padEnd(20, "0")]);
const chain = (i: number) => `CHAIN${i}`.padEnd(20, "0");

file("VIDdirect00000000001");
file("VIDdeep0000000000001", { parents: ["SUBSUBfolder00000001"] });
file("MP3file0000000000001", { name: "פרק 8.mp3", mimeType: "audio/mpeg", size: "77000000" });
file("OUTSIDEvisible000001", { parents: ["OTHERvisible00000001"] });
file("OUTSIDEhidden0000001", { parents: ["OTHERhidden000000001"] });
file("ANYONElink0000000001", { parents: [] }); // "anyone with the link": readable, no parent we can see
file("TWOparents0000000001", { parents: ["OTHERvisible00000001", "SUBfolder00000000001"] });
file("CYCLEfile00000000001", { parents: ["CYCLEa00000000000001"] });
file("FLAKYfile00000000001", { parents: ["FLAKYfolder000000001"] });
file("GDOC0000000000000001", { mimeType: "application/vnd.google-apps.document", size: undefined, sha256Checksum: undefined });
file("SHORTCUT000000000001", { mimeType: "application/vnd.google-apps.shortcut" });
file("ZIPfile0000000000001", { mimeType: "application/zip" });
file("TRASHED0000000000001", { trashed: true });
file("NODOWNLOAD0000000001", { capabilities: { canDownload: false } });
file("NOCAPS00000000000001", { capabilities: undefined });
file("NOSIZE00000000000001", { size: undefined });
file("ZEROSIZE000000000001", { size: "0" });
file("NOSHA000000000000001", { sha256Checksum: undefined });
file("BADSHA000000000000001".slice(0, 20), { sha256Checksum: "not-a-hash" });
file("UPPERMIME00000000001", { mimeType: "VIDEO/QuickTime" });
// owner 16.10: macOS AppleDouble next to the real file (seen live: a 4KB "._2_COMBO-2.wav" typed audio/wav)
file("APPLEDOUBLE000000001", { name: "._2_COMBO-2.wav", mimeType: "audio/wav", size: "4096" });
file("DOTFILE0000000000001", { name: ".hidden episode.mp4" });
file("DOTINSIDE00000000001", { name: "MALI ep.5 v3._final.mp4" }); // a dot INSIDE the name is fine
tree.set("FORBIDDEN00000000001", { status: 403 });
tree.set("BROKEN00000000000001", { status: 500 });
for (let i = 7; i <= 9; i++) file(`DEPTH${i}`.padEnd(20, "0"), { parents: [chain(11 - i)] }); // ROOT at level i

let calls: { url: string; auth: string | null }[] = [];
let tokenPosts: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_EMAIL = "bizi-booking@bizi-podclub.iam.gserviceaccount.com";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: SA_EMAIL,
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

global.fetch = (async (input: string | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    tokenPosts.push(String(init.body));
    return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 3599 }), { status: 200 });
  }
  const m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?(.*)$/.exec(url);
  if (!m) throw new Error(`unexpected fetch: ${url}`);
  const headers = new Headers(init.headers);
  calls.push({ url, auth: headers.get("authorization") });
  const node = tree.get(decodeURIComponent(m[1]));
  if (!node) return new Response(JSON.stringify({ error: { message: "File not found", errors: [{ reason: "notFound" }] } }), { status: 404 });
  if (node.status) return new Response(JSON.stringify({ error: { message: `fake ${node.status}` } }), { status: node.status });
  return new Response(JSON.stringify(node.body), { status: 200 });
}) as typeof fetch;

const run = (input: string) => checkReviewFile(input, { token: TOKEN, folderId: ROOT });
const code = async (input: string) => {
  const r = await run(input);
  return r.ok ? "ok" : r.code;
};

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("links → file id");
  check("…/file/d/<id>/view", extractDriveFileId("https://drive.google.com/file/d/VIDdirect00000000001/view?usp=sharing"), "VIDdirect00000000001");
  check("open?id=", extractDriveFileId("https://drive.google.com/open?id=VIDdirect00000000001"), "VIDdirect00000000001");
  check("uc?id=&export=download", extractDriveFileId("https://drive.google.com/uc?id=VIDdirect00000000001&export=download"), "VIDdirect00000000001");
  check("bare id, padded", extractDriveFileId("  VIDdirect00000000001 "), "VIDdirect00000000001");
  check("folder link → null", extractDriveFileId(`https://drive.google.com/drive/folders/${ROOT}`), null);
  check("not a link → null", extractDriveFileId("פרק 8 סופי"), null);
  calls = [];
  check("folder link refused as 'folder' (owner 18.10), zero Drive calls", [await code(`https://drive.google.com/drive/folders/${ROOT}`), calls.length], ["folder", 0]);
  check("folder link under /drive/u/1/ refused the same way", await code(`https://drive.google.com/drive/u/1/folders/${ROOT}?usp=sharing`), "folder");

  // ══════════════════════════════════════════════════════════════════════
  section("accepted files — what the version row keeps");
  calls = [];
  const v = await run("https://drive.google.com/file/d/VIDdirect00000000001/view");
  check("video directly in the folder", v, {
    ok: true,
    file: { fileId: "VIDdirect00000000001", name: "VIDdirect00000000001.mp4", sizeBytes: 7135800000, mimeType: "video/mp4", sha256: SHA.toLowerCase(), isAudioOnly: false },
  });
  check("…with ONE files.get (ROOT is the direct parent, no walk)", calls.length, 1);
  ok("files.get asks for parents, trashed, canDownload, sha256 — on all drives", /fields=[^&]*parents/.test(decodeURIComponent(calls[0].url)) &&
    /trashed/.test(decodeURIComponent(calls[0].url)) && /capabilities\/canDownload/.test(decodeURIComponent(calls[0].url)) &&
    /sha256Checksum/.test(decodeURIComponent(calls[0].url)) && calls[0].url.includes("supportsAllDrives=true"));
  check("Bearer on the call", calls[0].auth, `Bearer ${TOKEN}`);

  const a = await run("MP3file0000000000001");
  check("mp3: audio only from the Drive mime type (Bunny reports 1280x720)", a.ok && [a.file.isAudioOnly, a.file.mimeType, a.file.sizeBytes, a.file.name], [true, "audio/mpeg", 77000000, "פרק 8.mp3"]);
  calls = [];
  check("two folders down", await code("VIDdeep0000000000001"), "ok");
  check("…walked SUBSUB then SUB (2 folder reads + the file)", calls.length, 3);
  check("one of two parents is under the folder → accepted", await code("TWOparents0000000001"), "ok");
  check("mime type compared case-insensitively", await code("UPPERMIME00000000001"), "ok");
  const ns = await run("NOSHA000000000000001");
  check("no sha256 from Drive → accepted, sha256 null (integrity falls back to size)", ns.ok && ns.file.sha256, null);
  const bs = await run("BADSHA00000000000000");
  check("a sha256 that is not 64 hex → null, never stored as a hash", bs.ok && bs.file.sha256, null);

  // ══════════════════════════════════════════════════════════════════════
  section("refusals (decision 3) — each with a message for the technician");
  const cases: [string, string][] = [
    ["GDOC0000000000000001", "not_media"],
    ["SHORTCUT000000000001", "not_media"],
    ["ZIPfile0000000000001", "not_media"],
    ["TRASHED0000000000001", "trashed"],
    ["APPLEDOUBLE000000001", "system_file"],
    ["DOTFILE0000000000001", "system_file"],
    ["NODOWNLOAD0000000001", "cannot_download"],
    ["NOCAPS00000000000001", "cannot_download"],
    ["NOSIZE00000000000001", "no_size"],
    ["ZEROSIZE000000000001", "no_size"],
    ["FORBIDDEN00000000001", "not_visible"],
    ["DOESNOTEXIST00000001", "not_visible"],
    ["OUTSIDEvisible000001", "outside_folder"],
    ["OUTSIDEhidden0000001", "outside_folder"],
    ["ANYONElink0000000001", "outside_folder"],
    ["CYCLEfile00000000001", "outside_folder"],
  ];
  for (const [id, want] of cases) check(`${id} → ${want}`, await code(id), want);
  const msgs: string[] = [];
  for (const [id] of cases) {
    const r = await run(id);
    if (!r.ok) msgs.push(r.message);
  }
  ok("every refusal carries a Hebrew message", msgs.length === cases.length && msgs.every((m) => /[א-ת]/.test(m)));
  ok("no message contains the token", msgs.every((m) => !m.includes(TOKEN)));
  const ad = await run("APPLEDOUBLE000000001");
  check("._ file → the owner's message, word for word", !ad.ok && ad.message, "זה קובץ מערכת של Mac ולא הקובץ עצמו. בחר את הקובץ בלי ._ בתחילת השם");
  const di = await run("DOTINSIDE00000000001");
  ok("a dot inside the name (not at its start) is accepted", di.ok);
  calls = [];
  await code("GDOC0000000000000001");
  check("not media → refused before any folder walk", calls.length, 1);

  // ══════════════════════════════════════════════════════════════════════
  section("the folder walk: depth, cycles, unknowns");
  check(`max depth is ${REVIEW_FOLDER_MAX_DEPTH}`, REVIEW_FOLDER_MAX_DEPTH, 8);
  check("folder at level 7 → inside", await code("DEPTH7".padEnd(20, "0")), "ok");
  check("folder at level 8 → inside", await code("DEPTH8".padEnd(20, "0")), "ok");
  check("folder at level 9 → outside (beyond the limit)", await code("DEPTH9".padEnd(20, "0")), "outside_folder");
  check("isInsideFolder with maxDepth 1: direct parent only", [await isInsideFolder([ROOT], ROOT, TOKEN, 1), await isInsideFolder(["SUBfolder00000000001"], ROOT, TOKEN, 1)], [true, false]);
  calls = [];
  await code("CYCLEfile00000000001");
  check("a parent cycle ends: each folder read once", calls.filter((c) => c.url.includes("/CYCLE")).length, 3);
  for (const [id, what] of [["FLAKYfile00000000001", "a 503 on a folder"], ["BROKEN00000000000001", "a 500 on the file"]]) {
    try {
      await run(id);
      check(`${what} throws`, "no throw", "DriveError");
    } catch (e) {
      check(`${what} throws (could not check ≠ refused)`, [e instanceof DriveError, (e as DriveError).status], [true, what.includes("503") ? 503 : 500]);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  section("configuration");
  delete process.env.GOOGLE_DRIVE_REVIEW_FOLDER_ID;
  try {
    reviewFolderId();
    check("missing folder id throws", "no throw", "throw");
  } catch (e) {
    ok("missing GOOGLE_DRIVE_REVIEW_FOLDER_ID throws — never 'any folder'", String(e).includes("GOOGLE_DRIVE_REVIEW_FOLDER_ID"));
  }
  calls = [];
  try {
    await checkReviewFile("VIDdirect00000000001", { token: TOKEN });
    check("checkReviewFile without a folder throws", "no throw", "throw");
  } catch {
    check("checkReviewFile without a folder id throws before any Drive call", calls.length, 0);
  }
  process.env.GOOGLE_DRIVE_REVIEW_FOLDER_ID = ` ${ROOT} `;
  check("folder id from the env, trimmed", reviewFolderId(), ROOT);
  check("…and used when not passed", (await checkReviewFile("VIDdeep0000000000001", { token: TOKEN })).ok, true);

  // ══════════════════════════════════════════════════════════════════════
  section("service-account token: the account itself, drive.readonly");
  tokenPosts = [];
  const t = await serviceAccountToken();
  check("token returned", t.token, TOKEN);
  const assertion = new URLSearchParams(tokenPosts[0]).get("assertion")!;
  const [h, c, sig] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  check("scope is drive.readonly by default", claims.scope, DRIVE_READONLY);
  ok("no `sub` — no impersonation", !("sub" in claims));
  check("issuer is the service account", claims.iss, SA_EMAIL);
  ok("signature verifies with the account's public key", createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url")));
  const meta = await driveFileMeta("VIDdirect00000000001", TOKEN);
  check("driveFileMeta keeps parents and trashed", [meta.parents, meta.trashed, meta.size], [[ROOT], false, 7135800000]);

  // ══════════════════════════════════════════════════════════════════════
  section("static: the walls in the source");
  const src = readFileSync(join(__dirname, "../src/lib/google/drive.ts"), "utf8");
  ok("no console.* in lib/google/drive.ts (the token never reaches a log)", !/console\./.test(src));
  ok("no `sub:` claim in lib/google/drive.ts", !/\bsub\s*:/.test(src));
  check("the only OAuth scope in lib/google/drive.ts is drive.readonly", Array.from(new Set(src.match(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g) ?? [])), [DRIVE_READONLY]);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
