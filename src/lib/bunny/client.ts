import { bunnyApiConfig, isBunnyDryRun } from "./config";
import { describeError } from "./errors";
import { tusSignature } from "./sign";
import type { BunnyVideo } from "./status";

// ═══════════════════════════════════════════════════════════════════════════
// The Bunny Stream HTTP layer (E13-2). Server-side only.
// ═══════════════════════════════════════════════════════════════════════════
//
// Endpoints (bunny.net/docs/reference, read 15.10):
//   POST   /library/{id}/videos            create  {title} → VideoModel (guid)
//   PUT    /library/{id}/videos/{guid}     upload  raw bytes, application/octet-stream
//   GET    /library/{id}/videos/{guid}     read    VideoModel
//   DELETE /library/{id}/videos/{guid}     delete  200, or 404 when already gone
//   header AccessKey = the LIBRARY's API key.
//
// ═══ UPLOADS ARE TUS (owner 15.10) ═══
// Real uploads (5–10GB) go browser → Bunny over TUS: tusUploadAuthorization
// below + lib/bunny/tus.ts. uploadVideo (one PUT, whole file in memory) is
// kept ONLY for small files and for `e13_first_upload.ts --put-probe`; it is
// not an upload path for the product.
//
// ═══ EVERY WRITE GOES THROUGH `write()` ═══
// create, upload and delete all call `write()`, and `write()` is the only
// place that checks BUNNY_DRY_RUN. In dry run it makes NO request: it logs one
// `bunny_dry_run` line with what WOULD have been sent (method, URL, body
// summary — never the key) and returns `{ dryRun: true }`. There is no
// synthetic guid: a fake id written into client_review_versions would look
// like a real video to every later step. scripts/test_bunny.ts asserts that
// no other function in this file issues a non-GET request.
//
// TUS authorisation is not a request but it LETS a browser write, so it obeys
// the same switch.

const API_BASE = "https://video.bunnycdn.com";
const TIMEOUT_MS = 15_000;

export class BunnyError extends Error {
  status: number;
  body: unknown;
  /** The response headers that help diagnose a failure — never anything key-like (safeHeaders). */
  headers: Record<string, string>;
  constructor(message: string, status: number, body: unknown, headers: Record<string, string> = {}) {
    super(message);
    this.name = "BunnyError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

// Diagnostic response headers only (owner 15.10: "print the body and the
// relevant headers, without keys"). An allow-list, so a new header can never
// slip a secret into a log; and a deny pattern on top of it, belt and braces.
const DIAG_HEADERS = /^(content-type|content-length|date|server|via|retry-after|cf-ray|x-request-id|x-correlation-id|x-cache|cdn-[a-z-]+|x-bunny-[a-z-]+|stream-server)$/i;
const SECRET_LIKE = /key|auth|token|cookie|secret|signature/i;
export function safeHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (DIAG_HEADERS.test(k) && !SECRET_LIKE.test(k)) out[k] = v;
  });
  return out;
}

/**
 * No HTTP response at all (DNS, reset, timeout…). The message carries the
 * whole `.cause` chain — `fetch failed` alone hides the reason (first --live
 * run, 15.10). The original error stays on `.cause`.
 */
export class BunnyNetworkError extends Error {
  constructor(op: string, cause: unknown) {
    super(`Bunny ${op}: ${describeError(cause)}`, { cause });
    this.name = "BunnyNetworkError";
  }
}

async function send(op: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new BunnyNetworkError(op, e);
  }
}

export type DryRun = { dryRun: true; wouldSend: { method: string; url: string; body: string } };

