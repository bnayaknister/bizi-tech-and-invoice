import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { isWhatsappDryRun } from "./client";
import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// The notifications to the owner and to Eli. E9-2.
// ═══════════════════════════════════════════════════════════════════════════
//
// ⛔ NOTHING IS SENT FROM THIS FILE, AND THERE IS NO CODE HERE THAT COULD.
// `lib/whatsapp/client.ts` still has no send function (E9-1's decision), so
// what this module does is RENDER a notification and RECORD it in
// `wa_messages`. In dry run — the default, rule 40 — that is the whole of it.
// When the switch is off, the row is recorded as `queued` and a line goes to
// the server log saying that sending is not implemented yet; E9-3 is where the
// Graph call appears and reads those rows.
//
// ⚠️ SO A `queued` ROW IS AN HONEST STATE, NOT A BUG: it means "this would
// have been sent, the dry run is off, and the sender does not exist yet". The
// alternative — recording it as `sent` — would put a lie in the one table that
// is supposed to be the evidence.
//
// ═══ 🔴 THE RECIPIENTS COME FROM THE ENVIRONMENT, NOT FROM THE CODE ═══
// Owner decision 8.10: `WHATSAPP_NOTIFY_NUMBERS`, comma-separated, digits
// only. Eli's number is NOT in this repository and must not be: a phone
// number in source is a phone number in every clone, every fork and every
// screenshot of a diff. The same reasoning that keeps the studio's own number
// out (`STUDIO_WHATSAPP_NUMBER`, publicView.ts:164-167).
//
// ⚠️ AND IT IS VALIDATED, NOT SANITISED — the exact rule `whatsappNumberFrom`
// already applies: an entry with a `+`, a dash or a space is DROPPED rather
// than cleaned up, because silently stripping characters hides a typo'd number
// that still dials somewhere. A list of three where one is malformed notifies
// two people and says so in the log.

// ─── the templates ──────────────────────────────────────────────────────────
//
// 🔴 NAMES AND VARIABLE ORDER ARE A CONTRACT WITH META, not an internal
// detail. A template is registered once, approved once, and from then on the
// Graph call sends POSITIONAL parameters — so reordering this list silently
// swaps the studio and the guest inside a message the owner reads as fact.
// The order below is the order the body text uses, and the suite asserts that
// the rendered body contains each variable exactly where the list says.
//
// ⚠️ THE BODIES BELOW ARE *PROPOSED* COPY, pending the owner's approval, and
// they are deliberately written as the exact string a template would render
// with these parameters filled in. That is what makes them reviewable: the
// owner reads the sentence, not a schema.

/** Utility template — one recording was approved automatically. */
export const TEMPLATE_BOOKING_APPROVED = "bizi_booking_approved";
export const TEMPLATE_BOOKING_APPROVED_VARS = [
  "showName",
  "whenLine",
  "studio",
  "duration",
  "guest",
] as const;

/** Utility template — a request did NOT auto-approve and is waiting. */
export const TEMPLATE_BOOKING_PENDING = "bizi_booking_pending";
export const TEMPLATE_BOOKING_PENDING_VARS = [
  "showName",
  "whenLine",
  "studio",
  "duration",
  "reason",
] as const;

/** Why a request stayed pending. Each one is a different sentence to the owner. */
export type PendingReason = "second-same-day" | "calendar-failed" | "slot-taken";

/** Approved copy (proposed, 8.10). */
export const PENDING_REASON_LABEL: Record<PendingReason, string> = {
  "second-same-day": "הזמנה שנייה באותו יום",
  "calendar-failed": "הכתיבה ליומן נכשלה",
  "slot-taken": "המשבצת נתפסה ביומן",
};

export type NotificationKind = "booking-approved" | "booking-pending";

// ─── recipients ─────────────────────────────────────────────────────────────

/**
 * `WHATSAPP_NOTIFY_NUMBERS` -> the numbers to notify.
 *
 * Duplicates are collapsed — the owner's number appearing twice in the
 * variable must not produce two identical messages — and ORDER IS PRESERVED,
 * so the log reads in the order the owner wrote the list.
 */
export function parseNotifyNumbers(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim();
    if (v === "") continue;
    // the same test, character for character, as whatsappNumberFrom
    if (!/^\d{6,15}$/.test(v)) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** The entries that were REFUSED, so the caller can log what it is not notifying. */
export function rejectedNotifyNumbers(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim();
    if (v === "") continue;
    if (!/^\d{6,15}$/.test(v)) out.push(v);
  }
  return out;
}

