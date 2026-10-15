/**
 * E13-2 — scripts/e13_first_upload.ts: the guards, and the --live path end to
 * end against a MOCKED Bunny (API + CDN + player).
 *
 * Run: npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_first_upload.ts
 *
 * ═══ F19 ═══ No network: `global.fetch` answers from a fake Bunny and fails
 * on anything it does not know. A temp env file stands in for .env.local.
 */
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
    console.log(`  ❌ ${name}\n       got:  ${g?.slice(0, 500)}\n       want: ${w?.slice(0, 500)}`);
  }
}
const section = (t: string) => console.log(`\n── ${t}`);

const dir = mkdtempSync(join(tmpdir(), "e13fu-"));
const envPath = join(dir, "env");
const video = join(dir, "v.mp4");
const audio = join(dir, "a.mp3");
writeFileSync(video, Buffer.alloc(4096, 1));
writeFileSync(audio, Buffer.alloc(2048, 2));
const KEYS = "BUNNY_STREAM_LIBRARY_ID=111\nBUNNY_STREAM_API_KEY=k\nBUNNY_STREAM_CDN_HOSTNAME=vz-fake.b-cdn.net\nBUNNY_CDN_TOKEN_KEY=t\n";
process.env.E13_FIRST_UPLOAD_ENV_FILE = envPath;
process.env.E13_FIRST_UPLOAD_POLL_MS = "1";

// ── the fake Bunny ──────────────────────────────────────────────────────────
type Scenario = { originalOpen: boolean; audioFails: boolean };
let sc: Scenario = { originalOpen: false, audioFails: false };
let calls: string[] = [];
const created: string[] = [];
const deleted = new Set<string>();
const kindOf = new Map<string, "video" | "audio">();
const guids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

global.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = String(input);
  const method = init.method ?? "GET";
  calls.push(`${method} ${url}`);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const m = /^https:\/\/video\.bunnycdn\.com\/library\/111\/videos(?:\/([0-9a-f-]+))?$/.exec(url);
  if (m) {
    const guid = m[1];
    if (!guid && method === "POST") {
      const g = guids[created.length];
      created.push(g);
      kindOf.set(g, String(init.body).includes("אודיו") ? "audio" : "video");
      return json(200, { guid: g, status: 0 });
    }
    if (guid && method === "PUT") return json(200, { success: true });
    if (guid && method === "DELETE") {
      deleted.add(guid);
      return json(200, { success: true });
    }
    if (guid && method === "GET") {
      if (deleted.has(guid)) return json(404, {});
      if (kindOf.get(guid) === "audio" && sc.audioFails) return json(200, { guid, status: 5 });
      return json(200, { guid, status: 4, length: 12, hasOriginal: true, originalHash: "abc", availableResolutions: "240p,360p" });
    }
  }
  const cdn = /^https:\/\/vz-fake\.b-cdn\.net\/(.*)$/.exec(url);
  if (cdn) {
    const rest = cdn[1];
    const ref = (init.headers as Record<string, string>)?.Referer;
    if (ref !== "https://bizi-tech-and-invoice.vercel.app/") return new Response("", { status: 401 });
    if (/\/original/.test(rest)) {
      if (rest.includes("token=HS256-")) return new Response("x", { status: 206 });
      return new Response("", { status: sc.originalOpen ? 200 : 403 });
    }
    if (rest.startsWith("bcdn_token=HS256-")) {
      if (rest.endsWith("/playlist.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n360p/video.m3u8\n", { status: 200 });
      if (rest.endsWith("/360p/video.m3u8")) return new Response("#EXTM3U\n", { status: 200 });
    }
    if (rest.endsWith("/playlist.m3u8")) return new Response("", { status: 403 });
  }
  if (/^https:\/\/player\.mediadelivery\.net\/(play|embed)\/111\//.test(url)) return new Response("", { status: 403 });
  throw new Error(`F19: unknown request ${method} ${url}`);
}) as unknown as typeof fetch;

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const l = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = l;
  }
};

async function main() {
  const { main: run } = await import("./e13_first_upload");
  type Row = { file: string; check: string; result: string; detail: string };
  const res = (rows: Row[], file: string, c: string) => rows.find((r) => r.file === file && r.check === c)?.result;

  section("guards: --live refused unless the env FILE says BUNNY_DRY_RUN=false");
  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=true\n");
  delete process.env.BUNNY_DRY_RUN;
  calls = [];
  let err = "";
  try {
    await quiet(() => run(["--video", video, "--audio", audio, "--live"]));
  } catch (e) {
    err = (e as Error).message;
  }
  check("refused with the reason, zero requests", [err.includes("BUNNY_DRY_RUN=false"), calls.length], [true, 0]);

  writeFileSync(envPath, KEYS + "BUNNY_DRY_RUN=false\n");
  process.env.BUNNY_DRY_RUN = "true";
  err = "";
  try {
    await quiet(() => run(["--video", video, "--audio", audio, "--live"]));
  } catch (e) {
    err = (e as Error).message;
  }
  check("file says false but the shell overrides → refused, zero requests", [err.includes("shell"), calls.length], [true, 0]);

  section("dry run (no --live) even with false in the file: zero requests");
  delete process.env.BUNNY_DRY_RUN;
  const dry = await quiet(() => run(["--video", video, "--audio", audio]));
  check("zero requests", calls.length, 0);
  check("every row skipped", dry.every((r) => r.result === "דילוג"), true);
  check("12 rows per file", dry.length, 24);

  section("--live, everything as configured");
  process.env.BUNNY_DRY_RUN = "false";
  const live = await quiet(() => run(["--video", video, "--audio", audio, "--live"]));
  check("no failed row", live.filter((r) => r.result === "נכשל").map((r) => `${r.file}:${r.check}`), []);
  check("both videos created and both deleted", [created.length, deleted.size], [2, 2]);
  check("/original unsigned 403 → pass (Q5)", res(live, "וידאו", "/original בלי טוקן → 403"), "עבר");
  check("sub-playlist fetched through the directory token", calls.some((c) => /bcdn_token=HS256-[^/]*\/[0-9a-f-]+\/360p\/video\.m3u8$/.test(c)), true);
  check("Direct Play + Embed blocked → pass", [res(live, "וידאו", "Direct Play חסום"), res(live, "אודיו", "Embed בלי טוקן חסום")], ["עבר", "עבר"]);
  check("the API key never appears in a CDN/player URL", calls.filter((c) => !c.includes("video.bunnycdn.com")).some((c) => /[?&/]k(&|$)/.test(c)), false);

  section("--live, /original open and the audio fails to encode");
  sc = { originalOpen: true, audioFails: true };
  created.length = 0;
  deleted.clear();
  guids.splice(0, 2, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
  const bad = await quiet(() => run(["--video", video, "--audio", audio, "--live"]));
  check("Q5 fails: /original reachable without a token", res(bad, "וידאו", "/original בלי טוקן → 403"), "נכשל");
  check("audio stops at status 4 check", res(bad, "אודיו", "status 4"), "נכשל");
  check("both still deleted after the failures", [created.length, deleted.size, res(bad, "אודיו", "מחיקה")], [2, 2, "עבר"]);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
