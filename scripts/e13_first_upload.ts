/**
 * E13-2 — the FIRST real upload to Bunny, over TUS (the path the drawer will
 * use): one video file + one audio file, checked end to end, then deleted.
 * THE OWNER RUNS THIS, not Claude.
 *
 * Run (dry run — the default; sends NOTHING to Bunny, logs what it would send):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_first_upload.ts --video ./test.mp4 --audio ./test.mp3
 * Run (for real):
 *   … --live                 refused unless .env.local itself says BUNNY_DRY_RUN=false
 *   … --live --resume-test   the video upload is cut at ~30%, paused, and resumed;
 *                            the table says from which byte it continued
 *   … --live --put-probe     ALSO tries the old single-PUT upload of the video once,
 *                            only to record why it failed (full error cause); not a product path
 *   … --video-only           video only; --audio not needed (Q1 = "not checked")
 *   … --keep                 do NOT delete at the end; prints the guids to check in the dashboard
 *
 * RESULTS: עבר / נכשל / דילוג (dry-run, --keep) / לא נבדק — a check that never
 * got to run, or got no HTTP answer even after retries, is "לא נבדק", never
 * "נכשל". Q1 and Q5 follow the same three states.
 * Network failures on status reads, CDN/player probes and the delete are
 * retried 5 times with backoff (2s…32s) before they count.
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Bunny, with --live only: creates one video object per file, uploads over
 *     TUS (https://video.bunnycdn.com/tusupload) with the SAME signature
 *     (tusUploadAuthorization) and options (lib/bunny/tus.ts) the drawer will
 *     use, reads status, makes HTTP GETs against the CDN and the player, and
 *     DELETES every video it created at the end — also when a check fails.
 *   · Our database: NOTHING.
 *
 * ═══ THE CHECKS, per file ═══
 *   create · TUS upload (progress %, retries on network errors) · [video, with
 *   --resume-test: continues from the cut, not from 0] · status 4 ·
 *   hasOriginal + originalHash · /original without token → 403 (Q5) · /original
 *   signed → 200/206 · playlist without token → 403 · playlist signed → 200 ·
 *   sub-playlist through the directory token → 200 · Direct Play blocked ·
 *   Embed without token blocked · delete.
 *   Q1 (audio): the audio file reaches Finished and plays through a signed playlist.
 *
 * A failure in one file never stops the other, and the table is ALWAYS printed,
 * with the full error (cause chain included) in the detail column.
 * Every request without a token carries the ALLOWED Referer, so a 403 is the
 * token's doing — not the referrer rule's.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Upload } from "tus-js-client";
import {
  BunnyError,
  BunnyNetworkError,
  createVideo,
  deleteVideo,
  getVideo,
  tusUploadAuthorization,
  uploadVideo,
  type TusAuthorization,
} from "../src/lib/bunny/client";
import { describeError } from "../src/lib/bunny/errors";
import { signedOriginalUrl, signedPlaybackUrl } from "../src/lib/bunny/sign";
import type { BunnyVideo } from "../src/lib/bunny/status";
import { bunnyTusOptions, shouldRetryTusStatus, TUS_CHUNK_SIZE, TUS_RETRY_DELAYS } from "../src/lib/bunny/tus";

// ── test-only overrides (scripts/test_e13_first_upload.ts). None of them can
//    turn a dry run live: --live still needs the env FILE to say false. ──────
const T = {
  envFile: () => process.env.E13_FIRST_UPLOAD_ENV_FILE ?? join(__dirname, "..", ".env.local"),
  pollMs: () => Number(process.env.E13_FIRST_UPLOAD_POLL_MS ?? 10_000),
  tusEndpoint: () => process.env.E13_FIRST_UPLOAD_TUS_ENDPOINT,
  resumePauseMs: () => Number(process.env.E13_FIRST_UPLOAD_RESUME_PAUSE_MS ?? 5_000),
  backoffBaseMs: () => Number(process.env.E13_FIRST_UPLOAD_BACKOFF_MS ?? 2_000),
  waitMaxMs: () => Number(process.env.E13_FIRST_UPLOAD_WAIT_MAX_MS ?? 30 * 60_000),
  tusRetryDelays: (): number[] | undefined =>
    process.env.E13_FIRST_UPLOAD_TUS_RETRY_DELAYS ? JSON.parse(process.env.E13_FIRST_UPLOAD_TUS_RETRY_DELAYS) : undefined,
};

function loadEnvFile(): Record<string, string> {
  const envFile: Record<string, string> = {};
  for (const line of readFileSync(T.envFile(), "utf-8").split("\n")) {
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

const REFERER = "https://bizi-tech-and-invoice.vercel.app/";
const HTTP_TIMEOUT_MS = 20_000;
const RESUME_AT = 0.3;
const MB = 1024 * 1024;

type Result = "עבר" | "נכשל" | "דילוג" | "לא נבדק";
export type Row = { file: string; check: string; result: Result; detail: string };
let rows: Row[] = [];
const record = (file: string, check: string, result: Result, detail = "") => {
  rows.push({ file, check, result, detail });
  const icon = result === "עבר" ? "✅" : result === "נכשל" ? "❌" : result === "לא נבדק" ? "⬜" : "⏭️";
  console.log(`  ${icon} [${file}] ${check}${detail ? ` — ${detail}` : ""}`);
};

class Refused extends Error {}
function fail(msg: string): never {
  throw new Refused(msg);
}

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".avi": "video/x-msvideo", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
};
const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

// ── TUS ─────────────────────────────────────────────────────────────────────
export type TusRun = {
  ok: boolean;
  error?: string;
  retries: number;
  seconds: number;
  resume?: { abortedAt: number; resumedFrom: number | null };
};

/**
 * One TUS upload from disk with the drawer's options. The file is re-read by
 * offset (tus FileSource), so memory stays at ~one chunk whatever the size.
 * `resumeAt` (0–1): after the first acknowledged chunk at or past it, abort,
 * wait `resumePauseMs`, start again, and capture the offset the server's HEAD
 * reports — the proof that it continued rather than restarted.
 */
