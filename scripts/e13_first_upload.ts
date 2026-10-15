/**
 * E13-2 — the FIRST real upload to Bunny: one video file + one audio file,
 * checked end to end, then deleted. THE OWNER RUNS THIS, not Claude.
 *
 * Run (dry run — the default; sends NOTHING to Bunny, logs what it would send):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_first_upload.ts --video ./test.mp4 --audio ./test.mp3
 * Run (for real):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_first_upload.ts --video ./test.mp4 --audio ./test.mp3 --live
 *   --live is refused unless .env.local itself says BUNNY_DRY_RUN=false
 *   (and the shell does not override it with something else).
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Bunny, with --live only: creates 2 videos in the library, uploads the
 *     two files, reads their status, makes HTTP GETs against the CDN and the
 *     player, and DELETES both videos at the end (also when a check fails).
 *   · Our database: NOTHING. No version row is written; this tests Bunny only.
 *
 * ═══ THE CHECKS, per file ═══
 *   create · upload · status reaches 4 (Finished) · hasOriginal + originalHash
 *   /original  without token → 403 (Q5: the original IS covered by the token)
 *   /original  signed        → 200/206
 *   playlist   without token → 403
 *   playlist   signed        → 200, an HLS playlist
 *   sub-playlist through the directory token → 200 (HLS segments inherit it)
 *   Direct Play page   (player.mediadelivery.net/play/…)  → not 200
 *   Embed without token (player.mediadelivery.net/embed/…) → not 200
 *   delete → 2xx, then the video reads as gone
 *   Q1 (audio): the audio file reaches Finished and plays through a signed playlist.
 *
 * Every request without a token still carries the ALLOWED Referer, so a 403
 * is the token's doing — not the referrer rule's.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createVideo, deleteVideo, getVideo, uploadVideo } from "../src/lib/bunny/client";
import { signedOriginalUrl, signedPlaybackUrl } from "../src/lib/bunny/sign";
import type { BunnyVideo } from "../src/lib/bunny/status";

// ── env: remember what the FILE says, separately from the process env ──────
// E13_FIRST_UPLOAD_ENV_FILE exists only for scripts/test_e13_first_upload.ts
// (a temp file + a mocked fetch). --live still needs that file to say false.
function loadEnvFile(): Record<string, string> {
  const envFile: Record<string, string> = {};
  const path = process.env.E13_FIRST_UPLOAD_ENV_FILE ?? join(__dirname, "..", ".env.local");
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

let argv: string[] = [];
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const REFERER = "https://bizi-tech-and-invoice.vercel.app/";
const POLL_MS = Number(process.env.E13_FIRST_UPLOAD_POLL_MS ?? 10_000);
const WAIT_MAX_MS = 30 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;

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

async function probe(url: string, opts: { range?: boolean } = {}): Promise<{ status: number; head: string }> {
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
}

const pathOnly = (u: string) => {
  const url = new URL(u);
  return url.pathname.replace(/bcdn_token=[^/]*/, "bcdn_token=…");
};

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
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return getVideo(guid);
}

