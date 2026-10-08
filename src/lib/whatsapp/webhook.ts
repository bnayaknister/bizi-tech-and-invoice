import { createHmac, timingSafeEqual } from "node:crypto";
import type { Json } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// Everything the WhatsApp webhook DECIDES. PURE — no fetch, no client, no
// Date.now(), no env read. E9-1.
// ═══════════════════════════════════════════════════════════════════════════
//
// The split is the same one `lib/booking/request.ts` made, for the same
// reason, and it matters more here: this is an endpoint a STRANGER can reach,
// it is the first inbound webhook in the whole application, and F19 is open —
// so the code that decides whether a request is authentic has to be assertable
// without a database, without a network and without Meta.
//
// Every secret is a PARAMETER. Nothing in this file reads `process.env`: the
// route passes the values in, which is what lets the suite run the real
// signature check against a known key and a known body.
//
// ═══ 🟢 THE PRIMITIVES ARE NOT NEW, THE DIRECTION IS ═══
// `createHmac` + `timingSafeEqual` with a length guard is already in this
// codebase, in `lib/documents/overrideTicket.ts:55,93-97`. But that module
// signs a ticket for ITSELF and verifies its own signature; this one verifies
// a signature computed by somebody else over a body we did not write. That is
// a different threat model, and the two differences are handled below:
//   · the signature covers the RAW body, byte for byte — see verifyWebhookSignature
//   · a missing secret is a REFUSAL, never a pass — see the `no-secret` branch

/** Meta sends the signature as `sha256=<hex>`. */
const SIG_PREFIX = "sha256=";

// ─── the GET handshake ──────────────────────────────────────────────────────

export type HandshakeVerdict =
  | { ok: true; challenge: string }
  | { ok: false; reason: "no-token" | "wrong-mode" | "bad-token" | "no-challenge" };

/**
 * Meta's subscription handshake: `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`.
 * We must echo the challenge VERBATIM, as plain text, or the subscription is
 * never created.
 *
 * ⚠️ THE TOKEN IS COMPARED IN CONSTANT TIME, like the signature. It is a
 * shared secret of our own choosing and the handshake is reachable by anyone;
 * a byte-by-byte `===` on a secret is the same leak here as anywhere else, and
 * the comparison costs nothing.
 *
 * ⚠️ AND AN UNSET TOKEN REFUSES. `no-token` rather than "accept anything": a
 * deployment where the variable was forgotten must not confirm a subscription
 * to whoever asks first. This is the `CRON_SECRET` lesson stated as code —
 * that variable was never set on the project and every cron invocation 401'd
 * silently for a week (`api/calendar/sync/route.ts:45-46`). A missing secret
 * is a configuration failure, and it has to fail loudly in the one direction
 * that cannot be exploited.
 */
export function verifyHandshake(
  params: URLSearchParams,
  verifyToken: string | null | undefined
): HandshakeVerdict {
  const expected = (verifyToken ?? "").trim();
  if (expected === "") return { ok: false, reason: "no-token" };

  if (params.get("hub.mode") !== "subscribe") return { ok: false, reason: "wrong-mode" };

  const got = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-token" };

  const challenge = params.get("hub.challenge");
  // A correct token with no challenge is not something to echo. Refused rather
  // than answered with an empty body, which Meta reads as a failed handshake
  // anyway — this way the reason is in our own logs.
  if (challenge === null || challenge === "") return { ok: false, reason: "no-challenge" };

  return { ok: true, challenge };
}

// ─── the POST signature ─────────────────────────────────────────────────────

export type SignatureVerdict =
  | { ok: true }
  | { ok: false; reason: "no-secret" | "missing" | "malformed" | "bad-signature" };

