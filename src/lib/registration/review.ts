import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { ACTIVE_CLIENT } from "@/lib/clients/status";
import { normalizeClientName } from "@/lib/clients/match";
import { isSyntheticMorningId } from "@/lib/morning/clientMapping";
import { displayWaId } from "@/lib/whatsapp/phone";
import { TEMPLATE_CLIENT_APPROVED, isTemplateApproved } from "@/lib/whatsapp/notify";
import type { MorningPort } from "./approve";

/**
 * Everything the approval screen shows for one registration (E17-5): what the
 * client gave, the form prefilled from it, and the three checks — computed on
 * the SERVER, so the screen cannot be talked out of them.
 *
 *   · ח.פ of an ACTIVE client of ours -> approval is blocked; link to the card;
 *   · the name taken                  -> ask the admin to change it;
 *   · ח.פ known to Morning            -> offer to link that Morning client
 *                                        instead of creating a new one.
 * The Morning check is a live READ (`listClients`); when Morning cannot be
 * read the screen says so — the approval itself re-checks before it writes.
 */
export type RegistrationReview = {
  id: string;
  status: string;
  source: string;
  createdAt: string;
  given: {
    legalName: string;
    taxId: string;
    contactName: string | null;
    emails: string[];
    phone: string;
    address: string | null;
    podcastName: string;
    booking: { name: string; display: string; verified: boolean }[];
    privacyVersion: string;
    privacyAcceptedAt: string;
  };
  prefill: {
    clientName: string;
    taxId: string;
    emails: string[];
    phone: string;
    address: string;
    show: { name: string; alias: string; billingMode: string; pricingModel: string; rate: string; defaultStudio: string };
    contacts: { name: string; phone: string }[];
  };
  checks: {
    taxIdActive: { id: string; name: string } | null;
    nameTaken: boolean;
    morning:
      | { status: "skipped"; reason: "has-morning-id" | "duplicate" }
      | { status: "ok"; match: { id: string; name: string } | null }
      | { status: "unavailable"; error: string };
  };
  /** the pending client already carries a Morning id from an earlier attempt */
  morningIdSaved: boolean;
  lastMorningFailure: { error: string; field: string | null; at: string } | null;
  /** a registration matched to an existing card */
  card: { id: string; name: string; shows: { id: string; name: string }[] } | null;
  /** "ההודעה תישלח ל-X" — the first authorised number, displayed */
  noticeTo: string;
  templateApproved: boolean;
  dryRun: boolean;
};

export async function loadRegistrationReview(
  admin: SupabaseClient<Database>,
  morning: MorningPort,
  id: string
): Promise<RegistrationReview | null> {
  const { data: r } = await admin.from("client_registrations").select("*").eq("id", id).maybeSingle();
  if (!r) return null;

  const booking = [
    { name: r.booking_name_1, waId: r.booking_wa_id_1, verified: r.booking_wa_id_1_verified },
    ...(r.booking_wa_id_2 && r.booking_name_2
      ? [{ name: r.booking_name_2, waId: r.booking_wa_id_2, verified: r.booking_wa_id_2_verified }]
      : []),
  ];

  // ── the checks ──────────────────────────────────────────────────────────
  const { data: taxHolder } = await admin
    .from("clients")
    .select("id,name")
    .eq("status", ACTIVE_CLIENT)
    .eq("tax_id", r.tax_id)
    .maybeSingle();

  const { data: nameHolder } = await admin
    // clients-status: every status — the unique index does not care, so neither may this check
    .from("clients")
    .select("id")
    .eq("normalized_name", normalizeClientName(r.legal_name))
    .neq("id", r.client_id ?? "00000000-0000-0000-0000-000000000000")
    .maybeSingle();

  let morningIdSaved = false;
  if (r.client_id) {
    const { data: pc } = await admin
      // clients-status: by id — this registration's own pending row
      .from("clients")
      .select("morning_client_id")
      .eq("id", r.client_id)
      .maybeSingle();
    morningIdSaved = !!pc?.morning_client_id && !isSyntheticMorningId(pc.morning_client_id);
  }

  let morningCheck: RegistrationReview["checks"]["morning"];
  if (r.status === "duplicate") morningCheck = { status: "skipped", reason: "duplicate" };
  else if (morningIdSaved) morningCheck = { status: "skipped", reason: "has-morning-id" };
  else {
    try {
      const list = await morning.listClients();
      const hit = list.find((m) => (m.taxId ?? "").replace(/[\s-]/g, "") === r.tax_id);
      morningCheck = { status: "ok", match: hit ? { id: hit.id, name: hit.name } : null };
    } catch (e) {
      morningCheck = { status: "unavailable", error: e instanceof Error ? e.message : "לא ניתן לקרוא את מורנינג" };
    }
  }

  const { data: failures } = await admin
    .from("events")
    .select("payload,created_at")
    .eq("entity_type", "client_registration")
    .eq("entity_id", r.id)
    .eq("event_type", "registration_morning_failed")
    .order("created_at", { ascending: false })
    .limit(1);
  const f = (failures ?? [])[0] as { payload: { error?: string; field?: string | null } | null; created_at: string } | undefined;

  let card: RegistrationReview["card"] = null;
  if (r.duplicate_of_client_id) {
    const [{ data: c }, { data: shows }] = await Promise.all([
      // clients-status: by id — the card this registration matched
      admin.from("clients").select("id,name").eq("id", r.duplicate_of_client_id).maybeSingle(),
      admin.from("shows").select("id,name").eq("client_id", r.duplicate_of_client_id).eq("active", true).order("name"),
    ]);
    if (c) card = { id: c.id, name: c.name, shows: (shows ?? []).map((s) => ({ id: s.id, name: s.name })) };
  }

  return {
    id: r.id,
    status: r.status,
    source: r.source,
    createdAt: r.created_at,
    given: {
      legalName: r.legal_name,
      taxId: r.tax_id,
      contactName: r.contact_name,
      emails: r.emails,
      phone: displayWaId(r.phone),
      address: r.address,
      podcastName: r.podcast_name,
      booking: booking.map((b) => ({ name: b.name, display: displayWaId(b.waId), verified: b.verified })),
      privacyVersion: r.privacy_version,
      privacyAcceptedAt: r.privacy_accepted_at,
    },
    prefill: {
      clientName: r.legal_name,
      taxId: r.tax_id,
      emails: r.emails,
      phone: displayWaId(r.phone),
      address: r.address ?? "",
      show: {
        name: r.podcast_name,
        // owner decision 11.10: prefilled from what the client wrote, editable, required
        alias: r.podcast_name,
        billingMode: "per_episode",
        pricingModel: "per_episode",
        rate: "",
        defaultStudio: "",
      },
      contacts: booking.map((b) => ({ name: b.name, phone: displayWaId(b.waId) })),
    },
    checks: { taxIdActive: taxHolder ?? null, nameTaken: !!nameHolder, morning: morningCheck },
    morningIdSaved,
    lastMorningFailure: f?.payload?.error ? { error: f.payload.error, field: f.payload.field ?? null, at: f.created_at } : null,
    card,
    noticeTo: displayWaId(r.booking_wa_id_1),
    templateApproved: isTemplateApproved(TEMPLATE_CLIENT_APPROVED),
    dryRun: morning.isDryRun(),
  };
}

/** How many registrations wait for a decision: new ones and matched ones. */
export async function pendingRegistrationCount(admin: SupabaseClient<Database>): Promise<number> {
  const { count } = await admin
    .from("client_registrations")
    .select("id", { count: "exact", head: true })
    .in("status", ["pending", "duplicate"]);
  return count ?? 0;
}
