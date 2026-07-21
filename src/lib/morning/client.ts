import type {
  MorningDocumentRequest,
  MorningDocumentResponse,
} from "./types";

// The Morning HTTP layer. Server-side only — the keys never reach a browser
// and Morning does not support CORS anyway.
//
// The safety switch is MORNING_DRY_RUN: it must be explicitly set to "false"
// to make a real call. It defaults ON and fails closed, because the failure
// mode is a real document in the owner's books — there is no sandbox to
// catch a mistake (owner confirmed 2026-07-20).

// Morning uses TWO hosts by design (verified 2026-07-20 against the live
// account, both directions):
//   - the identity host issues tokens          — api.morning.co
//   - the resource host serves documents/clients — api.greeninvoice.co.il
// They are not interchangeable: the token host returns an AWS auth error for
// /documents, and the resource host 404s the token path. So there is exactly
// one host per purpose, each named once — not a configurable pair.
//
// There is no sandbox on a free account (owner confirmed 2026-07-20): API
// keys can't be minted there. Only production hosts exist, so the base is a
// constant. MORNING_DRY_RUN is what keeps this safe, not a fake environment.
const IDP_HOST = "https://api.morning.co";
const RESOURCE_BASE = "https://api.greeninvoice.co.il/api/v1";

// Kept for display/eventing only — real work always runs against production
// now, but callers still label rows with it.
export function morningEnv(): string {
  return "production";
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
type CachedToken = { token: string; expiresAtMs: number };
let cached: CachedToken | null = null;

// Refresh a minute early — a token that expires mid-flight would surface as
// a confusing 401 on the document call itself.
const EXPIRY_SKEW_MS = 60_000;

export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAtMs - EXPIRY_SKEW_MS > now) {
    return cached.token;
  }

  const clientId = process.env.MORNING_CLIENT_ID;
  const clientSecret = process.env.MORNING_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MorningError("MORNING_CLIENT_ID / MORNING_CLIENT_SECRET לא מוגדרים", 0, null);
  }

  const res = await fetch(`${IDP_HOST}/idp/v1/oauth/token`, {
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
  cached = { token: body.accessToken as string, expiresAtMs };
  return cached.token;
}

// Exposed for tests — drop the in-memory token (e.g. after rotating keys).
export function clearTokenCache() {
  cached = null;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${RESOURCE_BASE}${path}`, {
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

/**
 * Update a client in Morning (PUT /clients/{id}). Unlike documents — which
 * are immutable once issued and have no update endpoint — clients CAN be
 * edited. Respects DRY_RUN: in dry-run it makes no call and reports it, so
 * local testing never mutates a real Morning client.
 */
export async function updateClient(
  morningClientId: string,
  fields: Record<string, unknown>
): Promise<{ dryRun: boolean }> {
  if (isDryRun()) return { dryRun: true };
  await request(`/clients/${encodeURIComponent(morningClientId)}`, {
    method: "PUT",
    body: JSON.stringify(fields),
  });
  return { dryRun: false };
}

export type MorningSearchDoc = {
  id: string;
  type: number;
  number?: string;
  status?: number;
  documentDate?: string;
  amount?: number;
  currency?: string;
  client?: { id?: string; name?: string };
  url?: { origin?: string; he?: string };
};

/**
 * Documents issued since `fromDate` (YYYY-MM-DD), following pagination.
 * Read-only — runs for real even in DRY_RUN (the daily pull needs live data;
 * there is nothing to damage). Requires credentials.
 */
export async function searchDocuments(fromDate: string, pageSize = 100): Promise<MorningSearchDoc[]> {
  const out: MorningSearchDoc[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (let page = 1; page <= 100; page++) {
    const body = await request<{ items?: MorningSearchDoc[] }>("/documents/search", {
      method: "POST",
      body: JSON.stringify({ fromDate, toDate: today, page, pageSize, sort: "documentDate" }),
    });
    const items = body.items ?? [];
    out.push(...items);
    if (items.length < pageSize) break;
  }
  return out;
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
