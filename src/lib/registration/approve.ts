import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { ACTIVE_CLIENT } from "@/lib/clients/status";
import { normalizeClientName } from "@/lib/clients/match";
import { isSyntheticMorningId } from "@/lib/morning/clientMapping";
import { normalizeEmail, normalizeTaxId, LIMITS } from "./validate";
import { toWaId, PHONE_ERROR } from "@/lib/whatsapp/phone";
import {
  TEMPLATE_CLIENT_APPROVED,
  isTemplateApproved,
  recordBookingNotification,
  registrationNoticeVariables,
} from "@/lib/whatsapp/notify";
import { loadLang, templateLanguageFor } from "@/lib/whatsapp/lang";

// ═══════════════════════════════════════════════════════════════════════════
// E17-5 — approving a registration. The order of operations IS the design.
// ═══════════════════════════════════════════════════════════════════════════
//
// Two promises the owner asked for, and how this order keeps both:
//   (1) NEVER an active client without a Morning id;
//   (2) "נסה שוב" is safe to repeat — it never creates a second Morning client.
//
//   1. local checks           — ח.פ of an ACTIVE client (block, link to the
//                               card); the final name taken (ask to change).
//   2. the Morning id, in this order:
//        a. the pending row already carries one (a previous attempt got this
//           far) -> use it, and DO NOT CALL MORNING AT ALL;
//        b. the admin chose to link an existing Morning client -> use it;
//        c. a Morning client with this ח.פ exists -> STOP and offer to link;
//        d. otherwise create one.
//      Dry run (MORNING_DRY_RUN, B23): stop before b/d. Nothing is written,
//      the client is not activated, the screen says so.
//   3. persist that id on the PENDING client row — before anything else.
//   4. the transaction (0108 `approve_client_registration`): client active +
//      real name + ח.פ, the podcast with its alias and the first-booking flag,
//      the booking contacts, the registration approved. All or nothing. It
//      REFUSES a client with no Morning id or a `dry-` one — promise (1) is
//      enforced by the database, not only by this file.
//   5. the "approved" message to the client — only if Meta approved the
//      template; otherwise an event, and the screen says it was not sent.
//
// Failure at each step, and why a retry is safe:
//   · Morning refuses at 2d  -> nothing written; the registration stays
//     pending; the error and the field are shown; retry = 2c/2d again.
//   · 3 fails after 2d       -> the Morning client exists but we lost its id.
//     Retry: 2a finds nothing, 2c FINDS IT BY ח.פ and offers to link -> no
//     duplicate in Morning.
//   · 4 fails                -> the id is on the pending row. Retry: 2a, no
//     Morning call at all, straight to 4.
//   · 4 succeeded, the answer was lost -> retry: the function answers
//     `already: true` and nothing is done twice.

export type MorningPort = {
  isDryRun(): boolean;
  listClients(): Promise<{ id: string; name: string; taxId?: string | null }[]>;
  createClient(fields: {
    name: string;
    taxId: string;
    phone: string;
    emails: string[];
    address: string | null;
  }): Promise<{ id: string; dryRun: boolean }>;
};

export type ShowInput = {
  name: string;
  alias: string;
  billingMode: "per_episode" | "contract" | "none";
  pricingModel: "per_episode" | "per_hour";
  rate: number | null;
  defaultStudio: string | null;
};

export type ApprovalInput = {
  clientName: string;
  taxId: string;
  emails: string[];
  phone: string;
  address: string | null;
  show: ShowInput;
  contacts: { name: string; waId: string }[];
};

export type ApprovalErrors = Partial<Record<string, string>>;

const BILLING = ["per_episode", "contract", "none"] as const;
const PRICING = ["per_episode", "per_hour"] as const;

const text = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const chars = (s: string) => Array.from(s).length;

