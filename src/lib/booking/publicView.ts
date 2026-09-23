import { israelDateOf, type AvailabilityResult, type Slot } from "@/lib/calendar/availability";
import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// What a stranger holding a link is allowed to receive. PURE.
// ═══════════════════════════════════════════════════════════════════════════
//
// The internal route (/api/calendar/availability) returns the whole
// AvailabilityResult, which is right for the owner and catastrophic here: it
// carries `unknownRoomBlocks` and `skipped`, and BOTH of those carry the
// TITLE and UID of real calendar events — client names, guest names, whatever
// the owner typed. A public route that forwarded the same object would hand
// every link-holder a readable index of the studio's business.
//
// So the projection is a function with a name and a test, not a hand-written
// object literal inside the route. An object literal is edited by whoever adds
// a field next; a function whose suite counts the forbidden strings at zero
// refuses to be edited that way.

/** The client grid. 30 minutes, and this is the ONLY place the number appears. */
export const PUBLIC_SLOT_STEP_MINUTES = 30;

export type PublicSlot = {
  room: string;
  dateIsrael: string;
  startIsrael: string;
  endIsrael: string;
};

export type PublicAvailability = {
  fromIsrael: string;
  toIsrael: string;
  rooms: string[];
  free: PublicSlot[];
  /**
   * Rooms offering nothing at all, BY NAME ONLY.
   *
   * The internal shape is `{ room, seriesUid, seriesTitle }` and the title is
   * the name of a recurring series in the owner's calendar — "פודקאסט X
   * שבועי". The client is told the room is unavailable; they are not told what
   * is in it. The uid goes with it, for the same reason.
   */
  refusedRooms: string[];
};

/**
 * AvailabilityResult -> the public payload, by CONSTRUCTION rather than by
 * deletion: this builds a new object out of four named fields. Nothing is
 * spread, so a field added to AvailabilityResult tomorrow cannot arrive here
 * by accident — it has to be typed in.
 */
export function toPublicAvailability(
  result: AvailabilityResult,
  win: { fromIsrael: string; toIsrael: string },
  rooms: string[]
): PublicAvailability {
  return {
    fromIsrael: win.fromIsrael,
    toIsrael: win.toIsrael,
    rooms: rooms ?? [],
    // Israeli wall-clock strings, never Date objects: the same choice the
    // internal route made, and it keeps timezone arithmetic out of the browser.
    free: (result?.free ?? []).map((s: Slot) => ({
      room: s.room,
      dateIsrael: s.dateIsrael,
      startIsrael: s.startIsrael,
      endIsrael: s.endIsrael,
    })),
    refusedRooms: (result?.roomsRefused ?? []).map((r) => r.room),
  };
}

// ─── "הבקשות שלכם" ──────────────────────────────────────────────────────────

export type RequestRow = {
  id: string;
  studio: string;
  start_at: string; // ISO
  guest: string | null;
  status: string;
};

export type RequestView = {
  id: string;
  dowHe: string;
  dayMonth: string;
  timeIsrael: string; // "HH:MM"
  studio: string;
  guest: string | null;
  statusLabel: string;
};

/** Approved copy, 23.9. The map is exhaustive over 0096's status CHECK. */
export const STATUS_LABEL: Record<string, string> = {
  pending: "ממתינה לאישור",
  approved: "אושרה",
  declined: "נדחתה",
};

/**
 * "HH:MM" in Israel, read through Intl.
 *
 * Not `toISOString().slice(11,16)`: this runs on Vercel, which is UTC, and
 * that would show a client 06:00 for a recording at 09:00. The same trap
 * bookingWindow.ts documents at length, in its smaller form.
 */
function israelHHMM(instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${hh}:${g("minute")}`;
}

/**
 * This show's requests from TODAY onward, in time order.
 *
 * "From today", not "from now": a recording at 10:00 that a client is looking
 * at at 14:00 is still the thing they asked for this morning, and dropping it
 * mid-day would read as the request having vanished. The comparison is on the
 * Israeli DATE for the same reason every other comparison in this system is —
 * a UTC date is yesterday for the first two or three hours of every Israeli
 * day.
 *
 * A row whose instant will not parse is DROPPED rather than rendered as "—":
 * this list is the client's only evidence that their request exists, and a
 * malformed row placed somewhere arbitrary in the ordering is worse than one
 * that is absent.
 */
export function myRequests(rows: RequestRow[] | null | undefined, todayIsrael: string): RequestView[] {
  const out: { at: number; view: RequestView }[] = [];
  for (const r of rows ?? []) {
    if (!r?.start_at) continue;
    const t = Date.parse(r.start_at);
    if (!Number.isFinite(t)) continue;
    const d = new Date(t);
    const dateIsrael = israelDateOf(d);
    if (dateIsrael < todayIsrael) continue;
    out.push({
      at: t,
      view: {
        id: r.id,
        dowHe: dowHebrew(dateIsrael),
        dayMonth: dayMonth(dateIsrael),
        timeIsrael: israelHHMM(d),
        studio: r.studio,
        guest: r.guest && r.guest.trim() !== "" ? r.guest : null,
        statusLabel: STATUS_LABEL[r.status] ?? r.status,
      },
    });
  }
  return out.sort((a, b) => a.at - b.at).map((o) => o.view);
}

// ─── the WhatsApp nudge ─────────────────────────────────────────────────────

/**
 * The studio's WhatsApp number, or null.
 *
 * ⚠️ THERE IS NO NUMBER IN THIS REPOSITORY, on purpose. It comes from
 * STUDIO_WHATSAPP_NUMBER and nowhere else; unset means the button does not
 * render at all, rather than rendering onto a default that would send a
 * client's booking to whoever owns that number.
 *
 * Digits only, and validated rather than sanitised: a value with a "+" or
 * dashes in it is a configuration the owner should fix, and silently stripping
 * characters would hide a typo'd number that still dials somewhere.
 */
export function whatsappNumberFrom(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  return /^\d{6,15}$/.test(v) ? v : null;
}

/**
 * "{תוכנית} ביקשו הקלטה ביום {א׳} {23.9} ב-{11:00}, אולפן {גבעון}."
 * plus ", אורח/ת: {אורח}." when there is one — approved copy, 23.9.
 *
 * The guest sentence is APPENDED, never interpolated into the first one: the
 * message must read identically with and without a guest, and the guestless
 * form is the common case.
 */
export function whatsappText(input: {
  showName: string;
  dateIsrael: string;
  startIsrael: string;
  studio: string;
  guest?: string | null;
}): string {
  const base = `${input.showName} ביקשו הקלטה ביום ${dowHebrew(input.dateIsrael)} ${dayMonth(
    input.dateIsrael
  )} ב-${input.startIsrael}, אולפן ${input.studio}.`;
  const g = (input.guest ?? "").trim();
  return g === "" ? base : `${base} אורח/ת: ${g}.`;
}

/**
 * The full wa.me link, or null when no number is configured.
 *
 * encodeURIComponent, not encodeURI: the text is Hebrew and contains spaces,
 * commas and a "/" (in "אורח/ת"). encodeURI leaves all three alone, and the
 * "/" would read as a path separator the moment anything re-parses the URL.
 */
export function whatsappHref(
  number: string | null,
  text: string
): string | null {
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}
