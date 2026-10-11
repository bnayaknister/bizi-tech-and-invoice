import { createSign } from "node:crypto";

// ═══════════════════════════════════════════════════════════════════════════
// Writing ONE event to the shared Google Calendar — the owner's approval of a
// booking request is the only caller (feat/calendar-write, 7.10).
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 EVERYTHING ELSE IN THIS CODEBASE'S CALENDAR CODE IS READ-ONLY
// (lib/calendar/parse.ts: "read-only fetch of the real (secret) calendar
// URL — never writes to it"). This file is the one exception, and it exists
// because the owner's own decision (7.10) widened E7/E8: the approval should
// write the event itself instead of the owner pasting a TEMPLATE link by hand.
//
// ═══ NO googleapis / google-auth-library DEPENDENCY ═══
// The service-account OAuth2 "JWT bearer" grant is a signed JWT POSTed to
// Google's token endpoint — and Node's own `crypto.createSign` already does
// RS256 over a PEM key. A library would add convenience, not capability, for
// the one call this needs. (Measured against the alternative: adding
// google-auth-library pulls in its own dependency tree for what is, here, a
// single signed POST and a single authenticated POST/GET.) If a second
// Google API is ever needed, that calculus may change — this file is scoped
// to Calendar's `events.insert`/read and the one guarded delete below.
//
// ═══ 🔴 DELETE: ONE FUNCTION, OUR OWN EVENTS ONLY (owner decision 11.10) ═══
// Until E9-5 this file never deleted anything, and that was the whole wall:
// the shared calendar carries the advertising company's own recordings, and
// Google's sharing model has no "write your own events only" role — `writer`
// can delete ANY event on it. The owner has now ruled that the system may
// delete events IT CREATED, and only those. So the wall moved, it did not go:
//
//   · ONE function calls DELETE — `deleteSystemCalendarEvent`, below.
//   · Its guard is INSIDE it, not at the call sites: it deletes only when the
//     booking's `calendar_write_status` is 'created' AND the stored id equals
//     `calendarEventIdFor(booking id)` — the deterministic id only this code
//     ever mints. Any other id is refused before a token is even fetched.
//   · events.patch still does not exist here.
//
// scripts/test_calendar_write.ts reads this codebase's own text and fails if a
// second DELETE (or any PATCH) to Google Calendar appears anywhere in src/.

// ═══ DRY_RUN, THE SAME SHAPE AS MORNING (rule 40) ═══
// `isCalendarDryRun()` mirrors `isDryRun()` in lib/morning/client.ts exactly:
// defaults ON, so a missing or mistyped env var can never start writing to the
// real calendar. A dry run makes no network call and returns `{dryRun: true}`.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const TIMEOUT_MS = 15_000;

export function isCalendarDryRun(): boolean {
  return process.env.CALENDAR_WRITE_DRY_RUN !== "false";
}

class CalendarWriteError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

type ServiceAccountKey = { client_email: string; private_key: string };

function loadServiceAccount(): ServiceAccountKey {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON לא מוגדר");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON אינו JSON תקין");
  }
  const sa = parsed as Partial<ServiceAccountKey>;
  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON חסר client_email או private_key");
  }
  // Defensive: a key pasted through some env-var UIs arrives with its PEM
  // newlines double-escaped (literal "\n" characters surviving JSON.parse,
  // rather than becoming real newlines). Harmless when they are already
  // real — nothing left to replace — and the one thing that makes the key
  // parseable when they are not.
  return { client_email: sa.client_email, private_key: sa.private_key.replace(/\\n/g, "\n") };
}