/** The podcast half — shared by approval and by "new podcast under an existing card". PURE. */
export function validateShowInput(raw: Record<string, unknown> | null | undefined, errors: ApprovalErrors): ShowInput | null {
  const r = raw ?? {};
  const name = text(r.name);
  if (name === "" || chars(name) > 200) errors.showName = "נא למלא את שם הפודקאסט.";
  const alias = text(r.alias);
  if (alias === "" || chars(alias) > 120) errors.alias = "כינוי לפודקאסט הוא שדה חובה.";
  const billingMode = BILLING.includes(r.billingMode as never) ? (r.billingMode as ShowInput["billingMode"]) : null;
  if (!billingMode) errors.billingMode = "יש לבחור אופן חיוב.";
  const pricingModel = PRICING.includes(r.pricingModel as never) ? (r.pricingModel as ShowInput["pricingModel"]) : null;
  if (!pricingModel) errors.pricingModel = "יש לבחור מודל תמחור.";
  let rate: number | null = null;
  if (r.rate !== null && r.rate !== undefined && r.rate !== "") {
    const n = Number(r.rate);
    if (!Number.isFinite(n) || n < 0) errors.rate = "התעריף צריך להיות מספר חיובי.";
    else rate = n;
  }
  const defaultStudio = text(r.defaultStudio) || null;
  if (!name || !alias || !billingMode || !pricingModel || errors.rate) return null;
  return { name, alias, billingMode, pricingModel, rate, defaultStudio };
}

/** The booking numbers: 1–2, each with a name, distinct. PURE. */
export function validateContacts(raw: unknown, errors: ApprovalErrors): { name: string; waId: string }[] | null {
  const list = Array.isArray(raw) ? raw : [];
  const out: { name: string; waId: string }[] = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const o = (c ?? {}) as Record<string, unknown>;
    const name = text(o.name);
    const phoneRaw = typeof o.phone === "string" ? o.phone.trim() : "";
    if (name === "" && phoneRaw === "" && i > 0) continue; // an empty second row is "no second number"
    if (name === "" || chars(name) > LIMITS.bookingName) {
      errors[`contact${i + 1}Name`] = "נא למלא שם למספר המורשה.";
      continue;
    }
    const p = toWaId(phoneRaw);
    if (!p.ok) {
      errors[`contact${i + 1}Phone`] = PHONE_ERROR[p.reason];
      continue;
    }
    if (out.some((x) => x.waId === p.waId)) {
      errors[`contact${i + 1}Phone`] = "המספר השני זהה לראשון.";
      continue;
    }
    out.push({ name, waId: p.waId });
  }
  if (out.length === 0 && !Object.keys(errors).some((k) => k.startsWith("contact"))) {
    errors.contact1Phone = "נדרש לפחות מספר מורשה אחד.";
  }
  if (out.length > 2) errors.contact3Phone = "עד שני מספרים מורשים.";
  return Object.keys(errors).some((k) => k.startsWith("contact")) ? null : out;
}

/** The whole approval form. PURE. */
export function validateApprovalInput(raw: Record<string, unknown>): { ok: true; value: ApprovalInput } | { ok: false; errors: ApprovalErrors } {
  const errors: ApprovalErrors = {};
  const clientName = text(raw.clientName);
  if (clientName === "" || chars(clientName) > LIMITS.legalName) errors.clientName = "נא למלא שם לקוח.";
  const taxId = normalizeTaxId(raw.taxId);
  if (!taxId) errors.taxId = "ח.פ / ע.מ / ת.ז צריך להיות 9 ספרות.";
  const emails: string[] = [];
  for (const e of Array.isArray(raw.emails) ? raw.emails : []) {
    if (typeof e !== "string" || e.trim() === "") continue;
    const n = normalizeEmail(e);
    if (!n) errors.emails = "כתובת מייל לא תקינה.";
    else if (!emails.includes(n)) emails.push(n);
  }
  if (emails.length === 0 && !errors.emails) errors.emails = "נדרשת לפחות כתובת מייל אחת.";
  if (emails.length > LIMITS.emails) errors.emails = "עד 3 כתובות מייל.";
  const phone = toWaId(raw.phone);
  if (!phone.ok) errors.phone = PHONE_ERROR[phone.reason];
  const address = typeof raw.address === "string" && raw.address.trim() !== "" ? raw.address.trim() : null;
  if (address && chars(address) > LIMITS.address) errors.address = "הכתובת ארוכה מדי.";
  const show = validateShowInput(raw.show as Record<string, unknown>, errors);
  const contacts = validateContacts(raw.contacts, errors);
  if (Object.keys(errors).length > 0 || !taxId || !phone.ok || !show || !contacts) return { ok: false, errors };
  return { ok: true, value: { clientName, taxId, emails, phone: phone.waId, address, show, contacts } };
}

