import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { isWhatsappDryRun, sendWhatsapp, templatePayload } from "./client";
import { dayMonth, dowHebrew } from "@/app/calendar/availability/booking";

// ═══════════════════════════════════════════════════════════════════════════
// The notifications to the owner and to Eli. E9-2 rendered and recorded them;
// E9-3 SENDS them.
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ 🔴 THE ORDER: RECORD, THEN SEND, THEN SETTLE ═══
//   1. upsert the row (`queued`, or `dry_run` when the switch is on)
//   2. if NOTHING was inserted -> this notification already exists. STOP, and
//      send nothing.
//   3. dry run -> stop here. The row is the whole deliverable.
//   4. send
//   5. update the row: `sent` + `provider_wamid`, or `failed` + `error`
//
// Step 2 is the idempotency lock, and it is the database's unique index doing
// the work rather than a check of ours: `wamid` is our own deterministic
// `local:<kind>:<booking>:<recipient>` (see notificationWamid), so a second
// call for the same notification inserts zero rows and we never reach the
// send. A select-then-insert would lose that race against two approvals
// landing in the same second.
//
// Recording BEFORE sending is the other half: a crash between the two leaves a
// visible `queued` row, which is a thing somebody can see and act on. Sending
// first and crashing leaves a message in a client's phone that our database
// has never heard of.
//
// ⚠️ ONE CASE THIS CANNOT MAKE SAFE, AND IT IS STATED RATHER THAN HIDDEN: a
// TIMEOUT. Graph may have accepted the message and we will never know. The row
// goes to `failed` and keeps its deterministic wamid, so no second ROW is ever
// created — but a human retry can produce a second WhatsApp MESSAGE. At two
// recipients and a few bookings a day that is the right trade against the
// alternative (recording a timeout as `sent` and losing real failures).
//
// ═══ 🔴 THE RECIPIENTS COME FROM THE ENVIRONMENT, NOT FROM THE CODE ═══
// Owner decision 8.10: `WHATSAPP_NOTIFY_NUMBERS`, comma-separated, digits
// only. Eli's number is NOT in this repository and must not be: a phone number
// in source is a phone number in every clone, every fork and every screenshot
// of a diff. Same reasoning that keeps the studio's own number out
// (`STUDIO_WHATSAPP_NUMBER`, publicView.ts:164-167).
//
// ⚠️ AND IT IS VALIDATED, NOT SANITISED — the exact rule `whatsappNumberFrom`
// applies: an entry with a `+`, a dash or a space is DROPPED rather than
// cleaned up, because silently stripping characters hides a typo'd number that
// still dials somewhere. A list of three with one malformed notifies two
// people and says so in the log.

// ─── the templates ──────────────────────────────────────────────────────────
//
// 🔴 NAMES, LANGUAGE AND VARIABLE ORDER ARE A CONTRACT WITH META. A template
// is registered once and approved once; from then on Graph fills `{{1}}`,
// `{{2}}` … POSITIONALLY from the array `templatePayload` builds. Reordering
// one of the `*_VARS` lists below silently swaps two values inside a message
// the owner reads as fact — so each list is the single source of the order,
// the body builders read the same fields, and the suite asserts they agree.

/** Every template is registered in Hebrew. */
export const TEMPLATE_LANGUAGE = "he";

/** Utility — one recording was approved automatically. */
export const TEMPLATE_BOOKING_APPROVED = "bizi_booking_approved";
export const TEMPLATE_BOOKING_APPROVED_VARS = [
  "showName",
  "whenLine",
  "studio",
  "duration",
  "guest",
] as const;

/** Utility — a request did NOT auto-approve and is waiting. */
export const TEMPLATE_BOOKING_PENDING = "bizi_booking_pending";
export const TEMPLATE_BOOKING_PENDING_VARS = [
  "showName",
  "whenLine",
  "studio",
  "duration",
  "reason",
] as const;

/** Utility — an unknown number messaged the bot (E9-3). Owner only. */
export const TEMPLATE_UNKNOWN_CONTACT = "bizi_unknown_contact";
export const TEMPLATE_UNKNOWN_CONTACT_VARS = ["waId", "excerpt"] as const;

// ─── the registered texts ───────────────────────────────────────────────────
//
// 🔴 WORD FOR WORD WHAT META APPROVED (owner, 11.10), newlines included. Meta
// refused the first, shorter wording ("too many variables for its length"), so
// the owner submitted these. Graph only ever receives the PARAMETER VALUES, so
// this text is never sent — it exists so the `body` recorded in `wa_messages`
// is the message the recipient actually reads, filled from the very same
// positional array (see fillTemplate). Edit one of these only together with a
// re-submission to Meta.

