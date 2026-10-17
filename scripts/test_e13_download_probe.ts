/**
 * E13-6 — the Drive availability check before the download 302 (owner 17.10):
 * src/lib/review/driveAvailability.ts and its place in
 * src/app/api/r/[token]/download/[versionId]/route.ts.
 *
 * Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test_e13_download_probe.ts
 *
 * ═══ F19 ═══ No database, no network: fetch is injected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyDriveProbe, probeDriveDownload, unavailablePage } from "../src/lib/review/driveAvailability";
import { driveDownloadUrl } from "../src/lib/review/clientVersions";

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

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section("classify: what Drive answered (measured 17.10)");
  check("206 video/mp4 → ok", classifyDriveProbe(206, "video/mp4", null), { state: "ok" });
  check("200 audio/mpeg (no Range support) → ok", classifyDriveProbe(200, "audio/mpeg", null), { state: "ok" });
  check("404 text/html (deleted / trashed / bad id) → missing", classifyDriveProbe(404, "text/html; charset=utf-8", null), { state: "unavailable", reason: "missing", httpStatus: 404 });
  check("410 → missing", classifyDriveProbe(410, null, null), { state: "unavailable", reason: "missing", httpStatus: 410 });
  check("403 → not shared", classifyDriveProbe(403, "text/html", null), { state: "unavailable", reason: "not_shared", httpStatus: 403 });
  check("401 → not shared", classifyDriveProbe(401, null, null), { state: "unavailable", reason: "not_shared", httpStatus: 401 });
  check("302 to accounts.google.com (sign-in) → not shared", classifyDriveProbe(302, null, "https://accounts.google.com/ServiceLogin?continue=x"), { state: "unavailable", reason: "not_shared", httpStatus: 302 });
  check("302 elsewhere → unknown (go on to Drive)", classifyDriveProbe(302, null, "https://drive.usercontent.google.com/x"), { state: "unknown", detail: "HTTP 302" });
  check("200 text/html (virus page, quota page, captcha) → unknown, NOT a refusal", classifyDriveProbe(200, "text/html; charset=utf-8", null), { state: "unknown", detail: "HTTP 200 html" });
  check("429 → unknown", classifyDriveProbe(429, "text/html", null).state, "unknown");
  check("500 → unknown", classifyDriveProbe(500, null, null).state, "unknown");
  check("416 → unknown", classifyDriveProbe(416, "text/html", null).state, "unknown");

  // ══════════════════════════════════════════════════════════════════════
  section("probe: the request itself");
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fake = (status: number, headers: Record<string, string> = {}) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(status === 206 || status === 200 ? "x" : null, { status, headers });
    }) as typeof fetch;
  check("206 → ok", await probeDriveDownload("FILE1", { fetchImpl: fake(206, { "content-type": "video/mp4" }) }), { state: "ok" });
  const c = calls[0];
  check("asks the SAME address the client is sent to", c.url, driveDownloadUrl("FILE1"));
  check("one byte only", (c.init?.headers as Record<string, string>)?.Range, "bytes=0-0");
  check("does not follow redirects (sees a sign-in redirect)", c.init?.redirect, "manual");
  ok("anonymous: no Authorization header", !("Authorization" in ((c.init?.headers as Record<string, string>) ?? {})));
  ok("has a timeout signal", !!c.init?.signal);
  check("404 → missing", await probeDriveDownload("F", { fetchImpl: fake(404, { "content-type": "text/html" }) }), { state: "unavailable", reason: "missing", httpStatus: 404 });
  const throwing = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  check("network error → unknown, never throws", await probeDriveDownload("F", { fetchImpl: throwing }), { state: "unknown", detail: "TypeError" });
  const hanging = ((_u: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("timed out", "TimeoutError"))))) as typeof fetch;
  const t0 = Date.now();
  // AbortSignal.timeout's timer is unref'd: with nothing else pending, a
  // script would exit before it fires (a server never is in that state)
  const keepAlive = setInterval(() => {}, 1000);
  const slow = await probeDriveDownload("F", { fetchImpl: hanging, timeoutMs: 50 });
  clearInterval(keepAlive);
  check("timeout → unknown", slow.state, "unknown");
  ok("…and returns promptly", Date.now() - t0 < 2000);

  // ══════════════════════════════════════════════════════════════════════
  section("the page the client sees");
  const html = unavailablePage("/r/tok123");
  ok("the owner's wording", html.includes("הקובץ לא זמין כרגע להורדה") && html.includes("הצוות קיבל הודעה ויחזור אליכם"));
  ok("Hebrew, right to left, utf-8", html.includes('lang="he"') && html.includes('dir="rtl"') && html.includes('charset="utf-8"'));
  ok("a way back to the review page", html.includes('href="/r/tok123"'));
  ok("no technical detail (no Drive, no status codes)", !/drive|404|403|google/i.test(html.replace(/<style>[\s\S]*<\/style>/, "")));
  ok("phone width", html.includes('name="viewport"'));

  // ══════════════════════════════════════════════════════════════════════
  section("static: the route");
  const root = join(__dirname, "..");
  const src = readFileSync(join(root, "src/app/api/r/[token]/download/[versionId]/route.ts"), "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  const iGate = code.indexOf("gateDownloadForLink(");
  const iProbe = code.indexOf("probeDriveDownload(");
  const iMissing = code.indexOf("client_review_download_missing");
  const iRedirect = code.indexOf("NextResponse.redirect(");
  ok("order: gate → probe → (missing page) → redirect", iGate > 0 && iProbe > iGate && iMissing > iProbe && iRedirect > iMissing);
  ok("only 'unavailable' refuses; 'unknown' falls through to the 302", /if \(probe\.state === "unavailable"\)/.test(code) && !/probe\.state === "unknown"\)\s*return/.test(code));
  ok("the missing event carries the reason", /reason: probe\.reason/.test(code));
  ok("the download event is still written on the 302 path", code.indexOf('"client_review_download"') > iMissing);
  ok("nothing from Bunny", !/signedOriginalUrl|\/original|@\/lib\/bunny/.test(code));
  ok("route exports only GET and dynamic (Next rejects other exports)", (code.match(/^export /gm) ?? []).length === 2);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main();