export function runTusUpload(
  path: string,
  auth: TusAuthorization,
  opts: {
    title: string;
    filetype: string;
    chunkSize?: number;
    retryDelays?: number[];
    resumeAt?: number;
    resumePauseMs?: number;
    log?: (line: string) => void;
  }
): Promise<TusRun> {
  const size = statSync(path).size;
  const log = opts.log ?? ((l: string) => console.log(l));
  const started = Date.now();
  let retries = 0;
  let lastPct = -1;
  let abortedAt: number | null = null;
  let awaitingHead = false;
  let resumedFrom: number | null = null;

  return new Promise<TusRun>((done) => {
    const finish = (r: Omit<TusRun, "retries" | "seconds" | "resume">) =>
      done({
        ...r,
        retries,
        seconds: Math.round((Date.now() - started) / 1000),
        resume: abortedAt === null ? undefined : { abortedAt, resumedFrom },
      });

    const upload: Upload = new Upload(
      createReadStream(path),
      bunnyTusOptions(
        auth,
        { filetype: opts.filetype, title: opts.title },
        {
          uploadSize: size,
          chunkSize: opts.chunkSize ?? TUS_CHUNK_SIZE,
          retryDelays: opts.retryDelays ?? TUS_RETRY_DELAYS,
          onProgress: (sent, total) => {
            const pct = Math.floor((sent / total) * 100);
            if (pct >= lastPct + 10 || pct === 100) {
              lastPct = pct - (pct % 10);
              log(`     העלאה ${pct}% (${(sent / MB).toFixed(1)}/${(total / MB).toFixed(1)}MB)`);
            }
          },
          onChunkComplete: (_chunk, accepted, total) => {
            if (opts.resumeAt === undefined || abortedAt !== null || accepted >= total) return;
            if (accepted / total < opts.resumeAt) return;
            abortedAt = accepted;
            log(`     ✂️  ניתוק יזום ב-${((accepted / total) * 100).toFixed(1)}% (${accepted} בתים אושרו); ממשיך בעוד ${opts.resumePauseMs ?? 0}ms`);
            void upload.abort().then(() =>
              setTimeout(() => {
                awaitingHead = true;
                upload.start();
              }, opts.resumePauseMs ?? 0)
            );
          },
          onAfterResponse: (req, res) => {
            if (awaitingHead && req.getMethod() === "HEAD") {
              awaitingHead = false;
              const off = Number(res.getHeader("Upload-Offset"));
              resumedFrom = Number.isFinite(off) ? off : null;
              log(`     ↩️  השרת דיווח Upload-Offset=${res.getHeader("Upload-Offset")} — ממשיך משם`);
            }
          },
          onShouldRetry: (err, attempt) => {
            const status = err.originalResponse?.getStatus();
            const retry = shouldRetryTusStatus(status);
            if (retry) {
              retries++;
              log(`     🔁 ניסיון חוזר ${attempt + 1} (${status ? `HTTP ${status}` : "שגיאת רשת"}): ${describeError(err)}`);
            }
            return retry;
          },
          onSuccess: () => finish({ ok: true }),
          onError: (err) => finish({ ok: false, error: describeError(err) }),
        }
      )
    );
    upload.start();
  });
}

