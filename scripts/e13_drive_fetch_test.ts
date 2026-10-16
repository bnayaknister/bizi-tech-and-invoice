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
 *   --fetch-variant [--fetch-public-url <url>]: one POST per body shape (url
 *     only · + ASCII title · title as query · + empty headers · our old body),
 *     full answer printed, created videos found by a library snapshot and
 *     deleted unless --keep. Default URL: the W3C trailer below.
 *   --fetch-public-url <url> instead of a Drive file: Bunny fetches a PUBLIC
 *     URL with NO headers — does Fetch Video work at all, Drive aside?
 *     e.g. https://media.w3.org/2010/05/sintel/trailer.mp4 (W3C test media, 4.4MB)
 *   --verify-title "<title>" | --verify-guid <guid>  [--drive-file-id <id> | --sha256 <hex>]
 *     (owner 16.10) NO fetch, NO delete, read-only whatever .env.local says:
 *     find a video already in the library (e.g. imported from the dashboard)
 *     and run the after-arrival checks on it — status, hasOriginal, hash vs
 *     Drive's sha256, /original + playlist 403/200, Direct Play, Embed — and
 *     print Bunny's own timestamps (dateUploaded, transcodingMessages).
 *   --inspect-original (with --live or --verify-*; owner 16.10): after status 4,
 *     download the signed /original to a temp file, sha256 it HERE, describe
 *     it (ffprobe if installed + a first-bytes sniff); when it differs from
 *     Drive's sha256, download the Drive file too and describe it alongside.
 *     Temp files are deleted at the end. See _inspect_original.ts.
 *
 * 🔴 FETCH VIDEO IS SENT ONCE (owner 15.10, after a live 503): the POST is not
 * idempotent — any attempt may create a video. It is never retried. After a
 * failure the library is searched for the run id (up to 60s, Bunny may create
 * it late); what is found is reported and deleted unless --keep.
 * Every Bunny failure prints Bunny's whole response body and its diagnostic
 * headers (never key-like ones).
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
import { fetchVideoFromUrl, fetchVideoRaw, findVideosByTitle, getVideo, type FetchRawBody } from "../src/lib/bunny/client";
import { describeError } from "../src/lib/bunny/errors";
import type { BunnyVideo } from "../src/lib/bunny/status";
import {
  CDN_CHECKS,
  compareHashes,
  loadEnvFile,
  removeVideo,
  runCdnChecks,
  stepFailure,
  withRetry,
  type Result,
  type Row,
} from "./_bunny_checks";
import { INSPECT_CHECKS, inspectOriginal } from "./_inspect_original";
import { DRIVE_READONLY, DriveError, driveFileMeta, driveMediaUrl, extractDriveFileId, serviceAccountEmail, serviceAccountToken } from "./_google_drive";

export type { Row };

// ── test-only overrides (scripts/test_e13_drive_fetch.ts); none can turn a dry run live ──
const T = {
  envFile: () => process.env.E13_DRIVE_FETCH_ENV_FILE ?? join(__dirname, "..", ".env.local"),
  pollMs: () => Number(process.env.E13_DRIVE_FETCH_POLL_MS ?? 5_000),
  printEveryMs: () => Number(process.env.E13_DRIVE_FETCH_PRINT_MS ?? 30_000),
  findMaxMs: () => Number(process.env.E13_DRIVE_FETCH_FIND_MAX_MS ?? 5 * 60_000),
  waitMaxMs: () => Number(process.env.E13_DRIVE_FETCH_WAIT_MAX_MS ?? 6 * 60 * 60_000),
  sweepMs: () => Number(process.env.E13_DRIVE_FETCH_SWEEP_MS ?? 60_000),
};

const LABEL = "Drive→Bunny";
/** W3C test media (Sintel trailer, 4.4MB, unchanged since 2010) — the default for --fetch-variant. */
export const DEFAULT_PUBLIC_URL = "https://media.w3.org/2010/05/sintel/trailer.mp4";
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

/** HEAD on a public URL for its size (best effort; a read, safe in dry run). */
async function headInfo(url: string): Promise<{ status: number; length: number | null; type: string | null; error?: string }> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(20_000) });
    const len = Number(res.headers.get("content-length"));
    return { status: res.status, length: Number.isFinite(len) && len > 0 ? len : null, type: res.headers.get("content-type") };
  } catch (e) {
    return { status: -1, length: null, type: null, error: describeError(e) };
  }
}

/**
 * After a FAILED Fetch Video: did the attempt still leave a video behind?
 * Bunny may create it asynchronously, so the library is searched for the
 * run id for up to sweepMs. One POST creates at most one video, so the search
 * stops at the first hit. Returns the guids found (empty = nothing left).
 */