/**
 * timeout -> `CalendarWriteError` with status 504, the SAME mapping
 * `fetchWithTimeout` uses in lib/morning/client.ts and for the SAME reason: a
 * timeout is an UNKNOWN, not a failure. We cannot tell whether Google received
 * and acted on the request before the connection died. The caller must not
 * treat a 504 as "nothing happened" — see `createCalendarEvent`'s retry note.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new CalendarWriteError("הקריאה ליומן גוגל לא ענתה בזמן", 504);
    }
    throw e;
  }
}

async function getAccessToken(): Promise<string> {
  const sa = loadServiceAccount();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    // 1 hour, Google's own maximum for this grant — this token is used once
    // and discarded, never cached across calls (one booking approval, one
    // event write; the cost of a fresh token each time is one extra POST,
    // and caching it would be the first shared mutable state in a file that
    // otherwise has none).
    exp: now + 3600,
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key);
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarWriteError(`אימות מול גוגל נכשל: ${res.status} ${body.slice(0, 200)}`, res.status);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new CalendarWriteError("גוגל לא החזיר access_token", 502);
  return data.access_token;
}

// ═══ the eventId: deterministic, derived, never Google-generated ═══
//
// Google's constraint (Events: insert reference): a client-supplied `id`
// must be base32hex — lowercase a–v and 0–9 only — 5 to 1024 characters.
// A UUID's own alphabet (hex digits plus dashes) does not qualify, so this
// re-encodes the UUID's 16 raw BYTES through the base32hex alphabet, rather
// than reusing its hex text (which would carry 'a'-'f' validly but also the
// dashes, which are not in the alphabet at all).
//
// 🔴 DETERMINISTIC ON PURPOSE — this is the whole idempotency mechanism
// (gate / owner decision 7.10, "timeout הוא לא ידוע, לא כשל"). The SAME
// booking_requests.id always produces the SAME eventId, saved to
// `calendar_event_id` BEFORE the network call. A timeout leaves us not
// knowing whether Google received it; retrying with the SAME id is always
// safe — see `createCalendarEvent`'s 409 branch — because Google itself
// refuses to create a second event under an id that already exists.
const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";

export function calendarEventIdFor(bookingRequestId: string): string {
  const hex = bookingRequestId.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32 || /[^0-9a-f]/.test(hex)) {
    throw new Error(`calendarEventIdFor: "${bookingRequestId}" אינו UUID תקין`);
  }
  const bytes = Buffer.from(hex, "hex"); // 16 bytes = 128 bits
  let bits = "";
  // index-based, not `for...of` over the Buffer — the project's TS target
  // does not have downlevel iteration enabled for it
  for (let i = 0; i < bytes.length; i++) bits += bytes[i].toString(2).padStart(8, "0");
  // 128 bits / 5 = 25.6 → 26 groups of 5, the last zero-padded. No `=`
  // padding character: that is base32's OWN padding convention and it is not
  // in Google's a–v/0–9 alphabet at all.
  while (bits.length % 5 !== 0) bits += "0";
  let out = "";
  for (let i = 0; i < bits.length; i += 5) {
    out += BASE32HEX[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out; // always 26 characters, well inside Google's 5–1024
}

// ═══ the write itself ═══

export type CreateCalendarEventInput = {
  /** from `calendarEventIdFor` — saved by the caller BEFORE this is called */
  eventId: string;
  title: string;
  /** ISO instants — the SAME start_at/end_at the booking itself was approved on */
  startIso: string;
  endIso: string;
  description?: string | null;
};

export type CreateCalendarEventResult =
  | { ok: true; dryRun: true }
  | { ok: true; dryRun: false; id: string; iCalUID: string; htmlLink: string }
  | { ok: false; error: string; status: number };

type GoogleEventResource = { id: string; iCalUID: string; htmlLink: string };

export async function createCalendarEvent(
  input: CreateCalendarEventInput
): Promise<CreateCalendarEventResult> {
  if (isCalendarDryRun()) return { ok: true, dryRun: true };

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return { ok: false, error: "GOOGLE_CALENDAR_ID לא מוגדר", status: 500 };

  try {
    const token = await getAccessToken();
    const eventsUrl = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

    const res = await fetchWithTimeout(`${eventsUrl}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: input.eventId,
        summary: input.title,
        description: input.description ?? undefined,
        start: { dateTime: input.startIso, timeZone: "Asia/Jerusalem" },
        end: { dateTime: input.endIso, timeZone: "Asia/Jerusalem" },
      }),
    });

    // 🔴 409 = an event already exists under THIS id on THIS calendar — AND
    // THAT IS SUCCESS, not a conflict to report. It means an earlier attempt
    // (ours — the id is deterministic, nobody else could have minted it)
    // already created the event, whether or not we ever saw that attempt's
    // response. Read it back so the caller still gets a real iCalUID/htmlLink
    // instead of fabricating one.
    if (res.status === 409) {
      const existing = await fetchWithTimeout(`${eventsUrl}/${encodeURIComponent(input.eventId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!existing.ok) {
        const body = await existing.text().catch(() => "");
        return {
          ok: false,
          error: `האירוע כבר קיים ביומן, אך קריאתו חזרה נכשלה: ${existing.status} ${body.slice(0, 200)}`,
          status: existing.status,
        };
      }
      const data = (await existing.json()) as GoogleEventResource;
      return { ok: true, dryRun: false, id: data.id, iCalUID: data.iCalUID, htmlLink: data.htmlLink };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        error: `יצירת האירוע ביומן נכשלה: ${res.status} ${body.slice(0, 300)}`,
        status: res.status,
      };
    }
    const data = (await res.json()) as GoogleEventResource;
    return { ok: true, dryRun: false, id: data.id, iCalUID: data.iCalUID, htmlLink: data.htmlLink };
  } catch (e) {
    if (e instanceof CalendarWriteError) return { ok: false, error: e.message, status: e.status };
    return { ok: false, error: e instanceof Error ? e.message : "שגיאת רשת לא ידועה", status: 500 };
  }
}