// ── retries for the checks AROUND the upload (owner 15.10: the first live run
//    lost a whole video to one ConnectTimeoutError on a status read). A network
//    failure — or a 5xx — is retried RETRIES times with exponential backoff
//    before it counts. A clean HTTP answer (403, 404, 401…) is a result, never
//    retried. TUS has its own retries (lib/bunny/tus.ts). ──────────────────────
const RETRIES = 5;
const backoffMs = (attempt: number) => T.backoffBaseMs() * 2 ** attempt; // 2s, 4s, 8s, 16s, 32s

const isRetryable = (e: unknown) =>
  e instanceof BunnyNetworkError || (e instanceof BunnyError && e.status >= 500);

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
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
type Probe = { status: number; head: string; error?: string; attempts: number };
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
async function probe(url: string, opts: { range?: boolean } = {}): Promise<Probe> {
  for (let attempt = 0; ; attempt++) {
    const p = await probeOnce(url, opts);
    if ((p.status !== -1 && p.status < 500) || attempt >= RETRIES) return { ...p, attempts: attempt + 1 };
    const wait = backoffMs(attempt);
    console.log(`     🔁 ${pathOnly(url)}: ניסיון חוזר ${attempt + 1}/${RETRIES} בעוד ${wait}ms — ${p.status === -1 ? p.error : `HTTP ${p.status}`}`);
    await new Promise((r) => setTimeout(r, wait));
  }
}
/** A probe that never got an HTTP answer is "not checked", not a verdict. */
const probeResult = (p: Probe, pass: boolean): Result => (p.status === -1 ? "לא נבדק" : pass ? "עבר" : "נכשל");
const statusText = (p: Probe) =>
  (p.status === -1 ? `שגיאת רשת אחרי ${p.attempts} ניסיונות: ${p.error}` : `HTTP ${p.status}`) +
  (p.status !== -1 && p.attempts > 1 ? ` (אחרי ${p.attempts} ניסיונות)` : "");

const pathOnly = (u: string) => new URL(u).pathname.replace(/bcdn_token=[^/]*/, "bcdn_token=…");

/** Bunny status until a terminal state or WAIT_MAX_MS. Each read is retried. */
async function waitFinished(guid: string): Promise<{ video: BunnyVideo | null; timedOut: boolean }> {
  const start = Date.now();
  let last = -1;
  let v: BunnyVideo | null = null;
  while (Date.now() - start < T.waitMaxMs()) {
    v = await withRetry("קריאת סטטוס", () => getVideo(guid));
    if (!v) return { video: null, timedOut: false };
    if (v.status !== last) {
      console.log(`     status ${v.status} (encodeProgress ${v.encodeProgress ?? "?"}%)`);
      last = v.status;
    }
    if (v.status === 4 || v.status === 5 || v.status === 6) return { video: v, timedOut: false };
    await new Promise((r) => setTimeout(r, T.pollMs()));
  }
  return { video: v, timedOut: true };
}

const CHECKS_AFTER_UPLOAD = [
  "status 4", "hasOriginal + originalHash", "/original בלי טוקן → 403", "/original חתום → 200",
  "playlist בלי טוקן → 403", "playlist חתום → 200", "תת-playlist דרך טוקן התיקייה → 200",
  "Direct Play חסום", "Embed בלי טוקן חסום",
];

type Flags = { resumeTest: boolean; keep: boolean };
const kept: { label: string; guid: string }[] = [];

