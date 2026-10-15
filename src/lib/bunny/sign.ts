import { createHash, createHmac } from "node:crypto";
import { bunnyCdnConfig } from "./config";

// ═══════════════════════════════════════════════════════════════════════════
// Signed URLs for the pull zone's Token Authentication (plan §4).
// ═══════════════════════════════════════════════════════════════════════════
//
// THE ALGORITHM is Bunny's current one, taken from their reference signer
// (github.com/BunnyWay/BunnyCDN.TokenAuthentication, nodejs/token.js) and
// checked against the repo's own published vectors (e2e/vectors.json) in
// scripts/test_bunny.ts:
//
//   token = "HS256-" + base64url( HMAC-SHA256(key, signaturePath + expires + signingData) )
//
//   · signaturePath = token_path when one is given, else the URL path
//   · signingData   = the extra parameters INCLUDING token_path, sorted by key,
//                     "k=v" joined by "&" (raw values); token/expires excluded
//   · base64url     = "+"→"-", "/"→"_", trailing "=" stripped
//
// No IP lock and no country rules: a client on a phone changes IPs mid-episode,
// and both would have to be decided by the owner first.
//
// TWO SHAPES:
//   · directory (/bcdn_token=…/{guid}/playlist.m3u8) — for HLS. The token
//     sits in the PATH, so every relative segment request inherits it.
//   · exact file (?token=…&expires=…) — for /{guid}/original. Scoped to that
//     one path, minutes long (plan §4: the download route redirects to it).
//
// The key never leaves this module; it is not part of any URL.

const MAX_TTL_SECONDS = 24 * 60 * 60; // a sanity cap, not the policy (plan Q4 is open)

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The raw token for a path. PURE: expires is an absolute unix-seconds value,
 * so the result is deterministic and testable against Bunny's vectors.
 */
export function cdnToken(
  tokenKey: string,
  path: string,
  expires: number,
  params: Record<string, string> = {}
): string {
  if (!tokenKey) throw new Error("Bunny: מפתח טוקן ריק");
  if (!path.startsWith("/")) throw new Error("Bunny: נתיב לחתימה חייב להתחיל ב-/");
  if (!Number.isInteger(expires) || expires <= 0) throw new Error("Bunny: expires חייב להיות שניות unix");
  const signaturePath = params.token_path || path;
  const signingData = Object.keys(params)
    .filter((k) => params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const mac = createHmac("sha256", tokenKey);
  mac.update(signaturePath);
  mac.update(String(expires));
  mac.update(signingData);
  return "HS256-" + base64url(mac.digest());
}

function expiresFrom(ttlSeconds: number, nowMs: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`Bunny: תוקף טוקן חייב להיות 1–${MAX_TTL_SECONDS} שניות`);
  }
  return Math.floor(nowMs / 1000) + ttlSeconds;
}

function assertGuid(videoId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(videoId)) {
    throw new Error("Bunny: מזהה וידאו אינו guid");
  }
}

export type SignedUrl = { url: string; expires: number };

/**
 * HLS playback for one video: a DIRECTORY token over /{guid}/, so the
 * playlist and every segment under it are covered by one signature.
 */
export function signedPlaybackUrl(
  videoId: string,
  ttlSeconds: number,
  opts: { nowMs?: number; hostname?: string; tokenKey?: string } = {}
): SignedUrl {
  assertGuid(videoId);
  const cfg = opts.hostname && opts.tokenKey ? { hostname: opts.hostname, tokenKey: opts.tokenKey } : bunnyCdnConfig();
  const expires = expiresFrom(ttlSeconds, opts.nowMs ?? Date.now());
  const dir = `/${videoId}/`;
  const token = cdnToken(cfg.tokenKey, `${dir}playlist.m3u8`, expires, { token_path: dir });
  return {
    url: `https://${cfg.hostname}/bcdn_token=${token}&token_path=${encodeURIComponent(dir)}&expires=${expires}${dir}playlist.m3u8`,
    expires,
  };
}

/**
 * The full-quality original, exact path only (plan §4 — never a directory
 * token: a download link must not also open the stream or other files).
 */
export function signedOriginalUrl(
  videoId: string,
  ttlSeconds: number,
  opts: { nowMs?: number; hostname?: string; tokenKey?: string } = {}
): SignedUrl {
  assertGuid(videoId);
  const cfg = opts.hostname && opts.tokenKey ? { hostname: opts.hostname, tokenKey: opts.tokenKey } : bunnyCdnConfig();
  const expires = expiresFrom(ttlSeconds, opts.nowMs ?? Date.now());
  const path = `/${videoId}/original`;
  const token = cdnToken(cfg.tokenKey, path, expires);
  return { url: `https://${cfg.hostname}${path}?token=${token}&expires=${expires}`, expires };
}

/**
 * TUS upload authorisation for the browser (plan §5), per Bunny's docs:
 * hex SHA256(library_id + api_key + expiration_time + video_id). The API key
 * goes into the hash and never into the response. PURE.
 */
export function tusSignature(libraryId: string, apiKey: string, expires: number, videoId: string): string {
  return createHash("sha256").update(`${libraryId}${apiKey}${expires}${videoId}`).digest("hex");
}
