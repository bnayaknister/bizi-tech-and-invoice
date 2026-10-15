/**
 * E13 route A — scripts/e13_drive_fetch_test.ts against a fake Google + a fake
 * Bunny: the service-account JWT (verified with a key pair made here), Drive
 * metadata, Bunny's Fetch Video, finding the guid, the timing, the hash
 * comparison, the access checks, the guards, and that the token never leaks.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_drive_fetch.ts
 *
 * ═══ F19 ═══ No network: `global.fetch` answers from the fakes below and fails
 * on anything it does not know. The service-account key is generated here.
 */
import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// ── a real key pair, so the JWT signature is actually checked ──────────────
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA_EMAIL = "bizi-booking@bizi-podclub.iam.gserviceaccount.com";
const saJson = JSON.stringify({ client_email: SA_EMAIL, private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
const TOKEN = "ya29.SECRET-ACCESS-TOKEN-should-never-print";
const FILE_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const BYTES = Buffer.alloc(30 * 1024 * 1024, 7); // a 30MB "file" (only its hash and size are used)
const SHA_HEX = createHash("sha256").update(BYTES).digest("hex");
const SHA_B64 = Buffer.from(SHA_HEX, "hex").toString("base64");

const dir = mkdtempSync(join(tmpdir(), "e13df-"));
const envPath = join(dir, "env");
const KEYS = `BUNNY_STREAM_LIBRARY_ID=111\nBUNNY_STREAM_API_KEY=k\nBUNNY_STREAM_CDN_HOSTNAME=vz-fake.b-cdn.net\nBUNNY_CDN_TOKEN_KEY=t\nGOOGLE_SERVICE_ACCOUNT_JSON=${saJson}\n`;
process.env.E13_DRIVE_FETCH_ENV_FILE = envPath;
process.env.E13_DRIVE_FETCH_POLL_MS = "1";
process.env.E13_DRIVE_FETCH_PRINT_MS = "0";
process.env.E13_DRIVE_FETCH_FIND_MAX_MS = "200";
process.env.E13_BACKOFF_MS = "1";
process.env.E13_DRIVE_FETCH_SWEEP_MS = "30";

// ── the fakes ───────────────────────────────────────────────────────────────
type Scenario = {
  drive: "ok" | "404" | "403" | "google-doc";
  statuses: number[]; // successive status reads of the fetched video; the last one repeats
  originalHash: string | null;
  flakyStatusReads: number; // the first N status reads die with a connect timeout
  fetchMode: "ok" | "503-creates" | "503-nothing" | "strict";
  // strict: 500 when the body has a `headers` key or a non-ASCII title (the suspects); otherwise create
};
let sc: Scenario;
let calls: string[] = [];
let jwtClaims: Record<string, unknown> | null = null;
let jwtValid = false;
let fetchBody: { url?: string; headers?: Record<string, string>; title?: string } | null = null;
let fetchQueries: string[] = [];
const videos = new Map<string, { title: string; reads: number }>();
const deleted = new Set<string>();
let seq = 0;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const connectTimeout = () =>
  new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

global.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  calls.push(`${method} ${url}`);
  const hdr = (init.headers ?? {}) as Record<string, string>;

  if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
    const assertion = new URLSearchParams(String(init.body)).get("assertion") ?? "";
    const [h, c, sig] = assertion.split(".");
    jwtClaims = JSON.parse(Buffer.from(c, "base64url").toString());
    jwtValid = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"));
    return json(200, { access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
  }
  if (url.startsWith(`https://www.googleapis.com/drive/v3/files/${FILE_ID}?fields=`)) {
    if (hdr.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: { message: "no auth" } });
    if (sc.drive === "404") return json(404, { error: { message: `File not found: ${FILE_ID}.`, errors: [{ reason: "notFound" }] } });
    if (sc.drive === "403") return json(403, { error: { message: "The user does not have sufficient permissions for this file.", errors: [{ reason: "insufficientFilePermissions" }] } });
    if (sc.drive === "google-doc") return json(200, { name: "doc", mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } });
    return json(200, { name: "episode-12.mp4", size: String(BYTES.length), mimeType: "video/mp4", sha256Checksum: SHA_HEX, md5Checksum: "abc", capabilities: { canDownload: true } });
  }

  const m = /^https:\/\/video\.bunnycdn\.com\/library\/111\/videos(\/fetch|\/([0-9a-f-]+))?(\?.*)?$/.exec(url);
  if (m) {
    if (m[1] === "/fetch" && method === "POST") {
      fetchBody = JSON.parse(String(init.body));
      fetchQueries.push(new URL(url).search);
      if (sc.fetchMode === "strict") {
        const nonAscii = typeof fetchBody!.title === "string" && !/^[\x20-\x7E]*$/.test(fetchBody!.title);
        if ("headers" in fetchBody! || nonAscii) {
          return new Response(JSON.stringify({ success: false, message: "An error has occurred", statusCode: 500 }), { status: 500, headers: { "content-type": "application/json", "stream-server": "2134" } });
        }
        const g = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        const qTitle = new URL(url).searchParams.get("title");
        videos.set(g, { title: fetchBody!.title ?? qTitle ?? "trailer.mp4", reads: 0 });
        return json(200, { success: true, message: null, statusCode: 200 });
      }
      if (sc.fetchMode !== "503-nothing") {
        const g = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
        videos.set(g, { title: fetchBody!.title!, reads: 0 });
      }
      if (sc.fetchMode !== "ok") {
        return new Response(JSON.stringify({ success: false, message: "Service temporarily unavailable", statusCode: 503 }), {
          status: 503,
          headers: { "content-type": "application/json", "x-request-id": "req-503-abc", server: "BunnyCDN-DE1-123", "x-api-key-echo": "LEAKED-KEY-VALUE", "retry-after": "30" },
        });
      }
      return json(200, { success: true, message: null, statusCode: 200 });
    }
    if (!m[1] && method === "GET") {
      const search = new URL(url).searchParams.get("search") ?? "";
      const items = Array.from(videos.entries())
        .filter(([, v]) => v.title.toLowerCase().includes(search.toLowerCase()))
        .map(([guid, v]) => ({ guid, title: v.title, status: 0 }));
      return json(200, { totalItems: items.length, currentPage: 1, itemsPerPage: 100, items });
    }
    const guid = m[2];
    if (guid && method === "DELETE") {
      deleted.add(guid);
      return json(200, { success: true });
    }
    if (guid && method === "GET") {
      if (deleted.has(guid) || !videos.has(guid)) return json(404, {});
      const v = videos.get(guid)!;
      if (v.reads < sc.flakyStatusReads) {
        v.reads++;
        throw connectTimeout();
      }
      const i = Math.min(v.reads - sc.flakyStatusReads, sc.statuses.length - 1);
      v.reads++;
      const status = sc.statuses[i];
      return json(200, {
        guid, title: v.title, status, encodeProgress: status >= 4 ? 100 : 0,
        storageSize: status >= 1 ? BYTES.length : 0, length: 60, width: 1920, height: 1080,
        hasOriginal: status >= 1, originalHash: status >= 1 ? sc.originalHash : null,
      });
    }
  }
  if (url === PUBLIC_URL && method === "HEAD") {
    return new Response(null, { status: 200, headers: { "content-type": "video/mp4", "content-length": "4372373" } });
  }
  const cdn = /^https:\/\/vz-fake\.b-cdn\.net\/(.*)$/.exec(url);
  if (cdn) {
    const rest = cdn[1];
    if (/\/original/.test(rest)) return new Response(rest.includes("token=HS256-") ? "x" : "", { status: rest.includes("token=HS256-") ? 206 : 403 });
    if (rest.startsWith("bcdn_token=HS256-")) {
      if (rest.endsWith("/playlist.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n240p/video.m3u8\n", { status: 200 });
      if (rest.endsWith("/240p/video.m3u8")) return new Response("#EXTM3U\n", { status: 200 });
    }
    if (rest.endsWith("/playlist.m3u8")) return new Response("", { status: 403 });
  }
  if (/^https:\/\/player\.mediadelivery\.net\/(play|embed)\/111\//.test(url)) return new Response("", { status: 403 });
  throw new Error(`F19: unknown fetch ${method} ${url}`);
}) as unknown as typeof fetch;

async function capture<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  const lines: string[] = [];
  const l = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), out: lines.join("\n") };
  } finally {
    console.log = l;
  }
}

