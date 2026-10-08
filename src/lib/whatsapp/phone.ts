// ═══════════════════════════════════════════════════════════════════════════
// Israeli phone numbers -> the one format WhatsApp uses. PURE. E9-3.
// ═══════════════════════════════════════════════════════════════════════════
//
// WhatsApp's `wa_id` is E.164 WITHOUT the plus: `972501234567`. Nobody in this
// office types that. The owner types `050-123-4567`, pastes `+972-50-123-4567`
// out of a contact card, or copies `0501234567` out of a chat — and all three
// have to end up as the same stored string, because the stored string is what
// an inbound message is matched against. One number stored two ways is a
// client the bot does not recognise.
//
// 🔴 CONVERSION HAPPENS ONCE, ON THE WAY IN, AND THE STORED VALUE IS CANONICAL.
// Not on every read, and never on the comparison itself: a lookup that
// normalises both sides is a lookup that cannot use an index, and — worse — it
// hides the fact that two rows hold the same number in two spellings.
//
// ⚠️ AND IT REFUSES RATHER THAN GUESSES. `validateWaNumber` is the same
// decision `whatsappNumberFrom` made for the studio's own number
// (publicView.ts:164-177): a value we cannot confidently convert is a
// configuration error the owner should see, not a string to strip characters
// out of until it looks plausible. Stripping is how `0501234567` becomes
// `501234567` and messages start going to a stranger in Peru.

/** Israel. The only country this converts FROM a local format. */
const IL = "972";

/**
 * Separators a human puts in a phone number: spaces of every kind, dashes of
 * every kind, dots, slashes, and the bracket pair.
 *
 * ⚠️ THE UNICODE DASHES ARE DELIBERATE. A number pasted out of a Mac contact
 * card or a Word document carries U+2013 (en dash), not U+002D — and a regex
 * that only knows the ASCII hyphen refuses a number the owner can see is fine,
 * which is the most annoying possible failure. Same family of invisible-input
 * problem that `normalizeGuest` documents at length (request.ts:30-40).
 */
const SEPARATORS = /[\s   \-‐‑‒–—―.()/]/g;

/** Strip the separators and any international prefix, leaving digits. */
function digitsOf(raw: string): string {
  return raw.replace(SEPARATORS, "").replace(/^\+/, "").replace(/^00/, "");
}

export type PhoneResult =
  | { ok: true; waId: string }
  | { ok: false; reason: "empty" | "not-digits" | "too-short" | "too-long" | "not-a-number" };

/** Approved copy — the sentence the card shows under a refused input. */
export const PHONE_ERROR: Record<Exclude<PhoneResult, { ok: true }>["reason"], string> = {
  empty: "חסר מספר טלפון.",
  "not-digits": "המספר מכיל תווים שאינם ספרות.",
  "too-short": "המספר קצר מדי.",
  "too-long": "המספר ארוך מדי.",
  "not-a-number": "המספר אינו תקין. אפשר להקליד 05X-XXXXXXX או 9725XXXXXXXX.",
};

/**
 * Anything a human might type -> `wa_id`, or a named refusal.
 *
 * What it accepts:
 *   `0501234567`      local Israeli, 10 digits  -> 972501234567
 *   `050-123-4567`    the same with separators   -> 972501234567
 *   `03-1234567`      an Israeli landline         -> 97231234567
 *   `+972501234567`   already international       -> 972501234567
 *   `00972501234567`  the other international form-> 972501234567
 *   `972501234567`    already a wa_id             -> unchanged
 *   `447911123456`    a foreign number            -> unchanged
 *
 * ⚠️ A LEADING ZERO MEANS ISRAEL, and nothing else can. E.164 numbers never
 * start with 0, so a leading zero is unambiguously a national trunk prefix —
 * and this office is in Israel, so there is exactly one country it can belong
 * to. Dropping the 0 and prefixing 972 is therefore a conversion and not a
 * guess. A number that starts with any other digit is taken AS GIVEN, which is
 * what lets a guest from abroad be stored at all.
 *
 * ⚠️ 7..15 DIGITS is E.164's own limit (15) with a floor loose enough for a
 * short national number. The point of the range is to catch a half-typed
 * number, not to validate a dialling plan we do not own: refusing a real
 * foreign number because its shape is unfamiliar would be worse than storing
 * it, and the owner can see what they typed.
 */
export function toWaId(raw: unknown): PhoneResult {
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  const d = digitsOf(trimmed);
  if (d === "") return { ok: false, reason: "not-a-number" };
  if (!/^\d+$/.test(d)) return { ok: false, reason: "not-digits" };

  if (d.startsWith("0")) {
    // national form. 0 + 9 more (mobile, 10 total) or 0 + 8 more (landline).
    const national = d.slice(1);
    if (national.length < 8) return { ok: false, reason: "too-short" };
    if (national.length > 10) return { ok: false, reason: "too-long" };
    return { ok: true, waId: `${IL}${national}` };
  }

  if (d.length < 7) return { ok: false, reason: "too-short" };
  if (d.length > 15) return { ok: false, reason: "too-long" };
  return { ok: true, waId: d };
}

/**
 * The stored form -> something a human reads.
 *
 * Israeli numbers are shown in the local shape the owner recognises; anything
 * else is shown as `+<digits>`, because we do not know its grouping and a
 * wrong grouping reads as a wrong number.
 */
export function displayWaId(waId: string): string {
  const d = (waId ?? "").replace(/\D/g, "");
  if (d === "") return "";
  if (d.startsWith(IL) && d.length >= 11) {
    const national = `0${d.slice(IL.length)}`;
    // 0XX-XXXXXXX for a 10-digit mobile, 0X-XXXXXXX for a 9-digit landline
    return national.length === 10
      ? `${national.slice(0, 3)}-${national.slice(3)}`
      : `${national.slice(0, 2)}-${national.slice(2)}`;
  }
  return `+${d}`;
}

/**
 * The strict gate for a value that is ALREADY supposed to be a `wa_id`.
 *
 * Used on the way OUT of the database and on anything Meta sends us — not as a
 * second conversion. `toWaId` is for human input; this is for data that should
 * already be canonical, and a value that is not is a bug worth seeing rather
 * than a value worth fixing silently.
 */
export function isWaId(v: unknown): v is string {
  return typeof v === "string" && /^\d{7,15}$/.test(v);
}
