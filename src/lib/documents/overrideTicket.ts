import { createHmac, timingSafeEqual } from "node:crypto";

// The two-step consent ticket for an admin override (owner decision
// 2026-08-22).
//
// WHY A TICKET AND NOT A `confirm: true` FLAG. The existing double-confirm
// idiom in this codebase (morning/clients `confirm_shared`) is a boolean the
// caller sets, which means a client that hard-codes it true overrides silently,
// forever, and nothing in the system can tell that apart from a human who read
// the warning and agreed. On a 295,000 ₪ document with no PUT to undo it, "we
// would see it in the audit afterwards" is not the same as "it cannot happen".
//
// So the first call REFUSES and hands back a ticket that commits to the exact
// facts it warned about; the second call must echo it. The ticket is an HMAC
// over those facts, so a caller cannot mint one without having received the
// warning first. Hard-coding is not merely discouraged — there is nothing to
// hard-code.
//
// WHAT THE TICKET BINDS. Document, net, actor, and a time window. Changing any
// of them invalidates it:
//   • document — a ticket for one document can never approve another
//   • net      — if the parent is re-pulled and its amount moved between the
//                warning and the confirmation, the ticket dies. The operator
//                agreed to a NUMBER, not to a document
//   • actor    — one person's consent is not another's
//   • window   — consent is a moment, not a standing permission
//
// NO STORAGE, NO MIGRATION. The ticket carries its own facts and the signature
// proves them; there is nothing to persist and nothing to clean up. It is also
// deliberately NOT a capability that survives a restart of intent: TTL below.
//
// THE KEY. Derived from SUPABASE_SERVICE_ROLE_KEY, which is server-only, always
// present wherever this route can run, and never shipped to a browser. Derived
// rather than used raw so this signature can never be confused with, or
// replayed against, anything else that key is used for.

const TICKET_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough to read, short enough not to be a standing grant
const DOMAIN = "bizi:pull-ceiling-override:v1";

export type TicketFacts = {
  documentId: string;
  /** the PROVEN net, from the mapper — never a number the caller supplied */
  net: number;
  actorId: string;
};

function key(): string | null {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return k && k.length > 0 ? k : null;
}

function sign(payload: string): string | null {
  const k = key();
  if (!k) return null;
  return createHmac("sha256", `${DOMAIN}:${k}`).update(payload).digest("hex");
}

/**
 * Mint a ticket for the facts the caller was just warned about.
 * Returns null when no server key is available — the caller must then refuse
 * the override entirely rather than fall back to an unsigned confirmation.
 */
export function mintOverrideTicket(f: TicketFacts, now: number = Date.now()): string | null {
  // net is fixed to agorot so a float round-trip through JSON cannot shift it
  const body = `${f.documentId}|${Math.round(f.net * 100)}|${f.actorId}|${now}`;
  const sig = sign(body);
  return sig ? `${body}|${sig}` : null;
}

export type TicketVerdict =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" | "mismatch" | "no-key" };

/**
 * Verify a ticket against the facts of the request being made NOW — not
 * against what the ticket claims. The ticket is only trusted to say "this
 * person was shown these numbers"; whether those are still the numbers is
 * re-derived by the caller and passed in here.
 */
export function verifyOverrideTicket(
  ticket: string | null | undefined,
  f: TicketFacts,
  now: number = Date.now()
): TicketVerdict {
  if (!key()) return { ok: false, reason: "no-key" };
  if (typeof ticket !== "string" || !ticket) return { ok: false, reason: "malformed" };
  const parts = ticket.split("|");
  if (parts.length !== 5) return { ok: false, reason: "malformed" };
  const [documentId, netAgorot, actorId, issuedAt, sig] = parts;

  const expected = sign(`${documentId}|${netAgorot}|${actorId}|${issuedAt}`);
  if (!expected) return { ok: false, reason: "no-key" };
  // constant-time, and length-guarded because timingSafeEqual throws on a
  // length mismatch rather than returning false
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };

  const ts = Number(issuedAt);
  if (!Number.isFinite(ts) || now - ts > TICKET_TTL_MS || ts > now + 60_000) {
    return { ok: false, reason: "expired" };
  }

  // the facts must still be the facts
  if (
    documentId !== f.documentId ||
    actorId !== f.actorId ||
    netAgorot !== String(Math.round(f.net * 100))
  ) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}

export const OVERRIDE_TICKET_TTL_MS = TICKET_TTL_MS;
