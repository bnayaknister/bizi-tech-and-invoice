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
import { createVideo, deleteVideo, getVideo, tusUploadAuthorization, uploadVideo, type TusAuthorization } from "../src/lib/bunny/client";
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
const WAIT_MAX_MS = 30 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;
const RESUME_AT = 0.3;
const MB = 1024 * 1024;

type Result = "עבר" | "נכשל" | "דילוג";
export type Row = { file: string; check: string; result: Result; detail: string };
let rows: Row[] = [];
const record = (file: string, check: string, result: Result, detail = "") => {
  rows.push({ file, check, result, detail });
  const icon = result === "עבר" ? "✅" : result === "נכשל" ? "❌" : "⏭️";
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

// ── HTTP probes (never throw: a network error is a result) ──────────────────
async function probe(url: string, opts: { range?: boolean } = {}): Promise<{ status: number; head: string; error?: string }> {
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
const statusText = (p: { status: number; error?: string }) => (p.status === -1 ? `שגיאת רשת: ${p.error}` : `HTTP ${p.status}`);

const pathOnly = (u: string) => new URL(u).pathname.replace(/bcdn_token=[^/]*/, "bcdn_token=…");

async function waitFinished(guid: string): Promise<BunnyVideo | null> {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < WAIT_MAX_MS) {
    const v = await getVideo(guid);
    if (!v) return null;
    if (v.status !== last) {
      console.log(`     status ${v.status} (encodeProgress ${v.encodeProgress ?? "?"}%)`);
      last = v.status;
    }
    if (v.status === 4 || v.status === 5 || v.status === 6) return v;
    await new Promise((r) => setTimeout(r, T.pollMs()));
  }
  return getVideo(guid);
}

const DRY_CHECKS = [
  "status 4", "hasOriginal + originalHash", "/original בלי טוקן → 403", "/original חתום → 200",
  "playlist בלי טוקן → 403", "playlist חתום → 200", "תת-playlist דרך טוקן התיקייה → 200",
  "Direct Play חסום", "Embed בלי טוקן חסום", "מחיקה",
];

type FileOutcome = { finished: boolean; signedPlays: boolean; originalBlocked: boolean };

async function runOne(label: string, path: string, flags: { resumeTest: boolean }): Promise<FileOutcome> {
  const out: FileOutcome = { finished: false, signedPlays: false, originalBlocked: false };
  const size = statSync(path).size;
  console.log(`\n── ${label}: ${path} (${(size / MB).toFixed(1)}MB, ${mimeOf(path)})`);
  const wantResume = flags.resumeTest && label === "וידאו";

  let guid: string | null = null;
  let step = "יצירת וידאו";
  try {
    const created = await createVideo(`E13-2 בדיקה ראשונה — ${label} — ${new Date().toISOString()}`);
    if ("dryRun" in created && created.dryRun) {
      record(label, "יצירת וידאו", "דילוג", "dry-run: נרשם בלוג, לא נשלח");
      const auth = tusUploadAuthorization("00000000-0000-4000-8000-000000000000");
      record(label, "העלאת TUS", "דילוג", `dry-run: ${auth === null ? "אין חתימה במצב יבש" : "?"}; חתיכות של ${TUS_CHUNK_SIZE / MB}MB`);
      if (wantResume) record(label, "המשך אחרי ניתוק", "דילוג", "dry-run");
      for (const c of DRY_CHECKS) record(label, c, "דילוג", "dry-run");
      return out;
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
      resumeAt: wantResume ? RESUME_AT : undefined,
      resumePauseMs: T.resumePauseMs(),
    });
    const upDetail = `${(size / MB).toFixed(1)}MB ב-${up.seconds}s, ${up.retries} ניסיונות חוזרים`;
    record(label, "העלאת TUS", up.ok ? "עבר" : "נכשל", up.ok ? upDetail : `${upDetail} — ${up.error}`);
    if (wantResume) {
      const r = up.resume;
      if (!r) record(label, "המשך אחרי ניתוק", "נכשל", "הניתוק היזום לא קרה (קובץ קטן מדי לחתיכות?)");
      else {
        const okResume = r.resumedFrom !== null && r.resumedFrom > 0 && r.resumedFrom >= r.abortedAt;
        record(label, "המשך אחרי ניתוק", okResume && up.ok ? "עבר" : "נכשל",
          `נותק אחרי ${r.abortedAt} בתים (${((r.abortedAt / size) * 100).toFixed(1)}%), המשיך מ-${r.resumedFrom ?? "?"}${r.resumedFrom === 0 ? " — התחיל מאפס!" : ""}`);
      }
    }
    if (!up.ok) return out;

    step = "status 4";
    const v = await waitFinished(guid);
    if (!v || v.status !== 4) {
      record(label, "status 4", "נכשל", v ? `נעצר ב-status ${v.status}` : "הווידאו לא נמצא");
      return out;
    }
    out.finished = true;
    record(label, "status 4", "עבר", `length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}, resolutions "${v.availableResolutions ?? ""}"`);

    const hasOrig = v.hasOriginal === true && !!(v.originalHash ?? "").trim();
    record(label, "hasOriginal + originalHash", hasOrig ? "עבר" : "נכשל", `hasOriginal=${v.hasOriginal}, originalHash=${v.originalHash ? "קיים" : "חסר"}`);

    step = "בדיקות CDN";
    const host = (process.env.BUNNY_STREAM_CDN_HOSTNAME ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const lib = process.env.BUNNY_STREAM_LIBRARY_ID;

    const o0 = await probe(`https://${host}/${guid}/original`, { range: true });
    out.originalBlocked = o0.status === 403;
    record(label, "/original בלי טוקן → 403", o0.status === 403 ? "עבר" : "נכשל", statusText(o0));

    const os = signedOriginalUrl(guid, 600);
    const o1 = await probe(os.url, { range: true });
    record(label, "/original חתום → 200", o1.status === 200 || o1.status === 206 ? "עבר" : "נכשל", `${statusText(o1)} ${pathOnly(os.url)}`);

    const p0 = await probe(`https://${host}/${guid}/playlist.m3u8`);
    record(label, "playlist בלי טוקן → 403", p0.status === 403 ? "עבר" : "נכשל", statusText(p0));

    const ps = signedPlaybackUrl(guid);
    const p1 = await probe(ps.url);
    const isHls = p1.head.startsWith("#EXTM3U");
    out.signedPlays = p1.status === 200 && isHls;
    record(label, "playlist חתום → 200", out.signedPlays ? "עבר" : "נכשל", `${statusText(p1)}${p1.status === 200 && !isHls ? ", לא playlist" : ""}`);

    const sub = p1.head.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!sub) record(label, "תת-playlist דרך טוקן התיקייה → 200", "נכשל", "אין שורת variant ב-playlist");
    else {
      const s1 = await probe(ps.url.replace(/playlist\.m3u8$/, sub));
      record(label, "תת-playlist דרך טוקן התיקייה → 200", s1.status === 200 ? "עבר" : "נכשל", `${statusText(s1)} …/${sub}`);
    }

    const dp = await probe(`https://player.mediadelivery.net/play/${lib}/${guid}`);
    record(label, "Direct Play חסום", dp.status !== 200 && dp.status !== -1 ? "עבר" : "נכשל",
      dp.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : statusText(dp));

    const em = await probe(`https://player.mediadelivery.net/embed/${lib}/${guid}`);
    record(label, "Embed בלי טוקן חסום", em.status !== 200 && em.status !== -1 ? "עבר" : "נכשל",
      em.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : statusText(em));
  } catch (e) {
    record(label, step, "נכשל", describeError(e));
  } finally {
    if (guid) await removeVideo(label, guid);
  }
  return out;
}

