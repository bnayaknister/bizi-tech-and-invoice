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

/**
 * How long any single Morning call may hang before WE cut it (owner 2026-08-25).
 *
 * MEASURED, not guessed. 28 real issuance round-trips are in the event log
 * (morning_call_started -> morning_document_issued/failed): min 0.56s, median
 * 1.36s, p90 2.22s, max 2.48s. Fifteen seconds is six times the slowest call
 * this account has ever made, so it cannot cut a real one, and it is far below
 * the platform's own kill — which is the entire point.
 *
 * WHY IT MATTERS THAT WE CUT FIRST. `fetch` has no default timeout, so a hung
 * connection used to hang until Vercel killed the whole function. That kill
 * lands nowhere: the queue row was already set to 'approved' by the review
 * route before the call, and the catch in issue.ts — which exists, and correctly
 * writes status='failed' with the error — never runs. The row is stranded in a
 * status neither the queue screen nor the radar reads. Aborting ourselves turns
 * that silent stranding into the ordinary failure path that was always there.
 *
 * The review route declares maxDuration so this stays true by construction
 * rather than by inheriting an undeclared platform default.
 */
export const MORNING_TIMEOUT_MS = 15_000;

/**
 * A timeout is NOT a failure — it is an UNKNOWN, and the difference is a second
 * document.
 *
 * When Morning does not answer we cannot tell whether it created the document
 * and lost the reply, or never created it at all. This text is what lands in
 * `pending_documents.last_error` and is what the bookkeeper reads on the queue
 * row, so it has to say so plainly. A message that merely said "failed" would
 * invite the retry that issues the duplicate — and a duplicate tax document
 * cannot be deleted, only credited.
 */
const TIMEOUT_MESSAGE =
  "מורנינג לא הגיב תוך 15 שניות — לא ידוע אם המסמך נוצר. בדקי במורנינג לפני ניסיון חוזר";