/** The 0108 `p_show` argument: the rate lands on the column its model owns. PURE. */
export function showArg(s: ShowInput): Json {
  return {
    name: s.name,
    aliases: [s.alias],
    billing_mode: s.billingMode,
    pricing_model: s.pricingModel,
    default_rate: s.pricingModel === "per_episode" && s.rate !== null ? String(s.rate) : "",
    hourly_rate: s.pricingModel === "per_hour" && s.rate !== null ? String(s.rate) : "",
    default_studio: s.defaultStudio ?? "",
  };
}

export function contactsArg(contacts: { name: string; waId: string }[]): Json {
  return contacts.map((c) => ({ name: c.name, wa_id: c.waId }));
}

/** `E17:<code>` from 0108 -> the code, or null for an unexpected error. */
export function e17Code(message: string | null | undefined): string | null {
  const m = /E17:([a-z_]+)/.exec(message ?? "");
  return m ? m[1] : null;
}

export const E17_MESSAGE: Record<string, string> = {
  name_taken: "השם הזה כבר תפוס אצל לקוח אחר. יש לשנות את שם הלקוח.",
  tax_id_taken: "הח.פ הזה כבר שייך ללקוח פעיל.",
  no_morning_id: "ללקוח אין מזהה מורנינג — לא ניתן להפעיל אותו.",
  alias_required: "כינוי לפודקאסט הוא שדה חובה.",
  not_pending: "ההרשמה כבר טופלה. רעננו את המסך.",
  not_duplicate: "ההרשמה כבר טופלה. רעננו את המסך.",
  client_not_pending: "הלקוח כבר אינו ממתין. רעננו את המסך.",
  show_not_of_client: "הפודקאסט שנבחר אינו של הלקוח הזה.",
  card_not_active: "הכרטיס הקיים אינו פעיל.",
  already_approved: "ההרשמה כבר אושרה — אי אפשר לדחות אותה.",
  not_found: "ההרשמה לא נמצאה.",
};

/** Which form field a Morning refusal is about — a best guess from its words. PURE. */
export function morningFieldOf(message: string): string | null {
  const m = message.toLowerCase();
  if (/tax|vat|ח\.?פ|עוסק/.test(m)) return "taxId";
  if (/mail/.test(m)) return "emails";
  if (/phone|טלפון/.test(m)) return "phone";
  if (/address|כתובת/.test(m)) return "address";
  if (/name|שם/.test(m)) return "clientName";
  return null;
}

export type ApproveOutcome =
  | { kind: "approved"; already: boolean; clientId: string; showId: string | null; notice: "sent" | "dry-run" | "failed" | "skipped-template" | "none"; noticeTo: string | null }
  | { kind: "dry-run"; wouldCreate: boolean }
  | { kind: "invalid"; errors: ApprovalErrors }
  | { kind: "tax-id-active"; clientId: string; clientName: string }
  | { kind: "name-taken" }
  | { kind: "morning-exists"; morningClient: { id: string; name: string } }
  | { kind: "morning-link-unknown" }
  | { kind: "morning-failed"; error: string; field: string | null }
  | { kind: "refused"; code: string; message: string }
  | { kind: "error"; step: string };

