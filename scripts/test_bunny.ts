/**
 * E13-2 — lib/bunny: the HTTP layer, BUNNY_DRY_RUN, status derivation, and
 * the signed CDN / TUS signatures.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_bunny.ts
 *
 * ═══ F19 ═══
 * No database, no network. `global.fetch` is replaced by a recorder that
 * answers from a script; any call it was not told about fails the suite.
 * The signing algorithm is checked against Bunny's OWN published vectors
 * (github.com/BunnyWay/BunnyCDN.TokenAuthentication, e2e/vectors.json),
 * copied below as literals.
 */
import { createHash, createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createVideo, uploadVideo, getVideo, deleteVideo, tusUploadAuthorization, BunnyError, BunnyNetworkError, TUS_UPLOAD_TTL_SECONDS, fetchVideoFromUrl, fetchVideoRaw, findVideosByTitle } from "../src/lib/bunny/client";
import { describeError } from "../src/lib/bunny/errors";
import { bunnyTusOptions, shouldRetryTusStatus, TUS_CHUNK_SIZE } from "../src/lib/bunny/tus";
import { isBunnyDryRun, BunnyConfigError } from "../src/lib/bunny/config";
import { cdnToken, signedPlaybackUrl, signedOriginalUrl, tusSignature, PLAYBACK_TTL_SECONDS } from "../src/lib/bunny/sign";
import { deriveVersionFromVideo } from "../src/lib/bunny/status";

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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 400)}\n       want: ${w?.slice(0, 400)}`);
  }
}
const ok = (name: string, cond: boolean) => check(name, cond, true);
const section = (t: string) => console.log(`\n── ${t}`);

// ── the fetch recorder ─────────────────────────────────────────────────────
type Rec = { method: string; url: string; headers: Record<string, string>; body: unknown };
let calls: Rec[] = [];
let answers: Array<{ status: number; body?: unknown; headers?: Record<string, string> }> = [];
global.fetch = (async (url: string, init: RequestInit = {}) => {
  calls.push({
    method: init.method ?? "GET",
    url: String(url),
    headers: (init.headers ?? {}) as Record<string, string>,
    body: init.body,
  });
  const a = answers.shift();
  if (!a) throw new Error(`F19: unexpected fetch ${init.method} ${url}`);
  return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: a.headers });
}) as unknown as typeof fetch;

// capture console.log to see the dry-run lines
let logs: string[] = [];
const realLog = console.log;
function captureLogs<T>(fn: () => Promise<T> | T): Promise<T> {
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = realLog;
    });
}

const API_KEY = "lib-api-key-SECRET-123";
const GUID = "3f1e2d4c-5b6a-4789-8abc-def012345678";
function env(dry: string | undefined) {
  process.env.BUNNY_STREAM_LIBRARY_ID = "123456";
  process.env.BUNNY_STREAM_API_KEY = API_KEY;
  if (dry === undefined) delete process.env.BUNNY_DRY_RUN;
  else process.env.BUNNY_DRY_RUN = dry;
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("DRY_RUN switch — defaults ON, only exactly \"false\" turns it off");
  for (const [v, want] of [[undefined, true], ["", true], ["true", true], ["FALSE", true], ["False", true], ["0", true], ["no", true], ["false", false]] as const) {
    env(v);
    check(`BUNNY_DRY_RUN=${v === undefined ? "<unset>" : JSON.stringify(v)} → dry=${want}`, isBunnyDryRun(), want);
  }

  // ══════════════════════════════════════════════════════════════════════
  section("dry run: create / upload / delete send NOTHING and log what would be sent");
  env(undefined);
  calls = [];
  const c = await captureLogs(() => createVideo("פרק 12 — v2"));
  check("create returns dryRun", "dryRun" in c && c.dryRun, true);
  check("create: zero fetches", calls.length, 0);
  check("create: one bunny_dry_run log line", logs.filter((l) => l.includes('"tag":"bunny_dry_run"')).length, 1);
  const logged = JSON.parse(logs[0]);
  check("create log: method + url", [logged.method, logged.url], ["POST", "https://video.bunnycdn.com/library/123456/videos"]);
  check("create log: body is the title", logged.body, JSON.stringify({ title: "פרק 12 — v2" }));
  ok("create: no synthetic guid handed back", !("video" in c));

  const u = await captureLogs(() => uploadVideo(GUID, new Uint8Array(2048)));
  check("upload: dryRun, zero fetches", ["dryRun" in u && u.dryRun, calls.length], [true, 0]);
  check("upload log: PUT to the video + a size summary, not the bytes", [JSON.parse(logs[0]).method, JSON.parse(logs[0]).url, JSON.parse(logs[0]).body],
    ["PUT", `https://video.bunnycdn.com/library/123456/videos/${GUID}`, "<2048 bytes application/octet-stream>"]);

  const d = await captureLogs(() => deleteVideo(GUID));
  check("delete: dryRun, zero fetches", ["dryRun" in d && d.dryRun, calls.length], [true, 0]);
  check("delete log: DELETE to the video", [JSON.parse(logs[0]).method, JSON.parse(logs[0]).url], ["DELETE", `https://video.bunnycdn.com/library/123456/videos/${GUID}`]);

  const t = await captureLogs(() => tusUploadAuthorization(GUID, 3600));
  check("TUS authorisation in dry run: null (a browser must not get a real signature)", t, null);
  check("TUS dry run: logged, zero fetches", [logs.length, calls.length], [1, 0]);

  for (const v of [undefined, "true", "", "FALSE"]) {
    env(v);
    await captureLogs(async () => {
      await createVideo("x");
      await deleteVideo(GUID);
    });
  }
  check("no write leaves the process for any non-\"false\" value", calls.length, 0);

  // every dry-run line must be free of the API key
  env(undefined);
  await captureLogs(async () => {
    await createVideo("t");
    await uploadVideo(GUID, new Uint8Array(1));
    await deleteVideo(GUID);
    tusUploadAuthorization(GUID, 60);
  });
  ok("the API key appears in no dry-run log line", logs.length === 4 && logs.every((l) => !l.includes(API_KEY)));

  // ══════════════════════════════════════════════════════════════════════
  section("reads run for real even in dry run (they write nothing)");
  env(undefined);
  calls = [];
  answers = [{ status: 200, body: { guid: GUID, status: 4, hasOriginal: true, originalHash: "h" } }];
  const g = await getVideo(GUID);
  check("getVideo in dry run fetched once", calls.length, 1);
  check("GET + AccessKey header", [calls[0].method, calls[0].headers.AccessKey], ["GET", API_KEY]);
  check("returns the video", g?.guid, GUID);
  answers = [{ status: 404 }];
  check("getVideo 404 → null", await getVideo(GUID), null);
  answers = [{ status: 500, body: { message: "boom" } }];
  try {
    await getVideo(GUID);
    check("getVideo 500 throws", "no throw", "BunnyError");
  } catch (e) {
    check("getVideo 500 throws BunnyError(500)", [e instanceof BunnyError, (e as BunnyError).status], [true, 500]);
  }

  // ══════════════════════════════════════════════════════════════════════
  section("live mode (BUNNY_DRY_RUN=false) against the mock");
  env("false");
  calls = [];
  answers = [{ status: 200, body: { guid: GUID, status: 0, videoLibraryId: 123456 } }];
  const live = await createVideo("  פרק 3  ");
  check("create: POST /library/123456/videos", [calls[0].method, calls[0].url], ["POST", "https://video.bunnycdn.com/library/123456/videos"]);
  check("create: AccessKey + json body (title trimmed)", [calls[0].headers.AccessKey, calls[0].headers["content-type"], calls[0].body],
    [API_KEY, "application/json", JSON.stringify({ title: "פרק 3" })]);
  check("create: guid returned", "video" in live ? live.video.guid : null, GUID);

  calls = [];
  answers = [{ status: 200, body: { success: true, statusCode: 200 } }];
  const bytes = new Uint8Array([1, 2, 3]);
  await uploadVideo(GUID, bytes);
  check("upload: PUT octet-stream to the video", [calls[0].method, calls[0].url, calls[0].headers["content-type"]],
    ["PUT", `https://video.bunnycdn.com/library/123456/videos/${GUID}`, "application/octet-stream"]);
  ok("upload: the bytes themselves are the body", calls[0].body === bytes);

  calls = [];
  answers = [{ status: 200, body: { success: true } }];
  check("delete 200 → deleted, not alreadyGone", await deleteVideo(GUID), { dryRun: false, alreadyGone: false });
  check("delete: DELETE + AccessKey", [calls[0].method, calls[0].headers.AccessKey], ["DELETE", API_KEY]);
  answers = [{ status: 404, body: { success: false } }];
  check("delete 404 → counts as deleted, alreadyGone (plan §6)", await deleteVideo(GUID), { dryRun: false, alreadyGone: true });
  answers = [{ status: 500, body: { message: "x" } }];
  try {
    await deleteVideo(GUID);
    check("delete 500 throws", "no throw", "throw");
  } catch (e) {
    check("delete 500 throws BunnyError — never a silent 'deleted'", (e as BunnyError).status, 500);
  }
  answers = [{ status: 401, body: { message: "unauthorized" } }];
  try {
    await createVideo("x");
    check("create 401 throws", "no throw", "throw");
  } catch (e) {
    check("create 401 throws BunnyError", [e instanceof BunnyError, (e as BunnyError).status], [true, 401]);
  }
  answers = [{ status: 200, body: { title: "no guid" } }];
  try {
    await createVideo("x");
    check("create without guid throws", "no throw", "throw");
  } catch (e) {
    check("create 200 without guid throws", e instanceof BunnyError, true);
  }

  // ══════════════════════════════════════════════════════════════════════
  section("missing config fails before any request");
  env("false");
  delete process.env.BUNNY_STREAM_API_KEY;
  calls = [];
  try {
    await createVideo("x");
    check("missing key throws", "no throw", "BunnyConfigError");
  } catch (e) {
    check("missing BUNNY_STREAM_API_KEY → BunnyConfigError, zero fetches", [e instanceof BunnyConfigError, calls.length], [true, 0]);
  }
  env("false");
  process.env.BUNNY_STREAM_LIBRARY_ID = "abc";
  try {
    await getVideo(GUID);
    check("non-numeric library id throws", "no throw", "throw");
  } catch {
    check("non-numeric library id throws, zero fetches", calls.length, 0);
  }

  // ══════════════════════════════════════════════════════════════════════
  section("TUS authorisation (live mode): Bunny's documented hash, key never returned");
  env("false");
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const tus = tusUploadAuthorization(GUID, 7200, now)!;
  const exp = Math.floor(now / 1000) + 7200;
  check("expire = now + ttl (unix seconds)", tus.headers.AuthorizationExpire, String(exp));
  check("signature = hex sha256(library + key + expire + guid)", tus.headers.AuthorizationSignature,
    createHash("sha256").update(`123456${API_KEY}${exp}${GUID}`).digest("hex"));
  check("tusSignature helper agrees", tusSignature("123456", API_KEY, exp, GUID), tus.headers.AuthorizationSignature);
  check("headers name library + video", [tus.headers.LibraryId, tus.headers.VideoId, tus.endpoint], ["123456", GUID, "https://video.bunnycdn.com/tusupload"]);
  ok("the API key is nowhere in the authorisation", !JSON.stringify(tus).includes(API_KEY));
  for (const bad of [0, -5, 1.5, 86401]) {
    try {
      tusUploadAuthorization(GUID, bad, now);
      check(`TUS ttl ${bad} refused`, "accepted", "refused");
    } catch {
      check(`TUS ttl ${bad} refused`, "refused", "refused");
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  section("CDN token — Bunny's published vectors (no-IP cases)");
  // e2e/inputs.json: key "SecurityKey", expires 1598024587, host token-tester.b-cdn.net
  const K = "SecurityKey";
  const E = 1598024587;
  const vectors: Array<[string, string, Record<string, string>, string]> = [
    ["plain", "/300kb.jpg", {}, "HS256-o10JRWlsAItyAsdKS6jJKjabHN4FrFsplDHPV1idcX4"],
    ["countries_only", "/300kb.jpg", { token_countries: "CA,US" }, "HS256-i5s3Uv7mnrFfN5nznwU2BxhILpnipYeE18TapV0WNFM"],
    ["blocked_only", "/300kb.jpg", { token_countries_blocked: "RU,CN" }, "HS256-JS8dSuBSjSH-W2-xhdkCPC36-2rlxfDCQJjlNMPqKZQ"],
    ["path_only", "/abc/300kb.jpg", { token_path: "/abc" }, "HS256-uVZvT3SbEoVKYJyDJgbcsDmSFf73cv-uNUVaJiKWpbQ"],
    ["ignore_params", "/300kb.jpg", { token_ignore_params: "true" }, "HS256-1lwWBD_c1IAGSj1UKPoxreu8ePDQ-Z9FoWLcRn_RRH0"],
    ["limit_only", "/300kb.jpg", { limit: "1000" }, "HS256-DAVapqNNED3Z7JkjRTYX0UOIHNtbHEuuhRNEc4A7mMQ"],
  ];
  for (const [name, path, params, want] of vectors) check(`vector ${name}`, cdnToken(K, path, E, params), want);

  // ══════════════════════════════════════════════════════════════════════
  section("signed playback (HLS directory token) and original (exact path)");
  const HOST = "vz-test.b-cdn.net";
  const TK = "pull-zone-token-key-SECRET";
  const nowMs = Date.UTC(2026, 9, 15, 10, 0, 0);
  const play = signedPlaybackUrl(GUID, 4 * 3600, { nowMs, hostname: HOST, tokenKey: TK });
  const pExp = Math.floor(nowMs / 1000) + 4 * 3600;
  check("playback expires = now + ttl", play.expires, pExp);
  check("Q4: default playback TTL is 4 hours", [PLAYBACK_TTL_SECONDS, signedPlaybackUrl(GUID, undefined, { nowMs, hostname: HOST, tokenKey: TK }).expires], [14400, pExp]);
  try {
    signedPlaybackUrl(GUID, 86401, { nowMs, hostname: HOST, tokenKey: TK });
    check("24h cap still enforced on playback", "accepted", "refused");
  } catch {
    check("24h cap still enforced on playback", "refused", "refused");
  }
  const pTok = cdnToken(TK, `/${GUID}/playlist.m3u8`, pExp, { token_path: `/${GUID}/` });
  check("playback URL: Bunny's directory shape (token in the path, token_path, expires, then the file)", play.url,
    `https://${HOST}/bcdn_token=${pTok}&token_path=%2F${GUID}%2F&expires=${pExp}/${GUID}/playlist.m3u8`);
  // independent recomputation of the HMAC, not via cdnToken
  const manual = "HS256-" + createHmac("sha256", TK).update(`/${GUID}/`).update(String(pExp)).update(`token_path=/${GUID}/`).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  check("directory token = HMAC over token_path + expires + 'token_path=…'", pTok, manual);
  ok("a directory token covers any file under the guid (same token for a segment path)",
    cdnToken(TK, `/${GUID}/720p/video0.ts`, pExp, { token_path: `/${GUID}/` }) === pTok);

  const orig = signedOriginalUrl(GUID, 600, { nowMs, hostname: HOST, tokenKey: TK });
  const oExp = Math.floor(nowMs / 1000) + 600;
  check("original: exact-path query token, minutes long", orig.url,
    `https://${HOST}/${GUID}/original?token=${cdnToken(TK, `/${GUID}/original`, oExp)}&expires=${oExp}`);
  ok("original token is NOT the directory token (cannot open the stream)", !orig.url.includes(pTok));
  ok("the token key is in neither URL", !play.url.includes(TK) && !orig.url.includes(TK));
  ok("tamper: another guid's path gives another token",
    cdnToken(TK, `/00000000-0000-4000-8000-000000000000/original`, oExp) !== cdnToken(TK, `/${GUID}/original`, oExp));
  ok("tamper: a later expires gives another token (expiry cannot be extended)",
    cdnToken(TK, `/${GUID}/original`, oExp + 3600) !== cdnToken(TK, `/${GUID}/original`, oExp));
  ok("a different key gives another token", cdnToken("other", `/${GUID}/original`, oExp) !== cdnToken(TK, `/${GUID}/original`, oExp));

  for (const bad of [0, -1, 2.5, 86401]) {
    try {
      signedOriginalUrl(GUID, bad, { nowMs, hostname: HOST, tokenKey: TK });
      check(`ttl ${bad} refused`, "accepted", "refused");
    } catch {
      check(`ttl ${bad} refused`, "refused", "refused");
    }
  }
  try {
    signedPlaybackUrl("../etc/passwd", 60, { nowMs, hostname: HOST, tokenKey: TK });
    check("non-guid video id refused", "accepted", "refused");
  } catch {
    check("non-guid video id refused (no path injection into the signed scope)", "refused", "refused");
  }
  delete process.env.BUNNY_CDN_TOKEN_KEY;
  process.env.BUNNY_STREAM_CDN_HOSTNAME = HOST;
  try {
    signedOriginalUrl(GUID, 60);
    check("missing BUNNY_CDN_TOKEN_KEY throws", "no throw", "throw");
  } catch (e) {
    check("missing BUNNY_CDN_TOKEN_KEY → BunnyConfigError", e instanceof BunnyConfigError, true);
  }
  process.env.BUNNY_CDN_TOKEN_KEY = TK;
  process.env.BUNNY_STREAM_CDN_HOSTNAME = `https://${HOST}/`;
  check("env hostname with scheme/slash is normalised", signedOriginalUrl(GUID, 600, { nowMs }).url, orig.url);

  // ══════════════════════════════════════════════════════════════════════
  section("status derivation (plan §3) and the ready gate (§9 🔴)");
  const base = { guid: GUID };
  const st = (v: Record<string, unknown>) => deriveVersionFromVideo({ ...base, ...v } as never);
  check("0 → created, upload not confirmed", [st({ status: 0 }).bunny_status, st({ status: 0 }).uploadConfirmed], ["created", false]);
  check("1 Uploaded, no resolutions → processing, upload confirmed (Q11 numbering moment)",
    [st({ status: 1 }).bunny_status, st({ status: 1 }).uploadConfirmed], ["processing", true]);
  check("3 with a resolution → playable", st({ status: 3, availableResolutions: "240p" }).bunny_status, "playable");
  const fin = st({ status: 4, hasOriginal: true, originalHash: "abc123", length: 61.5 });
  check("4 + hasOriginal + hash → ready, duration ms", [fin.bunny_status, fin.duration_ms, fin.original_sha256, fin.originalMissing], ["ready", 61500, "abc123", false]);
  const noOrig = st({ status: 4, hasOriginal: false, originalHash: null, availableResolutions: "720p" });
  check("4 WITHOUT the original → processing + originalMissing", [noOrig.bunny_status, noOrig.originalMissing], ["processing", true]);
  check("4 with hasOriginal but empty hash → still not ready", st({ status: 4, hasOriginal: true, originalHash: " " }).bunny_status, "processing");
  check("5 Error → failed", [st({ status: 5 }).bunny_status, st({ status: 5 }).uploadConfirmed], ["failed", false]);
  check("6 UploadFailed → failed", st({ status: 6 }).bunny_status, "failed");
  const unk = st({ status: 42 });
  check("unknown code → processing + unknownStatus, raw kept", [unk.bunny_status, unk.unknownStatus, unk.bunny_status_raw, unk.uploadConfirmed], ["processing", true, 42, false]);
  check("missing/negative length → null duration", [st({ status: 1 }).duration_ms, st({ status: 1, length: -1 }).duration_ms], [null, null]);

  // ══════════════════════════════════════════════════════════════════════
  section("network failures carry their whole cause (first --live run printed only \"fetch failed\")");
  const sock = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  const tf = new TypeError("fetch failed", { cause: sock });
  const dTf = describeError(tf);
  ok("describeError walks .cause: message + code of the inner error", dTf.includes("fetch failed") && dTf.includes("other side closed") && dTf.includes("code=UND_ERR_SOCKET"));
  const deep = new Error("a", { cause: new Error("b", { cause: Object.assign(new Error("c"), { code: "ECONNRESET", syscall: "write" }) }) });
  ok("…to any depth, with syscall", describeError(deep).includes("code=ECONNRESET") && describeError(deep).includes("syscall=write"));
  const loop: { message: string; cause?: unknown } = { message: "loop" };
  loop.cause = loop;
  ok("a cause cycle does not hang", describeError(loop).split("⟵").length <= 6);
  const tusErr = Object.assign(new Error("tus: unexpected response"), {
    originalRequest: { getMethod: () => "PATCH", getURL: () => "https://video.bunnycdn.com/tusupload/x" },
    originalResponse: { getStatus: () => 401, getBody: () => "bad signature" },
    causingError: null,
  });
  ok("a tus DetailedError shows request, status and body", describeError(tusErr).includes("request=PATCH") && describeError(tusErr).includes("status=401") && describeError(tusErr).includes("bad signature"));

  env("false");
  const realFetch = global.fetch;
  global.fetch = (async () => {
    throw tf;
  }) as unknown as typeof fetch;
  for (const [name, fn] of [["create", () => createVideo("x")], ["get", () => getVideo(GUID)], ["delete", () => deleteVideo(GUID)]] as const) {
    try {
      await fn();
      check(`${name}: network failure throws`, "no throw", "BunnyNetworkError");
    } catch (e) {
      check(`${name}: BunnyNetworkError whose message has the cause code, cause kept`,
        [e instanceof BunnyNetworkError, (e as Error).message.includes("UND_ERR_SOCKET"), (e as Error).cause === tf], [true, true, true]);
    }
  }
  global.fetch = realFetch;

  // ══════════════════════════════════════════════════════════════════════
  section("Fetch Video (route A): dry run redacts header values; live posts {url, headers, title}");
  env(undefined);
  calls = [];
  const SECRET = "ya29.SECRET-BEARER";
  const fv = await captureLogs(() => fetchVideoFromUrl("https://www.googleapis.com/drive/v3/files/X?alt=media", { Authorization: `Bearer ${SECRET}` }, "E13 drive-fetch abc"));
  check("dry: no request, dryRun returned", ["dryRun" in fv && fv.dryRun, calls.length], [true, 0]);
  ok("dry log: POST …/videos/fetch, header name kept, value redacted, token absent",
    logs.length === 1 && logs[0].includes("/library/123456/videos/fetch") && logs[0].includes("Authorization") && logs[0].includes("<redacted>") && !logs[0].includes(SECRET));

  env("false");
  calls = [];
  answers = [{ status: 200, body: { success: true, message: null, statusCode: 200 } }];
  const fvLive = await fetchVideoFromUrl("https://example.test/v.mp4", { Authorization: "Bearer B" }, " t ");
  check("live: POST to /videos/fetch with the body Bunny documents", [calls[0].method, calls[0].url, calls[0].body],
    ["POST", "https://video.bunnycdn.com/library/123456/videos/fetch", JSON.stringify({ url: "https://example.test/v.mp4", title: "t", headers: { Authorization: "Bearer B" } })]);
  check("live: result", fvLive, { dryRun: false, message: null });
  for (const [st, body] of [[422, { success: false, message: "Unable to fetch video from origin", statusCode: 422 }], [429, { success: false, message: "Too many fetch jobs queued", statusCode: 429 }], [200, { success: false, message: "nope", statusCode: 400 }]] as const) {
    answers = [{ status: st, body }];
    try {
      await fetchVideoFromUrl("https://example.test/v.mp4", {}, "t");
      check(`fetch ${st}/${body.message}: throws`, "no throw", "BunnyError");
    } catch (e) {
      check(`fetch ${st} (${body.message}): BunnyError carrying Bunny's message`, [e instanceof BunnyError, (e as Error).message.includes(body.message)], [true, true]);
    }
  }
  // owner 15.10: the production shape — ASCII title, no `headers` key when empty
  calls = [];
  answers = [{ status: 200, body: { success: true } }];
  await fetchVideoFromUrl("https://example.test/v.mp4", {}, "E13 url-fetch ab12cd34");
  check("empty headers are OMITTED, not sent as {}", JSON.parse(String(calls[0].body)), { url: "https://example.test/v.mp4", title: "E13 url-fetch ab12cd34" });
  calls = [];
  for (const bad of ["E13 — trailer.mp4", "פרק 12", "tab\there"]) {
    try {
      await fetchVideoFromUrl("https://example.test/v.mp4", {}, bad);
      check(`non-ASCII title ${JSON.stringify(bad)} refused`, "sent", "refused");
    } catch {
      check(`non-ASCII title ${JSON.stringify(bad)} refused before any request`, calls.length, 0);
    }
  }
  answers = [{ status: 500, body: { success: false, message: "An error has occurred" }, headers: { "stream-server": "2134", "content-type": "application/json" } }];
  const raw500 = await fetchVideoRaw({ url: "https://example.test/v.mp4" }, { title: "q t" });
  check("fetchVideoRaw: 500 is a result (no throw), with body + safe headers; query string appended",
    ["dryRun" in raw500 ? "dry" : raw500.status, "dryRun" in raw500 ? null : raw500.headers["stream-server"], calls[0].url.endsWith("/videos/fetch?title=q+t")],
    [500, "2134", true]);

  calls = [];
  answers = [
    { status: 503, body: { success: false, message: "Service Unavailable", statusCode: 503 }, headers: { "x-request-id": "r-1", server: "BunnyCDN", "x-secret-token": "LEAK", "content-type": "application/json" } },
    { status: 200, body: { success: true } },
  ];
  try {
    await fetchVideoFromUrl("https://example.test/v.mp4", {}, "t");
    check("fetch 503 throws", "no throw", "throw");
  } catch (e) {
    check("fetch 503: ONE request, never retried (the 2nd answer is left unused)", [calls.length, answers.length], [1, 1]);
    const be = e as BunnyError;
    check("BunnyError keeps diagnostic headers only", be.headers, { "content-type": "application/json", server: "BunnyCDN", "x-request-id": "r-1" });
    const d = describeError(e);
    ok("describeError prints status, the whole body and the safe headers — never the secret-like one",
      d.includes("status=503") && d.includes('"message":"Service Unavailable"') && d.includes("x-request-id") && !d.includes("LEAK"));
  }
  answers = [];

  calls = [];
  answers = [{ status: 200, body: { totalItems: 1, items: [{ guid: GUID, title: "E13 drive-fetch abc — x", status: 1 }] } }];
  const found = await findVideosByTitle("abc def");
  check("findVideosByTitle: GET with search, returns items", [calls[0].method, calls[0].url.includes("/videos?search=abc%20def"), found.map((v) => v.guid)], ["GET", true, [GUID]]);

  // ══════════════════════════════════════════════════════════════════════
  section("TUS: 24h signature by default, Bunny's retry rule, shared options");
  env("false");
  const nowT = Date.UTC(2026, 9, 15, 12, 0, 0);
  const t24 = tusUploadAuthorization(GUID, undefined, nowT)!;
  check("default TUS TTL is 24h (the whole resumable window, plan: 10GB files)", [TUS_UPLOAD_TTL_SECONDS, Number(t24.headers.AuthorizationExpire)], [86400, Math.floor(nowT / 1000) + 86400]);
  check("retry: network error / 5xx / 409 / 423 yes; other 4xx no",
    [undefined, 0, 500, 503, 409, 423, 400, 401, 403, 404, 410].map((st) => shouldRetryTusStatus(st)),
    [true, true, true, true, true, true, false, false, false, false, false]);
  const o = bunnyTusOptions(t24, { filetype: "video/mp4", title: "פרק" });
  check("options: Bunny endpoint, 50MB chunks, signed headers, required metadata",
    [o.endpoint, o.chunkSize, o.headers?.VideoId, o.headers?.LibraryId, o.metadata],
    ["https://video.bunnycdn.com/tusupload", 50 * 1024 * 1024, GUID, "123456", { filetype: "video/mp4", title: "פרק" }]);
  check("TUS_CHUNK_SIZE = 50MiB", TUS_CHUNK_SIZE, 52428800);
  ok("the API key is not in the TUS options", !JSON.stringify(o).includes(API_KEY));

  // ══════════════════════════════════════════════════════════════════════
  section("static: the walls in the source");
  const clientSrc = readFileSync(join(__dirname, "../src/lib/bunny/client.ts"), "utf8");
  const fetchCalls = clientSrc.match(/\bfetch\(/g) ?? [];
  check("client.ts has exactly one fetch( call site (inside send())", fetchCalls.length, 1);
  const sendCalls = clientSrc.match(/\bsend\(/g) ?? [];
  check("send( is defined once and called from exactly three places (write(), getVideo, findVideosByTitle)", sendCalls.length, 4);
  const listBody = clientSrc.slice(clientSrc.indexOf("export async function findVideosByTitle"), clientSrc.indexOf("export type TusAuthorization"));
  ok("findVideosByTitle's send is a GET", /method: "GET"/.test(listBody) && /send\(/.test(listBody));
  const fetchFnBody = clientSrc.slice(clientSrc.indexOf("export async function fetchVideoRaw"), clientSrc.indexOf("export async function findVideosByTitle"));
  ok("Fetch Video (raw + production) writes only through write(), exactly once", (fetchFnBody.match(/await write\(/g) ?? []).length === 1 && !/send\(|[^.]fetch\(/.test(fetchFnBody));
  const getVideoBody = clientSrc.slice(clientSrc.indexOf("export async function getVideo"), clientSrc.indexOf("export async function deleteVideo"));
  ok("the send outside write() is the GET in getVideo", /method: "GET"/.test(getVideoBody) && /send\(/.test(getVideoBody));
  const writeBody = clientSrc.slice(clientSrc.indexOf("async function write("), clientSrc.indexOf("export async function createVideo"));
  ok("write() checks isBunnyDryRun() before it sends", writeBody.indexOf("isBunnyDryRun()") > -1 && writeBody.indexOf("isBunnyDryRun()") < writeBody.indexOf("send("));

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  const src = walk(join(__dirname, "../src"));
  const publicLeak = src.filter((f) => /NEXT_PUBLIC_BUNNY/.test(readFileSync(f, "utf8")));
  check("no NEXT_PUBLIC_BUNNY* anywhere in src/", publicLeak, []);
  const outside = src.filter((f) => !f.includes("/lib/bunny/") && /video\.bunnycdn\.com/.test(readFileSync(f, "utf8")));
  check("only lib/bunny talks to video.bunnycdn.com", outside, []);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.log = realLog;
  console.error(e);
  process.exit(1);
});