function videoUrl(libraryId: string, videoId?: string): string {
  return `${API_BASE}/library/${libraryId}/videos${videoId ? `/${encodeURIComponent(videoId)}` : ""}`;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

/** The ONLY non-GET path to Bunny. Honours BUNNY_DRY_RUN before anything else. */
async function write(
  method: "POST" | "PUT" | "DELETE",
  url: string,
  init: { json?: unknown; bytes?: Uint8Array | ArrayBuffer; bodySummary: string; timeoutMs?: number },
  apiKey: string
): Promise<DryRun | Response> {
  if (isBunnyDryRun()) {
    const wouldSend = { method, url, body: init.bodySummary };
    console.log(JSON.stringify({ tag: "bunny_dry_run", ...wouldSend }));
    return { dryRun: true, wouldSend };
  }
  const headers: Record<string, string> = { AccessKey: apiKey, accept: "application/json" };
  let body: BodyInit | undefined;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.bytes !== undefined) {
    headers["content-type"] = "application/octet-stream";
    body = init.bytes as BodyInit;
  }
  return send(`${method} ${url}`, url, { method, headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
}

/** Create the video object (no bytes yet). Returns its guid. */
export async function createVideo(title: string): Promise<DryRun | { dryRun: false; video: BunnyVideo }> {
  const t = title.trim();
  if (!t) throw new Error("Bunny: כותרת וידאו ריקה");
  const { libraryId, apiKey } = bunnyApiConfig();
  const res = await write("POST", videoUrl(libraryId), { json: { title: t }, bodySummary: JSON.stringify({ title: t }) }, apiKey);
  if ("dryRun" in res) return res;
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny create נכשל (${res.status})`, res.status, body, safeHeaders(res));
  const video = body as BunnyVideo;
  if (!video || typeof video.guid !== "string") throw new BunnyError("Bunny create: אין guid בתשובה", res.status, body, safeHeaders(res));
  return { dryRun: false, video };
}

/**
 * Server-side upload of the whole file (PUT). For the first test upload and
 * for scripts — the technician's upload from the drawer goes browser→Bunny
 * over TUS (tusUploadAuthorization), so an hour of video never passes
 * through a Vercel function.
 */
export async function uploadVideo(
  videoId: string,
  bytes: Uint8Array | ArrayBuffer,
  opts: { timeoutMs?: number } = {}
): Promise<DryRun | { dryRun: false }> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const size = bytes.byteLength;
  const res = await write(
    "PUT",
    videoUrl(libraryId, videoId),
    { bytes, bodySummary: `<${size} bytes application/octet-stream>`, timeoutMs: opts.timeoutMs ?? 10 * 60_000 },
    apiKey
  );
  if ("dryRun" in res) return res;
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny upload נכשל (${res.status})`, res.status, body, safeHeaders(res));
  return { dryRun: false };
}

/** Read the video object. A read writes nothing, so it runs even in dry run. null = 404. */
export async function getVideo(videoId: string): Promise<BunnyVideo | null> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const res = await send("GET video", videoUrl(libraryId, videoId), {
    method: "GET",
    headers: { AccessKey: apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny get נכשל (${res.status})`, res.status, body, safeHeaders(res));
  return body as BunnyVideo;
}

/**
 * Delete the video and all its files at Bunny. 404 counts as deleted (plan
 * §6: the video is already gone) and says so. Any other failure throws — the
 * caller records the attempt and NEVER marks media_deleted_at.
 */
export async function deleteVideo(videoId: string): Promise<DryRun | { dryRun: false; alreadyGone: boolean }> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const res = await write("DELETE", videoUrl(libraryId, videoId), { bodySummary: "" }, apiKey);
  if ("dryRun" in res) return res;
  if (res.status === 404) return { dryRun: false, alreadyGone: true };
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny delete נכשל (${res.status})`, res.status, body, safeHeaders(res));
  return { dryRun: false, alreadyGone: false };
}

/**
 * Fetch Video (E13 route A, research 15.10): Bunny pulls the file itself,
 * server to server — `POST /library/{id}/videos/fetch` with `{url, headers, title}`.
 * Bunny CREATES the video; the response carries no guid (OpenAPI: StatusModel
 * only), so the caller finds it by its title (findVideosByTitle).
 * Bunny's docs: headers such as `Authorization: Bearer` are supported; signed or
 * expiring URLs are not, because the fetch is one server-side request.
 *
 * A write → goes through write() and BUNNY_DRY_RUN. The dry-run log lists the
 * header NAMES only — their values (a bearer token) never reach a log line.
 *
 * 🔴 ONE ATTEMPT, NEVER RETRIED (owner 15.10, after a live 503): the call is
 * not idempotent — every POST may create a video, even one that answers 5xx.
 * A caller that needs to know what a failed call left behind searches the
 * library by the title it sent (findVideosByTitle).
 *
 * (This block describes the Fetch Video section below: fetchVideoRaw and
 * fetchVideoFromUrl.)
 */

/** Printable ASCII only — Bunny gets an id-bearing ASCII title; the file name stays with us (owner 15.10). */
export const isAsciiTitle = (t: string) => /^[\x20-\x7E]+$/.test(t);

export type FetchRawBody = { url: string; headers?: Record<string, string> | null; title?: string | null };
export type FetchRawResult = { status: number; ok: boolean; body: unknown; headers: Record<string, string>; ms: number };

/**
 * ONE raw Fetch Video request, exactly as given — for diagnosing which body
 * shape Bunny accepts (e13_drive_fetch_test.ts --fetch-variant). Never throws
 * on an HTTP status: the caller gets status, the whole body and the safe
 * headers. Still a write: through write() and BUNNY_DRY_RUN, header VALUES
 * redacted in the dry-run log. Never retried (see fetchVideoFromUrl).
 */
export async function fetchVideoRaw(body: FetchRawBody, query: Record<string, string> = {}): Promise<DryRun | FetchRawResult> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const qs = new URLSearchParams(query).toString();
  const url = `${videoUrl(libraryId)}/fetch${qs ? `?${qs}` : ""}`;
  const summary = {
    ...body,
    ...(body.headers ? { headers: Object.fromEntries(Object.keys(body.headers).map((k) => [k, "<redacted>"])) } : {}),
  };
  const t0 = Date.now();
  const res = await write("POST", url, { json: body, bodySummary: JSON.stringify(summary) }, apiKey);
  if ("dryRun" in res) return res;
  const parsed = await parse(res);
  return { status: res.status, ok: res.ok, body: parsed, headers: safeHeaders(res), ms: Date.now() - t0 };
}

/**
 * The production shape (owner 15.10, after the API answered 500 to a body the
 * dashboard's own URL upload accepted): `title` is printable ASCII only and
 * carries the run id — the file name is kept on our side, never sent; and
 * `headers` is OMITTED when there are none, never sent as `{}`.
 */
export async function fetchVideoFromUrl(
  sourceUrl: string,
  headers: Record<string, string>,
  title: string
): Promise<DryRun | { dryRun: false; message: string | null }> {
  const t = title.trim();
  if (!t) throw new Error("Bunny: כותרת וידאו ריקה");
  if (!isAsciiTitle(t)) throw new Error("Bunny: כותרת למשיכה חייבת להיות ASCII בלבד (שם הקובץ נשמר אצלנו, לא ב-Bunny)");
  const body: FetchRawBody = { url: sourceUrl, title: t, ...(Object.keys(headers).length ? { headers } : {}) };
  const res = await fetchVideoRaw(body);
  if ("dryRun" in res) return res;
  const b = res.body && typeof res.body === "object" ? (res.body as { success?: unknown; message?: unknown }) : {};
  if (!res.ok || b.success === false) {
    throw new BunnyError(`Bunny fetch נכשל (${res.status})${typeof b.message === "string" ? `: ${b.message}` : ""}`, res.status, res.body, res.headers);
  }
  return { dryRun: false, message: typeof b.message === "string" ? b.message : null };
}

/** List Videos filtered by title substring (read-only; runs in dry run too). */
export async function findVideosByTitle(search: string): Promise<BunnyVideo[]> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const url = `${videoUrl(libraryId)}?search=${encodeURIComponent(search)}&itemsPerPage=100&orderBy=date`;
  const res = await send("GET videos", url, {
    method: "GET",
    headers: { AccessKey: apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny list נכשל (${res.status})`, res.status, body, safeHeaders(res));
  const items = body && typeof body === "object" ? (body as { items?: unknown }).items : null;
  return Array.isArray(items) ? (items as BunnyVideo[]) : [];
}

export type TusAuthorization = {
  endpoint: string;
  headers: { AuthorizationSignature: string; AuthorizationExpire: string; LibraryId: string; VideoId: string };
};

/**
 * What the browser needs to upload straight to Bunny over TUS (plan §5). The
 * API key is hashed in, never returned. In dry run: null, and logged — a
 * browser holding a valid signature could write to the real library.
 */
/**
 * 24h (owner 15.10, for 5–10GB files). Bunny keeps an incomplete upload
 * resumable only until the expiry it was CREATED with (or ~48h idle), and a
 * re-sign does not extend it — so this is the whole window for one file,
 * including any resume after a disconnect or a page reload. 24h covers 10GB
 * down to ~1 Mbit/s of sustained upload. It is also the hard cap below.
 */
export const TUS_UPLOAD_TTL_SECONDS = 24 * 60 * 60;

export function tusUploadAuthorization(
  videoId: string,
  ttlSeconds: number = TUS_UPLOAD_TTL_SECONDS,
  nowMs: number = Date.now()
): TusAuthorization | null {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > 24 * 60 * 60) {
    throw new Error("Bunny: תוקף העלאה חייב להיות 1–86400 שניות");
  }
  const { libraryId, apiKey } = bunnyApiConfig();
  const expires = Math.floor(nowMs / 1000) + ttlSeconds;
  if (isBunnyDryRun()) {
    console.log(JSON.stringify({ tag: "bunny_dry_run", method: "TUS", url: `${API_BASE}/tusupload`, body: `videoId=${videoId}` }));
    return null;
  }
  return {
    endpoint: `${API_BASE}/tusupload`,
    headers: {
      AuthorizationSignature: tusSignature(libraryId, apiKey, expires, videoId),
      AuthorizationExpire: String(expires),
      LibraryId: libraryId,
      VideoId: videoId,
    },
  };
}
