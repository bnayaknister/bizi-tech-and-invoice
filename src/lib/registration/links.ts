import { randomBytes } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

// ═══════════════════════════════════════════════════════════════════════════
// Registration links (0107 `registration_links`, E17-4). SERVER ONLY — the
// token column is readable by no session role (0107 §7), so every function
// here takes a service-role client.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner decisions 11.10:
//   · valid for 7 days, single use;
//   · ONE live link per number — the bot hands the same link back to a number
//     that asks again;
//   · a link that expired, was used, was revoked or never existed gets ONE
//     screen that does not say which (same rule as `resolveBookingLink`).
//
// ⚠️ "One live link per number" is enforced HERE, by reading before minting.
// 0107 carries no partial unique index for it, so two inbound messages from
// one number in the same instant could mint two. Both are valid, single-use,
// and expire in a week; the second simply goes unused. That is the whole cost,
// and it is stated rather than papered over with a migration this stage may
// not write.

export const REGISTRATION_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 bytes -> 43 url-safe characters. Same generator as booking links. */
export function generateRegistrationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function registrationUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/join/${token}`;
}

export type RegistrationLink = { id: string; wa_id: string | null; expires_at: string };

export type RegistrationLinkState = { status: "ok"; link: RegistrationLink } | { status: "invalid" };

/** Live = not used, not revoked, not expired. PURE. */
export function isLinkLive(
  row: { used_at: string | null; revoked_at: string | null; expires_at: string },
  now: Date
): boolean {
  return !row.used_at && !row.revoked_at && new Date(row.expires_at).getTime() > now.getTime();
}

/**
 * Token -> live link, or "invalid" for every other case. ONE value for unknown,
 * malformed, expired, used and revoked: a visitor probing tokens learns
 * nothing from the difference, because there is none.
 */
export async function resolveRegistrationLink(
  admin: SupabaseClient<Database>,
  token: string,
  now: Date
): Promise<RegistrationLinkState> {
  const t = (token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(t)) return { status: "invalid" };
  const { data, error } = await admin
    .from("registration_links")
    .select("id,wa_id,expires_at,used_at,revoked_at")
    .eq("token", t)
    .maybeSingle();
  if (error || !data) return { status: "invalid" };
  if (!isLinkLive(data, now)) return { status: "invalid" };
  return { status: "ok", link: { id: data.id, wa_id: data.wa_id, expires_at: data.expires_at } };
}

/**
 * The bot's link for one number: the live one if there is one, else a new one.
 * Returns the token, which only ever leaves as the finished URL in the reply.
 */
export async function ensureRegistrationLinkForWaId(
  admin: SupabaseClient<Database>,
  waId: string,
  now: Date
): Promise<{ ok: true; token: string; created: boolean } | { ok: false }> {
  const { data: rows, error } = await admin
    .from("registration_links")
    .select("id,token,expires_at,used_at,revoked_at")
    .eq("wa_id", waId)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { ok: false };
  const live = (rows ?? []).find((r) => isLinkLive(r, now));
  if (live) return { ok: true, token: live.token, created: false };

  const token = generateRegistrationToken();
  const { error: insErr } = await admin.from("registration_links").insert({
    token,
    wa_id: waId,
    created_by: null,
    expires_at: new Date(now.getTime() + REGISTRATION_LINK_TTL_MS).toISOString(),
  });
  if (insErr) return { ok: false };
  return { ok: true, token, created: true };
}

/** A manual link for the general page: no number, minted by a studio_admin. */
export async function createManualRegistrationLink(
  admin: SupabaseClient<Database>,
  createdBy: string,
  now: Date
): Promise<{ ok: true; token: string; linkId: string; expiresAt: string } | { ok: false }> {
  const token = generateRegistrationToken();
  const expiresAt = new Date(now.getTime() + REGISTRATION_LINK_TTL_MS).toISOString();
  const { data, error } = await admin
    .from("registration_links")
    .insert({ token, wa_id: null, created_by: createdBy, expires_at: expiresAt })
    .select("id")
    .single();
  if (error || !data) return { ok: false };
  return { ok: true, token, linkId: data.id, expiresAt };
}
