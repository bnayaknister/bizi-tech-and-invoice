import type {
  MorningDocumentRequest,
  MorningDocumentResponse,
} from "./types";

// The Morning HTTP layer. Server-side only — the keys never reach a browser
// and Morning does not support CORS anyway.
//
// Everything here is off by default: MORNING_DRY_RUN must be explicitly set
// to "false" to make a real call, and MORNING_ENV must be explicitly set to
// "production" to leave the sandbox. Two independent switches, both failing
// closed, because the failure mode is a real tax document.

const BASE_URLS = {
  sandbox: "https://sandbox.d.greeninvoice.co.il/api/v1",
  production: "https://api.greeninvoice.co.il/api/v1",
} as const;

export type MorningEnv = keyof typeof BASE_URLS;

export function morningEnv(): MorningEnv {
  return process.env.MORNING_ENV === "production" ? "production" : "sandbox";
}

export function morningBaseUrl(): string {
  return BASE_URLS[morningEnv()];
}

// Defaults ON: a missing/typo'd env var must not start issuing documents.
export function isDryRun(): boolean {
  return process.env.MORNING_DRY_RUN !== "false";
}

export class MorningError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "MorningError";
    this.status = status;
    this.body = body;
  }
}

// ---------------------------------------------------------------------------
// auth: OAuth2 client_credentials -> POST /idp/v1/oauth/token
// Response: { accessToken, tokenType: "Bearer", expiresAt: <unix seconds> }
// ---------------------------------------------------------------------------
type CachedToken = { token: string; expiresAtMs: number; env: MorningEnv };
let cached: CachedToken | null = null;

// Refresh a minute early — a token that expires mid-flight would surface as
// a confusing 401 on the document call itself.
const EXPIRY_SKEW_MS = 60_000;

export async function getAccessToken(): Promise<string> {
  const env = morningEnv();
  const now = Date.now();
  if (cached && cached.env === env && cached.expiresAtMs - EXPIRY_SKEW_MS > now) {
    return cached.token;
  }

  const clientId = process.env.MORNING_CLIENT_ID;
  const clientSecret = process.env.MORNING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MorningError("MORNING_CLIENT_ID / MORNING_CLIENT_SECRET לא מוגדרים", 0, null);
  }

  const res = await fetch(`${morningBaseUrl()}/idp/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    cache: "no-store",
  });

  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.accessToken) {
    throw new MorningError("אימות מול מורנינג נכשל", res.status, body);
  }

  // expiresAt is a unix timestamp in seconds
  const expiresAtMs = typeof body.expiresAt === "number" ? body.expiresAt * 1000 : now + 25 * 60_000;
  cached = { token: body.accessToken as string, expiresAtMs, env };
  return cached.token;
}

// Exposed for tests and for the "switch environment" case — a token minted
// against sandbox must never be replayed at production.
export function clearTokenCache() {
  cached = null;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${morningBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && (body.errorMessage || body.message)) || `מורנינג החזיר ${res.status}`;
    throw new MorningError(String(msg), res.status, body);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

/**
 * Issue a document. In DRY_RUN this returns a synthetic response shaped
 * exactly like the real one and makes no network call — the id is prefixed
 * so a dry-run row can never be mistaken for a real Morning document.
 */
export async function createDocument(
  doc: MorningDocumentRequest
): Promise<{ result: MorningDocumentResponse; dryRun: boolean }> {
  if (isDryRun()) {
    return {
      dryRun: true,
      result: {
        id: `dry-${crypto.randomUUID()}`,
        number: Math.floor(Date.now() / 1000) % 1_000_000,
        type: doc.type,
        url: { origin: null as unknown as string },
        taxAuthorityConfirmationLastError: 0,
      },
    };
  }
  const result = await request<MorningDocumentResponse>("/documents", {
    method: "POST",
    body: JSON.stringify(doc),
  });
  return { result, dryRun: false };
}

export type MorningClient = {
  id: string;
  name: string;
  active?: boolean;
  taxId?: string;
  emails?: string[];
  phone?: string;
  city?: string;
};

/**
 * Full client list, following pagination. Used by the mapping screen.
 * Read-only, so it runs for real even in DRY_RUN — there is nothing to
 * damage and the mapping is useless without live data. It still requires
 * credentials, so it fails cleanly when they're absent.
 */
export async function listClients(pageSize = 100): Promise<MorningClient[]> {
  const out: MorningClient[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = await request<{ items?: MorningClient[]; total?: number }>("/clients/search", {
      method: "POST",
      body: JSON.stringify({ page, pageSize, active: true }),
    });
    const items = body.items ?? [];
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
}
