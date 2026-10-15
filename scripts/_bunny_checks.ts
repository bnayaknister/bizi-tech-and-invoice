/**
 * Shared by the E13 Bunny test scripts (e13_first_upload.ts, e13_drive_fetch_test.ts).
 * Not a test itself (no `test_` prefix).
 *
 *   · loadEnvFile        — what .env.local SAYS, kept apart from the process env
 *                          (the --live guard reads the file, not the shell)
 *   · withRetry / probe  — network failures and 5xx retried 5× with backoff;
 *                          a clean HTTP answer is a result, never retried
 *   · runCdnChecks       — /original + playlist 403/200, the directory token,
 *                          Direct Play and Embed blocked
 *   · removeVideo        — delete + confirm gone, with retries
 *   · compareHashes      — Bunny's originalHash vs Drive's sha256Checksum
 *
 * Results have three states besides "skipped": a check that never got an HTTP
 * answer is "לא נבדק", never "נכשל" (owner 15.10).
 */
import { readFileSync } from "node:fs";
import { BunnyError, BunnyNetworkError, deleteVideo, getVideo } from "../src/lib/bunny/client";
import { describeError } from "../src/lib/bunny/errors";
import { signedOriginalUrl, signedPlaybackUrl } from "../src/lib/bunny/sign";

export type Result = "עבר" | "נכשל" | "דילוג" | "לא נבדק";
export type Row = { file: string; check: string; result: Result; detail: string };
export type Recorder = (file: string, check: string, result: Result, detail?: string) => void;

export const REFERER = "https://bizi-tech-and-invoice.vercel.app/";
const HTTP_TIMEOUT_MS = 20_000;

/** Reads KEY=VALUE lines; fills process.env only where unset; returns what the FILE says. */
export function loadEnvFile(path: string): Record<string, string> {
  const envFile: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    envFile[k] = v;
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return envFile;
}

// ── retries (owner 15.10: the first live run lost a whole video to one
//    ConnectTimeoutError on a status read) ───────────────────────────────────
export const RETRIES = 5;
const backoffBaseMs = () => Number(process.env.E13_BACKOFF_MS ?? process.env.E13_FIRST_UPLOAD_BACKOFF_MS ?? 2_000);
const backoffMs = (attempt: number) => backoffBaseMs() * 2 ** attempt; // 2s, 4s, 8s, 16s, 32s

export const isRetryable = (e: unknown) =>
  e instanceof BunnyNetworkError || (e instanceof BunnyError && e.status >= 500);

