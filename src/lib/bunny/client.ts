import { bunnyApiConfig, isBunnyDryRun } from "./config";
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
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "BunnyError";
    this.status = status;
    this.body = body;
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
  return fetch(url, { method, headers, body, signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) });
}

/** Create the video object (no bytes yet). Returns its guid. */
export async function createVideo(title: string): Promise<DryRun | { dryRun: false; video: BunnyVideo }> {
  const t = title.trim();
  if (!t) throw new Error("Bunny: כותרת וידאו ריקה");
  const { libraryId, apiKey } = bunnyApiConfig();
  const res = await write("POST", videoUrl(libraryId), { json: { title: t }, bodySummary: JSON.stringify({ title: t }) }, apiKey);
  if ("dryRun" in res) return res;
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny create נכשל (${res.status})`, res.status, body);
  const video = body as BunnyVideo;
  if (!video || typeof video.guid !== "string") throw new BunnyError("Bunny create: אין guid בתשובה", res.status, body);
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
  if (!res.ok) throw new BunnyError(`Bunny upload נכשל (${res.status})`, res.status, body);
  return { dryRun: false };
}

/** Read the video object. A read writes nothing, so it runs even in dry run. null = 404. */
export async function getVideo(videoId: string): Promise<BunnyVideo | null> {
  const { libraryId, apiKey } = bunnyApiConfig();
  const res = await fetch(videoUrl(libraryId, videoId), {
    method: "GET",
    headers: { AccessKey: apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  const body = await parse(res);
  if (!res.ok) throw new BunnyError(`Bunny get נכשל (${res.status})`, res.status, body);
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
  if (!res.ok) throw new BunnyError(`Bunny delete נכשל (${res.status})`, res.status, body);
  return { dryRun: false, alreadyGone: false };
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
export function tusUploadAuthorization(
  videoId: string,
  ttlSeconds: number,
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