export const TEMPLATE_BOOKING_APPROVED_TEXT =
  "שלום! התקבלה הזמנה חדשה להקלטה באולפן ביזי, והיא אושרה אוטומטית במערכת.\n" +
  "פודקאסט: {{1}}\n" +
  "מועד: {{2}}\n" +
  "אולפן: {{3}}\n" +
  "משך ההקלטה: {{4}}\n" +
  "אורח/ת: {{5}}\n" +
  "פרטי ההזמנה המלאים זמינים במסך הבקשות במערכת.";

export const TEMPLATE_BOOKING_PENDING_TEXT =
  "שלום! התקבלה בקשת הקלטה חדשה שממתינה לאישור ידני במערכת ביזי.\n" +
  "פודקאסט: {{1}}\n" +
  "מועד: {{2}}\n" +
  "אולפן: {{3}}\n" +
  "משך ההקלטה: {{4}}\n" +
  "הסיבה לאישור ידני: {{5}}\n" +
  "אפשר לאשר או לדחות את הבקשה במסך הבקשות במערכת.";

export const TEMPLATE_UNKNOWN_CONTACT_TEXT =
  "שלום! מספר שאינו משויך לאף פודקאסט פנה לבוט ההזמנות של ביזי.\n" +
  "המספר: {{1}}\n" +
  "תוכן ההודעה: {{2}}\n" +
  "כדי לאפשר לו להזמין, יש לשייך אותו בכרטיס הלקוח, בכרטיסיית הרשאות הזמנת חדרים.";

export const TEMPLATE_BOOKING_CHANGE_TEXT =
  "עדכון על הקלטה במערכת ביזי: {{1}}.\n" +
  "פודקאסט: {{2}}\n" +
  "המועד: {{3}}\n" +
  "אולפן: {{4}}\n" +
  "פרטים: {{5}}\n" +
  "את כל הפרטים אפשר לראות במסך הבקשות במערכת.";

/** The `{{n}}` numbers in a template text, in the order they appear. */
export function templatePlaceholders(text: string): number[] {
  return Array.from(text.matchAll(/\{\{(\d+)\}\}/g), (m) => Number(m[1]));
}

/**
 * Fill `{{n}}` with `params[n-1]` — what Graph does on its side. A placeholder
 * with no parameter is left visible rather than blanked, so a mismatch shows
 * up in the recorded body instead of hiding in it.
 */
export function fillTemplate(text: string, params: readonly string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (whole, n: string) => params[Number(n) - 1] ?? whole);
}

/**
 * Utility — a recording was changed or a change was asked for (E9-5). ONE
 * template for five situations, the situation itself being `{{1}}`: every one
 * of them means "go and look at /bookings", and five templates would be five
 * approvals from Meta for one sentence (the same reasoning as the pending
 * template's reason parameter). SUBMITTED to Meta on 11.10 and awaiting
 * approval; until it is approved, a send fails (132001), is logged, and fails
 * nothing else.
 */
export const TEMPLATE_BOOKING_CHANGE = "bizi_booking_change";
export const TEMPLATE_BOOKING_CHANGE_VARS = ["change", "showName", "whenLine", "studio", "details"] as const;

export type BookingChange =
  | "client-cancelled"
  | "client-moved"
  | "cancel-request"
  | "move-request"
  | "calendar-delete-failed";

/** `{{1}}` — what happened, in the owner's words. Never starts the template. */
export const BOOKING_CHANGE_LABEL: Record<BookingChange, string> = {
  "client-cancelled": "הלקוח ביטל הקלטה דרך הבוט",
  "client-moved": "הלקוח הזיז הקלטה דרך הבוט",
  "cancel-request": "בקשת ביטול בתוך 24 השעות שלפני ההקלטה",
  "move-request": "בקשת הזזה בתוך 24 השעות שלפני ההקלטה",
  "calendar-delete-failed": "הקלטה בוטלה אבל המחיקה מהיומן נכשלה",
};

/** Why a request stayed pending. Each one is a different sentence to the owner. */
export type PendingReason = "second-same-day" | "calendar-failed" | "slot-taken";

export const PENDING_REASON_LABEL: Record<PendingReason, string> = {
  "second-same-day": "הזמנה שנייה באותו יום",
  "calendar-failed": "הכתיבה ליומן נכשלה",
  "slot-taken": "המשבצת נתפסה ביומן",
};