export async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= RETRIES) throw e;
      const wait = backoffMs(attempt);
      console.log(`     🔁 ${what}: ניסיון חוזר ${attempt + 1}/${RETRIES} בעוד ${wait}ms — ${describeError(e)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// ── HTTP probes (never throw: a network error is a result, after retries) ────
export type Probe = { status: number; head: string; error?: string; attempts: number };
async function probeOnce(url: string, opts: { range?: boolean }): Promise<Omit<Probe, "attempts">> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Referer: REFERER, ...(opts.range ? { Range: "bytes=0-0" } : {}) },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let head = "";
    if (res.ok && !opts.range) head = (await res.text()).slice(0, 4000);
    else await res.body?.cancel();
    return { status: res.status, head };
  } catch (e) {
    return { status: -1, head: "", error: describeError(e) };
  }
}
export async function probe(url: string, opts: { range?: boolean } = {}): Promise<Probe> {
  for (let attempt = 0; ; attempt++) {
    const p = await probeOnce(url, opts);
    if ((p.status !== -1 && p.status < 500) || attempt >= RETRIES) return { ...p, attempts: attempt + 1 };
    const wait = backoffMs(attempt);
    console.log(`     🔁 ${pathOnly(url)}: ניסיון חוזר ${attempt + 1}/${RETRIES} בעוד ${wait}ms — ${p.status === -1 ? p.error : `HTTP ${p.status}`}`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
/** A probe that never got an HTTP answer is "not checked", not a verdict. */
export const probeResult = (p: Probe, pass: boolean): Result => (p.status === -1 ? "לא נבדק" : pass ? "עבר" : "נכשל");
export const statusText = (p: Probe) =>
  (p.status === -1 ? `שגיאת רשת אחרי ${p.attempts} ניסיונות: ${p.error}` : `HTTP ${p.status}`) +
  (p.status !== -1 && p.attempts > 1 ? ` (אחרי ${p.attempts} ניסיונות)` : "");

export const pathOnly = (u: string) => new URL(u).pathname.replace(/bcdn_token=[^/]*/, "bcdn_token=…");

export const CDN_CHECKS = [
  "/original בלי טוקן → 403", "/original חתום → 200",
  "playlist בלי טוקן → 403", "playlist חתום → 200", "תת-playlist דרך טוקן התיקייה → 200",
  "Direct Play חסום", "Embed בלי טוקן חסום",
];

/** The access checks on a FINISHED video (status 4). Records one row per CDN_CHECKS entry it reaches. */
export async function runCdnChecks(label: string, guid: string, record: Recorder): Promise<void> {
  const host = (process.env.BUNNY_STREAM_CDN_HOSTNAME ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const lib = process.env.BUNNY_STREAM_LIBRARY_ID;

  const o0 = await probe(`https://${host}/${guid}/original`, { range: true });
  record(label, "/original בלי טוקן → 403", probeResult(o0, o0.status === 403), statusText(o0));

  const os = signedOriginalUrl(guid, 600);
  const o1 = await probe(os.url, { range: true });
  record(label, "/original חתום → 200", probeResult(o1, o1.status === 200 || o1.status === 206), `${statusText(o1)} ${pathOnly(os.url)}`);

  const p0 = await probe(`https://${host}/${guid}/playlist.m3u8`);
  record(label, "playlist בלי טוקן → 403", probeResult(p0, p0.status === 403), statusText(p0));

  const ps = signedPlaybackUrl(guid);
  const p1 = await probe(ps.url);
  const isHls = p1.head.startsWith("#EXTM3U");
  record(label, "playlist חתום → 200", probeResult(p1, p1.status === 200 && isHls), `${statusText(p1)}${p1.status === 200 && !isHls ? ", לא playlist" : ""}`);

  const sub = p1.head.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!sub) {
    if (p1.status === 200) record(label, "תת-playlist דרך טוקן התיקייה → 200", "נכשל", "אין שורת variant ב-playlist");
  } else {
    const s1 = await probe(ps.url.replace(/playlist\.m3u8$/, sub));
    record(label, "תת-playlist דרך טוקן התיקייה → 200", probeResult(s1, s1.status === 200), `${statusText(s1)} …/${sub}`);
  }

  const dp = await probe(`https://player.mediadelivery.net/play/${lib}/${guid}`);
  record(label, "Direct Play חסום", probeResult(dp, dp.status !== 200),
    dp.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : statusText(dp));

  const em = await probe(`https://player.mediadelivery.net/embed/${lib}/${guid}`);
  record(label, "Embed בלי טוקן חסום", probeResult(em, em.status !== 200),
    em.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : statusText(em));
}

/** Delete + confirm gone, both with retries. Never throws. */
export async function removeVideo(label: string, guid: string, record: Recorder, check = "מחיקה"): Promise<void> {
  try {
    const d = await withRetry("מחיקה", () => deleteVideo(guid));
    const gone = (await withRetry("בדיקת מחיקה", () => getVideo(guid))) === null;
    record(label, check, gone ? "עבר" : "נכשל", `${"alreadyGone" in d && d.alreadyGone ? "כבר לא היה" : "נמחק"}${gone ? "" : " — אבל עדיין נקרא"}`);
    if (!gone) console.log(`  ⚠️ מחק ידנית בדשבורד: ${guid}`);
  } catch (e) {
    record(label, check, "נכשל", `${describeError(e)} — מחק ידנית בדשבורד: ${guid}`);
  }
}

/**
 * Bunny's originalHash vs Drive's sha256Checksum. Bunny documents originalHash
 * as the original's SHA256 but not its encoding, so hex and base64 are both
 * accepted and normalised to lowercase hex before comparing.
 */
export function compareHashes(driveSha256: string | null | undefined, bunnyHash: string | null | undefined):
  { verdict: "זהה" | "לא זהה" | "לא ניתן להשוואה"; detail: string } {
  const toHex = (h: string): string | null => {
    const s = h.trim();
    if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
    try {
      const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      if (b.length === 32) return b.toString("hex");
    } catch {
      /* not base64 */
    }
    return null;
  };
  if (!driveSha256) return { verdict: "לא ניתן להשוואה", detail: "ל-Drive אין sha256Checksum לקובץ" };
  if (!bunnyHash) return { verdict: "לא ניתן להשוואה", detail: "Bunny לא החזיר originalHash" };
  const d = toHex(driveSha256);
  const b = toHex(bunnyHash);
  if (!d || !b) return { verdict: "לא ניתן להשוואה", detail: `פורמט לא מזוהה (drive=${driveSha256.slice(0, 12)}…, bunny=${bunnyHash.slice(0, 12)}…)` };
  return d === b
    ? { verdict: "זהה", detail: `sha256 ${d.slice(0, 16)}…` }
    : { verdict: "לא זהה", detail: `drive ${d.slice(0, 16)}… ≠ bunny ${b.slice(0, 16)}…` };
}
