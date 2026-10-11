import { createHash, randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { resolveRegistrationLink } from "./links";
import { lockedNumberTampered, validateRegistration, type FieldErrors } from "./validate";
import { ACTIVE_CLIENT, PENDING_CLIENT } from "@/lib/clients/status";
import { notifyClientRegistration } from "@/lib/whatsapp/notify";
import { PRIVACY_UPDATED_AT } from "@/lib/legal/privacy";

// ═══════════════════════════════════════════════════════════════════════════
// One registration submission, end to end (E17-4). The route is a thin wrapper:
// it reads the body and the IP and returns what this decides.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ THE OUTCOMES, AND WHAT THE VISITOR SEES ═══
//   thanks   — new registration, matched to an existing card, OR a honeypot
//              hit. ONE screen for all three: the page must not reveal that a
//              ח.פ belongs to an existing client of Bizi, nor that a bot was
//              spotted.
//   dead     — the link is unknown / expired / used / revoked, or a bot link's
//              locked number was tampered with. ONE screen, no reason given.
//   invalid  — field errors, so the visitor can fix them. Only reachable with
//              a live link.
//   slow     — rate-limited. "Try again later", no detail.
//   error    — the database refused something unexpected.
//
// ═══ 🔴 THE PENDING ROW AND THE UNIQUE NAME ═══
// `clients.normalized_name` is UNIQUE (0001) and a registration may carry the
// name of an existing client (owner: a same name never blocks a
// registration). The pending row is therefore written with
//     normalized_name = "pending:<registration id>"
// — always, not only on a collision. A marker that is always there is simpler
// than one that appears sometimes, it can never collide, and it means a
// pending row never occupies a real name: creating an ordinary client of the
// same name meanwhile still works. `name` keeps exactly what the client typed.
// On approval (E17-5) the admin sets the final name and the real
// normalized_name is written then — where the unique index asks the admin, not
// the client, to resolve a clash. Nothing reads normalized_name of a pending
// row: every name match runs on active clients only (E17-3).
//
// ═══ AND THE ח.פ STAYS OFF THE PENDING ROW ═══
// `clients.tax_id` is UNIQUE too (0107). It is written on approval, not here:
// two registrations with one number (a client who registered twice, a
// typo'd number that hits someone else's) must both land in front of the
// admin rather than the second failing on an index. The number lives on the
// registration row until then.
//
// ═══ ONE-TIME, BY THE DATABASE ═══
// `client_registrations_link_key` (0107: unique on link_id) is the real
// single-use guarantee. `used_at` is written after, for the link's own state;
// a double submit races into the index, loses, and gets the dead screen.

/** Per IP, per link, within the window (owner: basic spam protection). */
export const RATE_WINDOW_MS = 15 * 60 * 1000;
export const RATE_MAX_PER_IP = 10;
export const RATE_MAX_PER_LINK = 5;

export type SubmitOutcome =
  | { kind: "thanks" }
  | { kind: "dead" }
  | { kind: "invalid"; errors: FieldErrors }
  | { kind: "slow" }
  | { kind: "error" };

/** Never the raw IP in the database: a salted hash is enough to count with. */
export function hashIp(ip: string | null): string {
  return createHash("sha256").update(`bizi-join:${ip ?? "unknown"}`).digest("hex").slice(0, 32);
}

/** The first hop of x-forwarded-for, else x-real-ip, else null. PURE. */
export function clientIpFrom(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || null;
}

export async function submitRegistration(
  admin: SupabaseClient<Database>,
  input: { token: string; body: Record<string, unknown>; ip: string | null; now: Date }
): Promise<SubmitOutcome> {
  const { body, now } = input;

  const state = await resolveRegistrationLink(admin, input.token, now);
  if (state.status !== "ok") return { kind: "dead" };
  const link = state.link;

  // ── rate limit: count first, then record this attempt ──────────────────
  const ipHash = hashIp(input.ip);
  const since = new Date(now.getTime() - RATE_WINDOW_MS).toISOString();
  const [byIp, byLink] = await Promise.all([
    admin
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "registration_submit_attempt")
      .eq("payload->>ip_hash", ipHash)
      .gte("created_at", since),
    admin
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "registration_submit_attempt")
      .eq("entity_id", link.id)
      .gte("created_at", since),
  ]);
  // A failed count is a refusal, not a pass — the brake must not open by error.
  if (byIp.error || byLink.error) return { kind: "error" };
  if ((byIp.count ?? 0) >= RATE_MAX_PER_IP || (byLink.count ?? 0) >= RATE_MAX_PER_LINK) {
    return { kind: "slow" };
  }
  await admin.from("events").insert({
    entity_type: "registration_link",
    entity_id: link.id,
    event_type: "registration_submit_attempt",
    payload: { ip_hash: ipHash },
  });

  // ── honeypot: a filled hidden field is a bot. Thank it and keep nothing. ─
  if (typeof body.website === "string" && body.website.trim() !== "") {
    await admin.from("events").insert({
      entity_type: "registration_link",
      entity_id: link.id,
      event_type: "registration_honeypot",
      payload: { ip_hash: ipHash },
    });
    return { kind: "thanks" };
  }

  // ── a bot link's first number is locked to the number that asked ─────────
  if (link.wa_id && lockedNumberTampered(body, link.wa_id)) return { kind: "dead" };

  const v = validateRegistration(body, link.wa_id);
  if (!v.ok) return { kind: "invalid", errors: v.errors };
  const r = v.value;

  // ── duplicate: an ACTIVE client with this ח.פ (Morning is asked at approval, E17-5)
  const { data: match, error: matchErr } = await admin
    .from("clients")
    .select("id,name")
    .eq("status", ACTIVE_CLIENT)
    .eq("tax_id", r.taxId)
    .maybeSingle();
  if (matchErr) return { kind: "error" };

  const registrationId = randomUUID();
  const source = link.wa_id ? "bot" : "web";
  const base = {
    id: registrationId,
    source,
    link_id: link.id,
    legal_name: r.legalName,
    tax_id: r.taxId,
    contact_name: r.contactName,
    emails: r.emails,
    phone: r.phone,
    address: r.address,
    podcast_name: r.podcastName,
    booking_wa_id_1: r.booking1.waId,
    booking_name_1: r.booking1.name,
    // a bot link proved the first number: it messaged us from it
    booking_wa_id_1_verified: !!link.wa_id,
    booking_wa_id_2: r.booking2?.waId ?? null,
    booking_name_2: r.booking2?.name ?? null,
    booking_wa_id_2_verified: false,
    privacy_accepted_at: now.toISOString(),
    privacy_version: PRIVACY_UPDATED_AT,
  };

  let pendingClientId: string | null = null;
  if (match) {
    const { error } = await admin.from("client_registrations").insert({
      ...base,
      status: "duplicate",
      client_id: null,
      duplicate_of_client_id: match.id,
    });
    if (error) return (error as { code?: string }).code === "23505" ? { kind: "dead" } : { kind: "error" };
  } else {
    const { data: created, error: cErr } = await admin
      // clients-status: an insert — the one place a client is born `pending` (E17-4)
      .from("clients")
      .insert({ name: r.legalName, normalized_name: `pending:${registrationId}`, status: PENDING_CLIENT })
      .select("id")
      .single();
    if (cErr || !created) return { kind: "error" };
    pendingClientId = created.id;

    const { error } = await admin
      .from("client_registrations")
      .insert({ ...base, status: "pending", client_id: pendingClientId });
    if (error) {
      // no half-state: the pending client goes with the registration it was for
      // clients-status: a delete by id — the row inserted three lines above
      await admin.from("clients").delete().eq("id", pendingClientId);
      return (error as { code?: string }).code === "23505" ? { kind: "dead" } : { kind: "error" };
    }
  }

  await admin.from("registration_links").update({ used_at: now.toISOString() }).eq("id", link.id).is("used_at", null);

  await admin.from("events").insert({
    entity_type: "client_registration",
    entity_id: registrationId,
    event_type: match ? "client_registration_duplicate" : "client_registration_created",
    payload: { source, client_id: pendingClientId, duplicate_of_client_id: match?.id ?? null },
  });

  await notifyClientRegistration(admin, {
    event: match ? "duplicate" : "new",
    subjectId: registrationId,
    registrationId,
    name: r.legalName,
    podcast: r.podcastName,
    waId: r.booking1.waId,
    details: match
      ? `התאמה לכרטיס קיים: ${match.name} (לפי ח.פ)`
      : `${source === "bot" ? "נרשם דרך הבוט" : "נרשם דרך קישור ידני"} · לא נמצאה התאמה`,
  });

  return { kind: "thanks" };
}