// ─── the bodies ─────────────────────────────────────────────────────────────

export type BookingFacts = {
  showName: string;
  dateIsrael: string; // "YYYY-MM-DD"
  startIsrael: string; // "HH:MM"
  endIsrael: string; // "HH:MM"
  studio: string;
  /** the short form, e.g. "3 שעות"; null for the standard 90 minutes */
  durationTag: string | null;
  guest: string | null;
};

/** "יום א׳ 27.9, 09:00–12:00" — shared by both templates as one parameter. */
export function whenPhrase(f: BookingFacts): string {
  return `יום ${dowHebrew(f.dateIsrael)} ${dayMonth(f.dateIsrael)}, ${f.startIsrael}–${f.endIsrael}`;
}

/** The duration parameter, never empty — a template parameter may not be blank. */
export function durationParam(f: BookingFacts): string {
  return f.durationTag ?? "שעה וחצי";
}

/** The guest parameter, never empty — same rule. */
export function guestParam(f: BookingFacts): string {
  const g = (f.guest ?? "").trim();
  return g === "" ? "בלי אורח" : g;
}

/**
 * "הקלטה אושרה אוטומטית: {תוכנית}, {יום א׳ 27.9, 09:00–12:00}, אולפן {גבעון},
 *  {3 שעות}. אורח/ת: {דנה לוי}."
 *
 * PROPOSED copy. The word "אוטומטית" is in it on purpose: the owner needs to
 * know from the first three words that nobody pressed anything, because that
 * is exactly what changed about his day.
 */
export function approvedNoticeBody(f: BookingFacts): string {
  return (
    `הקלטה אושרה אוטומטית: ${f.showName}, ${whenPhrase(f)}, אולפן ${f.studio}, ` +
    `${durationParam(f)}. אורח/ת: ${guestParam(f)}.`
  );
}

/**
 * "בקשת הקלטה ממתינה לאישור: {תוכנית}, {יום א׳ 27.9, 09:00–12:00}, אולפן
 *  {גבעון}, {3 שעות}. הסיבה: {הזמנה שנייה באותו יום}. אפשר לאשר במסך הבקשות."
 *
 * PROPOSED copy. The reason is a parameter rather than three separate
 * templates: all three mean the same thing to the owner — go and look at
 * /bookings — and three templates is three approvals from Meta for one
 * sentence.
 */
export function pendingNoticeBody(f: BookingFacts, reason: PendingReason): string {
  return (
    `בקשת הקלטה ממתינה לאישור: ${f.showName}, ${whenPhrase(f)}, אולפן ${f.studio}, ` +
    `${durationParam(f)}. הסיבה: ${PENDING_REASON_LABEL[reason]}. אפשר לאשר במסך הבקשות.`
  );
}

// ─── the rows ───────────────────────────────────────────────────────────────

export type WaOutboundRow = {
  wamid: string;
  direction: "out";
  wa_id: string;
  type: "template";
  body: string;
  template_name: string;
  status: "dry_run" | "queued";
  payload: Json;
};

/**
 * The synthetic `wamid` for a message WE originate.
 *
 * 🔴 0101 MADE `wamid` NOT NULL UNIQUE because it is Meta's id and the de-dup
 * key for inbound deliveries. An outbound notification has no Meta id until it
 * is actually sent, so it needs one of ours — and making it DETERMINISTIC over
 * (kind, booking, recipient) buys the same protection for free:
 *
 *   **one notification per booking per kind per recipient, ever.**
 *
 * ⚠️ THAT IS A DELIBERATE SEMANTIC, NOT A SIDE EFFECT. A booking that is
 * approved, reverted to pending by a calendar failure, and approved again by
 * hand will NOT send a second "approved" notice. The owner is looking at
 * /bookings at that point — the screen carries the state, with the error text
 * — so the second message would be noise, and the failure mode of the
 * alternative is a notification storm aimed at two people's phones.
 *
 * `local:` prefixes it so no value here can ever collide with a real Meta id,
 * and so a human reading the table can see at a glance which rows we minted.
 */
export function notificationWamid(kind: NotificationKind, bookingId: string, waId: string): string {
  return `local:${kind}:${bookingId}:${waId}`;
}

