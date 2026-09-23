import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { STUDIOS } from "@/lib/calendar/studios";
import { cleanAliasFor } from "./alias";

// ═══════════════════════════════════════════════════════════════════════════
// Booking links (0096). SERVER ONLY — every function here takes a service-role
// client, because `booking_links.token` is readable by NO session role at all.
// ═══════════════════════════════════════════════════════════════════════════
//
// 0096 left the token out of the `authenticated` column grant deliberately
// (0096:224-231): the token IS the credential, and anyone who can read the
// column can book in the name of any show. So it is never selected from the
// browser, never returned to a client component except as the finished URL the
// owner asked to copy, and never logged.

/**
 * 32 bytes -> 43 url-safe characters.
 *
 * The same two lines as `@/lib/review/links:11-14`, and deliberately a COPY
 * rather than an import: that module pulls in the whole document-enqueue chain
 * (`enqueue`, `reels`) to build review links, none of which belongs in the
 * public booking path. The line is two tokens long and the comment below is
 * what keeps the two honest.
 *
 * ⚠️ NOT gen_random_uuid(): 122 bits in a guessable shape. This is 256 bits.
 */
export function generateBookingToken(): string {
  return randomBytes(32).toString("base64url");
}

export type BookingLinkState =
  | {
      status: "ok";
      link: { id: string; show_id: string };
      show: { id: string; name: string; default_studio: string | null };
    }
  | { status: "invalid" };

/**
 * Resolve a token to its live link and show, or say nothing at all.
 *
 * ⚠️ ONE RETURN VALUE FOR EVERY FAILURE, and that is a decision rather than a
 * simplification. A token that never existed, one that was revoked, and one
 * that is malformed all produce `"invalid"` — the caller cannot tell them
 * apart, therefore neither can a visitor probing the URL. Distinguishing
 * "revoked" from "unknown" would confirm to a stranger that a given token was
 * once real, which is the one bit an attacker holding a leaked list wants.
 *
 * `revoked_at is null` is applied in the QUERY, not after: a revoked row must
 * not travel out of the database at all.
 */
export async function resolveBookingLink(
  admin: SupabaseClient<Database>,
  token: string
): Promise<BookingLinkState> {
  const t = (token ?? "").trim();
  // Cheap shape gate before the round trip. The generator emits base64url, so
  // anything else cannot be one of ours; 0096's CHECK allows 20..200.
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) return { status: "invalid" };

  const { data, error } = await admin
    .from("booking_links")
    .select("id,show_id,shows(id,name,default_studio)")
    .eq("token", t)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) return { status: "invalid" };
  const show = data.shows as unknown as { id: string; name: string; default_studio: string | null } | null;
  if (!show) return { status: "invalid" };

  return {
    status: "ok",
    link: { id: data.id, show_id: data.show_id },
    show: { id: show.id, name: show.name, default_studio: show.default_studio },
  };
}

export type EnsureLinkResult =
  | { ok: true; token: string; created: boolean }
  | { ok: false; reason: "no-clean-alias" | "show-not-found" | "failed" };

/**
 * The show's live link — reusing the existing one, or minting the first.
 *
 * ⚠️ THE ALIAS GATE COMES BEFORE THE INSERT, and nothing is written when it
 * fails. A show whose every name contains a room name cannot produce a title
 * the calendar sync reads back correctly (see ./alias for the measurement), so
 * giving it a link would manufacture wrong-room productions on approval. The
 * owner adds an alias; that is the only thing that unblocks it.
 *
 * ⚠️ NO REVOCATION HERE. Replacing a leaked link is a separate, deliberate act
 * and is explicitly not part of this stage: a function that could both reuse
 * and replace would eventually replace one by accident, and every link the
 * owner has already sent would die silently.
 *
 * The partial unique index `booking_links_one_active_per_show` is the real
 * guarantee that a show has at most one live link; the select below is the
 * fast path, not the guard. If two owner clicks race, the second INSERT is
 * refused by the index and we re-read — which is why the failure path retries
 * the select rather than reporting an error.
 */
export async function ensureBookingLink(
  admin: SupabaseClient<Database>,
  showId: string,
  createdBy: string | null
): Promise<EnsureLinkResult> {
  const { data: show, error: showErr } = await admin
    .from("shows")
    .select("id,name,aliases")
    .eq("id", showId)
    .maybeSingle();
  if (showErr || !show) return { ok: false, reason: "show-not-found" };

  if (cleanAliasFor({ name: show.name, aliases: show.aliases }, STUDIOS) === null) {
    return { ok: false, reason: "no-clean-alias" };
  }

  const existing = await admin
    .from("booking_links")
    .select("token")
    .eq("show_id", showId)
    .is("revoked_at", null)
    .maybeSingle();
  if (existing.data?.token) return { ok: true, token: existing.data.token, created: false };

  const token = generateBookingToken();
  const { error: insErr } = await admin
    .from("booking_links")
    .insert({ show_id: showId, token, created_by: createdBy });

  if (insErr) {
    // Lost a race against another click: the index refused the second row, and
    // the first one is the answer. Re-read rather than report a failure.
    const retry = await admin
      .from("booking_links")
      .select("token")
      .eq("show_id", showId)
      .is("revoked_at", null)
      .maybeSingle();
    if (retry.data?.token) return { ok: true, token: retry.data.token, created: false };
    return { ok: false, reason: "failed" };
  }
  return { ok: true, token, created: true };
}