export async function approveRegistration(
  admin: SupabaseClient<Database>,
  morning: MorningPort,
  input: { registrationId: string; actorId: string; raw: Record<string, unknown>; linkMorningId?: string | null }
): Promise<ApproveOutcome> {
  const { data: reg, error: regErr } = await admin
    .from("client_registrations")
    .select("id,status,client_id")
    .eq("id", input.registrationId)
    .maybeSingle();
  if (regErr) return { kind: "error", step: "read" };
  if (!reg) return { kind: "refused", code: "not_found", message: E17_MESSAGE.not_found };
  if (reg.status === "approved" && reg.client_id) {
    // a retry after a success whose answer was lost — answer it, do nothing
    return { kind: "approved", already: true, clientId: reg.client_id, showId: null, notice: "none", noticeTo: null };
  }
  if (reg.status !== "pending" || !reg.client_id) {
    return { kind: "refused", code: "not_pending", message: E17_MESSAGE.not_pending };
  }

  const v = validateApprovalInput(input.raw);
  if (!v.ok) return { kind: "invalid", errors: v.errors };
  const a = v.value;

  const { data: client, error: cErr } = await admin
    // clients-status: by id — the pending row this registration created
    .from("clients")
    .select("id,status,morning_client_id")
    .eq("id", reg.client_id)
    .maybeSingle();
  if (cErr || !client) return { kind: "error", step: "read-client" };
  if (client.status !== "pending") return { kind: "refused", code: "client_not_pending", message: E17_MESSAGE.client_not_pending };

  // ── 1. local checks ──────────────────────────────────────────────────────
  const { data: taxHolder, error: tErr } = await admin
    .from("clients")
    .select("id,name")
    .eq("status", ACTIVE_CLIENT)
    .eq("tax_id", a.taxId)
    .maybeSingle();
  if (tErr) return { kind: "error", step: "check-tax" };
  if (taxHolder) return { kind: "tax-id-active", clientId: taxHolder.id, clientName: taxHolder.name };

  const normalized = normalizeClientName(a.clientName);
  const { data: nameHolder, error: nErr } = await admin
    // clients-status: every status — the unique index does not care, so neither may this check
    .from("clients")
    .select("id")
    .eq("normalized_name", normalized)
    .neq("id", client.id)
    .maybeSingle();
  if (nErr) return { kind: "error", step: "check-name" };
  if (nameHolder) return { kind: "name-taken" };

  // ── 2. the Morning id ────────────────────────────────────────────────────
  let morningId: string | null =
    client.morning_client_id && !isSyntheticMorningId(client.morning_client_id) ? client.morning_client_id : null;

  if (!morningId) {
    let list: { id: string; name: string; taxId?: string | null }[];
    try {
      list = await morning.listClients();
    } catch (e) {
      return morningFailed(admin, input, e);
    }
    if (input.linkMorningId) {
      const chosen = list.find((m) => m.id === input.linkMorningId);
      if (!chosen) return { kind: "morning-link-unknown" };
      if (morning.isDryRun()) return { kind: "dry-run", wouldCreate: false };
      morningId = chosen.id;
    } else {
      const existing = list.find((m) => (m.taxId ?? "").replace(/[\s-]/g, "") === a.taxId);
      if (existing) return { kind: "morning-exists", morningClient: { id: existing.id, name: existing.name } };
      if (morning.isDryRun()) return { kind: "dry-run", wouldCreate: true };
      try {
        const created = await morning.createClient({
          name: a.clientName,
          taxId: a.taxId,
          phone: a.phone,
          emails: a.emails,
          address: a.address,
        });
        // B23: a synthetic id never lands on a row, whatever the flag says
        if (created.dryRun || isSyntheticMorningId(created.id)) return { kind: "dry-run", wouldCreate: true };
        morningId = created.id;
        await admin.from("events").insert({
          entity_type: "client_registration",
          entity_id: input.registrationId,
          event_type: "registration_morning_client_created",
          actor_id: input.actorId,
          payload: { morning_client_id: created.id },
        });
      } catch (e) {
        return morningFailed(admin, input, e);
      }
    }

    // ── 3. the id on the pending row, before anything else ─────────────────
    const { data: saved, error: sErr } = await admin
      // clients-status: a write by id — the pending row, and only while pending
      .from("clients")
      .update({ morning_client_id: morningId })
      .eq("id", client.id)
      .eq("status", "pending")
      .select("id");
    if (sErr || (saved ?? []).length === 0) return { kind: "error", step: "persist-morning-id" };
  }

  // ── 4. the transaction ───────────────────────────────────────────────────
  const { data: res, error: rpcErr } = await admin.rpc("approve_client_registration", {
    p_registration_id: input.registrationId,
    p_actor: input.actorId,
    p_client_name: a.clientName,
    p_normalized_name: normalized,
    p_tax_id: a.taxId,
    p_show: showArg(a.show),
    p_contacts: contactsArg(a.contacts),
  });
  if (rpcErr) {
    const code = e17Code(rpcErr.message);
    if (code === "name_taken") return { kind: "name-taken" };
    if (code) return { kind: "refused", code, message: E17_MESSAGE[code] ?? rpcErr.message };
    return { kind: "error", step: "transaction" };
  }
  const out = (res ?? {}) as { already?: boolean; client_id?: string; show_id?: string | null };

  // ── 5. the message to the client ─────────────────────────────────────────
  const to = a.contacts[0].waId;
  const notice = out.already
    ? "none"
    : await sendApprovedNotice(admin, {
        registrationId: input.registrationId,
        to,
        name: a.clientName,
        podcast: a.show.name,
      });
  return {
    kind: "approved",
    already: !!out.already,
    clientId: out.client_id ?? client.id,
    showId: out.show_id ?? null,
    notice,
    noticeTo: to,
  };
}

