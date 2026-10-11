import { toWaId, PHONE_ERROR } from "@/lib/whatsapp/phone";

/**
 * The registration form's server-side validation (E17-4). PURE.
 *
 * ═══ EVERY RULE HERE MIRRORS A CHECK IN 0107 ═══
 * `client_registrations` carries a CHECK for every column this fills
 * (0107:208-247). The database is the last wall; this is the one that answers
 * in words. A rule that is looser than its CHECK would turn a typo into a 500,
 * and one that is stricter would refuse what the database accepts — so each
 * limit below names the constraint it mirrors.
 *
 * The browser validates too, for comfort only. Nothing here trusts it.
 */

export const LIMITS = {
  legalName: 200, // client_registrations_legal_name_chk
  contactName: 120, // _contact_name_chk
  podcastName: 200, // _podcast_name_chk
  bookingName: 120, // _name_1_chk / _name_2_chk
  address: 300, // _address_chk
  emails: 3, // _emails_chk: cardinality 1..3
  emailChars: 254,
} as const;

export const FIELD_ERROR = {
  legalName: "נא למלא שם (עסק או פרטי).",
  taxId: "ח.פ / ע.מ / ת.ז צריך להיות 9 ספרות.",
  email: "כתובת המייל לא תקינה.",
  emailRequired: "נא למלא לפחות כתובת מייל אחת.",
  emailDuplicate: "אותה כתובת מייל הוזנה פעמיים.",
  tooManyEmails: "אפשר עד 3 כתובות מייל.",
  podcastName: "נא למלא את שם הפודקאסט.",
  bookingName: "נא למלא שם למספר המורשה.",
  bookingSame: "המספר השני זהה לראשון.",
  bookingPair: "למספר השני צריך גם שם וגם טלפון.",
  contactName: "השם ארוך מדי.",
  address: "הכתובת ארוכה מדי.",
  privacy: "יש לאשר את מדיניות הפרטיות.",
} as const;

export type RegistrationInput = {
  legalName: string;
  taxId: string;
  emails: string[];
  phone: string; // wa_id digits
  contactName: string | null;
  address: string | null;
  podcastName: string;
  booking1: { name: string; waId: string };
  booking2: { name: string; waId: string } | null;
};

export type FieldErrors = Partial<Record<
  | "legalName"
  | "taxId"
  | "emails"
  | "phone"
  | "contactName"
  | "address"
  | "podcastName"
  | "booking1Name"
  | "booking1Phone"
  | "booking2Name"
  | "booking2Phone"
  | "privacy",
  string
>>;

export type ValidationResult = { ok: true; value: RegistrationInput } | { ok: false; errors: FieldErrors };

/** Collapse runs of whitespace; non-strings become "". */
function text(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/** Code points, not UTF-16 units — the CHECKs use char_length. */
const chars = (s: string) => Array.from(s).length;

/**
 * ח.פ / ע.מ / ת.ז: spaces and hyphens are stripped (owner, E17-4), then exactly
 * nine ASCII digits — the same `^[0-9]{9}$` as 0107's CHECK and as
 * `validateTaxId` (lib/clients/taxId.ts). No check-digit test, for the reason
 * that file gives.
 */
export function normalizeTaxId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\s\-‐-―−]/g, "");
  return /^[0-9]{9}$/.test(s) ? s : null;
}

/**
 * The same shape 0107's emails CHECK enforces (`[^@\s,]+@[^@\s,]+\.[^@\s,]+`),
 * lower-cased: the duplicate check and Morning both treat an address as
 * case-insensitive, so storing two spellings of one address helps nobody.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (s === "" || s.length > LIMITS.emailChars) return null;
  return /^[^@\s,]+@[^@\s,]+\.[^@\s,]+$/.test(s) ? s : null;
}

/**
 * Validate one submission. `lockedWaId` is the number a BOT link was minted
 * for: the first authorised number is that number, whatever the body says —
 * the caller decides what a mismatch means (it is a tampered form, and the
 * route answers it like a dead link).
 */
