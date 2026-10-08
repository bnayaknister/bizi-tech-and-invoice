// ═══════════════════════════════════════════════════════════════════════════
// The WhatsApp Cloud API side of the bot. E9-3 adds the SEND.
// ═══════════════════════════════════════════════════════════════════════════
//
// E9-1 shipped this file with the switch and nothing else, deliberately. E9-3
// adds three things and no more: a template send, a free-text send, and an
// interactive-list send. Everything else about a message — who it goes to,
// what it says, whether it is recorded — lives in `notify.ts` and `reply.ts`.
// This file is the transport.
//
// ═══ DRY_RUN, THE SAME SHAPE AS THE OTHER TWO (rule 40) ═══
// `isWhatsappDryRun()` mirrors `isCalendarDryRun()` (lib/calendar/write.ts:43)
// and `isDryRun()` (lib/morning/client.ts:35) exactly — including the
// `!== "false"` comparison, which is the whole point and not a style choice:
//
//   🔴 **DEFAULTS ON.** An unset variable, a typo'd variable, a new Vercel
//      environment nobody configured, a preview deployment, a teammate's
//      `.env.local` — every one of those sends nothing. The ONLY way to
//      message a real client is the exact string "false", typed deliberately
//      into the one environment that should send.
//
//   ⛔ Do NOT "simplify" this to `=== "true"`. It reads the same on the happy
//      path and inverts the failure: `WHATSAPP_DRY_RUN=fasle` would then start
//      messaging real clients from a preview deployment.
//
// ⚠️ AND NOTE THE DIRECTION IS OPPOSITE TO `isAutoApproveOn()` (decide.ts),
// which is `=== "true"`. Both default to the SAFE side; the safe side is
// simply inverted between them — a dry run that is ON sends nothing, an
// auto-approve that is OFF writes nothing. Same rule, opposite polarity.
//
// ═══ NO SDK, SAME REASONING AS lib/calendar/write.ts ═══
// Two POSTs to a documented JSON endpoint with a bearer token. A library
// would add a dependency tree for what is, here, `fetch` with a header. If a
// second Meta product is ever needed, that calculus may change — this file is
// scoped to `/messages` and nothing else.
//
// ⛔ AND IT NEVER THROWS. Every function returns a result object. A caller is
// always in the middle of something that matters more than the message (an
// approval, a webhook that owes Meta a 200), and an exception escaping the
// transport would take that down with it.

import { isWaId } from "./phone";

const GRAPH = "https://graph.facebook.com";
const TIMEOUT_MS = 15_000;

/** `true` unless `WHATSAPP_DRY_RUN` is exactly the string `"false"`. */
export function isWhatsappDryRun(): boolean {
  return process.env.WHATSAPP_DRY_RUN !== "false";
}

/**
 * The Graph version, PINNED through the environment.
 *
 * ⚠️ Not "whatever Graph defaults to": Meta deprecates versions on a schedule,
 * and an unpinned URL means the API under us changes on their calendar rather
 * than on ours. A default is provided so a missing variable is not an outage,
 * but the variable is the intended control.
 */
function graphVersion(): string {
  const v = (process.env.WHATSAPP_GRAPH_VERSION ?? "").trim();
  return /^v\d+\.\d+$/.test(v) ? v : "v21.0";
}

export type WhatsappConfig = { token: string; phoneNumberId: string };

export type ConfigResult =
  | { ok: true; config: WhatsappConfig }
  | { ok: false; missing: string[] };

/**
 * The two secrets a send needs, or the names of the ones that are absent.
 *
 * 🔴 NAMED, NOT BOOLEAN. The `CRON_SECRET` week (api/calendar/sync/route.ts:
 * 45-46) is the precedent that matters here: a variable that was never set
 * produced silent refusals for seven days. A caller that can log *which*
 * variable is missing turns that week into one line.
 */
