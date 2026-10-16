/**
 * E13-2 — scripts/e13_first_upload.ts over TUS: the upload itself (a local
 * TUS server), retries, resume after a cut, the guards, and that the table is
 * printed even after a failure.
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_first_upload.ts
 *
 * ═══ F19 ═══ Nothing leaves the machine. tus-js-client talks plain HTTP to a
 * TUS server this file starts on 127.0.0.1; the Bunny API, CDN and player go
 * through a mocked `global.fetch` that fails on anything it does not know.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

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
const MB = 1024 * 1024;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// ── a minimal TUS 1.0 server (creation + core), with failure injection ─────
type Up = { length: number; parts: Buffer[]; offset: number; meta: string; headers: Record<string, string> };
type TusServer = {
  url: string;
  uploads: Map<string, Up>;
  stats: { post: number; head: number; patch: number; patchBytes: number; missingAuth: number };
  failPatchNumbers: Set<number>; // destroy the socket mid-body on these PATCH counts (1-based)
  postStatus: number | null; // answer POST with this status (e.g. 401) instead of creating
  postStatusOnce: boolean; // ...only for the first POST
  close: () => Promise<void>;
  data: (id?: string) => Buffer;
};

function startTus(): Promise<TusServer> {
  const uploads = new Map<string, Up>();
  const stats = { post: 0, head: 0, patch: 0, patchBytes: 0, missingAuth: 0 };
  const s: Partial<TusServer> = { uploads, stats, failPatchNumbers: new Set(), postStatus: null, postStatusOnce: false };
  const srv = http.createServer((req, res) => {
    const h = (k: string) => String(req.headers[k.toLowerCase()] ?? "");
    for (const k of ["AuthorizationSignature", "AuthorizationExpire", "LibraryId", "VideoId"]) if (!h(k)) stats.missingAuth++;
    const base = `/tusupload`;
    res.setHeader("Tus-Resumable", "1.0.0");
    if (req.method === "POST" && req.url === base) {
      stats.post++;
      if (s.postStatus) {
        res.writeHead(s.postStatus, { "content-type": "application/json" });
        if (s.postStatusOnce) s.postStatus = null;
        res.end(JSON.stringify({ message: "Unauthorized: signature mismatch" }));
        return;
      }
      const id = randomBytes(6).toString("hex");
      uploads.set(id, {
        length: Number(h("Upload-Length")),
        parts: [],
        offset: 0,
        meta: h("Upload-Metadata"),
        headers: { sig: h("AuthorizationSignature"), exp: h("AuthorizationExpire"), lib: h("LibraryId"), vid: h("VideoId") },
      });
      res.writeHead(201, { Location: `${s.url}/${id}` });
      res.end();
      return;
    }
    const m = /^\/tusupload\/([0-9a-f]+)$/.exec(req.url ?? "");
    const up = m ? uploads.get(m[1]) : undefined;
    if (!up) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      stats.head++;
      res.writeHead(200, { "Upload-Offset": String(up.offset), "Upload-Length": String(up.length), "Cache-Control": "no-store" });
      res.end();
      return;
    }
    if (req.method === "PATCH") {
      stats.patch++;
      const n = stats.patch;
      if (Number(h("Upload-Offset")) !== up.offset) {
        res.writeHead(409);
        res.end();
        return;
      }
      const got: Buffer[] = [];
      let size = 0;
      req.on("data", (c: Buffer) => {
        got.push(c);
        size += c.length;
        stats.patchBytes += c.length;
        if (s.failPatchNumbers!.has(n) && size > 64 * 1024) {
          s.failPatchNumbers!.delete(n);
          req.socket.destroy(); // partial body discarded: offset unchanged
        }
      });
      req.on("end", () => {
        const b = Buffer.concat(got);
        up.parts.push(b);
        up.offset += b.length;
        res.writeHead(204, { "Upload-Offset": String(up.offset) });
        res.end();
      });
      return;
    }
    res.writeHead(405);
    res.end();
  });
  return new Promise((r) =>
    srv.listen(0, "127.0.0.1", () => {
      s.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/tusupload`;
      s.close = () =>
        new Promise<void>((rr) => {
          srv.closeAllConnections();
          srv.close(() => rr());
        });
      s.data = (id?: string) => {
        const u = id ? uploads.get(id)! : Array.from(uploads.values()).pop()!;
        return Buffer.concat(u.parts);
      };
      r(s as TusServer);
    })
  );
}

// ── files ───────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "e13tus-"));
const envPath = join(dir, "env");
const video = join(dir, "v.mp4");
const audio = join(dir, "a.mp3");
const videoBytes = randomBytes(10 * MB);
const audioBytes = randomBytes(3 * MB);
writeFileSync(video, videoBytes);
writeFileSync(audio, audioBytes);
const KEYS = "BUNNY_STREAM_LIBRARY_ID=111\nBUNNY_STREAM_API_KEY=k\nBUNNY_STREAM_CDN_HOSTNAME=vz-fake.b-cdn.net\nBUNNY_CDN_TOKEN_KEY=t\n";
process.env.E13_FIRST_UPLOAD_ENV_FILE = envPath;
process.env.E13_FIRST_UPLOAD_POLL_MS = "1";
process.env.E13_FIRST_UPLOAD_RESUME_PAUSE_MS = "50";
process.env.E13_FIRST_UPLOAD_BACKOFF_MS = "1";

// ── the fake Bunny API / CDN / player (fetch) ───────────────────────────────
let calls: string[] = [];
// fault injection: the next `times` requests matching `match` die with a
// connect timeout (what the first live run hit on a status read)
type Fault = { match: RegExp; method?: string; times: number };
let faults: Fault[] = [];
let audioStatus: number | null = null; // e.g. 2 = stuck "Processing"
const connectTimeout = () =>
  new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error (attempted address: video.bunnycdn.com:443, timeout: 10000ms)"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
let created: string[] = [];
const deleted = new Set<string>();
const kindOf = new Map<string, "video" | "audio">();
let guidSeq = 0;
global.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  calls.push(`${method} ${url}`);
  const fault = faults.find((f) => f.times > 0 && f.match.test(url) && (!f.method || f.method === method));
  if (fault) {
    fault.times--;
    throw connectTimeout();
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const m = /^https:\/\/video\.bunnycdn\.com\/library\/111\/videos(?:\/([0-9a-f-]+))?$/.exec(url);
  if (m) {
    const guid = m[1];
    if (!guid && method === "POST") {
      const g = `00000000-0000-4000-8000-${String(++guidSeq).padStart(12, "0")}`;
      created.push(g);
      kindOf.set(g, String(init.body).includes("אודיו") ? "audio" : "video");
      return json(200, { guid: g, status: 0 });
    }
    if (guid && method === "DELETE") {
      deleted.add(guid);
      return json(200, { success: true });
    }
    if (guid && method === "GET") {
      if (deleted.has(guid)) return json(404, {});
      if (audioStatus !== null && kindOf.get(guid) === "audio") return json(200, { guid, status: audioStatus, encodeProgress: 0 });
      return json(200, { guid, status: 4, length: 12, hasOriginal: true, originalHash: "abc", availableResolutions: "240p" });
    }
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

const AUTH = (endpoint: string) => ({
  endpoint,
  headers: { AuthorizationSignature: "sig", AuthorizationExpire: "9999999999", LibraryId: "111", VideoId: "00000000-0000-4000-8000-000000000999" },
});

async function main() {
  const { runTusUpload, main: run } = await import("./e13_first_upload");
  const quietLog = () => {};
  type Row = { file: string; check: string; result: string; detail: string };
  const res = (rows: Row[], file: string, c: string) => rows.find((r) => r.file === file && r.check === c);

  // ══════════════════════════════════════════════════════════════════════
  section("TUS upload: whole file arrives intact, Bunny's headers on every request");
  let tus = await startTus();
  const r1 = await runTusUpload(video, AUTH(tus.url), { title: "t", filetype: "video/mp4", chunkSize: 1 * MB, retryDelays: [0, 10], log: quietLog });
  check("ok, no retries", [r1.ok, r1.retries], [true, 0]);
  check("server bytes == file (sha256)", sha(tus.data()), sha(videoBytes));
  check("one POST, 10 PATCHes of 1MB", [tus.stats.post, tus.stats.patch], [1, 10]);
  check("AuthorizationSignature/Expire/LibraryId/VideoId on every request", tus.stats.missingAuth, 0);
  const meta = Array.from(tus.uploads.values())[0].meta;
  const decoded = Object.fromEntries(meta.split(",").map((kv: string) => { const [k, v] = kv.trim().split(" "); return [k, Buffer.from(v ?? "", "base64").toString()]; }));
  check("Upload-Metadata carries filetype + title (Bunny requires both)", [decoded.filetype, decoded.title], ["video/mp4", "t"]);
  await tus.close();

  // ══════════════════════════════════════════════════════════════════════
  section("a network drop mid-PATCH is retried and the upload completes");
  tus = await startTus();
  tus.failPatchNumbers.add(3);
  const lines: string[] = [];
  const r2 = await runTusUpload(video, AUTH(tus.url), { title: "t", filetype: "video/mp4", chunkSize: 1 * MB, retryDelays: [0, 10, 10], log: (l) => lines.push(l) });
  check("ok after a retry", [r2.ok, r2.retries >= 1], [true, true]);
  check("server bytes == file after the retry", sha(tus.data()), sha(videoBytes));
  ok("the retry was logged with the network error's description", lines.some((l) => l.includes("ניסיון חוזר") && l.includes("שגיאת רשת")));
  ok("resumed via HEAD (offset), not a new upload", tus.stats.post === 1 && tus.stats.head >= 1);
  await tus.close();

  // ══════════════════════════════════════════════════════════════════════
  section("resume after a deliberate cut at ~30%: continues from the cut, not from 0");
  tus = await startTus();
  const r3 = await runTusUpload(video, AUTH(tus.url), { title: "t", filetype: "video/mp4", chunkSize: 1 * MB, retryDelays: [0], resumeAt: 0.3, resumePauseMs: 50, log: quietLog });
  check("ok", r3.ok, true);
  ok("cut at or after 30%", !!r3.resume && r3.resume.abortedAt >= 0.3 * videoBytes.length && r3.resume.abortedAt < videoBytes.length);
  check("HEAD reported exactly the acknowledged offset", r3.resume?.resumedFrom, r3.resume?.abortedAt);
  check("server bytes == file", sha(tus.data()), sha(videoBytes));
  ok("total PATCH bytes < 1.2× file (no restart from 0)", tus.stats.patchBytes < 1.2 * videoBytes.length);
  check("still one upload resource (POST once)", tus.stats.post, 1);
  await tus.close();

  // ══════════════════════════════════════════════════════════════════════
  section("a 401 (bad signature) is NOT retried and comes back fully described");
  tus = await startTus();
  tus.postStatus = 401;
  const r4 = await runTusUpload(video, AUTH(tus.url), { title: "t", filetype: "video/mp4", chunkSize: 1 * MB, retryDelays: [0, 10, 10], log: quietLog });
  check("failed, zero retries, one POST", [r4.ok, r4.retries, tus.stats.post], [false, 0, 1]);
  ok("error names the status and the body", !!r4.error && r4.error.includes("status=401") && r4.error.includes("signature mismatch"));
  await tus.close();

  // ══════════════════════════════════════════════════════════════════════
  section("guards: --live refused unless the env FILE says BUNNY_DRY_RUN=false");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=true\n");
  delete process.env.BUNNY_DRY_RUN;
  calls = [];
  let err = "";
  try {
    await capture(() => run(["--video", video, "--audio", audio, "--live"]));
  } catch (e) {
    err = (e as Error).message;
  }
  check("refused, zero requests", [err.includes("BUNNY_DRY_RUN=false"), calls.length], [true, 0]);

  section("dry run: zero requests, every row skipped, table printed");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=false\n");
  const dry = await capture(() => run(["--video", video, "--audio", audio, "--resume-test"]));
  check("zero requests", calls.length, 0);
  check("all skipped", dry.value.every((r) => r.result === "דילוג"), true);
  ok("table printed", dry.out.includes("═══ סיכום ═══"));

  // ══════════════════════════════════════════════════════════════════════
  section("--live --resume-test against the local TUS server + mocked Bunny");
  tus = await startTus();
  process.env.E13_FIRST_UPLOAD_TUS_ENDPOINT = tus.url;
  process.env.BUNNY_DRY_RUN = "false";
  created = [];
  deleted.clear();
  const live = await capture(() => run(["--video", video, "--audio", audio, "--live", "--resume-test"]));
  check("no failed row", live.value.filter((r) => r.result === "נכשל").map((r) => `${r.file}:${r.check}: ${r.detail}`), []);
  check("resume row passed", res(live.value, "וידאו", "המשך אחרי ניתוק")?.result, "עבר");
  check("both files uploaded intact", Array.from(tus.uploads.values()).map((u) => sha(Buffer.concat(u.parts))), [sha(videoBytes), sha(audioBytes)]);
  check("both videos deleted", [created.length, deleted.size], [2, 2]);
  ok("progress printed in %", /העלאה \d+%/.test(live.out));
  await tus.close();

  // ══════════════════════════════════════════════════════════════════════
  section("--live where the VIDEO's TUS fails: audio still runs, table printed, video deleted");
  tus = await startTus();
  tus.postStatus = 401;
  tus.postStatusOnce = true; // the video's POST fails, the audio's succeeds
  process.env.E13_FIRST_UPLOAD_TUS_ENDPOINT = tus.url;
  created = [];
  deleted.clear();
  const bad = await capture(() => run(["--video", video, "--audio", audio, "--live"]));
  const vRow = res(bad.value, "וידאו", "העלאת TUS");
  check("video TUS row failed", vRow?.result, "נכשל");
  ok("detail carries the full error (status + body)", !!vRow && vRow.detail.includes("status=401") && vRow.detail.includes("signature mismatch"));
  check("audio still uploaded and passed", res(bad.value, "אודיו", "העלאת TUS")?.result, "עבר");
  ok("table printed after the failure", bad.out.includes("═══ סיכום ═══") && bad.out.includes("| וידאו | העלאת TUS | נכשל |"));
  check("both videos deleted (the failed one too)", [created.length, deleted.size], [2, 2]);
  await tus.close();


  // ══════════════════════════════════════════════════════════════════════
  // the live runs below reuse one local TUS server
  const fresh = async () => {
    const t = await startTus();
    process.env.E13_FIRST_UPLOAD_TUS_ENDPOINT = t.url;
    process.env.BUNNY_DRY_RUN = "false";
    created = [];
    deleted.clear();
    faults = [];
    audioStatus = null;
    calls = [];
    return t;
  };

  section("retries: a connect timeout on a status read / a CDN probe / the delete is retried, then passes");
  tus = await fresh();
  faults = [
    { match: /videos\/[0-9a-f-]+$/, method: "GET", times: 3 }, // status reads
    { match: /b-cdn\.net\/[0-9a-f-]+\/original$/, times: 2 }, // unsigned /original
    { match: /videos\/[0-9a-f-]+$/, method: "DELETE", times: 1 }, // delete
  ];
  const flaky = await capture(() => run(["--video", video, "--live", "--video-only"]));
  check("no failed / not-checked row", flaky.value.filter((r) => r.result === "נכשל" || r.result === "לא נבדק").map((r) => `${r.check}: ${r.detail}`), []);
  check("status 4 passed after retries", res(flaky.value, "וידאו", "status 4")?.result, "עבר");
  ok("/original 403 passed, detail says after 3 attempts", res(flaky.value, "וידאו", "/original בלי טוקן → 403")?.detail.includes("אחרי 3 ניסיונות") === true);
  check("deleted after a failed first DELETE", [res(flaky.value, "וידאו", "מחיקה")?.result, deleted.size], ["עבר", 1]);
  ok("each retry was logged with the cause code", (flaky.out.match(/ניסיון חוזר \d\/5/g) ?? []).length >= 6 && flaky.out.includes("UND_ERR_CONNECT_TIMEOUT"));
  ok("Q5 passed", flaky.out.includes("Q5 (/original מכוסה בטוקן): עבר"));
  ok("--video-only: Q1 not checked", flaky.out.includes("Q1 (אודיו טהור ב-Bunny): לא נבדק — --video-only"));
  check("--video-only: no audio rows", flaky.value.filter((r) => r.file === "אודיו").length, 0);
  await tus.close();

  section("a status read that never answers (6 attempts) → \"לא נבדק\", not \"נכשל\"; the rest not checked; Q5 not checked");
  tus = await fresh();
  faults = [{ match: /videos\/[0-9a-f-]+$/, method: "GET", times: 6 }];
  const dead = await capture(() => run(["--video", video, "--live", "--video-only"]));
  const st = res(dead.value, "וידאו", "status 4");
  check("status 4 = לא נבדק with the full cause", [st?.result, st?.detail.includes("UND_ERR_CONNECT_TIMEOUT"), st?.detail.includes("אחרי 5 ניסיונות")], ["לא נבדק", true, true]);
  check("every later check = לא נבדק", ["hasOriginal + originalHash", "/original בלי טוקן → 403", "playlist חתום → 200", "Embed בלי טוקן חסום"].map((c) => res(dead.value, "וידאו", c)?.result), ["לא נבדק", "לא נבדק", "לא נבדק", "לא נבדק"]);
  check("no row says נכשל", dead.value.filter((r) => r.result === "נכשל").map((r) => r.check), []);
  ok("Q5 = לא נבדק (not נכשל)", dead.out.includes("Q5 (/original מכוסה בטוקן): לא נבדק"));
  check("the video was still deleted", deleted.size, 1);
  await tus.close();

  section("a CDN probe with no answer at all → that row לא נבדק, Q5 לא נבדק");
  tus = await fresh();
  faults = [{ match: /b-cdn\.net\/[0-9a-f-]+\/original$/, times: 99 }];
  const noCdn = await capture(() => run(["--video", video, "--live", "--video-only"]));
  check("/original unsigned = לא נבדק", res(noCdn.value, "וידאו", "/original בלי טוקן → 403")?.result, "לא נבדק");
  check("the other probes still ran and passed", res(noCdn.value, "וידאו", "playlist בלי טוקן → 403")?.result, "עבר");
  ok("Q5 = לא נבדק", noCdn.out.includes("Q5 (/original מכוסה בטוקן): לא נבדק"));
  await tus.close();

  section("audio stuck in encoding past the wait → status 4 לא נבדק (Free Encoding queue), Q1 לא נבדק");
  tus = await fresh();
  audioStatus = 2;
  process.env.E13_FIRST_UPLOAD_WAIT_MAX_MS = "30";
  const stuck = await capture(() => run(["--video", video, "--audio", audio, "--live"]));
  delete process.env.E13_FIRST_UPLOAD_WAIT_MAX_MS;
  const ast = res(stuck.value, "אודיו", "status 4");
  check("audio status 4 = לא נבדק, says Free Encoding", [ast?.result, ast?.detail.includes("Free Encoding")], ["לא נבדק", true]);
  check("video unaffected", res(stuck.value, "וידאו", "playlist חתום → 200")?.result, "עבר");
  ok("Q1 = לא נבדק", stuck.out.includes("Q1 (אודיו טהור ב-Bunny): לא נבדק"));
  ok("Q5 = לא נבדק (audio's /original never ran)", stuck.out.includes("Q5 (/original מכוסה בטוקן): לא נבדק"));
  await tus.close();

  section("--keep: nothing deleted, guids printed");
  tus = await fresh();
  const keep = await capture(() => run(["--video", video, "--audio", audio, "--live", "--keep"]));
  check("zero DELETE requests", calls.filter((c) => c.startsWith("DELETE")).length, 0);
  check("delete rows = דילוג with the guid", ["וידאו", "אודיו"].map((f) => [res(keep.value, f, "מחיקה")?.result, res(keep.value, f, "מחיקה")?.detail.includes(created[f === "וידאו" ? 0 : 1])]), [["דילוג", true], ["דילוג", true]]);
  ok("guids listed at the end", keep.out.includes("--keep — נשארו בספרייה") && created.every((g) => keep.out.includes(g)));
  await tus.close();

  section("verdict(): three states");
  const { verdict } = await import("./e13_first_upload");
  check("pass / fail / not-checked", [verdict(["עבר", "עבר"]), verdict(["עבר", "נכשל"]), verdict(["עבר", "לא נבדק"]), verdict([undefined]), verdict([]), verdict(["לא נבדק", "נכשל"])],
    ["עבר", "נכשל", "לא נבדק", "לא נבדק", "לא נבדק", "נכשל"]);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