const reset = (s: Partial<Scenario> = {}) => {
  sc = { drive: "ok", statuses: [0, 0, 1, 2, 3, 4], originalHash: SHA_B64, flakyStatusReads: 0, fetchMode: "ok", ...s };
  calls = [];
  jwtClaims = null;
  jwtValid = false;
  fetchBody = null;
  fetchQueries = [];
  videos.clear();
  deleted.clear();
};
const bunnyCalls = () => calls.filter((c) => c.includes("bunnycdn.com") || c.includes("mediadelivery.net"));
const URL_ARG = `https://drive.google.com/file/d/${FILE_ID}/view?usp=drive_link`;
const PUBLIC_URL = "https://media.w3.org/2010/05/sintel/trailer.mp4";

async function main() {
  const { main: run } = await import("./e13_drive_fetch_test");
  const { extractDriveFileId } = await import("./_google_drive");
  const { compareHashes } = await import("./_bunny_checks");
  type R = { check: string; result: string; detail: string };
  const row = (rows: R[], c: string) => rows.find((r) => r.check === c);

  section("file id from Drive links");
  check("…/file/d/<id>/view", extractDriveFileId(URL_ARG), FILE_ID);
  check("open?id=<id>", extractDriveFileId(`https://drive.google.com/open?id=${FILE_ID}`), FILE_ID);
  check("uc?id=<id>&export=download", extractDriveFileId(`https://drive.google.com/uc?id=${FILE_ID}&export=download`), FILE_ID);
  check("bare id", extractDriveFileId(FILE_ID), FILE_ID);
  check("a folder / junk → null", [extractDriveFileId("https://drive.google.com/drive/folders/"), extractDriveFileId("hello")], [null, null]);

  section("hash comparison: hex or base64, normalised");
  check("hex = hex", compareHashes(SHA_HEX, SHA_HEX.toUpperCase()).verdict, "זהה");
  check("hex = base64", compareHashes(SHA_HEX, SHA_B64).verdict, "זהה");
  check("different", compareHashes(SHA_HEX, "0".repeat(64)).verdict, "לא זהה");
  check("missing on either side", [compareHashes(null, SHA_HEX).verdict, compareHashes(SHA_HEX, null).verdict], ["לא ניתן להשוואה", "לא ניתן להשוואה"]);
  check("unknown format", compareHashes(SHA_HEX, "xyz").verdict, "לא ניתן להשוואה");

  section("guard: --live refused unless the env FILE says BUNNY_DRY_RUN=false");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=true\n");
  delete process.env.BUNNY_DRY_RUN;
  reset();
  let err = "";
  try {
    await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  } catch (e) {
    err = (e as Error).message;
  }
  check("refused, zero requests", [err.includes("BUNNY_DRY_RUN=false"), calls.length], [true, 0]);

  section("dry run: Google read happens, Bunny gets nothing, token never printed");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=false\n");
  reset();
  const dry = await capture(() => run(["--drive-url", URL_ARG]));
  check("zero Bunny requests", bunnyCalls(), []);
  check("token + files.get passed", [row(dry.value.rows, "טוקן Google")?.result, row(dry.value.rows, "files.get (Drive)")?.result], ["עבר", "עבר"]);
  ok("JWT: signed with the SA key, no `sub`, drive.readonly, 1h", jwtValid && jwtClaims !== null && !("sub" in jwtClaims) &&
    jwtClaims.scope === "https://www.googleapis.com/auth/drive.readonly" && jwtClaims.iss === SA_EMAIL &&
    (jwtClaims.exp as number) - (jwtClaims.iat as number) === 3600);
  ok("files.get asked for sha256 + supportsAllDrives", calls.some((c) => c.includes("sha256Checksum") && c.includes("supportsAllDrives=true")));
  const dryLine = dry.out.split("\n").find((l) => l.includes('"tag":"bunny_dry_run"') && l.includes("/videos/fetch")) ?? "";
  ok("the dry-run log line names the header and redacts its value", dryLine.includes("Authorization") && dryLine.includes("<redacted>"));
  ok("the token appears nowhere in the output", !dry.out.includes(TOKEN));

  section("Drive 404 / 403 / a Google Doc: stop before Bunny, message + hint");
  for (const d of ["404", "403", "google-doc"] as const) {
    reset({ drive: d });
    process.env.BUNNY_DRY_RUN = "false";
    const r = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
    const fg = row(r.value.rows, "files.get (Drive)");
    check(`${d}: files.get failed, zero Bunny requests`, [fg?.result, bunnyCalls().length], ["נכשל", 0]);
    if (d !== "google-doc") ok(`${d}: Google's message + the sharing hint`, !!fg && fg.detail.includes(`HTTP ${d}`) && fg.detail.includes(SA_EMAIL));
    ok(`${d}: summary table printed`, r.out.includes("═══ סיכום ═══") && r.out.includes("═══ מדדים ═══"));
  }

  section("--live, the happy path");
  reset();
  process.env.BUNNY_DRY_RUN = "false";
  const live = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  check("no failed / not-checked row", live.value.rows.filter((r) => r.result === "נכשל" || r.result === "לא נבדק").map((r) => `${r.check}: ${r.detail}`), []);
  check("Bunny was asked to fetch the Drive media URL with our bearer header",
    [fetchBody?.url, fetchBody?.headers?.Authorization],
    [`https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media&supportsAllDrives=true`, `Bearer ${TOKEN}`]);
  ok("the title is ASCII with the run id, WITHOUT the file name", !!fetchBody?.title && /^E13 drive-fetch [0-9a-f]{8}$/.test(fetchBody.title));
  check("the file name is kept on our side", live.value.metrics.fileName, "episode-12.mp4");
  check("no separate createVideo (Fetch creates the video)", calls.filter((c) => c === "POST https://video.bunnycdn.com/library/111/videos").length, 0);
  check("hash = זהה (base64 from Bunny vs hex from Drive)", [live.value.metrics.hash, row(live.value.rows, "hash מול Drive")?.result], ["זהה", "עבר"]);
  ok("fetch time + Mbps measured", typeof live.value.metrics.fetchSeconds === "number" && typeof live.value.metrics.serverMbps === "number");
  check("CDN checks ran", ["/original בלי טוקן → 403", "/original חתום → 200", "playlist בלי טוקן → 403", "playlist חתום → 200"].map((c) => row(live.value.rows, c)?.result), ["עבר", "עבר", "עבר", "עבר"]);
  check("deleted at the end", [row(live.value.rows, "מחיקה")?.result, deleted.size], ["עבר", 1]);
  ok("progress lines printed", /⏱ .* status \d/.test(live.out));
  ok("the token appears nowhere in the output", !live.out.includes(TOKEN));

  section("status read flakes 3× → retried, still passes");
  reset({ flakyStatusReads: 3 });
  const flaky = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  check("received + status 4 passed", [row(flaky.value.rows, "הקובץ התקבל ב-Bunny")?.result, row(flaky.value.rows, "status 4")?.result], ["עבר", "עבר"]);
  ok("retries logged with the cause", flaky.out.includes("UND_ERR_CONNECT_TIMEOUT"));

  section("Bunny's fetch fails (status 5) → failed, rest not checked, still deleted");
  reset({ statuses: [0, 5] });
  const bad = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  check("received = נכשל", row(bad.value.rows, "הקובץ התקבל ב-Bunny")?.result, "נכשל");
  check("later checks = לא נבדק", ["status 4", "hash מול Drive", "/original בלי טוקן → 403"].map((c) => row(bad.value.rows, c)?.result), ["לא נבדק", "לא נבדק", "לא נבדק"]);
  check("deleted", deleted.size, 1);

  section("hash mismatch → נכשל");
  reset({ originalHash: "f".repeat(64) });
  const mism = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  check("hash row", [row(mism.value.rows, "hash מול Drive")?.result, mism.value.metrics.hash], ["נכשל", "לא זהה"]);

  section("--no-wait-encode: stop once the file is in");
  reset({ statuses: [0, 1, 2] });
  const nw = await capture(() => run(["--drive-url", URL_ARG, "--live", "--no-wait-encode"]));
  check("received passed, status 4 skipped", [row(nw.value.rows, "הקובץ התקבל ב-Bunny")?.result, row(nw.value.rows, "status 4")?.result], ["עבר", "דילוג"]);
  check("no CDN requests", calls.filter((c) => c.includes("b-cdn.net") || c.includes("mediadelivery")).length, 0);
  check("hash still compared at arrival", row(nw.value.rows, "hash מול Drive")?.result, "עבר");

  section("encoding not done before the wait ends → status 4 לא נבדק");
  reset({ statuses: [0, 1, 2] });
  process.env.E13_DRIVE_FETCH_WAIT_MAX_MS = "50";
  const slow = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  delete process.env.E13_DRIVE_FETCH_WAIT_MAX_MS;
  const s4 = row(slow.value.rows, "status 4");
  check("status 4 = לא נבדק, mentions Free Encoding", [s4?.result, s4?.detail.includes("Free Encoding")], ["לא נבדק", true]);

  section("--keep: no DELETE, guid printed");
  reset();
  const keep = await capture(() => run(["--drive-file-id", FILE_ID, "--live", "--keep"]));
  check("zero DELETE", calls.filter((c) => c.startsWith("DELETE")).length, 0);
  ok("delete row = דילוג with the guid", row(keep.value.rows, "מחיקה")?.result === "דילוג" && !!keep.value.metrics.guid && keep.out.includes(keep.value.metrics.guid));


  section("503 from Fetch Video: ONE POST, full body + safe headers, the video it left behind found and deleted");
  reset({ fetchMode: "503-creates" });
  process.env.BUNNY_DRY_RUN = "false";
  const f503 = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  const fr = row(f503.value.rows, "בקשת משיכה ל-Bunny");
  check("exactly one POST to /videos/fetch", calls.filter((c) => c === "POST https://video.bunnycdn.com/library/111/videos/fetch").length, 1);
  check("fetch row = נכשל", fr?.result, "נכשל");
  ok("detail: one attempt, status, Bunny's whole body, diagnostic headers", !!fr &&
    fr.detail.includes("ניסיון אחד בלבד") && fr.detail.includes("status=503") &&
    fr.detail.includes("Service temporarily unavailable") && fr.detail.includes("req-503-abc") && fr.detail.includes("retry-after"));
  ok("a key-like response header is never printed", !f503.out.includes("LEAKED-KEY-VALUE") && !f503.out.includes("x-api-key-echo"));
  ok("no false \"after 5 retries\" anywhere", !/אחרי \d+ ניסיונות חוזרים/.test(f503.out));
  const sweep = row(f503.value.rows, "וידאו שנוצרו בניסיון");
  check("sweep found the 1 video the failed attempt created", [sweep?.result, sweep?.detail.startsWith("1 נמצאו")], ["עבר", true]);
  check("…and deleted it", deleted.size, 1);
  ok("the token appears nowhere in the output", !f503.out.includes(TOKEN));
  ok("summary printed", f503.out.includes("═══ סיכום ═══"));

  section("503 that created nothing → sweep reports 0, nothing deleted");
  reset({ fetchMode: "503-nothing" });
  const n503 = await capture(() => run(["--drive-url", URL_ARG, "--live"]));
  check("one POST, sweep 0, no DELETE", [calls.filter((c) => c.endsWith("/videos/fetch")).length, row(n503.value.rows, "וידאו שנוצרו בניסיון")?.detail.startsWith("0"), calls.filter((c) => c.startsWith("DELETE")).length], [1, true, 0]);

  section("503 + --keep → reported, not deleted");
  reset({ fetchMode: "503-creates" });
  const k503 = await capture(() => run(["--drive-url", URL_ARG, "--live", "--keep"]));
  check("sweep row = דילוג with the guid, zero DELETE", [row(k503.value.rows, "וידאו שנוצרו בניסיון")?.result, calls.filter((c) => c.startsWith("DELETE")).length], ["דילוג", 0]);

  section("--fetch-public-url: no Google, no headers, HEAD for size, hash skipped");
  writeFileSync(envPath, KEYS.replace(/GOOGLE_SERVICE_ACCOUNT_JSON=.*\n/, "") + "BUNNY_DRY_RUN=false\n");
  const savedSa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  reset();
  const pub = await capture(() => run(["--fetch-public-url", PUBLIC_URL, "--live"]));
  check("no failed / not-checked row", pub.value.rows.filter((r) => r.result === "נכשל" || r.result === "לא נבדק").map((r) => `${r.check}: ${r.detail}`), []);
  check("zero Google requests", calls.filter((c) => c.includes("googleapis.com")).length, 0);
  check("Bunny fetched the public URL with NO `headers` key at all (not {})", [fetchBody?.url, fetchBody ? "headers" in fetchBody : null], [PUBLIC_URL, false]);
  ok("title marks url-fetch, ASCII only", !!fetchBody?.title && /^E13 url-fetch [0-9a-f]{8}$/.test(fetchBody.title));
  check("Google rows + hash = דילוג", ["טוקן Google", "files.get (Drive)", "hash מול Drive"].map((c) => row(pub.value.rows, c)?.result), ["דילוג", "דילוג", "דילוג"]);
  ok("size from HEAD used for Mbps", pub.value.metrics.sizeBytes === 4372373 && typeof pub.value.metrics.serverMbps === "number");
  check("deleted at the end", deleted.size, 1);

  section("public dry run: HEAD only, zero Bunny requests");
  reset();
  delete process.env.BUNNY_DRY_RUN;
  const pubDry = await capture(() => run(["--fetch-public-url", PUBLIC_URL]));
  check("zero Bunny requests; HEAD done", [bunnyCalls().length, calls.includes(`HEAD ${PUBLIC_URL}`)], [0, true]);
  ok("dry log shows the empty headers", pubDry.out.includes("/videos/fetch") && pubDry.out.includes("trailer.mp4"));
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = savedSa;
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=false\n");

  section("two sources at once → refused");
  reset();
  let both = "";
  try {
    await capture(() => run(["--fetch-public-url", PUBLIC_URL, "--drive-file-id", FILE_ID]));
  } catch (e) {
    both = (e as Error).message;
  }
  check("refused, zero requests", [both.includes("מקור אחד"), calls.length], [true, 0]);


  section("--fetch-variant against a strict fake (500 on `headers` key or non-ASCII title)");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=false\n");
  reset({ fetchMode: "strict" });
  process.env.BUNNY_DRY_RUN = "false";
  // a video that already exists (the one made from the dashboard) must never be touched
  videos.set("99999999-0000-4000-8000-000000000001", { title: "trailer", reads: 0 });
  const vr = await capture(() => run(["--fetch-variant", "--live"]));
  check("exactly 5 POSTs, one per variant", calls.filter((c) => c.includes("/videos/fetch")).length, 5);
  check("א ב ג work, ד ה (headers / non-ASCII) fail",
    ["א", "ב", "ג", "ד", "ה"].map((k) => vr.value.rows.find((r) => r.check.startsWith(`וריאציה ${k}:`) && !r.check.endsWith("וידאו שנוצר"))?.result),
    ["עבר", "עבר", "עבר", "נכשל", "נכשל"]);
  check("each working variant created exactly one video, the failing ones none",
    ["א", "ב", "ג", "ד", "ה"].map((k) => vr.value.rows.find((r) => r.check === `וריאציה ${k}: וידאו שנוצר`)?.detail.split(" ")[0]),
    ["1", "1", "1", "0", "0"]);
  ok("variant ג sent title in the query string", fetchQueries.some((q) => /^\?title=E13\+variant-c\+[0-9a-f]{8}$/.test(q)));
  ok("the full 500 answer is printed (body + stream-server header)", vr.out.includes("An error has occurred") && vr.out.includes("stream-server"));
  check("the 3 created videos deleted, the pre-existing one untouched", [deleted.size, deleted.has("99999999-0000-4000-8000-000000000001")], [3, false]);
  ok("summary table of variants printed", vr.out.includes("═══ וריאציות ═══") && vr.out.includes("| ה |"));

  section("--fetch-variant --keep: nothing deleted");
  reset({ fetchMode: "strict" });
  const vk = await capture(() => run(["--fetch-variant", "--live", "--keep"]));
  check("zero DELETE, 3 kept rows", [calls.filter((c) => c.startsWith("DELETE")).length, vk.value.rows.filter((r) => r.check.startsWith("מחיקה") && r.result === "דילוג").length], [0, 3]);

  section("--fetch-variant dry run: zero Bunny requests");
  reset({ fetchMode: "strict" });
  delete process.env.BUNNY_DRY_RUN;
  const vd = await capture(() => run(["--fetch-variant"]));
  check("zero Bunny requests, 5 skipped", [bunnyCalls().length, vd.value.rows.filter((r) => r.result === "דילוג").length], [0, 5]);
  process.env.BUNNY_DRY_RUN = "false";

  section("--fetch-variant with a Drive source → refused");
  reset();
  let vErr = "";
  try {
    await capture(() => run(["--fetch-variant", "--drive-file-id", FILE_ID]));
  } catch (e) {
    vErr = (e as Error).message;
  }
  check("refused, zero requests", [vErr.includes("כתובת ציבורית"), calls.length], [true, 0]);

  section("the production path now matches the shape that works");
  reset({ fetchMode: "strict" });
  const strictLive = await capture(() => run(["--fetch-public-url", PUBLIC_URL, "--live", "--no-wait-encode"]));
  check("fetchVideoFromUrl accepted by the strict fake (no `headers` key, ASCII title)", row(strictLive.value.rows, "בקשת משיכה ל-Bunny")?.result, "עבר");

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