/**
 * `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the **raw request body**
 * keyed with the app secret.
 *
 * 🔴 `rawBody` MUST BE THE BODY AS IT ARRIVED. The route reads it with
 * `await request.text()` and never with `request.json()`: a parse-then-
 * re-serialize round trip changes key order, whitespace and number formatting,
 * and the HMAC is over bytes, not over meaning. Every re-serialized body fails
 * this check — and it fails in the direction that looks like an attack, which
 * is the worst way to debug it.
 *
 * ⚠️ WHY A STRING AND NOT A Buffer. `request.text()` decodes the body as UTF-8;
 * `Buffer.from(s, "utf8")` below encodes it back. For valid UTF-8 — which a
 * Meta payload is, and which is the only thing a JSON webhook may be — that
 * round trip is byte-identical, so the HMAC is computed over exactly what
 * arrived. Keeping the signature over a string is what lets the suite feed it
 * a fixture it can also read.
 *
 * ⚠️ A MISSING SECRET REFUSES EVERYTHING. `no-secret` is not "skip the check":
 * an unauthenticated webhook writes whatever a stranger posts into our
 * database. There is no useful degraded mode here, so there isn't one.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string | null | undefined
): SignatureVerdict {
  const secret = (appSecret ?? "").trim();
  if (secret === "") return { ok: false, reason: "no-secret" };

  const h = (header ?? "").trim();
  if (h === "") return { ok: false, reason: "missing" };
  if (!h.startsWith(SIG_PREFIX)) return { ok: false, reason: "malformed" };

  const hex = h.slice(SIG_PREFIX.length);
  // Shape-gated before it reaches Buffer.from: `Buffer.from("zz", "hex")` does
  // not throw, it silently yields an EMPTY buffer — which would then compare
  // equal to nothing and fall through to the length guard as a `bad-signature`
  // rather than as what it is. The explicit test says which.
  if (!/^[0-9a-f]{64}$/i.test(hex)) return { ok: false, reason: "malformed" };

  const expected = createHmac("sha256", secret).update(Buffer.from(rawBody, "utf8")).digest("hex");

  // constant-time, and length-guarded because timingSafeEqual THROWS on a
  // length mismatch rather than returning false — the exact idiom, and the
  // exact reason, as overrideTicket.ts:93-97.
  const a = Buffer.from(hex.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };

  return { ok: true };
}

// ─── the payload ────────────────────────────────────────────────────────────

/** Digits only, `+` tolerated on the way in. Meta sends `wa_id` without one. */
export function normalizeWaId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^\+/, "");
  return /^\d{6,20}$/.test(v) ? v : null;
}

export type InboundMessage = {
  /** Meta's own message id. THE de-dup key — see the route and 0101. */
  wamid: string;
  /** normalized sender, digits only; null when it could not be normalized */
  waId: string | null;
  /** the sender exactly as Meta wrote it, normalized or not */
  rawFrom: string;
  /** Meta's message type: text / button / interactive / image / … */
  type: string;
  /** the readable content, or null for a type that has none */
  body: string | null;
  /**
   * The single message object, for `wa_messages.payload` — typed as `Json`
   * because that column is `jsonb`.
   *
   * ⚠️ THE CAST IN parseInboundMessages IS SOUND, AND THIS IS WHY: every
   * value that reaches it came out of `JSON.parse` in the route, so it is a
   * JSON value by construction. The cast asserts something already true
   * rather than hiding something unknown — and keeping the field `unknown`
   * instead was what the typed client rejected (TS2345 on the upsert), which
   * is the check doing its job.
   */
  raw: Json;
};

/** 0101's cap on `body`, restated so the app truncates before the database refuses. */
export const BODY_MAX_CHARS = 8000;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The readable content of one message, by type.
 *
 * ⚠️ EXHAUSTIVE OVER WHAT CAN ARRIVE, with a null tail rather than a throw. A
 * message type Meta adds next year must be LOGGED, not lost: stage 1's whole
 * deliverable is "every message that reaches the number is recorded", and a
 * parser that refuses an unknown shape would quietly defeat it. The full
 * object still travels into `payload`, so nothing is actually discarded.
 *
 * `button` is a quick-reply press on a TEMPLATE; `interactive` is a press on a
 * free-form interactive message. Both are how stage 2's approve/decline
 * buttons will arrive, which is why they are read here rather than later: the
 * log has to be able to show the owner what they pressed.
 */
