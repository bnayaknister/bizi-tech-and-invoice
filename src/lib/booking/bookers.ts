import { PHONE_ERROR, toWaId } from "@/lib/whatsapp/phone";

// ═══════════════════════════════════════════════════════════════════════════
// E22 — "מורשים לקבוע הקלטות": who may book a show's recordings through the
// bot. The rows are `booking_contacts` (0103: show_id, name, wa_id) plus the
// optional `email` of 0111. PURE — shared by the show screen's route and the
// B26 invitation, so both read an email the same way.
// ═══════════════════════════════════════════════════════════════════════════

export const BOOKER_NAME_MAX = 120;

/** The same basic shape 0111's CHECK enforces. */
export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** trim + lowercase; "" -> null; a malformed value is an error, not a null. */
export function normalizeBookerEmail(raw: unknown): { ok: true; email: string | null } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, email: null };
  if (typeof raw !== "string") return { ok: false };
  const e = raw.trim().toLowerCase();
  if (e === "") return { ok: true, email: null };
  if (e.length < 3 || e.length > 254 || !EMAIL_SHAPE.test(e)) return { ok: false };
  return { ok: true, email: e };
}

export type BookerInput = { name: string; waId: string; email: string | null };
export type BookerField = "name" | "phone" | "email";

export const BOOKER_ERROR = {
  name: "שם המורשה חסר או ארוך מדי.",
  email: "כתובת המייל אינה תקינה.",
  duplicate: "המספר הזה כבר מורשה לתוכנית הזו.",
} as const;

/** The add/edit form, validated. PURE. */
export function validateBooker(body: {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
}): { ok: true; value: BookerInput } | { ok: false; field: BookerField; error: string } {
  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (name === "" || Array.from(name).length > BOOKER_NAME_MAX) return { ok: false, field: "name", error: BOOKER_ERROR.name };
  const phone = toWaId(body.phone);
  if (!phone.ok) return { ok: false, field: "phone", error: PHONE_ERROR[phone.reason] };
  const email = normalizeBookerEmail(body.email);
  if (!email.ok) return { ok: false, field: "email", error: BOOKER_ERROR.email };
  return { ok: true, value: { name, waId: phone.waId, email: email.email } };
}