export type NotificationKind =
  | "booking-approved"
  | "booking-pending"
  | "unknown-contact"
  | "booking-change"
  | "client-registration";

// ─── E17-4: the registration notice, and which templates Meta approved ──────

/**
 * Utility — a client registration event, to Bnaya and Eli (E17-4). ONE
 * template for three events, the event itself being `{{1}}` — the pattern Meta
 * already accepted in `bizi_booking_change`. Text: docs/plans/E17 "תבניות
 * להגשה". NOT YET APPROVED by Meta — see TEMPLATE_META_APPROVED.
 */
export const TEMPLATE_CLIENT_REGISTRATION = "bizi_client_registration";
export const TEMPLATE_CLIENT_REGISTRATION_VARS = ["event", "name", "podcast", "phone", "details"] as const;
export const TEMPLATE_CLIENT_REGISTRATION_TEXT =
  "עדכון על לקוח במערכת ביזי: {{1}}.\n" +
  "שם העסק: {{2}}\n" +
  "פודקאסט: {{3}}\n" +
  "מספר הוואטסאפ: {{4}}\n" +
  "פרטים: {{5}}\n" +
  "את ההמשך מטפלים במסך הלקוחות במערכת.";

export type RegistrationEvent = "new" | "duplicate" | "existing-claim";

/** `{{1}}`, word for word as submitted (docs/plans/E17, "תבניות להגשה"). */
export const REGISTRATION_EVENT_LABEL: Record<RegistrationEvent, string> = {
  new: "נרשם לקוח חדש והוא ממתין לאישור",
  duplicate: "הרשמה חדשה הותאמה לכרטיס קיים",
  "existing-claim": "מספר לא משויך כתב בבוט שהוא כבר לקוח",
};

/** A `{{2}}`/`{{3}}` the event has no value for — Graph refuses an empty parameter. */
export const NOT_GIVEN = "לא נמסר";

/**
 * Which templates Meta has APPROVED (E17-4). A template that is not listed, or
 * is listed `false`, is NOT SENT: `recordBookingNotification` refuses it before
 * recording anything, and the caller decides what to do instead.
 *
 * Default: not approved. Flip an entry only after Meta's approval, in the same
 * commit that says so.
 *
 *   · bizi_booking_change       — approved by Meta 11.10 (Active).
 *   · bizi_client_registration  — approved by Meta 11.10 (Active).
 *   · bizi_client_approved      — IN REVIEW. Re-submitted 11.10 with a new
 *                                 wording after Meta classified the first as
 *                                 marketing (see TEMPLATE_CLIENT_APPROVED_TEXT).
 */
export const TEMPLATE_META_APPROVED: Record<string, boolean> = {
  bizi_booking_approved: true,
  bizi_booking_pending: true,
  bizi_unknown_contact: true,
  bizi_booking_change: true,
  bizi_client_registration: true,
  bizi_client_approved: false,
};

/**
 * Utility — "your account is approved", to the CLIENT's first authorised
 * number, outside the 24-hour window (E17-5). Hebrew + English under one name.
 * Re-submitted 11.10 (the first wording was classified as marketing); no
 * button; message validity in Meta: 6 hours. `{{1}}` = name, `{{2}}` = podcast.
 */
export const TEMPLATE_CLIENT_APPROVED = "bizi_client_approved";
export const TEMPLATE_CLIENT_APPROVED_VARS = ["name", "podcast"] as const;
export const TEMPLATE_CLIENT_APPROVED_TEXT: Record<"he" | "en", string> = {
  he:
    "שלום {{1}}, הכרטיס שלכם ב-Bizi Podclub אושר.\n" +
    "הפודקאסט {{2}} חובר למספר הזה לצורך הזמנת הקלטות.\n" +
    "ההזמנה הראשונה תאושר ידנית על ידי הצוות.",
  en:
    "Hi {{1}}, your account at Bizi Podclub has been approved.\n" +
    "{{2}} has been linked to this number for booking recordings.\n" +
    "Your first booking will be approved manually by the team.",
};

export function isTemplateApproved(name: string): boolean {
  return TEMPLATE_META_APPROVED[name] === true;
}

