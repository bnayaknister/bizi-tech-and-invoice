import type { Upload } from "tus-js-client";
import type { TusAuthorization } from "./client";

// ═══════════════════════════════════════════════════════════════════════════
// TUS upload options — THE upload path to Bunny (owner 15.10).
// ═══════════════════════════════════════════════════════════════════════════
//
// The studio uploads 5–10GB files. They go browser → Bunny over TUS, signed by
// our server (tusUploadAuthorization), and never through Vercel. The first-
// upload script uses these SAME options from Node, so what it tests is the
// path the drawer will run. No tus-js-client import at runtime here (type
// only), so this file is safe in both bundles.
//
// FACTS FROM BUNNY'S TUS DOCS (bunny.net/docs/stream/tus-resumable-uploads, read 15.10):
//   · AuthorizationExpire is checked at the start of EVERY POST/HEAD/PATCH,
//     not during a PATCH already streaming.
//   · An incomplete upload stays resumable until the AuthorizationExpire it was
//     CREATED with, or ~48h of inactivity — whichever first. Re-signing the
//     same video lets you continue but does NOT extend that deadline.
//   · Expired upload → 404 (not 410). Bunny recommends ≥ 1h.
//   · Their retry advice: retry network errors, 5xx, 409, 423; never other 4xx.
//   · No file-size limit is documented; the documented limits are 72h duration
//     and 2160p (docs/stream/video-specification).
//
// CHUNK SIZE: 50 MiB. Every PATCH is a checkpoint Bunny acknowledges — a drop
// loses at most one chunk, and a resume continues from the last acknowledged
// offset. 10GB = ~205 PATCHes. In Node the source is re-read from disk by
// offset (tus FileSource), so memory stays at about one chunk.

export const TUS_CHUNK_SIZE = 50 * 1024 * 1024;
export const TUS_RETRY_DELAYS = [0, 3000, 5000, 10000, 20000, 60000, 60000];

export type TusOptions = ConstructorParameters<typeof Upload>[1];

/** Bunny's advice as a pure rule: a 4xx other than 409/423 will not fix itself. */
export function shouldRetryTusStatus(status: number | undefined): boolean {
  if (status === undefined || status === 0) return true; // network error, no response
  if (status === 409 || status === 423) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

export function bunnyTusOptions(
  auth: TusAuthorization,
  meta: { filetype: string; title: string },
  extra: Partial<TusOptions> = {}
): TusOptions {
  return {
    endpoint: auth.endpoint,
    chunkSize: TUS_CHUNK_SIZE,
    retryDelays: TUS_RETRY_DELAYS,
    headers: { ...auth.headers },
    metadata: { filetype: meta.filetype, title: meta.title },
    onShouldRetry: (err) => shouldRetryTusStatus(err.originalResponse?.getStatus()),
    ...extra,
  };
}
