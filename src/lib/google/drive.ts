import { createSign } from "node:crypto";
import { FOLDER_LINK_ERROR, isDriveFolderLink } from "@/lib/review/itemLinks";

// ═══════════════════════════════════════════════════════════════════════════
// Google Drive, READ-ONLY, for E13 review media (plan §5.2). Server-side only.
// ═══════════════════════════════════════════════════════════════════════════
//
// The service account bizi-booking was given Viewer on the "BIZI PODCLUB"
// folder directly (owner 15.10), so it reads those files under its OWN
// identity with drive.readonly: no `sub`, no Domain-Wide Delegation. Same
// JWT-bearer grant and key handling as lib/calendar/write.ts, deliberately
// NOT shared with it: that file is the calendar's write path and is left
// untouched (and it may impersonate; this must not).
//
// Moved here from scripts/_google_drive.ts in E13-3; that file now re-exports
// this one so the diagnostic scripts keep working.
//
// ═══ WHAT "A REVIEW FILE" MEANS (owner 16.10, decision 3) ═══
// checkReviewFile() is the gate before any Bunny fetch: files.get, and the
// file is refused unless it is downloadable, video/* or audio/*, has a size,
// and sits inside GOOGLE_DRIVE_REVIEW_FOLDER_ID (directly or in a subfolder).
// The folder check is needed EVEN THOUGH the service account can see the
// file: a file shared "anyone with the link" is readable by files.get from
// anywhere in Drive.
//
// The access token is a secret: nothing here logs it, and callers must not.
// A fresh token is minted for every fetch (decision 6) — never cached.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly";
const TIMEOUT_MS = 20_000;

/** How many folder levels above the file are searched for the review folder. */
export const REVIEW_FOLDER_MAX_DEPTH = 8;

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