/** The registration template's named variables — never an empty value. */
export function registrationNoticeVariables(input: {
  event: RegistrationEvent;
  name: string | null;
  podcast: string | null;
  waId: string;
  details: string;
}) {
  const v = (s: string | null) => (s && s.trim() !== "" ? excerptParam(s) : NOT_GIVEN);
  return {
    event: REGISTRATION_EVENT_LABEL[input.event],
    name: v(input.name),
    podcast: v(input.podcast),
    phone: displayWaIdForNotice(input.waId),
    details: excerptParam(input.details),
  } satisfies Record<(typeof TEMPLATE_CLIENT_REGISTRATION_VARS)[number], string>;
}

/** 972501234567 -> 050-123-4567 (Israeli mobiles); anything else as given. */
function displayWaIdForNotice(waId: string): string {
  const m = /^972(5\d)(\d{3})(\d{4})$/.exec(waId);
  return m ? `0${m[1]}-${m[2]}-${m[3]}` : waId;
}

/** How much of an unknown sender's message travels into the notification. */
export const EXCERPT_MAX_CHARS = 120;

// ─── recipients ─────────────────────────────────────────────────────────────

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

/** "יום א׳ 27.9, 09:00–12:00" — shared by both booking templates as one parameter. */
export function whenPhrase(f: BookingFacts): string {
  return `יום ${dowHebrew(f.dateIsrael)} ${dayMonth(f.dateIsrael)}, ${f.startIsrael}–${f.endIsrael}`;
}

/** The duration parameter, never empty — Meta rejects a blank template parameter. */
export function durationParam(f: BookingFacts): string {
  return f.durationTag ?? "שעה וחצי";
}

/** The guest parameter, never empty — same rule. */
export function guestParam(f: BookingFacts): string {
  const g = (f.guest ?? "").trim();
  return g === "" ? "בלי אורח" : g;
}

/**
 * The excerpt parameter, never empty and never a newline.
 *
 * 🔴 NEWLINES ARE COLLAPSED, AND THAT IS A META CONSTRAINT, NOT COSMETICS. A
 * template parameter may not contain a newline or a tab — Graph rejects the
 * whole send — and a client's WhatsApp message very often has one. Collapsing
 * to single spaces is what lets a multi-line message be quoted at all.
 */
export function excerptParam(body: string | null | undefined): string {
  const collapsed = (body ?? "").replace(/\s+/g, " ").trim();
  if (collapsed === "") return "(הודעה בלי טקסט)";
  return Array.from(collapsed).slice(0, EXCERPT_MAX_CHARS).join("");
}

/** The approved template's named variables — the ONE place they are built. */
export function approvedNoticeVariables(f: BookingFacts) {
  return {
    showName: f.showName,
    whenLine: whenPhrase(f),
    studio: f.studio,
    duration: durationParam(f),
    guest: guestParam(f),
  } satisfies Record<(typeof TEMPLATE_BOOKING_APPROVED_VARS)[number], string>;
}

/** The pending template's named variables. */
export function pendingNoticeVariables(f: BookingFacts, reason: PendingReason) {
  return {
    showName: f.showName,
    whenLine: whenPhrase(f),
    studio: f.studio,
    duration: durationParam(f),
    reason: PENDING_REASON_LABEL[reason],
  } satisfies Record<(typeof TEMPLATE_BOOKING_PENDING_VARS)[number], string>;
}

/**
 * The approved notice as the owner reads it (registered text, owner 11.10).
 * "אוטומטית" is in its first line on purpose: the owner needs to know at once
 * that nobody pressed anything.
 */
export function approvedNoticeBody(f: BookingFacts): string {
  const v = approvedNoticeVariables(f);
  return fillTemplate(TEMPLATE_BOOKING_APPROVED_TEXT, TEMPLATE_BOOKING_APPROVED_VARS.map((k) => v[k]));
}

/**
 * The pending notice (registered text, owner 11.10). The reason is a PARAMETER
 * rather than three templates: all three mean "go and look at /bookings", and
 * three templates is three approvals from Meta for one sentence.
 */
export function pendingNoticeBody(f: BookingFacts, reason: PendingReason): string {
  const v = pendingNoticeVariables(f, reason);
  return fillTemplate(TEMPLATE_BOOKING_PENDING_TEXT, TEMPLATE_BOOKING_PENDING_VARS.map((k) => v[k]));
}

/** The change template's named variables. `details` is never empty and never multi-line. */
export function changeNoticeVariables(f: BookingFacts, change: BookingChange, details: string) {
  return {
    change: BOOKING_CHANGE_LABEL[change],
    showName: f.showName,
    whenLine: whenPhrase(f),
    studio: f.studio,
    details: excerptParam(details),
  } satisfies Record<(typeof TEMPLATE_BOOKING_CHANGE_VARS)[number], string>;
}