async function runOne(label: string, path: string, flags: Flags): Promise<void> {
  const size = statSync(path).size;
  console.log(`\n── ${label}: ${path} (${(size / MB).toFixed(1)}MB, ${mimeOf(path)})`);
  const wantResume = flags.resumeTest && label === "וידאו";
  const planned = ["יצירת וידאו", "העלאת TUS", ...(wantResume ? ["המשך אחרי ניתוק"] : []), ...CHECKS_AFTER_UPLOAD];

  let guid: string | null = null;
  let step = "יצירת וידאו";
  let stoppedAt: string | null = null;
  try {
    const created = await createVideo(`E13-2 בדיקה ראשונה — ${label} — ${new Date().toISOString()}`);
    if ("dryRun" in created && created.dryRun) {
      record(label, "יצירת וידאו", "דילוג", "dry-run: נרשם בלוג, לא נשלח");
      const auth = tusUploadAuthorization("00000000-0000-4000-8000-000000000000");
      record(label, "העלאת TUS", "דילוג", `dry-run: ${auth === null ? "אין חתימה במצב יבש" : "?"}; חתיכות של ${TUS_CHUNK_SIZE / MB}MB`);
      if (wantResume) record(label, "המשך אחרי ניתוק", "דילוג", "dry-run");
      for (const c of [...CHECKS_AFTER_UPLOAD, "מחיקה"]) record(label, c, "דילוג", "dry-run");
      return;
    }
    guid = created.video.guid;
    record(label, "יצירת וידאו", "עבר", `guid ${guid}`);

    step = "העלאת TUS";
    const signed = tusUploadAuthorization(guid);
    if (!signed) throw new Error("tusUploadAuthorization החזירה null — BUNNY_DRY_RUN דלוק?");
    const auth: TusAuthorization = { ...signed, endpoint: T.tusEndpoint() ?? signed.endpoint };
    const up = await runTusUpload(path, auth, {
      title: `E13-2 ${label}`,
      filetype: mimeOf(path),
      // the resume test needs several chunks before 30%; the product default is 50MB
      chunkSize: wantResume ? Math.max(1 * MB, Math.min(TUS_CHUNK_SIZE, Math.ceil(size / 10))) : TUS_CHUNK_SIZE,
      retryDelays: T.tusRetryDelays(),
      resumeAt: wantResume ? RESUME_AT : undefined,
      resumePauseMs: T.resumePauseMs(),
    });
    const mbps = up.seconds > 0 ? ((size * 8) / 1e6 / up.seconds).toFixed(2) : "?";
    const upDetail = `${(size / MB).toFixed(1)}MB ב-${up.seconds}s (~${mbps}Mbps), ${up.retries} ניסיונות חוזרים`;
    record(label, "העלאת TUS", up.ok ? "עבר" : "נכשל", up.ok ? upDetail : `${upDetail} — ${up.error}`);
    if (wantResume) {
      const r = up.resume;
      if (!r) record(label, "המשך אחרי ניתוק", up.ok ? "נכשל" : "לא נבדק", up.ok ? "הניתוק היזום לא קרה (קובץ קטן מדי לחתיכות?)" : "ההעלאה נכשלה לפני נקודת הניתוק");
      else {
        const okResume = r.resumedFrom !== null && r.resumedFrom > 0 && r.resumedFrom >= r.abortedAt;
        record(label, "המשך אחרי ניתוק", okResume && up.ok ? "עבר" : "נכשל",
          `נותק אחרי ${r.abortedAt} בתים (${((r.abortedAt / size) * 100).toFixed(1)}%), המשיך מ-${r.resumedFrom ?? "?"}${r.resumedFrom === 0 ? " — התחיל מאפס!" : ""}`);
      }
    }
    if (!up.ok) {
      stoppedAt = "העלאת TUS נכשלה";
      return;
    }

    step = "status 4";
    const { video: v, timedOut } = await waitFinished(guid);
    if (!v) {
      record(label, "status 4", "נכשל", "הווידאו לא נמצא");
      stoppedAt = "status 4";
      return;
    }
    if (v.status !== 4) {
      // still encoding when time ran out is NOT a verdict — Free Encoding can
      // queue for hours (Bunny docs). 5/6 are real failures.
      const failedEnc = v.status === 5 || v.status === 6;
      record(label, "status 4", failedEnc ? "נכשל" : "לא נבדק",
        failedEnc ? `Bunny סימן כשל (status ${v.status})` : `עדיין בעיבוד אחרי ${Math.round(T.waitMaxMs() / 60000)} דקות (status ${v.status}, encodeProgress ${v.encodeProgress ?? "?"}%)${timedOut ? " — Free Encoding יכול להמתין שעות; הרץ עם --keep ובדוק בדשבורד" : ""}`);
      stoppedAt = failedEnc ? "הקידוד נכשל" : "הקידוד לא הסתיים בזמן";
      return;
    }
    record(label, "status 4", "עבר", `length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}, resolutions "${v.availableResolutions ?? ""}"`);

    const hasOrig = v.hasOriginal === true && !!(v.originalHash ?? "").trim();
    record(label, "hasOriginal + originalHash", hasOrig ? "עבר" : "נכשל", `hasOriginal=${v.hasOriginal}, originalHash=${v.originalHash ? "קיים" : "חסר"}`);

    step = "בדיקות CDN";
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
  } catch (e) {
    // no answer even after the retries → no verdict on this step
    record(label, step, isRetryable(e) ? "לא נבדק" : "נכשל", `${isRetryable(e) ? `אין תשובה אחרי ${RETRIES} ניסיונות חוזרים: ` : ""}${describeError(e)}`);
    stoppedAt = step;
  } finally {
    // every planned check that never ran is "not checked" — never "failed"
    for (const c of planned) {
      if (!rows.some((r) => r.file === label && r.check === c)) {
        record(label, c, "לא נבדק", `לא הגיע לרוץ${stoppedAt ? `: ${stoppedAt}` : ""}`);
      }
    }
    if (guid) {
      if (flags.keep) {
        kept.push({ label, guid });
        record(label, "מחיקה", "דילוג", `--keep: הווידאו נשאר בספרייה — guid ${guid}`);
      } else await removeVideo(label, guid);
    }
  }
}