/**
 * Run a fetch under our own deadline and translate an abort into a MorningError.
 *
 * `AbortSignal.timeout` raises a TimeoutError DOMException, which is an Error
 * and would otherwise reach the caller as the browser's own English text. 504
 * is the status because that is what it is: an upstream that did not answer in
 * time.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(MORNING_TIMEOUT_MS) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new MorningError(TIMEOUT_MESSAGE, 504, null);
    }
    throw e;
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

  // The token call gets the same deadline as the resource calls: it runs first,
  // on the same request, so a hung token fetch strands a row exactly as a hung
  // document fetch would.
  const res = await fetchWithTimeout(`${IDP_HOST}/idp/v1/oauth/token`, {
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
  // One place, every Morning resource call — documents, clients, emails. A
  // deadline added per-call-site is a deadline the next call site forgets.
  const res = await fetchWithTimeout(`${RESOURCE_BASE}${path}`, {
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
 *
 * ✅ THE PUT IS A PARTIAL UPDATE — verified 2026-09-06 against live data.
 *
 * The verb said "replace", the caller sends one field, and nothing here or in
 * Morning's docs said which of the two wins. It was left open from the day this
 * was written. Measured on the rename of client `dce40719` (וואיקי דיגיטל →
 * וואי 360 בע״מ), body `{ name }` alone, snapshot GET before and after:
 * `name` changed and **all 29 other fields were byte-identical** — `taxId`
 * (516006988), `phone`, `emails`, `accountingKey`, `country`, `active`,
 * `category`, and the address block that was already empty.
 *
 * So a caller may send only what it means to change. Two caveats before
 * relying on it: this was ONE field on ONE client, and it is Morning's
 * behaviour rather than a contract they publish — a caller touching several
 * fields at once should snapshot first. scripts/morning_client_snapshot.py.
 *
 * ---- FOLLOW-UP, 2026-09-09: the several-fields case above WAS measured ----
 *
 * Eight PUTs on client ac3309ec (מכללת מבחר — inactive, zero turnover, not
 * mapped in our `clients` table), each one snapshotted before and after and
 * diffed on the KEY SET, not a field count. Restored to byte-identical.
 *
 * ✅ THREE FIELDS AT ONCE IS SAFE. `{name, emails, phone}` in one body moved
 *    exactly those fields; the other 24 came back byte-identical. A `name`
 *    resent at its current value does not even register as a change, so a
 *    caller may send all of its fields every time without diffing first.
 * ✅ `emails` IS REPLACE-WHOLE. Sending two of three removes the third. There
 *    is no array merge — to remove one address, send the ones that remain.
 * ✅ `phone: ""` CLEARS the field (it comes back as "", never null, and the key
 *    never disappears). NOTE the asymmetry with createMorningClient below,
 *    which does `if (fields.phone) body.phone = ...` — correct on create,
 *    WRONG on update: omitting the key means "leave as is", so copying that
 *    idiom would make clearing a phone silently do nothing.
 *
 * 🔴 AND THE ONE NOBODY ASKED FOR — `emails` AND `send` ARE COUPLED ON WRITE.
 *
 * `send` is the client-card toggle for "email documents to this client at
 * issuance" (Morning's own help centre: "ללקוחות שמורים תוכלו להגדיר בכרטיס
 * הלקוח שליחה אוטומטית של מסמכים, בזמן הפקתם"). Sending `emails: []` turns it
 * OFF — silently, with a 200, on a field that was not in the request.
 *
 * THE COUPLING IS ONE-WAY, and that is the dangerous half:
 *   emptying the list  -> send goes false        (measured twice)
 *   filling  the list  -> send is NOT touched    (measured twice)
 * So there is NO automatic path back. A flag knocked off here stays off until
 * somebody turns it on by hand in Morning.
 *
 * AND IT CANNOT BE PREVENTED IN-REQUEST. `{emails: [], send: true}` in ONE body,
 * `send` sent explicitly, still came back false — Morning recomputes the flag
 * from `emails` and overwrites what was sent. A separate follow-up
 * `{send: true}` does work, but that is a compensating write with a window and
 * a silent failure mode, on a toggle we have no published contract for.
 *
 * ✅ WHAT IT DOES *NOT* AFFECT — OUR OWN ISSUANCE. Answered 2026-09-09 by the
 * owner, against the client rather than against the API: ונוס קונספט sits at
 * send=false and DID receive the documents we issued to it (40303, 50068). So
 * the `client.emails` we put in the POST /documents body wins, and `send`
 * governs only Morning's own automatic dispatch. This bounds the blast radius —
 * a knocked-off flag does NOT mean an invoice silently failed to reach anyone.
 *
 * It does NOT change the design, and the warning stays: the flag is still
 * turned off silently, still does not come back on its own, and is still the
 * owner's setting to lose. It is confirmed by ONE client, and it is Morning's
 * behaviour rather than a contract — same standing as everything else here.
 *
 * Not derived on READ, only on WRITE: 115 of the 291 clients in the account sit
 * at zero emails with send=true quite legally. Seven are send=false; six
 * pre-date this test and three of those are active, revenue-bearing clients
 * that DO have an address on file. Our issuance path was cleared as the cause
 * (23 clients we issued to, 9 same-day record updates, 8 of them send=true).
 *
 * CONSEQUENCE FOR ANY UI OVER CLIENT EMAILS (owner decision 2026-09-09): show
 * `send`, read-only; do NOT write it, and do NOT compensate; warn before the
 * list drops to zero, because that is the only moment the coupling fires.
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

/**
 * The LIVE email list of one Morning client (GET /clients/{id}). The snapshot
 * in documents.raw.client.emails is stale (owner: כפיר ארביב empty in 10288,
 * present in 40283), so the recipient picker must read this instead. Read-only,
 * runs for real even in DRY_RUN (a read writes nothing). Returns ok:false on any
 * failure so the caller degrades (accountant-only) rather than blocking issuance.
 */