export function changeNoticeBody(f: BookingFacts, change: BookingChange, details: string): string {
  const v = changeNoticeVariables(f, change, details);
  return fillTemplate(TEMPLATE_BOOKING_CHANGE_TEXT, TEMPLATE_BOOKING_CHANGE_VARS.map((k) => v[k]));
}

/** The unknown-contact notice (registered text, owner 11.10). Owner only. */
export function unknownContactBody(waId: string, excerpt: string): string {
  return fillTemplate(TEMPLATE_UNKNOWN_CONTACT_TEXT, [waId, excerpt]);
}

// ─── the rows ───────────────────────────────────────────────────────────────

export type OutboundStatus = "dry_run" | "queued" | "sent" | "failed";

export type WaOutboundRow = {
  wamid: string;
  direction: "out";
  wa_id: string;
  type: "template";
  body: string;
  template_name: string;
  status: OutboundStatus;
  payload: Json;
};

/**
 * The synthetic `wamid` for a message WE originate.
 *
 * 🔴 0101 MADE `wamid` NOT NULL UNIQUE because it is Meta's id and the de-dup
 * key for inbound deliveries. An outbound notification has no Meta id until it
 * is sent, so it needs one of ours — and making it DETERMINISTIC over
 * (kind, subject, recipient) buys the same protection for free:
 *
 *   **one notification per subject per kind per recipient, ever.**
 *
 * ⚠️ A DELIBERATE SEMANTIC, NOT A SIDE EFFECT. A booking that is approved,
 * reverted by a calendar failure, and approved again by hand will NOT send a
 * second "approved" notice. The owner is looking at /bookings at that point —
 * the screen carries the state, with the error text — so the second message
 * would be noise, and the failure mode of the alternative is a notification
 * storm aimed at two people's phones.
 *
 * 🔴 AND IT IS WHY 0102 ADDED `provider_wamid` AS A SEPARATE COLUMN rather
 * than overwriting this one after a send: overwriting would change the key
 * AFTER the send, a retry would no longer collide, and the same notification
 * would go out twice.
 *
 * `local:` prefixes it so no value here can collide with a real Meta id, and
 * so a human reading the table can see at a glance which rows we minted.
 */
export function notificationWamid(kind: NotificationKind, subjectId: string, waId: string): string {
  return `local:${kind}:${subjectId}:${waId}`;
}

/** One row per recipient. PURE — the status comes in, it is not read from env. */
export function buildNotificationRows(input: {
  kind: NotificationKind;
  subjectId: string;
  recipients: string[];
  templateName: string;
  /** POSITIONAL, in the template's `{{1}}..{{n}}` order */
  params: string[];
  variables: Record<string, string>;
  body: string;
  status: OutboundStatus;
}): WaOutboundRow[] {
  return input.recipients.map((waId) => ({
    wamid: notificationWamid(input.kind, input.subjectId, waId),
    direction: "out" as const,
    wa_id: waId,
    type: "template" as const,
    body: input.body,
    template_name: input.templateName,
    status: input.status,
    // 🔴 THE FULL PAYLOAD, so a row is reproducible without this code: the
    // template, the positional parameters IN ORDER, the named variables for a
    // human reading the table, and which subject it is about.
    payload: {
      kind: input.kind,
      subject_id: input.subjectId,
      template: input.templateName,
      language: TEMPLATE_LANGUAGE,
      params: input.params,
      variables: input.variables,
      dry_run: input.status === "dry_run",
    } as Json,
  }));
}

// ─── incoming status updates (PURE half) ────────────────────────────────────

/** Meta's four delivery statuses, in the order they can only ever advance. */
const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Should an incoming status replace the one on the row?
 *
 * 🔴 STATUSES ARRIVE OUT OF ORDER, AND WITHOUT THIS GUARD THAT CORRUPTS THE
 * ROW. Meta delivers `sent`, `delivered` and `read` as three separate webhook
 * calls with no ordering promise, and it retries any of them that did not get
 * a 200. So a `read` can land before the `delivered` that preceded it — and a
 * naive write would move a message that was read back to merely delivered.
 *
 * ⚠️ `failed` IS THE EXCEPTION AND ALWAYS WINS. It is the only status that is
 * not a step forward along the same path: a message can fail after being sent,
 * and the owner needs to see that even though `failed` arrives "late".
 */
