/**
 * E13 — route A test (research 15.10): the technician uploads to Google Drive as
 * today, and Bunny PULLS the file from the Drive API itself, server to server.
 * A test script only — no app code calls this, nothing is written to our DB.
 * THE OWNER RUNS THIS, not Claude.
 *
 * Run (dry run — the default; reads Drive metadata, sends NOTHING to Bunny):
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/e13_drive_fetch_test.ts --drive-url "https://drive.google.com/file/d/<id>/view"
 * Run for real (refused unless .env.local itself says BUNNY_DRY_RUN=false):
 *   … --live                    fetch, wait for the file, wait for encoding (up to 6h), check access, delete
 *   … --live --no-wait-encode   stop as soon as Bunny has the whole file
 *   … --live --keep             do not delete at the end; prints the guid
 *   --drive-file-id <id> instead of --drive-url.
 *
 * ═══ WHAT IT TOUCHES ═══
 *   · Google: one token for the service account ITSELF (no `sub`, scope
 *     drive.readonly) and one files.get (metadata). Both run in dry run too —
 *     they are reads, and they prove access before anything is sent to Bunny.
 *   · Bunny, with --live only: ONE Fetch Video (Bunny creates the video and
 *     downloads https://www.googleapis.com/drive/v3/files/<id>?alt=media with
 *     our `Authorization: Bearer` header), status reads, CDN/player GETs, and a
 *     delete at the end (also after a failure) unless --keep.
 *   · Our database: NOTHING.
 *
 * THE TOKEN is a secret. It goes to Google and, in the fetch headers, to
 * Bunny — nowhere else: never printed, never in a log line (lib/bunny's
 * dry-run log redacts header values). It lives 1 hour and can only read what
 * the service account was shared on.
 *
 * Fetch Video returns no guid (Bunny's OpenAPI: StatusModel only), so the
 * video is titled with a unique run id and found again through List Videos.
 *
 * Timing: t0 = the fetch request; "received" = the first status read showing
 * status ≥ 1 (Uploaded). Reads every 5s, printed every 30s, so the measured
 * fetch time is accurate to about ±5s.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fetchVideoFromUrl, findVideosByTitle, getVideo } from "../src/lib/bunny/client";
import { describeError } from "../src/lib/bunny/errors";
import type { BunnyVideo } from "../src/lib/bunny/status";
import {
  CDN_CHECKS,
  RETRIES,
  compareHashes,
  isRetryable,
  loadEnvFile,
  removeVideo,
  runCdnChecks,
  withRetry,
  type Result,
  type Row,
} from "./_bunny_checks";
import { DRIVE_READONLY, DriveError, driveFileMeta, driveMediaUrl, extractDriveFileId, serviceAccountEmail, serviceAccountToken } from "./_google_drive";

export type { Row };

// ── test-only overrides (scripts/test_e13_drive_fetch.ts); none can turn a dry run live ──
const T = {
  envFile: () => process.env.E13_DRIVE_FETCH_ENV_FILE ?? join(__dirname, "..", ".env.local"),
  pollMs: () => Number(process.env.E13_DRIVE_FETCH_POLL_MS ?? 5_000),
  printEveryMs: () => Number(process.env.E13_DRIVE_FETCH_PRINT_MS ?? 30_000),
  findMaxMs: () => Number(process.env.E13_DRIVE_FETCH_FIND_MAX_MS ?? 5 * 60_000),
  waitMaxMs: () => Number(process.env.E13_DRIVE_FETCH_WAIT_MAX_MS ?? 6 * 60 * 60_000),
};

const LABEL = "Drive→Bunny";
const MB = 1024 * 1024;
const PLANNED = [
  "טוקן Google", "files.get (Drive)", "בקשת משיכה ל-Bunny", "איתור הווידאו ב-Bunny", "הקובץ התקבל ב-Bunny",
  "status 4", "hasOriginal", "hash מול Drive", ...CDN_CHECKS,
];

let rows: Row[] = [];
const record = (file: string, check: string, result: Result, detail = "") => {
  rows.push({ file, check, result, detail });
  const icon = result === "עבר" ? "✅" : result === "נכשל" ? "❌" : result === "לא נבדק" ? "⬜" : "⏭️";
  console.log(`  ${icon} ${check}${detail ? ` — ${detail}` : ""}`);
};

class Refused extends Error {}
function fail(msg: string): never {
  throw new Refused(msg);
}

export type Metrics = {
  fileName: string | null;
  sizeBytes: number | null;
  fetchSeconds: number | null;
  serverMbps: number | null;
  encodeSeconds: number | null;
  hash: string | null;
  guid: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (s: number | null) => (s === null ? "—" : s < 90 ? `${s}s` : s < 5400 ? `${(s / 60).toFixed(1)} דק׳` : `${(s / 3600).toFixed(2)} שע׳`);
const fmtSize = (b: number | null | undefined) => (b === null || b === undefined ? "?" : `${(b / MB).toFixed(1)}MB`);

/** Polls until `done(v)` says stop, printing a line every printEveryMs. Each read is retried. */
async function pollVideo(
  guid: string,
  t0: number,
  deadline: number,
  done: (v: BunnyVideo) => boolean
): Promise<{ video: BunnyVideo | null; at: number; timedOut: boolean }> {
  let lastPrint = 0;
  for (;;) {
    const v = await withRetry("קריאת סטטוס", () => getVideo(guid));
    const now = Date.now();
    if (!v) return { video: null, at: now, timedOut: false };
    if (now - lastPrint >= T.printEveryMs()) {
      lastPrint = now;
      console.log(`     ⏱  ${fmtDur(Math.round((now - t0) / 1000))} · status ${v.status} · storageSize ${fmtSize(v.storageSize)} · encodeProgress ${v.encodeProgress ?? "?"}%`);
    }
    if (done(v)) return { video: v, at: now, timedOut: false };
    if (now >= deadline) return { video: v, at: now, timedOut: true };
    await sleep(T.pollMs());
  }
}