export async function getClientEmails(morningClientId: string): Promise<{ emails: string[]; ok: boolean }> {
  try {
    const c = await request<{ emails?: unknown }>(`/clients/${encodeURIComponent(morningClientId)}`, { method: "GET" });
    const emails = Array.isArray(c.emails)
      ? c.emails.filter((e): e is string => typeof e === "string" && e.trim() !== "")
      : [];
    return { emails, ok: true };
  } catch {
    return { emails: [], ok: false };
  }
}

/**
 * The contact block of one Morning client, for the drawer's client card.
 *
 * `send` rides along READ-ONLY and is never written back — see the coupling
 * documented on updateClient above. It is here so the card can SHOW it, which
 * is the whole mitigation: the flag is invisible today, and an invisible flag
 * is what lets a silent change happen.
 */
export type MorningClientContacts = {
  emails: string[];
  phone: string | null;
  contactPerson: string | null;
  send: boolean | null;
};

/**
 * Morning has THREE shapes for "this text field is empty" and they are not
 * interchangeable across endpoints: `GET /clients/{id}` answers `""`,
 * `/clients/search` answers `null`, and our own MorningClient type declares the
 * key optional, i.e. `undefined`. Collapse all three at the boundary — the same
 * idiom getAccountantEmail uses (recipients.ts:50-51) — so no screen ever
 * compares against the wrong one and paints an untouched field as changed.
 */
export function normalizeMorningText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * And the way back out. Morning clears a text field ONLY when the key is
 * present with an empty string — measured 2026-09-09. Omitting the key means
 * "leave as is", which is why createMorningClient's `if (fields.phone)` idiom
 * must not be copied into an update: it would make clearing a phone silently
 * do nothing.
 */
export function toMorningText(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Same filter getClientEmails applies, extracted so the two cannot drift. */
export function normalizeMorningEmails(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim())
    : [];
}

/**
 * Read-only, and degrades instead of blocking: `ok:false` lets the card render
 * its own "Morning is unreachable" state beside the DB fields rather than
 * failing the whole drawer. Same contract as getClientEmails/fetchClientEmails.
 */
export async function getClientContacts(
  morningClientId: string
): Promise<{ contacts: MorningClientContacts; ok: boolean }> {
  const empty: MorningClientContacts = { emails: [], phone: null, contactPerson: null, send: null };
  try {
    const c = await request<Record<string, unknown>>(`/clients/${encodeURIComponent(morningClientId)}`, {
      method: "GET",
    });
    return {
      contacts: {
        emails: normalizeMorningEmails(c.emails),
        phone: normalizeMorningText(c.phone),
        contactPerson: normalizeMorningText(c.contactPerson),
        // a real boolean or nothing — never coerced, so "we could not tell"
        // stays distinguishable from "it is off"
        send: typeof c.send === "boolean" ? c.send : null,
      },
      ok: true,
    };
  } catch {
    return { contacts: empty, ok: false };
  }
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

/**
 * Create a client in Morning (POST /clients) and return its new id. Respects
 * DRY_RUN — in dry-run it makes NO call and returns a synthetic id, so local
 * testing never creates a real Morning client. A real creation is a write to
 * the owner's books, so callers gate it behind a double confirmation.
 */
export async function createMorningClient(fields: {
  name: string;
  taxId?: string | null;
  phone?: string | null;
  emails?: string[];
  address?: string | null;
}): Promise<{ id: string; dryRun: boolean }> {
  if (isDryRun()) {
    return { id: `dry-client-${crypto.randomUUID()}`, dryRun: true };
  }
  const body: Record<string, unknown> = { name: fields.name };
  if (fields.taxId) body.taxId = fields.taxId;
  if (fields.phone) body.phone = fields.phone;
  if (fields.emails?.length) body.emails = fields.emails;
  if (fields.address) body.address = fields.address;
  const res = await request<{ id: string }>("/clients", { method: "POST", body: JSON.stringify(body) });
  return { id: res.id, dryRun: false };
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