export function shouldApplyStatus(current: string | null | undefined, incoming: string): boolean {
  if (!(incoming in STATUS_RANK)) return false;
  if (incoming === "failed") return true;
  const cur = STATUS_RANK[current ?? ""] ?? -1;
  return STATUS_RANK[incoming] > cur;
}

// ─── the impure functions ───────────────────────────────────────────────────

export type RecordResult = {
  recipients: number;
  recorded: number;
  sent: number;
  failed: number;
  dryRun: boolean;
  /** E17-4: the template is not approved by Meta — nothing was recorded or sent */
  unapproved?: boolean;
};

type NotifyInput =
  | { kind: "booking-approved"; subjectId: string; facts: BookingFacts }
  | { kind: "booking-pending"; subjectId: string; facts: BookingFacts; reason: PendingReason }
  | { kind: "unknown-contact"; subjectId: string; waId: string; excerpt: string }
  | { kind: "booking-change"; subjectId: string; change: BookingChange; facts: BookingFacts; details: string }
  | {
      kind: "client-registration";
      subjectId: string;
      event: RegistrationEvent;
      name: string | null;
      podcast: string | null;
      waId: string;
      details: string;
    };

/** The template name, the positional params, the named variables and the body. */
function renderNotification(input: NotifyInput): {
  templateName: string;
  params: string[];
  variables: Record<string, string>;
  body: string;
} {
  if (input.kind === "unknown-contact") {
    const excerpt = excerptParam(input.excerpt);
    return {
      templateName: TEMPLATE_UNKNOWN_CONTACT,
      // {{1}} = the number, {{2}} = the excerpt — TEMPLATE_UNKNOWN_CONTACT_VARS
      params: [input.waId, excerpt],
      variables: { waId: input.waId, excerpt },
      body: unknownContactBody(input.waId, excerpt),
    };
  }

  if (input.kind === "client-registration") {
    const variables = registrationNoticeVariables(input);
    const params = TEMPLATE_CLIENT_REGISTRATION_VARS.map((k) => variables[k]);
    return {
      templateName: TEMPLATE_CLIENT_REGISTRATION,
      params,
      variables,
      body: fillTemplate(TEMPLATE_CLIENT_REGISTRATION_TEXT, params),
    };
  }

  const f = input.facts;

  if (input.kind === "booking-change") {
    const variables = changeNoticeVariables(f, input.change, input.details);
    return {
      templateName: TEMPLATE_BOOKING_CHANGE,
      params: TEMPLATE_BOOKING_CHANGE_VARS.map((k) => variables[k]),
      variables,
      body: changeNoticeBody(f, input.change, input.details),
    };
  }

  if (input.kind === "booking-approved") {
    const variables = approvedNoticeVariables(f);
    return {
      templateName: TEMPLATE_BOOKING_APPROVED,
      // ⚠️ BUILT FROM THE *_VARS LIST, not hand-ordered. The list is the single
      // source of the `{{1}}..{{5}}` order, so the array and the approved
      // template cannot drift apart by someone editing one of the two.
      params: TEMPLATE_BOOKING_APPROVED_VARS.map((k) => variables[k]),
      variables,
      body: approvedNoticeBody(f),
    };
  }

  const variables = pendingNoticeVariables(f, input.reason);
  return {
    templateName: TEMPLATE_BOOKING_PENDING,
    params: TEMPLATE_BOOKING_PENDING_VARS.map((k) => variables[k]),
    variables,
    body: pendingNoticeBody(f, input.reason),
  };
}

/**
 * Render, record, and (outside a dry run) send one notification to everyone on
 * the list.
 *
 * 🔴 IT NEVER THROWS. Every caller is in the middle of something that matters
 * more — a client's booking being approved, a webhook that owes Meta a 200 —
 * and a notification failure must not fail that. "Best effort, loudly logged",
 * and the return value says exactly what happened.
 *
 * ⚠️ `onlyOwner` exists for the unknown-contact notice: owner decision 9.10
 * sends that one to the OWNER ALONE, while the two booking notices go to both
 * recipients. "The owner" is the FIRST entry in `WHATSAPP_NOTIFY_NUMBERS` —
 * documented in the report, because it is the one place where the order of
 * that variable carries meaning.
 */