/** Returns rows + metrics; throws Refused before any request when a guard says no. */
export async function main(args: string[]): Promise<{ rows: Row[]; metrics: Metrics }> {
  rows = [];
  const metrics: Metrics = { fileName: null, sizeBytes: null, fetchSeconds: null, serverMbps: null, encodeSeconds: null, hash: null, guid: null };
  const arg = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const LIVE = args.includes("--live");
  const KEEP = args.includes("--keep");
  const NO_WAIT_ENCODE = args.includes("--no-wait-encode");
  const envFile = loadEnvFile(T.envFile());

  const raw = arg("--drive-file-id") ?? arg("--drive-url");
  if (!raw) fail("חסר --drive-url <קישור שיתוף> או --drive-file-id <מזהה>");
  const fileId = extractDriveFileId(raw);
  if (!fileId) fail(`לא הצלחתי לחלץ מזהה קובץ מ: ${raw}`);

  if (LIVE) {
    if (envFile.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ב-.env.local חייב להופיע BUNNY_DRY_RUN=false");
    if (process.env.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ה-shell דורס את BUNNY_DRY_RUN בערך אחר");
  } else {
    process.env.BUNNY_DRY_RUN = "true"; // dry run no matter what the file or shell says
  }
  const need = ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_CDN_HOSTNAME", "BUNNY_CDN_TOKEN_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON"];
  const missing = need.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length) fail(`חסרים ב-.env.local: ${missing.join(", ")}`);

  console.log(LIVE ? "🔴 ריצה אמיתית: Bunny ימשוך את הקובץ מ-Drive" : "🟢 dry-run — קריאה מ-Drive בלבד, שום בקשה כותבת לא יוצאת ל-Bunny");
  console.log(`   קובץ Drive: ${fileId}`);

  let guid: string | null = null;
  let fetchTitle: string | null = null;
  let step = "טוקן Google";
  let stoppedAt: string | null = null;
  try {
    // ── 1. token for the service account itself ────────────────────────────
    const { token, expiresAt } = await serviceAccountToken(DRIVE_READONLY);
    record(LABEL, "טוקן Google", "עבר", `${serviceAccountEmail()}, drive.readonly, תקף עד ${new Date(expiresAt * 1000).toLocaleTimeString("he-IL")}`);

    // ── 2. metadata — stop on 403/404 ──────────────────────────────────────
    step = "files.get (Drive)";
    let meta;
    try {
      meta = await driveFileMeta(fileId, token);
    } catch (e) {
      const hint = e instanceof DriveError && (e.status === 404 || e.status === 403)
        ? ` — ודא שהקובץ נמצא בתיקייה ששותפה עם ${serviceAccountEmail()}`
        : "";
      record(LABEL, "files.get (Drive)", "נכשל", `${describeError(e)}${hint}`);
      stoppedAt = "files.get נכשל";
      return { rows, metrics };
    }
    metrics.fileName = meta.name;
    metrics.sizeBytes = meta.size;
    const metaDetail = `"${meta.name}", ${fmtSize(meta.size)}, ${meta.mimeType}, sha256 ${meta.sha256Checksum ? `${meta.sha256Checksum.slice(0, 16)}…` : "—"}, md5 ${meta.md5Checksum ?? "—"}`;
    if (meta.size === null) {
      record(LABEL, "files.get (Drive)", "נכשל", `${metaDetail} — אין size: זה לא קובץ בינארי (מסמך Google?)`);
      stoppedAt = "קובץ לא בינארי";
      return { rows, metrics };
    }
    if (meta.canDownload === false) {
      record(LABEL, "files.get (Drive)", "נכשל", `${metaDetail} — canDownload=false: הורדה חסומה לקובץ`);
      stoppedAt = "הורדה חסומה";
      return { rows, metrics };
    }
    record(LABEL, "files.get (Drive)", "עבר", metaDetail);

    // ── 3. Bunny fetch ─────────────────────────────────────────────────────
    step = "בקשת משיכה ל-Bunny";
    const runId = randomBytes(4).toString("hex");
    fetchTitle = `E13 drive-fetch ${runId} — ${meta.name}`;
    const t0 = Date.now();
    const res = await fetchVideoFromUrl(driveMediaUrl(fileId), { Authorization: `Bearer ${token}` }, fetchTitle);
    if ("dryRun" in res && res.dryRun) {
      record(LABEL, "בקשת משיכה ל-Bunny", "דילוג", "dry-run: נרשם בלוג (בלי ערך הטוקן), לא נשלח");
      for (const c of PLANNED.slice(3)) record(LABEL, c, "דילוג", "dry-run");
      record(LABEL, "מחיקה", "דילוג", "dry-run");
      return { rows, metrics };
    }
    record(LABEL, "בקשת משיכה ל-Bunny", "עבר", `Bunny ענה תוך ${((Date.now() - t0) / 1000).toFixed(1)}s${res.message ? `: ${res.message}` : ""}`);

    // ── 4. find the video Bunny created ────────────────────────────────────
    step = "איתור הווידאו ב-Bunny";
    const findDeadline = Date.now() + T.findMaxMs();
    for (;;) {
      const found = await withRetry("חיפוש הווידאו", () => findVideosByTitle(runId));
      const hit = found.find((v) => v.title?.includes(runId));
      if (hit) {
        guid = hit.guid;
        metrics.guid = guid;
        break;
      }
      if (Date.now() >= findDeadline) break;
      await sleep(T.pollMs());
    }
    if (!guid) {
      record(LABEL, "איתור הווידאו ב-Bunny", "נכשל", `לא נמצא וידאו בכותרת "${fetchTitle}" תוך ${Math.round(T.findMaxMs() / 1000)}s — בדוק בדשבורד`);
      stoppedAt = "הווידאו לא נמצא";
      return { rows, metrics };
    }
    record(LABEL, "איתור הווידאו ב-Bunny", "עבר", `guid ${guid}`);

    // ── 5. until the whole file is in (status ≥ 1) ─────────────────────────
    step = "הקובץ התקבל ב-Bunny";
    const deadline = t0 + T.waitMaxMs();
    const got = await pollVideo(guid, t0, deadline, (v) => v.status >= 1);
    if (!got.video) {
      record(LABEL, "הקובץ התקבל ב-Bunny", "נכשל", "הווידאו נעלם מהספרייה");
      stoppedAt = "הווידאו נעלם";
      return { rows, metrics };
    }
    if (got.video.status === 5 || got.video.status === 6) {
      record(LABEL, "הקובץ התקבל ב-Bunny", "נכשל", `Bunny סימן כשל (status ${got.video.status}) — סביר שהמשיכה מ-Drive נכשלה (טוקן, הרשאה או ניתוק)`);
      stoppedAt = "המשיכה נכשלה";
      return { rows, metrics };
    }
    if (got.timedOut) {
      record(LABEL, "הקובץ התקבל ב-Bunny", "לא נבדק", `עדיין status ${got.video.status} אחרי ${fmtDur(Math.round((got.at - t0) / 1000))}`);
      stoppedAt = "המשיכה לא הסתיימה בזמן";
      return { rows, metrics };
    }
    metrics.fetchSeconds = Math.max(1, Math.round((got.at - t0) / 1000));
    metrics.serverMbps = Number((((meta.size ?? 0) * 8) / 1e6 / metrics.fetchSeconds).toFixed(1));
    record(LABEL, "הקובץ התקבל ב-Bunny", "עבר",
      `${fmtSize(meta.size)} ב-${fmtDur(metrics.fetchSeconds)} (~${metrics.serverMbps}Mbps בין השרתים, דיוק ±${Math.round(T.pollMs() / 1000)}s)`);

    const hashRow = (v: BunnyVideo) => {
      const h = compareHashes(meta.sha256Checksum, v.originalHash);
      metrics.hash = h.verdict;
      record(LABEL, "hash מול Drive", h.verdict === "זהה" ? "עבר" : h.verdict === "לא זהה" ? "נכשל" : "לא נבדק", `${h.verdict}: ${h.detail}`);
    };

    if (NO_WAIT_ENCODE) {
      record(LABEL, "status 4", "דילוג", "--no-wait-encode");
      record(LABEL, "hasOriginal", got.video.hasOriginal ? "עבר" : "לא נבדק", `hasOriginal=${got.video.hasOriginal} (לפני סוף הקידוד)`);
      hashRow(got.video);
      for (const c of CDN_CHECKS) record(LABEL, c, "דילוג", "--no-wait-encode");
      return { rows, metrics };
    }

    // ── 6. until encoded (status 4), up to 6h from t0 ──────────────────────
    step = "status 4";
    const enc = await pollVideo(guid, t0, deadline, (v) => v.status === 4 || v.status === 5 || v.status === 6);
    const v = enc.video;
    if (!v) {
      record(LABEL, "status 4", "נכשל", "הווידאו נעלם מהספרייה");
      stoppedAt = "הווידאו נעלם";
      return { rows, metrics };
    }
    if (v.status !== 4) {
      const failedEnc = v.status === 5 || v.status === 6;
      record(LABEL, "status 4", failedEnc ? "נכשל" : "לא נבדק",
        failedEnc ? `Bunny סימן כשל קידוד (status ${v.status})` : `עדיין status ${v.status} (${v.encodeProgress ?? "?"}%) אחרי ${fmtDur(Math.round((enc.at - t0) / 1000))} — תור Free Encoding; הרץ עם --keep ובדוק בדשבורד`);
      stoppedAt = failedEnc ? "הקידוד נכשל" : "הקידוד לא הסתיים בזמן";
      return { rows, metrics };
    }
    metrics.encodeSeconds = Math.round((enc.at - got.at) / 1000);
    record(LABEL, "status 4", "עבר", `הקידוד לקח ${fmtDur(metrics.encodeSeconds)} · length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}`);
    record(LABEL, "hasOriginal", v.hasOriginal === true ? "עבר" : "נכשל", `hasOriginal=${v.hasOriginal}`);
    hashRow(v);

    // ── 7. access checks (shared with e13_first_upload) ───────────────────
    step = "בדיקות CDN";
    await runCdnChecks(LABEL, guid, record);
  } catch (e) {
    record(LABEL, step, isRetryable(e) ? "לא נבדק" : "נכשל", `${isRetryable(e) ? `אין תשובה אחרי ${RETRIES} ניסיונות חוזרים: ` : ""}${describeError(e)}`);
    stoppedAt = step;
  } finally {
    for (const c of PLANNED) {
      if (!rows.some((r) => r.check === c)) record(LABEL, c, "לא נבדק", `לא הגיע לרוץ${stoppedAt ? `: ${stoppedAt}` : ""}`);
    }
    if (guid) {
      if (KEEP) record(LABEL, "מחיקה", "דילוג", `--keep: הווידאו נשאר בספרייה — guid ${guid}`);
      else await removeVideo(LABEL, guid, record);
    } else if (fetchTitle && LIVE && !rows.some((r) => r.check === "מחיקה")) {
      record(LABEL, "מחיקה", "לא נבדק", `לא ידוע guid — אם נוצר וידאו, חפש בדשבורד את "${fetchTitle}" ומחק ידנית`);
    }
    printSummary(metrics);
  }
  return { rows, metrics };
}

function printSummary(m: Metrics) {
  console.log("\n═══ סיכום ═══");
  console.log("| בדיקה | תוצאה | פרט |");
  console.log("|---|---|---|");
  for (const r of rows) console.log(`| ${r.check} | ${r.result} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  const res = (c: string) => rows.find((r) => r.check === c)?.result ?? "—";
  console.log("\n═══ מדדים ═══");
  console.log("| מדד | ערך |");
  console.log("|---|---|");
  console.log(`| קובץ | ${m.fileName ?? "—"} (${fmtSize(m.sizeBytes)}) |`);
  console.log(`| זמן משיכה (מבקשה ועד status ≥ 1) | ${fmtDur(m.fetchSeconds)} |`);
  console.log(`| קצב בין השרתים | ${m.serverMbps === null ? "—" : `${m.serverMbps} Mbps`} |`);
  console.log(`| המתנה לקידוד (status 4) | ${fmtDur(m.encodeSeconds)} |`);
  console.log(`| hash (Bunny מול Drive) | ${m.hash ?? "—"} |`);
  console.log(`| /original בלי טוקן → 403 | ${res("/original בלי טוקן → 403")} |`);
  console.log(`| /original חתום → 200 | ${res("/original חתום → 200")} |`);
  console.log(`| playlist בלי טוקן → 403 | ${res("playlist בלי טוקן → 403")} |`);
  console.log(`| playlist חתום → 200 | ${res("playlist חתום → 200")} |`);
  if (m.guid) console.log(`| guid | ${m.guid} |`);
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then(({ rows: r }) => {
      if (r.some((x) => x.result === "נכשל" || x.result === "לא נבדק")) process.exit(1);
    })
    .catch((e) => {
      console.error("❌", describeError(e));
      process.exit(1);
    });
}