async function morningFailed(
  admin: SupabaseClient<Database>,
  input: { registrationId: string; actorId: string },
  e: unknown
): Promise<ApproveOutcome> {
  const error = e instanceof Error ? e.message : "פתיחת הלקוח במורנינג נכשלה";
  const field = morningFieldOf(error);
  await admin.from("events").insert({
    entity_type: "client_registration",
    entity_id: input.registrationId,
    event_type: "registration_morning_failed",
    actor_id: input.actorId,
    payload: { error, field },
  });
  return { kind: "morning-failed", error, field };
}

/**
 * `bizi_client_approved` to the first authorised number, in the language that
 * number chose in the bot (wa_contact_prefs; Hebrew by default, and Hebrew
 * whenever the English version is not marked approved — E19's seam).
 * Not approved by Meta -> not sent; an event, and the screen says so.
 */
export async function sendApprovedNotice(
  admin: SupabaseClient<Database>,
  input: { registrationId: string; to: string; name: string; podcast: string }
): Promise<"sent" | "dry-run" | "failed" | "skipped-template"> {
  if (!isTemplateApproved(TEMPLATE_CLIENT_APPROVED)) {
    await admin.from("events").insert({
      entity_type: "client_registration",
      entity_id: input.registrationId,
      event_type: "notification_skipped_template_unapproved",
      payload: {
        template: TEMPLATE_CLIENT_APPROVED,
        variables: registrationNoticeVariables({ event: "new", name: input.name, podcast: input.podcast, waId: input.to, details: "-" }),
      } as Json,
    });
    return "skipped-template";
  }
  const saved = await loadLang(admin, input.to);
  const lang = templateLanguageFor(TEMPLATE_CLIENT_APPROVED, saved.ok && saved.lang ? saved.lang : "he");
  const r = await recordBookingNotification(admin, {
    kind: "client-approved",
    subjectId: input.registrationId,
    to: input.to,
    lang,
    name: input.name,
    podcast: input.podcast,
  });
  if (r.dryRun) return "dry-run";
  if (r.failed > 0) return "failed";
  return "sent";
}