export async function recordBookingNotification(
  admin: SupabaseClient<Database>,
  input: NotifyInput & { onlyOwner?: boolean }
): Promise<RecordResult> {
  const dryRun = isWhatsappDryRun();
  const raw = process.env.WHATSAPP_NOTIFY_NUMBERS;
  const all = parseNotifyNumbers(raw);
  const rejected = rejectedNotifyNumbers(raw);
  const recipients = input.onlyOwner ? all.slice(0, 1) : all;

  if (rejected.length > 0) {
    // Counted, not printed: a malformed entry is still somebody's number. The
    // count is what tells the owner the variable has a typo in it.
    console.error("wa/notify: WHATSAPP_NOTIFY_NUMBERS נדחו רשומות, nrejected=", rejected.length);
  }
  if (recipients.length === 0) {
    // The CRON_SECRET lesson: a variable that was never set must not fail
    // silently. Nothing is recorded, because there is no recipient.
    console.error("wa/notify: אין נמענים — WHATSAPP_NOTIFY_NUMBERS ריק או שגוי. לא נרשמה התראה");
    return { recipients: 0, recorded: 0, sent: 0, failed: 0, dryRun };
  }

  const r = renderNotification(input);

  // E17-4: a template Meta has not approved is not sent and not recorded as a
  // message — a `queued`/`failed` row would claim a message existed. The
  // caller is told, and decides what replaces it.
  if (!isTemplateApproved(r.templateName)) {
    return { recipients: recipients.length, recorded: 0, sent: 0, failed: 0, dryRun, unapproved: true };
  }

  const rows = buildNotificationRows({
    kind: input.kind,
    subjectId: input.subjectId,
    recipients,
    templateName: r.templateName,
    params: r.params,
    variables: r.variables,
    body: r.body,
    status: dryRun ? "dry_run" : "queued",
  });

  // ── step 1-2: record, and let the unique index decide who is new ────────
  let fresh: string[] = [];
  try {
    const { data, error } = await admin
      .from("wa_messages")
      .upsert(rows, { onConflict: "wamid", ignoreDuplicates: true })
      .select("wamid");
    if (error) {
      console.error("wa/notify: רישום ההתראה נכשל", error);
      return { recipients: recipients.length, recorded: 0, sent: 0, failed: 0, dryRun };
    }
    fresh = (data ?? []).map((d) => d.wamid);
  } catch (e) {
    console.error("wa/notify: רישום ההתראה זרק", e);
    return { recipients: recipients.length, recorded: 0, sent: 0, failed: 0, dryRun };
  }

  // ── step 3: a dry run stops here. The row IS the deliverable. ───────────
  if (dryRun || fresh.length === 0) {
    return { recipients: recipients.length, recorded: fresh.length, sent: 0, failed: 0, dryRun };
  }

  // ── step 4-5: send only the rows that were actually inserted ────────────
  let sent = 0;
  let failed = 0;
  for (const row of rows.filter((x) => fresh.includes(x.wamid))) {
    const result = await sendWhatsapp(
      templatePayload({
        to: row.wa_id,
        name: row.template_name,
        language: TEMPLATE_LANGUAGE,
        params: r.params,
      })
    );
    const at = new Date().toISOString();
    if (result.ok && !result.dryRun) {
      sent++;
      await admin
        .from("wa_messages")
        .update({ status: "sent", provider_wamid: result.providerWamid, status_at: at })
        .eq("wamid", row.wamid);
    } else if (!result.ok) {
      failed++;
      console.error("wa/notify: שליחה נכשלה", row.template_name, result.error);
      await admin
        .from("wa_messages")
        .update({ status: "failed", error: result.error, status_at: at })
        .eq("wamid", row.wamid);
    }
  }

  return { recipients: recipients.length, recorded: fresh.length, sent, failed, dryRun };
}

/**
 * Apply one delivery-status update from Meta.
 *
 * Matched on `provider_wamid` — 0102's partial unique index is what makes that
 * a single row. Never on our own `wamid`: Meta has never seen that value.
 *
 * ⚠️ READ-THEN-WRITE, GUARDED BY `shouldApplyStatus`. The read is what lets
 * an out-of-order `delivered` arriving after a `read` be DROPPED instead of
 * regressing the row. A blind update would be one round trip cheaper and
 * wrong.
 */