export function messageBody(message: Record<string, unknown>): string | null {
  const type = str(message.type) ?? "";
  switch (type) {
    case "text":
      return str(obj(message.text)?.body);
    case "button":
      return str(obj(message.button)?.text);
    case "interactive": {
      const i = obj(message.interactive);
      return (
        str(obj(i?.button_reply)?.title) ??
        str(obj(i?.list_reply)?.title) ??
        null
      );
    }
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker":
      return str(obj(message[type])?.caption);
    case "reaction":
      return str(obj(message.reaction)?.emoji);
    default:
      return null;
  }
}

/**
 * Every inbound MESSAGE in one webhook delivery, in arrival order.
 *
 * ⚠️ `statuses` IS DELIBERATELY IGNORED. The same `messages` field carries
 * delivery receipts (sent / delivered / read) for messages WE sent — and in
 * E9-1 we send none, so there is nothing to reconcile and a status row in the
 * message log would be a row about a message that does not exist in it.
 * Stage 2 is where they start meaning something.
 *
 * ⚠️ A MESSAGE WITHOUT AN ID IS DROPPED, and it is the only thing that is.
 * `wamid` is the de-dup key: a row without one cannot be de-duplicated, and a
 * log that can double-count its own rows is not evidence of anything. Nothing
 * else about a message can get it dropped — see messageBody.
 *
 * Defensive at every level because this object came from the network: one
 * malformed entry must not take the rest of the delivery with it.
 */
export function parseInboundMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = obj(payload);
  const entries = Array.isArray(root?.entry) ? root!.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(obj(entry)?.changes) ? (obj(entry)!.changes as unknown[]) : [];
    for (const change of changes) {
      const c = obj(change);
      // `field` is checked, not assumed: a WABA subscription can carry other
      // fields (template status updates, phone-number quality), and those are
      // not messages.
      if (str(c?.field) !== "messages") continue;
      const value = obj(c?.value);
      const messages = Array.isArray(value?.messages) ? (value!.messages as unknown[]) : [];

      for (const m of messages) {
        const message = obj(m);
        if (!message) continue;
        const wamid = str(message.id);
        if (!wamid) continue;

        const rawFrom = str(message.from) ?? "";
        const body = messageBody(message);
        out.push({
          wamid,
          waId: normalizeWaId(rawFrom),
          rawFrom,
          type: str(message.type) ?? "unknown",
          // Truncated HERE, not at the insert: 0101's CHECK would refuse the
          // row, and a refused row is a lost message. A body longer than the
          // cap is a body we keep the beginning of.
          body: body === null ? null : Array.from(body).slice(0, BODY_MAX_CHARS).join(""),
          raw: m as Json,
        });
      }
    }
  }

  return out;
}

export type WaMessageRow = {
  wamid: string;
  direction: "in";
  wa_id: string;
  type: string;
  body: string | null;
  template_name: null;
  status: "received";
  payload: Json;
};

/**
 * Parsed messages -> the rows 0101 accepts.
 *
 * ⚠️ `wa_id` FALLS BACK TO THE RAW VALUE when normalization failed, and 0101's
 * CHECK on that column is deliberately loose (1..32 chars, any text) to let it.
 * The strict digits-only rule lives in `normalizeWaId`, where it is a pure
 * function with a suite — and NOT in the column, because a column that refuses
 * an unexpected sender format turns "we logged everything" into "we logged
 * everything we recognised". A sender we cannot normalize is exactly the one
 * worth having a record of.
 *
 * The fallback is still capped, because the column is.
 */
export function toWaMessageRows(messages: InboundMessage[]): WaMessageRow[] {
  return messages.map((m) => ({
    wamid: m.wamid,
    direction: "in" as const,
    wa_id: m.waId ?? (Array.from(m.rawFrom).slice(0, 32).join("") || "unknown"),
    type: m.type,
    body: m.body,
    template_name: null,
    status: "received" as const,
    payload: m.raw,
  }));
}
