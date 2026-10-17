import { createHmac, timingSafeEqual } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Bunny Stream webhook signature (E13-5). Pure. Server-side only.
// ═══════════════════════════════════════════════════════════════════════════
//
// From bunny.net/docs/stream-webhook (read 16.10):
//   X-BunnyStream-Signature-Version    v1
//   X-BunnyStream-Signature-Algorithm  hmac-sha256
//   X-BunnyStream-Signature            lower-case hex HMAC-SHA256, 64 chars
//   key  = the library's READ-ONLY API key (BUNNY_STREAM_READONLY_KEY)
//   data = the exact raw request body bytes — never parsed and re-serialised
// The URL, a timestamp, the method and the other headers are NOT signed, so
// there is no replay protection: the handler must be idempotent (it is — the
// body only says "fetch this video again").
//
// Same shape as wa/webhook and documents/overrideTicket.ts: constant-time
// compare, after checking the lengths match (timingSafeEqual throws otherwise).

export type HeaderSource = { get(name: string): string | null };

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "no_signature" | "bad_version" | "bad_algorithm" | "malformed_signature" | "mismatch" };

export function verifyBunnySignature(rawBody: string, headers: HeaderSource, key: string): SignatureCheck {
  const sig = (headers.get("x-bunnystream-signature") ?? "").trim();
  const version = (headers.get("x-bunnystream-signature-version") ?? "").trim();
  const algorithm = (headers.get("x-bunnystream-signature-algorithm") ?? "").trim().toLowerCase();
  if (!sig) return { ok: false, reason: "no_signature" };
  if (version !== "v1") return { ok: false, reason: "bad_version" };
  if (algorithm !== "hmac-sha256") return { ok: false, reason: "bad_algorithm" };
  if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "malformed_signature" };
  const expected = createHmac("sha256", key).update(Buffer.from(rawBody, "utf8")).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