/** One row per recipient. PURE — the status comes in, it is not read from env here. */
export function buildNotificationRows(input: {
  kind: NotificationKind;
  bookingId: string;
  recipients: string[];
  templateName: string;
  variables: Record<string, string>;
  body: string;
  status: "dry_run" | "queued";
}): WaOutboundRow[] {
  return input.recipients.map((waId) => ({
    wamid: notificationWamid(input.kind, input.bookingId, waId),
    direction: "out" as const,
    wa_id: waId,
    type: "template" as const,
    body: input.body,
    template_name: input.templateName,
    status: input.status,
    // 🔴 THE FULL PAYLOAD, so a row is reproducible without this code. The
    // owner asked for "המטען המלא": the template, the positional variables in
    // order, and which booking it is about. When E9-3 adds the sender, this is
    // the object it serialises — it does not re-derive it.
    payload: {
      kind: input.kind,
      booking_id: input.bookingId,
      template: input.templateName,
      variables: input.variables,
      dry_run: input.status === "dry_run",
    } as Json,
  }));
}

// ─── the one impure function ────────────────────────────────────────────────

export type RecordResult = { recorded: number; recipients: number; dryRun: boolean };

/**
 * Render a notification and record it. Writes to `wa_messages` and nothing else.
 *
 * 🔴 IT NEVER THROWS. Every caller is in the middle of something that matters
 * more than the notification — a client's booking being approved, a calendar
 * write being retried — and a notification failure must not fail that. The
 * contract is "best effort, loudly logged", and the return value says what
 * happened so the caller can log it too.
 *
 * ⚠️ `ignoreDuplicates` on the deterministic wamid: see notificationWamid. The
 * second call for the same (kind, booking, recipient) writes nothing and
 * reports `recorded: 0`, which is the honest number.
 */
export async function recordBookingNotification(
  admin: SupabaseClient<Database>,
  input:
    | { kind: "booking-approved"; bookingId: string; facts: BookingFacts }
    | { kind: "booking-pending"; bookingId: string; facts: BookingFacts; reason: PendingReason }
): Promise<RecordResult> {
  const dryRun = isWhatsappDryRun();
  const raw = process.env.WHATSAPP_NOTIFY_NUMBERS;
  const recipients = parseNotifyNumbers(raw);
  const rejected = rejectedNotifyNumbers(raw);

  if (rejected.length > 0) {
    // Counted, not printed: these are phone numbers, and a malformed one is
    // still somebody's number. The count is what tells the owner the variable
    // has a typo in it.
    console.error("wa/notify: WHATSAPP_NOTIFY_NUMBERS נדחו רשומות, nrejected=", rejected.length);
  }
  if (recipients.length === 0) {
    // The CRON_SECRET lesson (api/calendar/sync/route.ts:45-46): a variable
    // that was never set must not fail silently. Nothing is recorded, because
    // there is no recipient to record a message to.
    console.error("wa/notify: אין נמענים — WHATSAPP_NOTIFY_NUMBERS ריק או שגוי. לא נרשמה התראה");
    return { recorded: 0, recipients: 0, dryRun };
  }

  const f = input.facts;
  const templateName =
    input.kind === "booking-approved" ? TEMPLATE_BOOKING_APPROVED : TEMPLATE_BOOKING_PENDING;

  const variables: Record<string, string> =
    input.kind === "booking-approved"
      ? {
          showName: f.showName,
          whenLine: whenPhrase(f),
          studio: f.studio,
          duration: durationParam(f),
          guest: guestParam(f),
        }
      : {
          showName: f.showName,
          whenLine: whenPhrase(f),
          studio: f.studio,
          duration: durationParam(f),
          reason: PENDING_REASON_LABEL[input.reason],
        };

  const body =
    input.kind === "booking-approved" ? approvedNoticeBody(f) : pendingNoticeBody(f, input.reason);

  const rows = buildNotificationRows({
    kind: input.kind,
    bookingId: input.bookingId,
    recipients,
    templateName,
    variables,
    body,
    status: dryRun ? "dry_run" : "queued",
  });

  if (!dryRun) {
    // Honest about the gap rather than silently producing rows that look sent.
    console.error(
      "wa/notify: WHATSAPP_DRY_RUN=false אבל השליחה עוד לא ממומשת (E9-3). ההתראה נרשמת כ-queued, nrows=",
      rows.length
    );
  }

  try {
    const { data, error } = await admin
      .from("wa_messages")
      .upsert(rows, { onConflict: "wamid", ignoreDuplicates: true })
      .select("wamid");
    if (error) {
      console.error("wa/notify: רישום ההתראה נכשל", error);
      return { recorded: 0, recipients: recipients.length, dryRun };
    }
    return { recorded: (data ?? []).length, recipients: recipients.length, dryRun };
  } catch (e) {
    console.error("wa/notify: רישום ההתראה זרק", e);
    return { recorded: 0, recipients: recipients.length, dryRun };
  }
}