export function validateRegistration(body: Record<string, unknown>, lockedWaId: string | null): ValidationResult {
  const errors: FieldErrors = {};

  const legalName = text(body.legalName);
  if (legalName === "" || chars(legalName) > LIMITS.legalName) errors.legalName = FIELD_ERROR.legalName;

  const taxId = normalizeTaxId(body.taxId);
  if (!taxId) errors.taxId = FIELD_ERROR.taxId;

  const rawEmails = Array.isArray(body.emails) ? body.emails : [];
  const filled = rawEmails.filter((e) => typeof e === "string" && e.trim() !== "");
  const emails: string[] = [];
  if (filled.length === 0) errors.emails = FIELD_ERROR.emailRequired;
  else if (filled.length > LIMITS.emails) errors.emails = FIELD_ERROR.tooManyEmails;
  else {
    for (const e of filled) {
      const n = normalizeEmail(e);
      if (!n) {
        errors.emails = FIELD_ERROR.email;
        break;
      }
      if (emails.includes(n)) {
        errors.emails = FIELD_ERROR.emailDuplicate;
        break;
      }
      emails.push(n);
    }
  }

  const phone = toWaId(body.phone);
  if (!phone.ok) errors.phone = PHONE_ERROR[phone.reason];

  const contactName = text(body.contactName);
  if (chars(contactName) > LIMITS.contactName) errors.contactName = FIELD_ERROR.contactName;

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (chars(address) > LIMITS.address) errors.address = FIELD_ERROR.address;

  const podcastName = text(body.podcastName);
  if (podcastName === "" || chars(podcastName) > LIMITS.podcastName) errors.podcastName = FIELD_ERROR.podcastName;

  const b1Name = text(body.booking1Name);
  if (b1Name === "" || chars(b1Name) > LIMITS.bookingName) errors.booking1Name = FIELD_ERROR.bookingName;
  let b1WaId: string | null = null;
  if (lockedWaId) {
    b1WaId = lockedWaId;
  } else {
    const p = toWaId(body.booking1Phone);
    if (p.ok) b1WaId = p.waId;
    else errors.booking1Phone = PHONE_ERROR[p.reason];
  }

  const b2NameRaw = text(body.booking2Name);
  const b2PhoneRaw = typeof body.booking2Phone === "string" ? body.booking2Phone.trim() : "";
  let booking2: { name: string; waId: string } | null = null;
  if (b2NameRaw !== "" || b2PhoneRaw !== "") {
    if (b2NameRaw === "" || b2PhoneRaw === "") {
      errors.booking2Phone = FIELD_ERROR.bookingPair;
    } else if (chars(b2NameRaw) > LIMITS.bookingName) {
      errors.booking2Name = FIELD_ERROR.bookingName;
    } else {
      const p = toWaId(b2PhoneRaw);
      if (!p.ok) errors.booking2Phone = PHONE_ERROR[p.reason];
      else if (b1WaId && p.waId === b1WaId) errors.booking2Phone = FIELD_ERROR.bookingSame;
      else booking2 = { name: b2NameRaw, waId: p.waId };
    }
  }

  if (body.privacyAccepted !== true) errors.privacy = FIELD_ERROR.privacy;

  if (Object.keys(errors).length > 0 || !taxId || !phone.ok || !b1WaId) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      legalName,
      taxId,
      emails,
      phone: phone.waId,
      contactName: contactName === "" ? null : contactName,
      address: address === "" ? null : address,
      podcastName,
      booking1: { name: b1Name, waId: b1WaId },
      booking2,
    },
  };
}

/**
 * Did a bot-link submission try to change the locked number? The form sends it
 * disabled, so an honest browser sends either nothing or exactly that number.
 */
export function lockedNumberTampered(body: Record<string, unknown>, lockedWaId: string): boolean {
  const raw = body.booking1Phone;
  if (raw === undefined || raw === null || raw === "") return false;
  const p = toWaId(raw);
  return !p.ok || p.waId !== lockedWaId;
}