// ═══ the delete — the ONE place, guarded (owner decision 11.10) ═══

export type CalendarDeletionInput = {
  bookingId: string;
  /** `booking_requests.calendar_event_id` exactly as stored */
  calendarEventId: string | null;
  /** `booking_requests.calendar_write_status` exactly as stored */
  calendarWriteStatus: string | null;
};

export type DeletionVerdict =
  | { ok: true; eventId: string }
  | { ok: false; reason: "not-created" | "no-id" | "id-mismatch" | "bad-booking-id" };

/**
 * May the system delete this booking's event? PURE — the guard itself.
 *
 * Only an event THIS CODE wrote: the row says the write succeeded, and the id
 * stored on it is the deterministic one derived from the booking's own id. An
 * id that merely looks valid but was not derived from this booking — a typo, a
 * hand-edited row, another event's id — is refused, because deleting it could
 * delete somebody else's recording.
 */
export function calendarDeletionAllowed(input: CalendarDeletionInput): DeletionVerdict {
  if (input.calendarWriteStatus !== "created") return { ok: false, reason: "not-created" };
  if (!input.calendarEventId) return { ok: false, reason: "no-id" };
  let expected: string;
  try {
    expected = calendarEventIdFor(input.bookingId);
  } catch {
    return { ok: false, reason: "bad-booking-id" };
  }
  if (input.calendarEventId !== expected) return { ok: false, reason: "id-mismatch" };
  return { ok: true, eventId: expected };
}

export type DeleteCalendarEventResult =
  | { ok: true; dryRun: boolean; alreadyGone: boolean }
  | { ok: false; refused: true; reason: Extract<DeletionVerdict, { ok: false }>["reason"] }
  | { ok: false; refused: false; error: string; status: number };

/**
 * Delete ONE event this system created. THE ONLY DELETE IN THE CODEBASE.
 *
 * Order: the guard, then the dry-run switch, then the network. A refused id
 * never reaches the network in either mode; a dry run records and deletes
 * nothing (rule 40 — `CALENDAR_WRITE_DRY_RUN` defaults ON).
 *
 * 410 / 404 from Google = the event is already gone = SUCCESS: the goal is
 * "no such event in the calendar", and it holds.
 */
export async function deleteSystemCalendarEvent(input: CalendarDeletionInput): Promise<DeleteCalendarEventResult> {
  const verdict = calendarDeletionAllowed(input);
  if (!verdict.ok) return { ok: false, refused: true, reason: verdict.reason };

  if (isCalendarDryRun()) return { ok: true, dryRun: true, alreadyGone: false };

  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return { ok: false, refused: false, error: "GOOGLE_CALENDAR_ID לא מוגדר", status: 500 };

  try {
    const token = await getAccessToken();
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(verdict.eventId)}`;
    const res = await fetchWithTimeout(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 410 || res.status === 404) return { ok: true, dryRun: false, alreadyGone: true };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, refused: false, error: `המחיקה מהיומן נכשלה: ${res.status} ${body.slice(0, 300)}`, status: res.status };
    }
    return { ok: true, dryRun: false, alreadyGone: false };
  } catch (e) {
    if (e instanceof CalendarWriteError) return { ok: false, refused: false, error: e.message, status: e.status };
    return { ok: false, refused: false, error: e instanceof Error ? e.message : "שגיאת רשת לא ידועה", status: 500 };
  }
}
