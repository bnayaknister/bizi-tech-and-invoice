import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// The calendar event an approved request becomes. ALL PURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// Nothing here writes to a calendar. The owner pastes; these functions decide
// what they paste. That is the owner's decision from 0096 ("אין כתיבה ליומן.
// אישור מייצר טקסט אירוע להדבקה ידנית") and it is why the title has to be
// exactly right the first time — there is no sync back, and a title the parser
// misreads becomes a production in the wrong room, on an invoice.
//
// ═══ WHY THE TITLE HAS THIS SHAPE, MEASURED 23.9 ═══
// The sync reads a title with `extractStudioAndGuest` (@/lib/calendar/match),
// which removes the LONGEST matching room variant from anywhere in the string
// and then reads the guest as the text between "אורח:" and the next comma.
// Measured against the real parsers:
//
//   "{alias}, אורח: {guest}, {room}"  -> studio and guest both read correctly
//   a guest containing a comma        -> TRUNCATED at that comma
//   the label "אורחים:"               -> NOT recognised; guest comes back null
//
// So the label stays singular even for two guests, and the comma inside a name
// is the one character that must not survive into the title.

/**
 * The guest name, shaped so the title parses back correctly.
 *
 * ⚠️ THIS IS NOT WHAT IS STORED. `booking_requests.guest` holds what the
 * client typed, whitespace-normalized and nothing else (see ./request), and it
 * stays that way forever. This is a DERIVATION, applied at the moment a title
 * is built, so the stored name remains the client's own words and the title
 * remains readable by the sync. Storing the derived form would destroy the
 * original with no way back.
 *
 * Two transformations, and only the first is a fix:
 *
 *   comma -> " ו"   REQUIRED. Measured: "דנה לוי, יוסי כהן" in a title yields
 *                   the guest "דנה לוי" — the second name is silently lost.
 *                   The Hebrew conjunction attaches to the following word with
 *                   no space, so ", " becomes " ו" and the result reads
 *                   "דנה לוי ויוסי כהן", which is how a person would write it.
 *
 *   whitespace      COSMETIC, and said so plainly. Both parsers already
 *                   tolerate runs of whitespace (match.ts:87, rooms.ts:80), so
 *                   a newline breaks nothing — it just makes a two-line
 *                   calendar entry. Directional marks and NBSP go the same way
 *                   because they are invisible and a name that differs from
 *                   another only by a U+200F cannot be matched by eye.
 *
 * ⚠️ The COLON is deliberately left alone. Measured: a guest written "דנה: לוי"
 * parses correctly, because GUEST_LABEL matches the FIRST "אורח:" and the
 * guest is read to the next comma. Replacing it would change a name for no
 * reason, and the rule here is the least change that works.
 */
export function guestForTitle(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/[\r\n\t ‎‏‪-‮⁦-⁩]+/g, " ")
    // before the whitespace collapse, so ",\n" and " , " both land on one form
    .replace(/\s*,\s*/g, " ו")
    .replace(/\s+/g, " ")
    .trim();
}

/** The label, singular in both readings. "אורחים:" is NOT recognised by the parser. */
const GUEST_LABEL = "אורח";

/**
 * The event title to paste into the calendar.
 *
 *   without a guest:  "{alias}, {room}"
 *   with a guest:     "{alias}, אורח: {guest}, {room}"
 *
 * `alias` must be a CLEAN alias — one containing no room name — or the room
 * this title names can be shadowed by the show's own name. `cleanAliasFor` in
 * ./alias is what produces it, and a show without one never got a booking
 * link in the first place.
 *
 * ⚠️ THE NOTE IS NEVER IN HERE. A free-text note can contain a comma, a room
 * name, the word "אורח", or a paragraph; any of those in a title changes what
 * the sync reads. It goes in the event's DESCRIPTION, where nothing parses it.
 */
export function eventTitle(input: { alias: string; guest?: string | null; studio: string }): string {
  const alias = (input.alias ?? "").replace(/\s+/g, " ").trim();
  const studio = (input.studio ?? "").replace(/\s+/g, " ").trim();
  const guest = guestForTitle(input.guest);
  return guest === ""
    ? `${alias}, ${studio}`
    : `${alias}, ${GUEST_LABEL}: ${guest}, ${studio}`;
}

// ─── the Google Calendar hand-off ───────────────────────────────────────────

/**
 * "20261027T070000Z" — the only format Google's TEMPLATE link accepts for an
 * absolute instant.
 *
 * ⚠️ UTC, ALWAYS, AND DERIVED FROM THE INSTANT. The stored `start_at` is a
 * timestamptz; converting it here through any local reading would land an hour
 * out for half the year. Israel is UTC+3 until 25.10.2026 and UTC+2 after it,
 * so 09:00 Israel is 06:00Z in October and 07:00Z in November — the suite
 * asserts both sides of that date, because a link that is silently an hour
 * wrong is a client standing outside a locked studio.
 *
 * `ctz=Asia/Jerusalem` travels with the link as well, so the times Google
 * DISPLAYS are Israeli even for an owner whose account sits in another zone.
 */
export function googleDateStamp(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error("googleDateStamp: תאריך לא תקין");
  }
  return instant.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * A "create event" link, pre-filled. Opening it does NOT create anything — the
 * owner still sees Google's own form and presses save, which is the manual
 * step 0096 chose over writing to the calendar ourselves.
 */
export function googleCalendarUrl(input: {
  title: string;
  start: Date;
  end: Date;
  details?: string | null;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${googleDateStamp(input.start)}/${googleDateStamp(input.end)}`,
    ctz: "Asia/Jerusalem",
  });
  // Appended only when there is one: an empty `details=` in the URL becomes an
  // empty description field the owner has to look at and dismiss.
  const details = (input.details ?? "").trim();
  if (details !== "") params.set("details", details);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// ─── the two WhatsApp messages the owner sends after deciding ───────────────

/**
 * ⚠️ NO NUMBER IN THESE LINKS, and that is the difference from the client's
 * side of the flow.
 *
 * The public page knows exactly who to message — the studio — so its link
 * carries STUDIO_WHATSAPP_NUMBER. Here the owner is messaging the PODCAST, and
 * the system has no phone number for one (0096 stores no name, phone or email
 * for a requester, deliberately). `wa.me/?text=` opens WhatsApp with the
 * message composed and lets the owner pick the chat — which is also the only
 * honest option, since guessing a chat would send a confirmation to whoever
 * happened to match.
 */
export function whatsappComposeHref(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** "ההקלטה של {תוכנית} אושרה: יום א׳ 27.9 ב-11:00, אולפן גבעון. נתראה!" */
export function approvedWhatsappText(input: {
  showName: string;
  dateIsrael: string;
  startIsrael: string;
  studio: string;
}): string {
  return `ההקלטה של ${input.showName} אושרה: יום ${dowHebrew(input.dateIsrael)} ${dayMonth(
    input.dateIsrael
  )} ב-${input.startIsrael}, אולפן ${input.studio}. נתראה!`;
}

/** "הבקשה של {תוכנית} ליום א׳ 27.9 ב-11:00 לא אושרה. אפשר לבחור מועד אחר בקישור." */
export function declinedWhatsappText(input: {
  showName: string;
  dateIsrael: string;
  startIsrael: string;
}): string {
  return `הבקשה של ${input.showName} ליום ${dowHebrew(input.dateIsrael)} ${dayMonth(
    input.dateIsrael
  )} ב-${input.startIsrael} לא אושרה. אפשר לבחור מועד אחר בקישור.`;
}