async function sweepAfterFailedFetch(runId: string): Promise<{ guids: string[]; error?: string; waitedS: number }> {
  const start = Date.now();
  for (;;) {
    try {
      const found = (await withRetry("חיפוש וידאו אחרי כשל", () => findVideosByTitle(runId))).filter((v) => v.title?.includes(runId));
      if (found.length) return { guids: found.map((v) => v.guid), waitedS: Math.round((Date.now() - start) / 1000) };
    } catch (e) {
      return { guids: [], error: describeError(e), waitedS: Math.round((Date.now() - start) / 1000) };
    }
    if (Date.now() - start >= T.sweepMs()) return { guids: [], waitedS: Math.round((Date.now() - start) / 1000) };
    await sleep(T.pollMs());
  }
}

// ── --fetch-variant: which body shape does Fetch Video accept? ──────────────
// The dashboard's own "upload from URL" fetched the W3C trailer; the API
// answered 500 to our request for the same URL every time (owner 15.10). The
// variants isolate the difference, one POST each, never retried. Videos are
// attributed by a snapshot of the library taken BEFORE the run — so a video
// that already existed (the dashboard one) is never touched, and a video
// titled by Bunny from the file name is still found.
type Variant = {
  key: string;
  desc: string;
  body: (url: string, id: string) => FetchRawBody;
  query?: (id: string) => Record<string, string>;
};
export const VARIANTS: Variant[] = [
  { key: "א", desc: "גוף עם url בלבד", body: (url) => ({ url }) },
  { key: "ב", desc: "url + title ב-ASCII", body: (url, id) => ({ url, title: `E13 variant-b ${id}` }) },
  { key: "ג", desc: "title כ-query param (מחוץ למפרט)", body: (url) => ({ url }), query: (id) => ({ title: `E13 variant-c ${id}` }) },
  { key: "ד", desc: "url + headers ריק ({})", body: (url) => ({ url, headers: {} }) },
  { key: "ה", desc: "ביקורת: הבקשה הקודמת (headers ריק + title עם —)", body: (url, id) => ({ url, headers: {}, title: `E13 url-fetch ${id} — trailer.mp4` }) },
];

async function libraryGuids(): Promise<Set<string>> {
  const all = await withRetry("רשימת הספרייה", () => findVideosByTitle(""));
  return new Set(all.map((v) => v.guid));
}