export async function applyStatusUpdate(
  admin: SupabaseClient<Database>,
  update: { providerWamid: string; status: string; errorText: string | null; at: string }
): Promise<"applied" | "skipped" | "unknown" | "error"> {
  try {
    const { data, error } = await admin
      .from("wa_messages")
      .select("wamid,status")
      .eq("provider_wamid", update.providerWamid)
      .maybeSingle();
    if (error) {
      console.error("wa/notify: קריאת שורת ההודעה לעדכון מצב נכשלה", error);
      return "error";
    }
    // A status for a message we never recorded. Not an error: Meta also
    // reports on messages sent from the WhatsApp Manager by hand.
    if (!data) return "unknown";

    const row = data;
    if (!shouldApplyStatus(row.status, update.status)) return "skipped";

    const patch: Database["public"]["Tables"]["wa_messages"]["Update"] = {
      status: update.status,
      status_at: update.at,
    };
    if (update.errorText) patch.error = update.errorText;
    const { error: updErr } = await admin.from("wa_messages").update(patch).eq("wamid", row.wamid);
    if (updErr) {
      console.error("wa/notify: עדכון מצב ההודעה נכשל", updErr);
      return "error";
    }
    return "applied";
  } catch (e) {
    console.error("wa/notify: עדכון מצב ההודעה זרק", e);
    return "error";
  }
}

/**
 * A change notice (E9-5), keyed ONCE per (change, booking): a client who asks
 * twice inside the 24 hours does not page the owner twice, and a re-delivered
 * webhook cannot either. The owner and Eli get the client's own changes; a
 * calendar-delete failure goes to the owner alone (owner decision 11.10, 2).
 */
export async function notifyBookingChange(
  admin: SupabaseClient<Database>,
  input: { change: BookingChange; bookingId: string; facts: BookingFacts; details: string }
): Promise<RecordResult> {
  return recordBookingNotification(admin, {
    kind: "booking-change",
    subjectId: `${input.change}:${input.bookingId}`,
    change: input.change,
    facts: input.facts,
    details: input.details,
    onlyOwner: input.change === "calendar-delete-failed",
  });
}

/**
 * A registration notice to Bnaya and Eli (E17-4), once per subject.
 *
 * While `bizi_client_registration` is not approved:
 *   · a NEW or DUPLICATE registration is not sent; an event is written on the
 *     registration row, and the registration itself is what the owner sees —
 *     the "ממתינים לאישור" tab of /clients lists both kinds;
 *   · an EXISTING-CLAIM ("אני כבר לקוח") has no row on any screen, so it falls
 *     back to `bizi_unknown_contact` — approved, owner only, and its own
 *     wording already says "associate the number on the client card". One
 *     message either way, never both.
 */
export async function notifyClientRegistration(
  admin: SupabaseClient<Database>,
  input: {
    event: RegistrationEvent;
    subjectId: string;
    /** the registration row, when there is one — where a skipped notice is recorded */
    registrationId: string | null;
    name: string | null;
    podcast: string | null;
    waId: string;
    details: string;
  }
): Promise<RecordResult & { fallback?: "unknown-contact" | "event" }> {
  try {
    const res = await recordBookingNotification(admin, {
      kind: "client-registration",
      subjectId: input.subjectId,
      event: input.event,
      name: input.name,
      podcast: input.podcast,
      waId: input.waId,
      details: input.details,
    });
    if (!res.unapproved) return res;

    if (input.event === "existing-claim") {
      const fb = await recordBookingNotification(admin, {
        kind: "unknown-contact",
        subjectId: input.subjectId,
        waId: input.waId,
        excerpt: EXISTING_CLAIM_EXCERPT,
        onlyOwner: true,
      });
      return { ...fb, fallback: "unknown-contact" };
    }

    if (input.registrationId) {
      const variables = registrationNoticeVariables(input);
      await admin.from("events").insert({
        entity_type: "client_registration",
        entity_id: input.registrationId,
        event_type: "notification_skipped_template_unapproved",
        payload: { template: TEMPLATE_CLIENT_REGISTRATION, event: input.event, variables } as Json,
      });
    }
    return { ...res, fallback: "event" };
  } catch (e) {
    console.error("wa/notify: התראת ההרשמה זרקה", e);
    return { recipients: 0, recorded: 0, sent: 0, failed: 0, dryRun: isWhatsappDryRun() };
  }
}

/** The `{{2}}` of the fallback notice — what the number did, in the owner's words. */
export const EXISTING_CLAIM_EXCERPT = "לחץ/ה בבוט על \"אני כבר לקוח\"";

/** The `{{5}}` of an existing-claim notice (docs/plans/E17, "תבניות להגשה"). */
export const EXISTING_CLAIM_DETAILS = "יש לשייך את המספר ידנית בכרטיס הלקוח";