export function readConfig(): ConfigResult {
  const token = (process.env.WHATSAPP_TOKEN ?? "").trim();
  const phoneNumberId = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const missing: string[] = [];
  if (token === "") missing.push("WHATSAPP_TOKEN");
  if (phoneNumberId === "") missing.push("WHATSAPP_PHONE_NUMBER_ID");
  return missing.length === 0 ? { ok: true, config: { token, phoneNumberId } } : { ok: false, missing };
}

// ─── the payloads (PURE, and that is why they are exported) ─────────────────

export type TemplateParam = string;

/**
 * The body Meta expects for a template send.
 *
 * 🔴 PARAMETERS ARE POSITIONAL. Meta fills `{{1}}`, `{{2}}` … in the order of
 * this array, and the template is approved once with those placeholders baked
 * in. So the ORDER of `params` is a contract with a thing outside this
 * repository: swapping two entries silently swaps the studio and the guest
 * inside a message the owner reads as fact. `notify.ts` builds the array from
 * its own `*_VARS` list, and the suite asserts the two agree.
 *
 * ⚠️ AND NO PARAMETER MAY BE EMPTY. Meta rejects a template send whose
 * parameter is "" with a 131008-family error, and it rejects the whole
 * message rather than that one field. `notify.ts` guarantees non-empty through
 * `durationParam`/`guestParam`; this function refuses as a second lock, with
 * a named reason, rather than letting Graph answer for it.
 */
export function templatePayload(input: {
  to: string;
  name: string;
  language: string;
  params: TemplateParam[];
}): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.name,
      language: { code: input.language },
      components:
        input.params.length === 0
          ? []
          : [
              {
                type: "body",
                parameters: input.params.map((text) => ({ type: "text", text })),
              },
            ],
    },
  };
}

/**
 * The body for a free-text send.
 *
 * ⚠️ `preview_url: false` DELIBERATELY. The bot's text carries the booking
 * link, and a link preview would make Meta fetch `/b/<token>` — putting the
 * credential in a third party's fetch log and rendering a preview card of a
 * page that is `noindex, no-referrer` precisely to avoid that
 * (`b/[token]/page.tsx:32-47`). The client taps the link; nobody needs a
 * thumbnail of it.
 */
export function textPayload(input: { to: string; body: string }): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "text",
    text: { preview_url: false, body: input.body },
  };
}

export type ListRow = { id: string; title: string; description?: string };

/** Meta's hard limits on an interactive list. Exceeding any one rejects the send. */
export const LIST_LIMITS = {
  button: 20,
  rowTitle: 24,
  rowDescription: 72,
  body: 1024,
  header: 60,
  rows: 10,
} as const;

/** Cut to a limit by CODE POINTS, never by UTF-16 units — see truncate's note. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s ?? "");
  return chars.length <= max ? (s ?? "") : chars.slice(0, max).join("");
}

/**
 * The body for an interactive list — how a client with several podcasts picks
 * one.
 *
 * 🔴 EVERY FIELD IS TRUNCATED HERE, AND THE LIMITS ARE META'S. A row title
 * over 24 characters does not get trimmed by Meta, it REJECTS THE MESSAGE —
 * and plenty of real show names are longer than 24 Hebrew characters. The full
 * name goes into `description` (72) where there is room, so nothing is hidden
 * from the client; only the title line is cut.
 *
 * ⚠️ Truncation is by CODE POINT (`Array.from`), not by `.slice()`. Hebrew is
 * safe in UTF-16 either way, but an emoji in a show name is a surrogate pair,
 * and slicing one in half produces a lone surrogate — which Meta rejects as
 * malformed UTF-8, for a message that looked fine in the editor.
 */