export async function runFetchVariants(url: string, live: boolean, keep: boolean): Promise<{ rows: Row[]; metrics: Metrics }> {
  const metrics: Metrics = { fileName: null, sizeBytes: null, fetchSeconds: null, serverMbps: null, encodeSeconds: null, hash: null, guid: null };
  const label = "וריאציות fetch";
  const summary: { key: string; desc: string; http: string; created: string; verdict: string }[] = [];
  const created: string[] = [];
  try {
    const known = live ? await libraryGuids() : new Set<string>();
    if (live) console.log(`   תמונת מצב: ${known.size} סרטונים קיימים בספרייה — לא ייגעו בהם`);
    for (const v of VARIANTS) {
      const id = randomBytes(4).toString("hex");
      const body = v.body(url, id);
      const query = v.query ? v.query(id) : {};
      console.log(`\n── וריאציה ${v.key}: ${v.desc}`);
      console.log(`   POST …/videos/fetch${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}  body=${JSON.stringify(body)}`);
      let res;
      try {
        res = await fetchVideoRaw(body, query);
      } catch (e) {
        record(label, `וריאציה ${v.key}: ${v.desc}`, "נכשל", `אין תשובת HTTP (ניסיון אחד): ${describeError(e)}`);
        summary.push({ key: v.key, desc: v.desc, http: "רשת", created: "?", verdict: "נכשל" });
        continue;
      }
      if ("dryRun" in res) {
        record(label, `וריאציה ${v.key}: ${v.desc}`, "דילוג", "dry-run: נרשם בלוג, לא נשלח");
        summary.push({ key: v.key, desc: v.desc, http: "—", created: "—", verdict: "dry-run" });
        continue;
      }
      const b = res.body && typeof res.body === "object" ? (res.body as { success?: unknown }) : {};
      const accepted = res.ok && b.success !== false;
      record(label, `וריאציה ${v.key}: ${v.desc}`, accepted ? "עבר" : "נכשל",
        `HTTP ${res.status} תוך ${(res.ms / 1000).toFixed(1)}s · body=${typeof res.body === "string" ? res.body : JSON.stringify(res.body)} · headers=${JSON.stringify(res.headers)}`);

      // what did this attempt create? (new guids since the snapshot, up to sweepMs)
      const start = Date.now();
      let fresh: string[] = [];
      for (;;) {
        try {
          const now = await libraryGuids();
          fresh = Array.from(now).filter((g) => !known.has(g));
        } catch (e) {
          record(label, `וריאציה ${v.key}: וידאו שנוצר`, "לא נבדק", `רשימת הספרייה נכשלה: ${describeError(e)}`);
          break;
        }
        if (fresh.length || Date.now() - start >= T.sweepMs()) break;
        await sleep(T.pollMs());
      }
      for (const g of fresh) known.add(g);
      created.push(...fresh);
      const consistent = accepted ? fresh.length === 1 : fresh.length === 0;
      if (!rows.some((r) => r.check === `וריאציה ${v.key}: וידאו שנוצר`)) {
        record(label, `וריאציה ${v.key}: וידאו שנוצר`, consistent ? "עבר" : "נכשל",
          `${fresh.length} נוצרו${fresh.length ? `: ${fresh.join(", ")}` : ""} (חיפוש ${Math.round((Date.now() - start) / 1000)}s)${consistent ? "" : accepted ? " — התקבל אבל לא נמצא וידאו" : " — נכשל אבל נוצר וידאו"}`);
      }
      summary.push({ key: v.key, desc: v.desc, http: String(res.status), created: String(fresh.length), verdict: accepted ? "עובד" : "לא עובד" });
    }
  } catch (e) {
    const f = stepFailure(e);
    record(label, "תמונת מצב של הספרייה", f.result, f.detail);
  } finally {
    for (const g of created) {
      if (keep) record(label, `מחיקה ${g.slice(0, 8)}`, "דילוג", `--keep: guid ${g}`);
      else await removeVideo(label, g, record, `מחיקה ${g.slice(0, 8)}`);
    }
    console.log("\n═══ סיכום ═══");
    console.log("| בדיקה | תוצאה | פרט |");
    console.log("|---|---|---|");
    for (const r of rows) console.log(`| ${r.check} | ${r.result} | ${r.detail.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
    console.log("\n═══ וריאציות ═══");
    console.log("| וריאציה | מה נשלח | HTTP | נוצרו | מסקנה |");
    console.log("|---|---|---|---|---|");
    for (const x of summary) console.log(`| ${x.key} | ${x.desc} | ${x.http} | ${x.created} | ${x.verdict} |`);
  }
  return { rows, metrics };
}

// ── what Bunny says about WHEN (owner 16.10) ────────────────────────────────
// VideoModel documents `dateUploaded` and `transcodingMessages[].timeStamp`;
// there is no documented "fetch finished" or "encoding finished" field. So
// every date-like field the object actually carries is printed as is, plus
// the transcoding messages; the only duration derived is dateUploaded → the
// last transcoding message, and it is labelled an estimate.
type TranscodingMessage = { timeStamp?: string | null; level?: number | null; issueCode?: number | null; message?: string | null; value?: string | null };
type RawVideo = BunnyVideo & Record<string, unknown> & { dateUploaded?: string | null; transcodingMessages?: TranscodingMessage[] | null };

/** Bunny's dates come without a zone ("2026-10-16T09:12:03.123") — they are UTC. */
export function parseBunnyDate(s: unknown): number | null {
  if (typeof s !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)) return null;
  const t = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? t : null;
}
const fmtIl = (ms: number) => new Date(ms).toLocaleString("he-IL", { timeZone: "Asia/Jerusalem" });

export function bunnyTimeline(v: BunnyVideo): string[] {
  const raw = v as RawVideo;
  const lines: string[] = [];
  const dated = Object.entries(raw).filter(([, val]) => parseBunnyDate(val) !== null);
  if (!dated.length) lines.push("Bunny לא החזיר שום שדה תאריך בווידאו");
  for (const [k, val] of dated) lines.push(`${k}: ${val} (UTC) = ${fmtIl(parseBunnyDate(val)!)} שעון ישראל`);
  const msgs = (Array.isArray(raw.transcodingMessages) ? raw.transcodingMessages : [])
    .filter((m) => parseBunnyDate(m?.timeStamp) !== null)
    .sort((a, b) => parseBunnyDate(a.timeStamp)! - parseBunnyDate(b.timeStamp)!);
  if (!msgs.length) {
    lines.push("transcodingMessages: אין הודעות עם חותמת זמן");
  } else {
    lines.push(`transcodingMessages: ${msgs.length}`);
    for (const m of msgs.slice(0, 20)) {
      lines.push(`  ${fmtIl(parseBunnyDate(m.timeStamp)!)} · level ${m.level ?? "?"} · ${m.message ?? ""}${m.value ? ` (${m.value})` : ""}`);
    }
    if (msgs.length > 20) lines.push(`  … ועוד ${msgs.length - 20}`);
    const up = parseBunnyDate(raw.dateUploaded);
    const last = parseBunnyDate(msgs[msgs.length - 1].timeStamp)!;
    if (up !== null && last >= up) lines.push(`הערכה: dateUploaded → הודעת הקידוד האחרונה = ${fmtDur(Math.round((last - up) / 1000))}`);
  }
  lines.push("שים לב: Bunny לא מתעד שדה של \"סוף המשיכה\" או \"סוף הקידוד\" — אלה השדות היחידים שיש");
  return lines;
}
function printTimeline(v: BunnyVideo) {
  console.log("\n═══ זמנים מ-Bunny ═══");
  for (const l of bunnyTimeline(v)) console.log(`  ${l}`);
}

const VERIFY_PLANNED = ["איתור הווידאו ב-Bunny", "status 4", "hasOriginal", "hash מול Drive", ...CDN_CHECKS];

/**
 * --verify-title / --verify-guid (owner 16.10): the checks that follow arrival,
 * on a video ALREADY in the library (e.g. one imported from the dashboard).
 * READ-ONLY: no fetch, no delete — BUNNY_DRY_RUN is forced on, so even a bug
 * could not write. The hash source is Drive's sha256 (--drive-file-id /
 * --drive-url, through the service account) or --sha256 <hex> given by hand.
 */
export async function runVerify(o: { title?: string; guid?: string; driveRaw?: string; sha256?: string; inspect?: boolean }): Promise<{ rows: Row[]; metrics: Metrics }> {
  const metrics: Metrics = { fileName: null, sizeBytes: null, fetchSeconds: null, serverMbps: null, encodeSeconds: null, hash: null, guid: null };
  const label = "בדיקת וידאו קיים";
  let step = "איתור הווידאו ב-Bunny";
  let stoppedAt: string | null = null;
  try {
    // ── 1. the video ───────────────────────────────────────────────────────
    let v: BunnyVideo | null;
    if (o.guid) {
      v = await withRetry("קריאת הווידאו", () => getVideo(o.guid!));
      if (!v) {
        record(label, step, "נכשל", `אין וידאו עם guid ${o.guid} בספרייה ${process.env.BUNNY_STREAM_LIBRARY_ID}`);
        stoppedAt = "הווידאו לא נמצא";
        return { rows, metrics };
      }
    } else {
      const want = o.title!.trim();
      const hits = await withRetry("חיפוש הווידאו", () => findVideosByTitle(want));
      const exact = hits.filter((h) => (h.title ?? "").trim() === want);
      if (exact.length !== 1) {
        const near = hits.slice(0, 10).map((h) => `"${h.title}" ${h.guid}`).join(" · ");
        record(label, step, "נכשל", exact.length
          ? `${exact.length} סרטונים בכותרת "${want}": ${exact.map((h) => h.guid).join(", ")} — הרץ עם --verify-guid`
          : `אין וידאו בכותרת המדויקת "${want}"${near ? ` · דומים: ${near}` : ""}`);
        stoppedAt = "הווידאו לא זוהה";
        return { rows, metrics };
      }
      v = await withRetry("קריאת הווידאו", () => getVideo(exact[0].guid));
      if (!v) {
        record(label, step, "נכשל", `נמצא ברשימה (${exact[0].guid}) אבל הקריאה החזירה 404`);
        stoppedAt = "הווידאו נעלם";
        return { rows, metrics };
      }
    }
    metrics.guid = v.guid;
    metrics.sizeBytes = v.storageSize ?? null;
    record(label, step, "עבר", `guid ${v.guid} · "${v.title ?? ""}" · storageSize ${fmtSize(v.storageSize)} · length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}`);
    printTimeline(v);
    console.log("");

    // ── 2. status + original ──────────────────────────────────────────────
    step = "status 4";
    const finished = v.status === 4;
    record(label, "status 4", finished ? "עבר" : v.status === 5 || v.status === 6 ? "נכשל" : "לא נבדק",
      `status ${v.status}${finished ? "" : ` (${v.encodeProgress ?? "?"}%)`}`);
    record(label, "hasOriginal", v.hasOriginal === true ? "עבר" : "נכשל", `hasOriginal=${v.hasOriginal}`);

    // ── 3. hash: Drive's sha256 (service account) or one given by hand ────
    step = "hash מול Drive";
    let sha: string | null = null;
    let shaFrom = "";
    let driveMedia: string | null = null;
    if (o.sha256) {
      sha = o.sha256.trim();
      shaFrom = "--sha256";
    } else if (o.driveRaw) {
      const fileId = extractDriveFileId(o.driveRaw);
      try {
        if (!fileId) throw new Error(`לא הצלחתי לחלץ מזהה קובץ מ: ${o.driveRaw}`);
        const { token } = await serviceAccountToken(DRIVE_READONLY);
        const meta = await driveFileMeta(fileId, token);
        sha = meta.sha256Checksum;
        driveMedia = driveMediaUrl(fileId);
        shaFrom = `Drive "${meta.name}" ${fmtSize(meta.size)}`;
        metrics.fileName = meta.name;
      } catch (e) {
        const hint = e instanceof DriveError && (e.status === 404 || e.status === 403)
          ? ` — הקובץ לא משותף עם ${serviceAccountEmail()}; אפשר להעביר את ה-sha256 ידנית עם --sha256`
          : "";
        record(label, "hash מול Drive", "לא נבדק", `${describeError(e)}${hint}`);
      }
    }
    if (!rows.some((r) => r.check === "hash מול Drive")) {
      if (!o.sha256 && !o.driveRaw) {
        record(label, "hash מול Drive", "דילוג", `אין מקור להשוואה (--drive-file-id או --sha256) · originalHash=${v.originalHash ?? "—"}`);
      } else {
        const h = compareHashes(sha, v.originalHash);
        metrics.hash = h.verdict;
        record(label, "hash מול Drive", h.verdict === "זהה" ? "עבר" : h.verdict === "לא זהה" ? "נכשל" : "לא נבדק", `${h.verdict}: ${h.detail} (${shaFrom})`);
      }
    }

    // ── 4. access checks — only on a finished video ────────────────────────
    step = "בדיקות CDN";
    if (!finished) {
      for (const c of CDN_CHECKS) record(label, c, "לא נבדק", `status ${v.status} — הקידוד לא הסתיים`);
    } else {
      await runCdnChecks(label, v.guid, record);
      if (o.inspect) {
        step = "original: הורדה";
        await inspectOriginal(label, v.guid, record, {
          sha256: sha,
          mediaUrl: driveMedia,
          getToken: driveMedia ? async () => (await serviceAccountToken(DRIVE_READONLY)).token : null,
        });
      }
    }
  } catch (e) {
    const f = stepFailure(e);
    record(label, step, f.result, f.detail);
    stoppedAt = step;
  } finally {
    for (const c of [...VERIFY_PLANNED, ...(o.inspect ? INSPECT_CHECKS : [])]) {
      if (!rows.some((r) => r.check === c)) record(label, c, "לא נבדק", `לא הגיע לרוץ${stoppedAt ? `: ${stoppedAt}` : ""}`);
    }
    record(label, "מחיקה", "דילוג", "--verify: קריאה בלבד, הווידאו נשאר");
    printSummary(metrics);
  }
  return { rows, metrics };
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
  const INSPECT = args.includes("--inspect-original");
  if (INSPECT && NO_WAIT_ENCODE) fail("--inspect-original רץ אחרי status 4 — לא משלבים עם --no-wait-encode");
  if (INSPECT && args.includes("--fetch-variant")) fail("--inspect-original לא רץ עם --fetch-variant");
  const envFile = loadEnvFile(T.envFile());

  // ── --verify-title / --verify-guid: read-only checks on an existing video ──
  if (args.includes("--verify-title") || args.includes("--verify-guid")) {
    const title = arg("--verify-title");
    const guid = arg("--verify-guid");
    if (args.includes("--verify-title") && args.includes("--verify-guid")) fail("בחר אחד: --verify-title או --verify-guid");
    if (args.includes("--verify-title") && (!title || title.startsWith("--") || !title.trim())) fail("--verify-title צריך כותרת");
    if (args.includes("--verify-guid") && (!guid || !/^[0-9a-f-]{36}$/i.test(guid))) fail(`--verify-guid צריך guid של Bunny: ${guid ?? ""}`);
    const clash = ["--live", "--keep", "--no-wait-encode", "--fetch-variant", "--fetch-public-url"].filter((f) => args.includes(f));
    if (clash.length) fail(`--verify הוא קריאה בלבד — לא משלבים עם ${clash.join(", ")}`);
    const driveRaw = arg("--drive-file-id") ?? arg("--drive-url");
    const sha256 = arg("--sha256");
    if (driveRaw && sha256) fail("בחר מקור hash אחד: --drive-file-id / --drive-url, או --sha256");
    if (sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(sha256)) fail("--sha256 צריך 64 תווי hex");
    process.env.BUNNY_DRY_RUN = "true"; // read-only: no write can leave, whatever the file says
    const needV = ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_CDN_HOSTNAME", "BUNNY_CDN_TOKEN_KEY", ...(driveRaw ? ["GOOGLE_SERVICE_ACCOUNT_JSON"] : [])];
    const missingV = needV.filter((k) => !(process.env[k] ?? "").trim());
    if (missingV.length) fail(`חסרים ב-.env.local: ${missingV.join(", ")}${driveRaw ? " (או השתמש ב---sha256 במקום Drive)" : ""}`);
    console.log(`🔎 בדיקת וידאו קיים — קריאה בלבד, בלי משיכה ובלי מחיקה: ${guid ? `guid ${guid}` : `"${title}"`}`);
    return runVerify({ title, guid, driveRaw, sha256, inspect: INSPECT });
  }

  // ── the source: a Drive file, or (--fetch-public-url) any public URL ──────
  const VARIANT = args.includes("--fetch-variant");
  const publicUrl = arg("--fetch-public-url") ?? (VARIANT ? DEFAULT_PUBLIC_URL : undefined);
  const raw = arg("--drive-file-id") ?? arg("--drive-url");
  if (publicUrl && raw) fail(VARIANT ? "--fetch-variant רץ על כתובת ציבורית בלבד, לא על Drive" : "בחר מקור אחד: --fetch-public-url, או --drive-url / --drive-file-id");
  if (!publicUrl && !raw) fail("חסר מקור: --drive-url <קישור שיתוף>, --drive-file-id <מזהה>, או --fetch-public-url <כתובת>");
  let fileId: string | null = null;
  if (publicUrl) {
    if (!/^https?:\/\/\S+$/i.test(publicUrl)) fail(`--fetch-public-url חייב להיות כתובת http(s): ${publicUrl}`);
  } else {
    fileId = extractDriveFileId(raw!);
    if (!fileId) fail(`לא הצלחתי לחלץ מזהה קובץ מ: ${raw}`);
  }
  const label = publicUrl ? "URL→Bunny" : LABEL;

  if (LIVE) {
    if (envFile.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ב-.env.local חייב להופיע BUNNY_DRY_RUN=false");
    if (process.env.BUNNY_DRY_RUN !== "false") fail("--live נדחה: ה-shell דורס את BUNNY_DRY_RUN בערך אחר");
  } else {
    process.env.BUNNY_DRY_RUN = "true"; // dry run no matter what the file or shell says
  }
  const need = ["BUNNY_STREAM_LIBRARY_ID", "BUNNY_STREAM_API_KEY", "BUNNY_STREAM_CDN_HOSTNAME", "BUNNY_CDN_TOKEN_KEY", ...(publicUrl ? [] : ["GOOGLE_SERVICE_ACCOUNT_JSON"])];
  const missing = need.filter((k) => !(process.env[k] ?? "").trim());
  if (missing.length) fail(`חסרים ב-.env.local: ${missing.join(", ")}`);

  console.log(LIVE ? `🔴 ריצה אמיתית: Bunny ימשוך את הקובץ ${publicUrl ? "מכתובת ציבורית, בלי כותרות" : "מ-Drive"}` : `🟢 dry-run — ${publicUrl ? "HEAD לכתובת בלבד" : "קריאה מ-Drive בלבד"}, שום בקשה כותבת לא יוצאת ל-Bunny`);
  console.log(publicUrl ? `   כתובת: ${publicUrl}` : `   קובץ Drive: ${fileId}`);
  if (VARIANT) return runFetchVariants(publicUrl!, LIVE, KEEP);

  let guid: string | null = null;
  let runId: string | null = null;
  let fetchSent = false;
  let extraGuids: string[] = [];
  let step = publicUrl ? "גודל הקובץ (HEAD)" : "טוקן Google";
  let stoppedAt: string | null = null;
  try {
    let sourceUrl: string;
    let headers: Record<string, string> = {};
    let sha256: string | null = null;
    let sizeBytes: number | null;
    let name: string;

    if (publicUrl) {
      // ── 1–2 (public): no Google at all; HEAD only for the size ───────────
      record(label, "טוקן Google", "דילוג", "--fetch-public-url");
      const h = await headInfo(publicUrl);
      record(label, "files.get (Drive)", "דילוג",
        `--fetch-public-url · HEAD: ${h.status === -1 ? `שגיאת רשת: ${h.error}` : `HTTP ${h.status}`}, ${fmtSize(h.length)}, ${h.type ?? "?"}`);
      sourceUrl = publicUrl;
      sizeBytes = h.length;
      name = decodeURIComponent(new URL(publicUrl).pathname.split("/").pop() || "public.mp4");
    } else {
      // ── 1. token for the service account itself ──────────────────────────
      const { token, expiresAt } = await serviceAccountToken(DRIVE_READONLY);
      record(label, "טוקן Google", "עבר", `${serviceAccountEmail()}, drive.readonly, תקף עד ${new Date(expiresAt * 1000).toLocaleTimeString("he-IL")}`);

      // ── 2. metadata — stop on 403/404 ────────────────────────────────────
      step = "files.get (Drive)";
      let meta;
      try {
        meta = await driveFileMeta(fileId!, token);
      } catch (e) {
        const hint = e instanceof DriveError && (e.status === 404 || e.status === 403)
          ? ` — ודא שהקובץ נמצא בתיקייה ששותפה עם ${serviceAccountEmail()}`
          : "";
        record(label, "files.get (Drive)", "נכשל", `${describeError(e)}${hint}`);
        stoppedAt = "files.get נכשל";
        return { rows, metrics };
      }
      const metaDetail = `"${meta.name}", ${fmtSize(meta.size)}, ${meta.mimeType}, sha256 ${meta.sha256Checksum ? `${meta.sha256Checksum.slice(0, 16)}…` : "—"}, md5 ${meta.md5Checksum ?? "—"}`;
      if (meta.size === null) {
        record(label, "files.get (Drive)", "נכשל", `${metaDetail} — אין size: זה לא קובץ בינארי (מסמך Google?)`);
        stoppedAt = "קובץ לא בינארי";
        return { rows, metrics };
      }
      if (meta.canDownload === false) {
        record(label, "files.get (Drive)", "נכשל", `${metaDetail} — canDownload=false: הורדה חסומה לקובץ`);
        stoppedAt = "הורדה חסומה";
        return { rows, metrics };
      }
      record(label, "files.get (Drive)", "עבר", metaDetail);
      sourceUrl = driveMediaUrl(fileId!);
      headers = { Authorization: `Bearer ${token}` };
      sha256 = meta.sha256Checksum;
      sizeBytes = meta.size;
      name = meta.name;
    }
    metrics.fileName = name;
    metrics.sizeBytes = sizeBytes;

    // ── 3. Bunny fetch — ONE attempt, never retried (not idempotent) ───────
    step = "בקשת משיכה ל-Bunny";
    runId = randomBytes(4).toString("hex");
    // ASCII only, with the run id; the file name stays with us (owner 15.10)
    const fetchTitle = `E13 ${publicUrl ? "url-fetch" : "drive-fetch"} ${runId}`;
    const t0 = Date.now();
    let res;
    try {
      fetchSent = LIVE;
      res = await fetchVideoFromUrl(sourceUrl, headers, fetchTitle);
    } catch (e) {
      record(label, "בקשת משיכה ל-Bunny", "נכשל",
        `ניסיון אחד בלבד, ללא חזרה (POST לא אידמפוטנטי), אחרי ${((Date.now() - t0) / 1000).toFixed(1)}s — ${describeError(e)}`);
      stoppedAt = "בקשת המשיכה נכשלה";
      return { rows, metrics };
    }
    if ("dryRun" in res && res.dryRun) {
      record(label, "בקשת משיכה ל-Bunny", "דילוג", `dry-run: נרשם בלוג (${publicUrl ? "בלי כותרות" : "בלי ערך הטוקן"}), לא נשלח`);
      for (const c of PLANNED.slice(3)) record(label, c, "דילוג", "dry-run");
      record(label, "מחיקה", "דילוג", "dry-run");
      return { rows, metrics };
    }
    record(label, "בקשת משיכה ל-Bunny", "עבר", `Bunny ענה תוך ${((Date.now() - t0) / 1000).toFixed(1)}s${res.message ? `: ${res.message}` : ""}`);

    // ── 4. find the video Bunny created ────────────────────────────────────
    step = "איתור הווידאו ב-Bunny";
    const findDeadline = Date.now() + T.findMaxMs();
    let hits: BunnyVideo[] = [];
    for (;;) {
      hits = (await withRetry("חיפוש הווידאו", () => findVideosByTitle(runId!))).filter((v) => v.title?.includes(runId!));
      if (hits.length || Date.now() >= findDeadline) break;
      await sleep(T.pollMs());
    }
    if (!hits.length) {
      record(label, "איתור הווידאו ב-Bunny", "נכשל", `לא נמצא וידאו בכותרת "${fetchTitle}" תוך ${Math.round(T.findMaxMs() / 1000)}s — בדוק בדשבורד`);
      stoppedAt = "הווידאו לא נמצא";
      return { rows, metrics };
    }
    guid = hits[0].guid;
    metrics.guid = guid;
    record(label, "איתור הווידאו ב-Bunny", "עבר", `guid ${guid}${hits.length > 1 ? ` (⚠️ נמצאו ${hits.length} — האחרים יימחקו בסוף)` : ""}`);
    extraGuids = hits.slice(1).map((v) => v.guid);

    // ── 5. until the whole file is in (status ≥ 1) ─────────────────────────
    step = "הקובץ התקבל ב-Bunny";
    const deadline = t0 + T.waitMaxMs();
    const got = await pollVideo(guid, t0, deadline, (v) => v.status >= 1);
    if (!got.video) {
      record(label, "הקובץ התקבל ב-Bunny", "נכשל", "הווידאו נעלם מהספרייה");
      stoppedAt = "הווידאו נעלם";
      return { rows, metrics };
    }
    if (got.video.status === 5 || got.video.status === 6) {
      record(label, "הקובץ התקבל ב-Bunny", "נכשל", `Bunny סימן כשל (status ${got.video.status}) — סביר שהמשיכה מהמקור נכשלה (טוקן, הרשאה או ניתוק)`);
      stoppedAt = "המשיכה נכשלה";
      return { rows, metrics };
    }
    if (got.timedOut) {
      record(label, "הקובץ התקבל ב-Bunny", "לא נבדק", `עדיין status ${got.video.status} אחרי ${fmtDur(Math.round((got.at - t0) / 1000))}`);
      stoppedAt = "המשיכה לא הסתיימה בזמן";
      return { rows, metrics };
    }
    metrics.fetchSeconds = Math.max(1, Math.round((got.at - t0) / 1000));
    const bytesIn = sizeBytes ?? got.video.storageSize ?? null;
    metrics.serverMbps = bytesIn ? Number(((bytesIn * 8) / 1e6 / metrics.fetchSeconds).toFixed(1)) : null;
    record(label, "הקובץ התקבל ב-Bunny", "עבר",
      `${fmtSize(bytesIn)} ב-${fmtDur(metrics.fetchSeconds)} (~${metrics.serverMbps ?? "?"}Mbps בין השרתים, דיוק ±${Math.round(T.pollMs() / 1000)}s)`);

    const hashRow = (v: BunnyVideo) => {
      if (publicUrl) {
        record(label, "hash מול Drive", "דילוג", "--fetch-public-url: אין hash מקור להשוואה");
        return;
      }
      const h = compareHashes(sha256, v.originalHash);
      metrics.hash = h.verdict;
      record(label, "hash מול Drive", h.verdict === "זהה" ? "עבר" : h.verdict === "לא זהה" ? "נכשל" : "לא נבדק", `${h.verdict}: ${h.detail}`);
    };

    if (NO_WAIT_ENCODE) {
      record(label, "status 4", "דילוג", "--no-wait-encode");
      record(label, "hasOriginal", got.video.hasOriginal ? "עבר" : "לא נבדק", `hasOriginal=${got.video.hasOriginal} (לפני סוף הקידוד)`);
      hashRow(got.video);
      for (const c of CDN_CHECKS) record(label, c, "דילוג", "--no-wait-encode");
      return { rows, metrics };
    }

    // ── 6. until encoded (status 4), up to 6h from t0 ──────────────────────
    step = "status 4";
    const enc = await pollVideo(guid, t0, deadline, (v) => v.status === 4 || v.status === 5 || v.status === 6);
    const v = enc.video;
    if (!v) {
      record(label, "status 4", "נכשל", "הווידאו נעלם מהספרייה");
      stoppedAt = "הווידאו נעלם";
      return { rows, metrics };
    }
    if (v.status !== 4) {
      const failedEnc = v.status === 5 || v.status === 6;
      record(label, "status 4", failedEnc ? "נכשל" : "לא נבדק",
        failedEnc ? `Bunny סימן כשל קידוד (status ${v.status})` : `עדיין status ${v.status} (${v.encodeProgress ?? "?"}%) אחרי ${fmtDur(Math.round((enc.at - t0) / 1000))} — תור Free Encoding; הרץ עם --keep ובדוק בדשבורד`);
      stoppedAt = failedEnc ? "הקידוד נכשל" : "הקידוד לא הסתיים בזמן";
      return { rows, metrics };
    }
    metrics.encodeSeconds = Math.round((enc.at - got.at) / 1000);
    record(label, "status 4", "עבר", `הקידוד לקח ${fmtDur(metrics.encodeSeconds)} · length ${v.length ?? "?"}s, ${v.width ?? 0}x${v.height ?? 0}`);
    record(label, "hasOriginal", v.hasOriginal === true ? "עבר" : "נכשל", `hasOriginal=${v.hasOriginal}`);
    hashRow(v);
    printTimeline(v);

    // ── 7. access checks (shared with e13_first_upload) ───────────────────
    step = "בדיקות CDN";
    await runCdnChecks(label, guid, record);

    // ── 8. --inspect-original: what does Bunny really keep? ────────────────
    if (INSPECT) {
      step = "original: הורדה";
      await inspectOriginal(label, guid, record, publicUrl ? null : {
        sha256,
        mediaUrl: sourceUrl,
        getToken: async () => (await serviceAccountToken(DRIVE_READONLY)).token,
      });
    }
  } catch (e) {
    const f = stepFailure(e);
    record(label, step, f.result, f.detail);
    stoppedAt = step;
  } finally {
    for (const c of [...PLANNED, ...(INSPECT ? INSPECT_CHECKS : [])]) {
      if (!rows.some((r) => r.check === c)) record(label, c, "לא נבדק", `לא הגיע לרוץ${stoppedAt ? `: ${stoppedAt}` : ""}`);
    }
    if (guid) {
      if (KEEP) record(label, "מחיקה", "דילוג", `--keep: הווידאו נשאר בספרייה — guid ${guid}`);
      else await removeVideo(label, guid, record);
      for (const g of extraGuids) {
        if (KEEP) record(label, `מחיקה ${g.slice(0, 8)}`, "דילוג", `--keep: וידאו נוסף באותה כותרת — guid ${g}`);
        else await removeVideo(label, g, record, `מחיקה ${g.slice(0, 8)}`);
      }
    } else if (fetchSent && runId) {
      // the fetch was SENT but no video was tracked: report what it left behind
      const sw = await sweepAfterFailedFetch(runId);
      if (sw.error) {
        record(label, "וידאו שנוצרו בניסיון", "לא נבדק", `החיפוש בספרייה נכשל: ${sw.error} — חפש בדשבורד "${runId}"`);
      } else if (!sw.guids.length) {
        record(label, "וידאו שנוצרו בניסיון", "עבר", `0 — לא נמצא וידאו עם "${runId}" בכותרת (חיפוש במשך ${sw.waitedS}s)`);
      } else {
        record(label, "וידאו שנוצרו בניסיון", KEEP ? "דילוג" : "עבר", `${sw.guids.length} נמצאו: ${sw.guids.join(", ")}${KEEP ? " — --keep: לא נמחקו" : " — נמחקים"}`);
        if (!KEEP) for (const g of sw.guids) await removeVideo(label, g, record, `מחיקה ${g.slice(0, 8)}`);
      }
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