async function runOne(label: string, path: string): Promise<{ finished: boolean; signedPlays: boolean; originalBlocked: boolean }> {
  const out = { finished: false, signedPlays: false, originalBlocked: false };
  const bytes = readFileSync(path);
  console.log(`\n── ${label}: ${path} (${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB)`);

  const created = await createVideo(`E13-2 בדיקה ראשונה — ${label} — ${new Date().toISOString()}`);
  if ("dryRun" in created && created.dryRun) {
    record(label, "יצירת וידאו", "דילוג", "dry-run: נרשם בלוג, לא נשלח");
    const up = await uploadVideo("00000000-0000-4000-8000-000000000000", bytes);
    record(label, "העלאה", "דילוג", "dry-run: נרשם בלוג, לא נשלח" + ("dryRun" in up ? "" : ""));
    for (const c of ["status 4", "hasOriginal + originalHash", "/original בלי טוקן → 403", "/original חתום → 200",
      "playlist בלי טוקן → 403", "playlist חתום → 200", "תת-playlist דרך טוקן התיקייה → 200",
      "Direct Play חסום", "Embed בלי טוקן חסום", "מחיקה"]) record(label, c, "דילוג", "dry-run");
    return out;
  }
  const guid = created.video.guid;
  record(label, "יצירת וידאו", "עבר", `guid ${guid}`);

  try {
    await uploadVideo(guid, bytes);
    record(label, "העלאה", "עבר");

    const v = await waitFinished(guid);
    if (!v || v.status !== 4) {
      record(label, "status 4", "נכשל", v ? `נעצר ב-status ${v.status}` : "הווידאו לא נמצא");
      return out;
    }
    out.finished = true;
    record(label, "status 4", "עבר", `length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}, resolutions "${v.availableResolutions ?? ""}"`);

    const hasOrig = v.hasOriginal === true && !!(v.originalHash ?? "").trim();
    record(label, "hasOriginal + originalHash", hasOrig ? "עבר" : "נכשל",
      `hasOriginal=${v.hasOriginal}, originalHash=${v.originalHash ? "קיים" : "חסר"}`);

    const host = (process.env.BUNNY_STREAM_CDN_HOSTNAME ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
    const lib = process.env.BUNNY_STREAM_LIBRARY_ID;

    const o0 = await probe(`https://${host}/${guid}/original`, { range: true });
    out.originalBlocked = o0.status === 403;
    record(label, "/original בלי טוקן → 403", o0.status === 403 ? "עבר" : "נכשל", `HTTP ${o0.status}`);

    const os = signedOriginalUrl(guid, 600);
    const o1 = await probe(os.url, { range: true });
    record(label, "/original חתום → 200", o1.status === 200 || o1.status === 206 ? "עבר" : "נכשל", `HTTP ${o1.status} ${pathOnly(os.url)}`);

    const p0 = await probe(`https://${host}/${guid}/playlist.m3u8`);
    record(label, "playlist בלי טוקן → 403", p0.status === 403 ? "עבר" : "נכשל", `HTTP ${p0.status}`);

    const ps = signedPlaybackUrl(guid);
    const p1 = await probe(ps.url);
    const isHls = p1.head.startsWith("#EXTM3U");
    out.signedPlays = p1.status === 200 && isHls;
    record(label, "playlist חתום → 200", out.signedPlays ? "עבר" : "נכשל", `HTTP ${p1.status}${p1.status === 200 && !isHls ? ", לא playlist" : ""}`);

    const sub = p1.head.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    if (!sub) record(label, "תת-playlist דרך טוקן התיקייה → 200", "נכשל", "אין שורת variant ב-playlist");
    else {
      const subUrl = ps.url.replace(/playlist\.m3u8$/, sub);
      const s1 = await probe(subUrl);
      record(label, "תת-playlist דרך טוקן התיקייה → 200", s1.status === 200 ? "עבר" : "נכשל", `HTTP ${s1.status} …/${sub}`);
    }

    const dp = await probe(`https://player.mediadelivery.net/play/${lib}/${guid}`);
    record(label, "Direct Play חסום", dp.status !== 200 ? "עבר" : "נכשל",
      dp.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : `HTTP ${dp.status}`);

    const em = await probe(`https://player.mediadelivery.net/embed/${lib}/${guid}`);
    record(label, "Embed בלי טוקן חסום", em.status !== 200 ? "עבר" : "נכשל",
      em.status === 200 ? "HTTP 200 — פתח בדפדפן ובדוק אם הנגן מנגן" : `HTTP ${em.status}`);
  } finally {
    try {
      const d = await deleteVideo(guid);
      const gone = (await getVideo(guid)) === null;
      record(label, "מחיקה", gone ? "עבר" : "נכשל", `${"alreadyGone" in d && d.alreadyGone ? "כבר לא היה" : "נמחק"}${gone ? "" : " — אבל עדיין נקרא"}`);
      if (!gone) console.log(`  ⚠️ מחק ידנית בדשבורד: ${guid}`);
    } catch (e) {
      record(label, "מחיקה", "נכשל", e instanceof Error ? e.message : String(e));
      console.log(`  ⚠️ מחק ידנית בדשבורד: ${guid}`);
    }
  }
  return out;
}

/** Returns the rows; throws Refused before any request when a guard says no. */
export async function main(args: string[]): Promise<Row[]> {
  argv = args;
  rows = [];
  const LIVE = argv.includes("--live");
  const envFile = loadEnvFile();
  const video = arg("--video");
  const audio = arg("--audio");
  if (!video || !audio) fail("חסר --video <נתיב> או --audio <נתיב>");
  for (const f of [video, audio]) {
    if (!existsSync(f) || !statSync(f).isFile()) fail(`הקובץ לא קיים: ${f}`);
    if (statSync(f).size === 0) fail(`הקובץ ריק: ${f}`);
    if (statSync(f).size > 1024 * 1024 * 1024) fail(`הקובץ גדול מ-1GB: ${f} — לבדיקה הזו מספיק קובץ קצר`);
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

  console.log(LIVE ? "🔴 ריצה אמיתית מול Bunny" : "🟢 dry-run — שום בקשה כותבת לא יוצאת ל-Bunny");
  const v = await runOne("וידאו", resolve(video));
  const a = await runOne("אודיו", resolve(audio));

  console.log("\n═══ סיכום ═══");
  console.log("| קובץ | בדיקה | תוצאה | פרט |");
  console.log("|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.file} | ${r.check} | ${r.result} | ${r.detail.replace(/\|/g, "/")} |`);

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
      console.error("❌", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