async function removeVideo(label: string, guid: string, check = "מחיקה") {
  try {
    const d = await withRetry("מחיקה", () => deleteVideo(guid));
    const gone = (await withRetry("בדיקת מחיקה", () => getVideo(guid))) === null;
    record(label, check, gone ? "עבר" : "נכשל", `${"alreadyGone" in d && d.alreadyGone ? "כבר לא היה" : "נמחק"}${gone ? "" : " — אבל עדיין נקרא"}`);
    if (!gone) console.log(`  ⚠️ מחק ידנית בדשבורד: ${guid}`);
  } catch (e) {
    record(label, check, "נכשל", `${describeError(e)} — מחק ידנית בדשבורד: ${guid}`);
  }
}

/** --put-probe: the old single PUT, once, to record WHY it failed. Documentation only. */
async function putProbe(path: string, flags: Flags) {
  const label = "PUT probe";
  const size = statSync(path).size;
  if (size > 1024 * MB) {
    record(label, "PUT בודד (תיעוד)", "דילוג", "קובץ מעל 1GB — PUT טוען הכול לזיכרון");
    return;
  }
  let guid: string | null = null;
  try {
    const created = await createVideo(`E13-2 PUT probe — ${new Date().toISOString()}`);
    if ("dryRun" in created && created.dryRun) {
      record(label, "PUT בודד (תיעוד)", "דילוג", "dry-run");
      return;
    }
    guid = created.video.guid;
    const t0 = Date.now();
    try {
      await uploadVideo(guid, readFileSync(path));
      record(label, "PUT בודד (תיעוד)", "עבר", `${(size / MB).toFixed(1)}MB ב-${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      record(label, "PUT בודד (תיעוד)", "נכשל", `אחרי ${Math.round((Date.now() - t0) / 1000)}s — ${describeError(e)}`);
    }
  } catch (e) {
    record(label, "PUT בודד (תיעוד)", "נכשל", describeError(e));
  } finally {
    if (guid) {
      if (flags.keep) {
        kept.push({ label, guid });
        record(label, "מחיקה", "דילוג", `--keep: guid ${guid}`);
      } else await removeVideo(label, guid);
    }
  }
}

function printTable() {
  if (!rows.length) return;
  console.log("\n═══ סיכום ═══");
  console.log("| קובץ | בדיקה | תוצאה | פרט |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.file} | ${r.check} | ${r.result} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
}

/** Three-state verdict from rows: any failure → failed; all passed → passed; else not checked. */
export function verdict(results: (Result | undefined)[]): "עבר" | "נכשל" | "לא נבדק" {
  if (results.some((r) => r === "נכשל")) return "נכשל";
  if (results.length && results.every((r) => r === "עבר")) return "עבר";
  return "לא נבדק";
}
const resultOf = (file: string, check: string) => rows.find((r) => r.file === file && r.check === check)?.result;

/** Returns the rows; throws Refused before any request when a guard says no. */
export async function main(args: string[]): Promise<Row[]> {
  rows = [];
  kept.length = 0;
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const LIVE = args.includes("--live");
  const VIDEO_ONLY = args.includes("--video-only");
  const envFile = loadEnvFile();
  const video = arg("--video");
  const audio = VIDEO_ONLY ? undefined : arg("--audio");
  if (!video) fail("חסר --video <נתיב>");
  if (!VIDEO_ONLY && !audio) fail("חסר --audio <נתיב> (או --video-only)");
  for (const f of [video, ...(audio ? [audio] : [])]) {
    if (!existsSync(f) || !statSync(f).isFile()) fail(`הקובץ לא קיים: ${f}`);
    if (statSync(f).size === 0) fail(`הקובץ ריק: ${f}`);
  }

  if (LIVE) {
    if (envFile.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ב-.env.local חייב להופיע BUNNY_DRY_RUN=false");
    if (process.env.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ה-shell דורס את BUNNY_DRY_RUN בערך אחר");
  } else {
    process.env.BUNNY_DRY_RUN = "true"; // dry run no matter what the file or shell says
  }

  const need = ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_CDN_HOSTNAME", "BUNNY_CDN_TOKEN_KEY"];
  const missing = need.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length) fail(`חסרים ב-.env.local: ${missing.join(", ")}`);

  console.log(LIVE ? "🔴 ריצה אמיתית מול Bunny (TUS)" : "🟢 dry-run — שום בקשה כותבת לא יוצאת ל-Bunny");
  const flags: Flags = { resumeTest: args.includes("--resume-test"), keep: args.includes("--keep") };
  try {
    await runOne("וידאו", resolve(video), flags);
    if (audio) await runOne("אודיו", resolve(audio), flags);
    if (args.includes("--put-probe")) await putProbe(resolve(video), flags);
  } finally {
    printTable();
  }

  if (LIVE) {
    const q1 = audio
      ? verdict([resultOf("אודיו", "status 4"), resultOf("אודיו", "playlist חתום → 200")])
      : "לא נבדק";
    const files = ["וידאו", ...(audio ? ["אודיו"] : [])];
    const q5 = verdict(files.map((f) => resultOf(f, "/original בלי טוקן → 403")));
    const q1Text = { "עבר": "עבר — האודיו קודד ומתנגן דרך playlist חתום", "נכשל": "נכשל — פריטי אודיו נשארים במסלול Drive עד הכרעה", "לא נבדק": audio ? "לא נבדק — הבדיקה לא הגיעה לרוץ (ראה את הטבלה)" : "לא נבדק — --video-only" }[q1];
    const q5Text = { "עבר": "עבר — בלי טוקן מתקבל 403", "נכשל": "נכשל — להסתיר את כפתור ההורדה ולחזור לבעלים", "לא נבדק": "לא נבדק — הבדיקה לא הגיעה לרוץ (ראה את הטבלה)" }[q5];
    console.log(`\nQ1 (אודיו טהור ב-Bunny): ${q1Text}`);
    console.log(`Q5 (/original מכוסה בטוקן): ${q5Text}`);
    if (kept.length) {
      console.log("\n--keep — נשארו בספרייה (למחוק ידנית בדשבורד אחרי הבדיקה):");
      for (const k of kept) console.log(`  ${k.label}: ${k.guid}`);
    }
  } else {
    console.log("\nQ1 / Q5: דילוג (dry-run). להרצה אמיתית: --live, עם BUNNY_DRY_RUN=false ב-.env.local");
  }
  return rows;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => {
      // non-zero when anything failed OR never reached a verdict
      if (r.some((x) => x.result === "נכשל" || x.result === "לא נבדק")) process.exit(1);
    })
    .catch((e) => {
      console.error("❌", describeError(e));
      process.exit(1);
    });
}
