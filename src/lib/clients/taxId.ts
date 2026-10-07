// ח.פ / ע.מ — the one place the rule is spelled.
//
// 🔴 THIS NUMBER PRINTS ON THE CLIENT'S INVOICE, and it lives in MORNING, not
// in `clients` (there is no column; see MORNING_ONLY_CLIENT_FIELDS in
// entities.ts). So every write is a remote write, and a wrong value is wrong on
// a tax document rather than wrong on a screen. Hence: validate before the
// wire, never after.
//
// THE RULE IS "EXACTLY 9 DIGITS" (owner 7.10) — and deliberately NOT the
// Israeli check-digit algorithm. Two reasons, and the second is the real one:
//   · a ח.פ and an ע.מ are both 9 digits and the owner named that as the test;
//   · a check-digit test would REJECT values Morning already holds. The account
//     carries real clients whose number we did not mint and cannot correct from
//     here, and a validator that refuses to let someone retype a number that is
//     already live in Morning is a validator that blocks the fix rather than
//     the typo.
// So: length and digits. Anything else is the operator's call, and the
// confirmation window is what makes it a deliberate one.

/** The approved message, verbatim. One constant so the screen cannot reword it. */
export const TAX_ID_INVALID = "ח.פ / ע.מ צריך להיות 9 ספרות.";

/** The approved empty-state label, verbatim. */
export const TAX_ID_UNKNOWN = "לא ידוע";

export type TaxIdVerdict =
  | { ok: true; value: string; clears: boolean }
  | { ok: false; error: string };

/**
 * `clears: true` is the EXPLICIT-EMPTY case, and it is not a convenience.
 *
 * Morning clears a text field only when the key is present with "" — omitting
 * it means "leave as is" (morning/client.ts:412, measured 2026-09-09). So
 * "the operator emptied the box" and "the operator did not touch it" must stay
 * distinguishable all the way to the request body, or clearing a ח.פ silently
 * does nothing. `toMorningText` is the function that puts the "" on the wire;
 * this one is what decides that "" was meant.
 *
 * Non-string input (undefined, null, a number from a hand-built body) is
 * REJECTED rather than coerced: `String(123456789)` would validate, and a
 * number that lost a leading zero on its way through JSON is exactly the kind
 * of value that must not reach a tax document.
 */
export function validateTaxId(raw: unknown): TaxIdVerdict {
  if (typeof raw !== "string") return { ok: false, error: TAX_ID_INVALID };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: "", clears: true };
  // /^\d{9}$/ on the TRIMMED string: surrounding space is an artefact of
  // copy-paste and is not the operator's mistake, but a space in the MIDDLE is
  // a different number and is refused. \d and not [0-9] would admit Arabic-
  // Indic digits in some engines — the character class is explicit for that
  // reason, and because Morning stores this as text.
  if (!/^[0-9]{9}$/.test(trimmed)) return { ok: false, error: TAX_ID_INVALID };
  return { ok: true, value: trimmed, clears: false };
}

/**
 * What the card shows. Morning answers "" for an unset field and
 * `/clients/search` answers null (morning/client.ts:395), and a failed READ is
 * a third thing again — the caller passes null for all three and gets the one
 * approved label. Never a guess, never a "—".
 */
export function displayTaxId(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : TAX_ID_UNKNOWN;
}