// ─── the matched-card actions and the rejection (0108) ─────────────────────

export type SimpleOutcome =
  | { kind: "done"; already: boolean; showId?: string | null }
  | { kind: "invalid"; errors: ApprovalErrors }
  | { kind: "refused"; code: string; message: string }
  | { kind: "error" };

/** Numbers to an existing podcast of the card, or a new podcast under it. No Morning. */
export async function attachRegistration(
  admin: SupabaseClient<Database>,
  input: { registrationId: string; actorId: string; raw: Record<string, unknown> }
): Promise<SimpleOutcome> {
  const errors: ApprovalErrors = {};
  const mode = input.raw.mode === "existing" ? "existing" : input.raw.mode === "new" ? "new" : null;
  if (!mode) errors.mode = "יש לבחור: פודקאסט קיים או פודקאסט חדש.";
  const showId = typeof input.raw.showId === "string" && input.raw.showId ? input.raw.showId : null;
  if (mode === "existing" && !showId) errors.showId = "יש לבחור פודקאסט.";
  const show = mode === "new" ? validateShowInput(input.raw.show as Record<string, unknown>, errors) : null;
  const contacts = validateContacts(input.raw.contacts, errors);
  if (Object.keys(errors).length > 0 || !contacts) return { kind: "invalid", errors };

  const { data, error } = await admin.rpc("attach_client_registration", {
    p_registration_id: input.registrationId,
    p_actor: input.actorId,
    // the generated type says string; 0108 takes NULL for "a new podcast"
    p_show_id: (mode === "existing" ? showId : null) as string,
    p_show: (show ? showArg(show) : null) as Json,
    p_contacts: contactsArg(contacts),
  });
  if (error) {
    const code = e17Code(error.message);
    return code ? { kind: "refused", code, message: E17_MESSAGE[code] ?? error.message } : { kind: "error" };
  }
  const out = (data ?? {}) as { already?: boolean; show_id?: string | null };
  return { kind: "done", already: !!out.already, showId: out.show_id ?? null };
}

/** Reject: nothing sent to the client, nothing created in Morning. */
export async function rejectRegistration(
  admin: SupabaseClient<Database>,
  input: { registrationId: string; actorId: string; reason: unknown }
): Promise<SimpleOutcome> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (chars(reason) > 500) return { kind: "invalid", errors: { reason: "הסיבה ארוכה מדי (עד 500 תווים)." } };
  const { data, error } = await admin.rpc("reject_client_registration", {
    p_registration_id: input.registrationId,
    p_actor: input.actorId,
    p_reason: reason,
  });
  if (error) {
    const code = e17Code(error.message);
    return code ? { kind: "refused", code, message: E17_MESSAGE[code] ?? error.message } : { kind: "error" };
  }
  return { kind: "done", already: !!(data as { already?: boolean } | null)?.already };
}

/** The daily purge (0108): registrations rejected more than 30 days ago. */
export const PURGE_AFTER_DAYS = 30;

export async function runRegistrationPurge(
  admin: SupabaseClient<Database>,
  now: Date
): Promise<{ ok: true; registrations: number; clients: number; keptWithLinks: number } | { ok: false; error: string }> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin.rpc("purge_rejected_registrations", { p_cutoff: cutoff });
  if (error) return { ok: false, error: error.message };
  const r = (data ?? {}) as { registrations?: number; clients?: number; kept_with_links?: number };
  const out = { registrations: r.registrations ?? 0, clients: r.clients ?? 0, keptWithLinks: r.kept_with_links ?? 0 };
  // counts only — never a name, a number or an id of what was deleted
  await admin.from("events").insert({
    entity_type: "system",
    entity_id: "00000000-0000-0000-0000-000000000000",
    event_type: "registrations_purged",
    payload: { ...out, cutoff },
  });
  return { ok: true, ...out };
}