function loadServiceAccount(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON לא מוגדר");
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

/** The review folder ("BIZI PODCLUB"). Missing = a config error, never "allow everything". */
export function reviewFolderId(): string {
  const v = (process.env.GOOGLE_DRIVE_REVIEW_FOLDER_ID ?? "").trim();
  if (!v) throw new Error("GOOGLE_DRIVE_REVIEW_FOLDER_ID לא מוגדר");
  return v;
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
export async function serviceAccountToken(scope: string = DRIVE_READONLY): Promise<{ token: string; expiresAt: number }> {
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
  id: string;
  name: string;
  size: number | null;
  mimeType: string;
  sha256Checksum: string | null;
  md5Checksum: string | null;
  canDownload: boolean | null;
  parents: string[];
  trashed: boolean;
};

export class DriveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

async function filesGet(fileId: string, fields: string, token: string): Promise<Record<string, unknown>> {
  const url = `${FILES_URL}/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`;
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
  return JSON.parse(text) as Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** files.get metadata, supportsAllDrives=true. 403/404 → DriveError with Google's message. */
export async function driveFileMeta(fileId: string, token: string): Promise<DriveFileMeta> {
  const b = await filesGet(fileId, "id,name,size,mimeType,sha256Checksum,md5Checksum,capabilities/canDownload,parents,trashed", token);
  const caps = b.capabilities && typeof b.capabilities === "object" ? (b.capabilities as { canDownload?: unknown }) : {};
  const size = str(b.size);
  return {
    id: str(b.id) ?? fileId,
    name: str(b.name) ?? "",
    size: size !== null && /^\d+$/.test(size) ? Number(size) : null,
    mimeType: str(b.mimeType) ?? "",
    sha256Checksum: str(b.sha256Checksum),
    md5Checksum: str(b.md5Checksum),
    canDownload: typeof caps.canDownload === "boolean" ? caps.canDownload : null,
    parents: Array.isArray(b.parents) ? b.parents.filter((p): p is string => typeof p === "string") : [],
    trashed: b.trashed === true,
  };
}

/** The URL Bunny fetches: the raw bytes, shared drives included. */
export const driveMediaUrl = (fileId: string) => `${FILES_URL}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

/**
 * Is any ancestor of `parents` the folder? Walks up breadth-first, at most
 * `maxDepth` levels, each folder read once. A parent the service account
 * cannot see (403/404) is NOT under the review folder — every subfolder of it
 * inherits the Viewer grant — so that branch simply ends. Any other failure
 * (5xx, network) throws: "could not check" is not "outside".
 */
export async function isInsideFolder(
  parents: string[],
  folderId: string,
  token: string,
  maxDepth: number = REVIEW_FOLDER_MAX_DEPTH
): Promise<boolean> {
  const seen = new Set<string>();
  let level = parents;
  for (let depth = 1; depth <= maxDepth && level.length; depth++) {
    if (level.includes(folderId)) return true;
    const next: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      let b: Record<string, unknown>;
      try {
        b = await filesGet(id, "id,parents", token);
      } catch (e) {
        if (e instanceof DriveError && (e.status === 403 || e.status === 404)) continue;
        throw e;
      }
      if (Array.isArray(b.parents)) for (const p of b.parents) if (typeof p === "string" && !seen.has(p)) next.push(p);
    }
    level = next;
  }
  return false; // not found within maxDepth levels (or the walk ran out of parents)
}

export type ReviewFileRejection =
  | "bad_link"
  | "folder"
  | "not_visible"
  | "trashed"
  | "system_file"
  | "not_media"
  | "cannot_download"
  | "no_size"
  | "outside_folder";

/** What the version row keeps (plan §2.2, 0116). sha256 is lower-case hex, or null when Drive gave none. */
export type CheckedReviewFile = {
  fileId: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  sha256: string | null;
  isAudioOnly: boolean;
};

export type ReviewFileCheck =
  | { ok: true; file: CheckedReviewFile }
  | { ok: false; code: ReviewFileRejection; message: string };

const reject = (code: ReviewFileRejection, message: string): ReviewFileCheck => ({ ok: false, code, message });

/**
 * The gate before a Bunny fetch (decision 3). A refusal is a result with a
 * Hebrew message for the technician; a failure to CHECK (token, 5xx,
 * network) throws, and the caller sends nothing.
 *
 * `is_audio_only` comes from the Drive mime type alone: Bunny reports an mp3
 * as 1280x720 (16.10), so width/height cannot tell.
 */
export async function checkReviewFile(input: string, opts: { token: string; folderId?: string }): Promise<ReviewFileCheck> {
  // owner 18.10: a folder link is the common mistake — say so, plainly
  if (isDriveFolderLink(input)) return reject("folder", FOLDER_LINK_ERROR);
  const fileId = extractDriveFileId(input);
  if (!fileId) return reject("bad_link", "זה לא קישור לקובץ ב-Drive. העתק את הקישור של הקובץ עצמו (לא של תיקייה)");
  const folderId = opts.folderId ?? reviewFolderId();

  let meta: DriveFileMeta;
  try {
    meta = await driveFileMeta(fileId, opts.token);
  } catch (e) {
    if (e instanceof DriveError && (e.status === 403 || e.status === 404)) {
      return reject("not_visible", "חשבון השירות לא רואה את הקובץ. ודא שהוא בתיקיית BIZI PODCLUB");
    }
    throw e;
  }

  if (meta.trashed) return reject("trashed", "הקובץ נמצא באשפה של Drive");
  // owner 16.10: a name starting with a dot is never the deliverable. macOS
  // leaves "._name" AppleDouble files next to the real one on shared drives;
  // Drive types them by extension (a 4KB "._2_COMBO-2.wav" passed as audio/wav).
  if (meta.name.trim().startsWith(".")) {
    return reject("system_file", "זה קובץ מערכת של Mac ולא הקובץ עצמו. בחר את הקובץ בלי ._ בתחילת השם");
  }
  const mime = meta.mimeType.toLowerCase();
  if (!mime.startsWith("video/") && !mime.startsWith("audio/")) {
    return reject("not_media", `הקובץ אינו וידאו או אודיו (${meta.mimeType || "סוג לא ידוע"})`);
  }
  if (meta.canDownload !== true) return reject("cannot_download", "ההרשאות ב-Drive לא מאפשרות להוריד את הקובץ");
  if (meta.size === null || meta.size <= 0) return reject("no_size", "Drive לא החזיר גודל לקובץ. אולי ההעלאה ל-Drive עוד לא הסתיימה");
  if (!(await isInsideFolder(meta.parents, folderId, opts.token))) {
    return reject("outside_folder", "הקובץ לא נמצא בתיקיית BIZI PODCLUB. העבר אותו לתיקייה ושלח שוב");
  }

  const sha = meta.sha256Checksum?.trim().toLowerCase() ?? "";
  return {
    ok: true,
    file: {
      fileId: meta.id,
      name: meta.name,
      sizeBytes: meta.size,
      mimeType: meta.mimeType,
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null,
      isAudioOnly: mime.startsWith("audio/"),
    },
  };
}