async function removeVideo(label: string, guid: string, check = "מחיקה") {
  try {
    const d = await deleteVideo(guid);
    const gone = (await getVideo(guid)) === null;
    record(label, check, gone ? "עבר" : "נכשל", `${"alreadyGone" in d && d.alreadyGone ? "כבר לא היה" : "נמחק"}${gone ? "" : " — אבל עדיין נקרא"}`);
    if (!gone) console.log(`  ⚠️ מחק ידנית בדשבורד: ${guid}`);
  } catch (e) {
    record(label, check, "נכשל", `${describeError(e)} — מחק ידנית בדשבורד: ${guid}`);
  }
}

/** --put-probe: the old single PUT, once, to record WHY it failed. Documentation only. */
async function putProbe(path: string) {
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
    if (guid) await removeVideo(label, guid);
  }
}

function printTable() {
  if (!rows.length) return;
  console.log("\n═══ סיכום ═══");
  console.log("| קובץ | בדיקה | תוצאה | פרט |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.file} | ${r.check} | ${r.result} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
}

/** Returns the rows; throws Refused before any request when a guard says no. */
export async function main(args: string[]): Promise<Row[]> {
  rows = [];
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const LIVE = args.includes("--live");
  const envFile = loadEnvFile();
  const video = arg("--video");
  const audio = arg("--audio");
  if (!video || !audio) fail("חסר --video <נתיב> או --audio <נתיב>");
  for (const f of [video, audio]) {
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
  const flags = { resumeTest: args.includes("--resume-test") };
  let v: FileOutcome = { finished: false, signedPlays: false, originalBlocked: false };
  let a: FileOutcome = { ...v };
  try {
    v = await runOne("וידאו", resolve(video), flags);
    a = await runOne("אודיו", resolve(audio), flags);
    if (args.includes("--put-probe")) await putProbe(resolve(video));
  } finally {
    printTable();
  }

  if (LIVE) {
    const q1 = a.finished && a.signedPlays;
    const q5 = v.originalBlocked && a.originalBlocked;
    console.log(`\nQ1 (אודיו טהור ב-Bunny): ${q1 ? "עבר — האודיו קודד ומתנגן דרך playlist חתום" : "נכשל — פריטי אודיו נשארים במסלול Drive עד הכרעה"}`);
    console.log(`Q5 (/original מכוסה בטוקן): ${q5 ? "עבר — בלי טוקן מתקבל 403" : "נכשל — להסתיר את כפתור ההורדה ולחזור לבעלים"}`);
  } else {
    console.log("\nQ1 / Q5: דילוג (dry-run). להרצה אמיתית: --live, עם BUNNY_DRY_RUN=false ב-.env.local");
  }
  return rows;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((r) => {
      if (r.some((x) => x.result === "נכשל")) process.exit(1);
    })
    .catch((e) => {
      console.error("❌", describeError(e));
      process.exit(1);
    });
}