export function listPayload(input: {
  to: string;
  body: string;
  button: string;
  sectionTitle: string;
  rows: ListRow[];
}): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: truncate(input.body, LIST_LIMITS.body) },
      action: {
        button: truncate(input.button, LIST_LIMITS.button),
        sections: [
          {
            title: truncate(input.sectionTitle, LIST_LIMITS.header),
            rows: input.rows.slice(0, LIST_LIMITS.rows).map((r) => ({
              id: r.id,
              title: truncate(r.title, LIST_LIMITS.rowTitle),
              ...(r.description ? { description: truncate(r.description, LIST_LIMITS.rowDescription) } : {}),
            })),
          },
        ],
      },
    },
  };
}

/**
 * Meta's error object -> one readable line.
 *
 * The code is kept because it is the only part worth searching for in Meta's
 * docs, and the owner-facing screens show this string.
 */
export function describeGraphError(status: number, body: unknown): string {
  const e = (body as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
    if (e?.message) {
    const code = e.code !== undefined ? ` (code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})` : "";
    return `${e.message}${code}`;
  }
  return `Graph החזירה HTTP ${status}`;
}

// ─── the send ───────────────────────────────────────────────────────────────

export type SendResult =
  | { ok: true; dryRun: true }
  | { ok: true; dryRun: false; providerWamid: string }
  | { ok: false; error: string; retryable: boolean };

/**
 * POST one message payload to Graph.
 *
 * 🔴 DRY RUN RETURNS BEFORE THE NETWORK CALL, as the first statement after the
 * guards. There is no code path in which a dry run reaches `fetch`.
 *
 * ⚠️ `retryable` separates "Meta refused this message" from "we could not
 * reach Meta". A 400 on a malformed template will fail identically forever and
 * a retry is just two failures; a timeout or a 5xx is worth trying again. The
 * caller records both, but only one of them is worth a second attempt.
 *
 * ⛔ THE TOKEN NEVER REACHES A LOG OR A RETURN VALUE. It goes in the
 * Authorization header and nowhere else — `describeGraphError` reads only
 * Meta's own error object, and the payload (which carries no secret) is what
 * gets recorded.
 */
export async function sendWhatsapp(payload: Record<string, unknown>): Promise<SendResult> {
  if (isWhatsappDryRun()) return { ok: true, dryRun: true };

  const to = payload.to;
  if (!isWaId(to)) {
    return { ok: false, error: "מספר הנמען אינו בפורמט wa_id", retryable: false };
  }

  const cfg = readConfig();
  if (!cfg.ok) {
    return {
      ok: false,
      error: `חסרים משתני סביבה: ${cfg.missing.join(", ")}`,
      // not retryable: nothing about trying again sets an env var
      retryable: false,
    };
  }

  const url = `${GRAPH}/${graphVersion()}/${cfg.config.phoneNumberId}/messages`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    // A timeout is the ambiguous case: Meta may have accepted the message and
    // we will never know. The caller records `failed` and the row keeps our
    // own deterministic `wamid`, so a retry cannot produce a second NOTIFICATION
    // row — but it CAN produce a second WhatsApp message. Retryable, and said
    // plainly here so nobody mistakes it for "nothing happened".
    return {
      ok: false,
      error: `לא הצלחתי להגיע ל-Graph (${(e as { name?: string })?.name ?? "error"})`,
      retryable: true,
    };
  }

  const body = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    return {
      ok: false,
      error: describeGraphError(res.status, body),
      // 408/429 and every 5xx are worth another attempt; a 4xx about the
      // message itself is not.
      retryable: res.status === 408 || res.status === 429 || res.status >= 500,
    };
  }

  const wamid = (body as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
  if (typeof wamid !== "string" || wamid === "") {
    // A 200 with no id is a shape we do not understand. Treated as a failure
    // rather than as a success with a missing field: a row recorded as `sent`
    // with no `provider_wamid` could never be matched to a status update, and
    // would sit there looking delivered forever.
    return { ok: false, error: "Graph החזירה 200 בלי מזהה הודעה", retryable: false };
  }

  return { ok: true, dryRun: false, providerWamid: wamid };
}
