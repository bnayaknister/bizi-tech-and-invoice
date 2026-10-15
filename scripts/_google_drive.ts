/**
 * Google Drive, READ-ONLY, as the service account ITSELF (no `sub`, no
 * Domain-Wide Delegation) — for scripts/e13_drive_fetch_test.ts.
 * Not a test itself (no `test_` prefix).
 *
 * The service account bizi-booking@bizi-podclub was given Viewer on the
 * "BIZI PODCLUB" folder directly (owner 15.10), so it reads those files under
 * its own identity with drive.readonly. Same JWT-bearer grant and key handling
 * as lib/calendar/write.ts, deliberately NOT shared with it: that file is the
 * calendar's write path and is left untouched.
 *
 * The access token is a secret: nothing here logs it, and callers must not.
 */
import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const TIMEOUT_MS = 20_000;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON לא מוגדר ב-.env.local");
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON אינו JSON תקין");
  }
  if (!parsed.client_email || !parsed.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON חסר client_email או private_key");
  // same defence as lib/calendar/write.ts: PEM newlines sometimes arrive double-escaped
  return { client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, "\n") };
}

export function serviceAccountEmail(): string {
  return loadServiceAccount().client_email;
}

/** The signed assertion (pure given `now`), exported for the offline tests. */
export function buildAssertion(scope: string, nowSec: number): string {
  const sa = loadServiceAccount();
  const claims = { iss: sa.client_email, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 };
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  return `${unsigned}.${b64url(signature)}`;
}

/** A 1-hour access token for the service account itself (no `sub`). */
export async function serviceAccountToken(scope: string): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildAssertion(scope, now) }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`אימות מול גוגל נכשל: HTTP ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("אימות מול גוגל: אין access_token בתשובה");
  return { token: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
}

/** File id from a Drive share link (…/file/d/<id>/…, ?id=<id>, /open?id=, /uc?id=) or a bare id. */
export function extractDriveFileId(input: string): string | null {
  const s = input.trim();
  const valid = (id: string | undefined | null) => (id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null);
  if (valid(s) && !s.includes("/")) return s;
  const m = /\/(?:file|document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]+)/.exec(s);
  if (m) return valid(m[1]);
  try {
    const u = new URL(s);
    return valid(u.searchParams.get("id"));
  } catch {
    return null;
  }
}

export type DriveFileMeta = {
  name: string;
  size: number | null;
  mimeType: string;
  sha256Checksum: string | null;
  md5Checksum: string | null;
  canDownload: boolean | null;
};

export class DriveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

/** files.get metadata, supportsAllDrives=true. 403/404 → DriveError with Google's message. */
export async function driveFileMeta(fileId: string, token: string): Promise<DriveFileMeta> {
  const fields = "name,size,mimeType,sha256Checksum,md5Checksum,capabilities/canDownload";
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const e = JSON.parse(text) as { error?: { message?: string; errors?: { reason?: string }[] } };
      msg = `${e.error?.message ?? msg}${e.error?.errors?.[0]?.reason ? ` (${e.error.errors[0].reason})` : ""}`;
    } catch {
      /* keep raw */
    }
    throw new DriveError(`Drive files.get נכשל: HTTP ${res.status} — ${msg}`, res.status);
  }
  const b = JSON.parse(text) as { name: string; size?: string; mimeType: string; sha256Checksum?: string; md5Checksum?: string; capabilities?: { canDownload?: boolean } };
  return {
    name: b.name,
    size: b.size ? Number(b.size) : null,
    mimeType: b.mimeType,
    sha256Checksum: b.sha256Checksum ?? null,
    md5Checksum: b.md5Checksum ?? null,
    canDownload: b.capabilities?.canDownload ?? null,
  };
}

/** The URL Bunny fetches: the raw bytes, shared drives included. */
export const driveMediaUrl = (fileId: string) =>
  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
