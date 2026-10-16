import { BOOKING_DURATIONS, DEFAULT_BOOKING_DURATION, validateDuration, type BookingDuration } from "@/lib/booking/duration";
import {
  BOOKABLE_ROOM_NAMES,
  normalizeGuest,
  normalizeNote,
  validateStudio,
  type BookableRoom,
} from "@/lib/booking/request";
import { clickableDays, hoursFor } from "@/app/calendar/availability/booking";
import type { PublicAvailability } from "@/lib/booking/publicView";
import { bookableRoomForDefault } from "@/lib/calendar/rooms";
import { STUDIOS } from "@/lib/calendar/studios";
import type { SubmitResult } from "@/lib/booking/submit";
import { selfServeAllowed } from "@/lib/booking/manage";
import { COPY, copy, isLang, DEFAULT_LANG, type BotCopy, type Lang } from "./copy";
import type { ParsedAvailability, ParsedEdit } from "./freetext";
import { langButtonId } from "../lang";

// ═══════════════════════════════════════════════════════════════════════════
// The booking conversation, as a PURE state machine. E9-4.
// ═══════════════════════════════════════════════════════════════════════════
//
// Input: the stored state + ONE STRUCTURED EVENT. Output: the next state + what
// to send, or a request for the one thing the machine cannot know by itself
// (fresh availability, the result of a submission, the booking link). No
// fetch, no client, no clock read, no env — every one of those is the
// driver's (./run.ts), which only wires.
//
// ═══ 🔴 WHY STRUCTURED EVENTS, AND NOT BUTTON IDS ═══
// Owner decision 11.10 (1): buttons and lists only for now, and LATER a
// free-language layer that understands "יש מקום מחר אחרי 4?". So the machine
// never sees a button id. `parseFlowId` turns a tap into an event like
// `{ type: "day", date: "2026-10-14" }`, and a future language layer will emit
// the very same events — no rewrite of any step.
//
// 🔴 AND EVERY PICK IS VALIDATED AGAINST THE STATE, never against what came
// back from Meta. A day is accepted only if it is in `state.days` (the days
// availability actually offered), an hour only if it is in `state.hours`, a
// duration and a studio only through the same validators the public route
// uses. That is what makes a stale tap on an old message, a double tap, or a
// crafted payload harmless — and it is exactly the property a language layer
// needs, because a parsed "Tuesday" is just as untrusted as a tapped one.
//
// ═══ THE STEPS ═══
//   menu → duration → (studio-default | studio) → day → hour → guest → note
//        → summary → submitting → done
// "חזרה" walks one step back (or one PAGE back inside a paged list);
// "התחלה מחדש" returns to the menu with nothing chosen.
//
// ═══ E9-5: CANCEL AND MOVE (owner decision 11.10) ═══
//   menu → mine → manage → cancel-confirm → submitting → done
//                        → (move) studio-default → day → hour → summary
//                          → submitting → done
// A move REUSES the booking steps with `mode: "move"`: the length and the
// room come from the original recording (the room can be changed), the guest
// and the note are carried over, and the summary shows "מ־… ל־…". More than
// 24 hours ahead the bot acts; within 24 hours it forwards to the team (the
// driver re-checks at execution, with a fresh read — the conversation can
// cross the boundary while the client is tapping).

/** Meta allows 10 list rows IN TOTAL; 7 choices + "more" + back + restart. */
export const PAGE_SIZE = 7;

/** "ההקלטות שלי": at most 8 recordings + back + restart = 10 rows. */
export const MINE_MAX = 8;

/** A conversation that has not moved for this long is over (owner-approved, 11.10). */
export const FLOW_TTL_MS = 30 * 60 * 1000;

export const FLOW_STEPS = [
  "menu",
  "duration",
  "studio-default",
  "studio",
  "day",
  "hour",
  "guest",
  "note",
  "summary",
  "submitting",
  "done",
  // E9-5
  "mine",
  "manage",
  "cancel-confirm",
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

/** One of the client's own upcoming approved recordings (E9-5). */
export type RecordingOption = {
  id: string;
  showId: string;
  showName: string;
  studio: string;
  date: string;
  start: string;
  end: string;
  startIso: string;
  /** from the two instants; null for a length that is not one of the three */
  durationMinutes: number | null;
  guest: string | null;
  note: string | null;
};

export type FlowState = {
  v: 1;
  step: FlowStep;
  showId: string;
  showName: string;
  /** the show's default room, already resolved through bookableRoomForDefault */
  defaultStudio: BookableRoom | null;
  /** does this number book more than one podcast? (offers "פודקאסט אחר") */
  multiShow: boolean;
  duration: BookingDuration | null;
  studio: BookableRoom | null;
  /** every day availability offered for (duration, studio) — the validation set */
  days: string[];
  dayPage: number;
  date: string | null;
  /** every start availability offered on `date` — the validation set */
  hours: { start: string; end: string }[];
  hourPage: number;
  start: string | null;
  end: string | null;
  guest: string | null;
  note: string | null;
  /** a one-line prefix for the next rendered step (slot taken, day full…) */
  notice: string | null;
  /** set once a request exists, so a second "לקבוע" can never make another */
  requestId: string | null;
  // ── E9-5 ──
  /** "book" a new recording, or "move" `target` */
  mode: "book" | "move";
  /** is cancel/move switched on (WHATSAPP_BOOKING_MANAGE)? decides the menu */
  manageOn: boolean;
  /** the show's booking link, shown in the menu's body */
  linkUrl: string | null;
  /** the recordings "ההקלטות שלי" offered — the validation set */
  recordings: RecordingOption[];
  /** the recording being cancelled or moved */
  target: RecordingOption | null;
  // ── E19 ──
  /** the language every message of this conversation is written in */
  lang: Lang;
  /** is the bilingual bot switched on (WHATSAPP_BILINGUAL)? decides the menu's language button */
  bilingualOn: boolean;
  // ── E14 ──
  /** is the free-text layer switched on (WHATSAPP_BOOKING_FREETEXT)? */
  freeTextOn: boolean;
  /**
   * constraints the client WROTE (E14): they narrow the day and hour lists.
   * null = the button path, every offered option. A pick is still validated
   * against the STORED lists — the filter only decides which of them are
   * stored as offered at all.
   */
  filter: { dateFrom: string | null; dateTo: string | null; timeFrom: string | null; timeTo: string | null } | null;
  /** the length is the DEFAULT the language layer applied, not a choice — the summary says so (owner, 16.10) */
  durationFromDefault: boolean;
};

export type FlowEvent =
  | { type: "text"; text: string }
  | { type: "go" }
  | { type: "link" }
  | { type: "switch-show" }
  | { type: "duration"; minutes: number }
  | { type: "studio-yes" }
  | { type: "studio-other" }
  | { type: "studio"; studio: string }
  | { type: "day"; date: string }
  | { type: "more-days" }
  | { type: "hour"; start: string }
  | { type: "more-hours" }
  | { type: "no-guest" }
  | { type: "no-note" }
  | { type: "confirm" }
  | { type: "cancel" }
  | { type: "back" }
  | { type: "restart" }
  // E9-5
  | { type: "mine" }
  | { type: "recording"; id: string }
  | { type: "move" }
  | { type: "cancel-booking" }
  | { type: "confirm-cancel" }
  // E19: the language changed — say so and re-send the current step in it
  | { type: "refresh" }
  // E14: the language layer parsed a menu text into certain constraints
  | { type: "query"; q: ParsedAvailability }
  // E14: …or a summary text into certain edits (nothing silently dropped)
  | { type: "edit"; edits: ParsedEdit[]; dropped: string[] }
  // E14: the client chose to see EVERYTHING after a zero-match filter
  | { type: "broaden" };

export type FlowRow = { id: string; title: string; description?: string };

export type FlowReply =
  | { type: "text"; body: string }
  | { type: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | { type: "list"; body: string; button: string; sections: { title: string; rows: FlowRow[] }[] };

export type Transition =
  | { kind: "reply"; state: FlowState; reply: FlowReply }
  /** load availability for state.duration, then call withAvailability */
  | { kind: "need-availability"; state: FlowState }
  /** state.step is "submitting": submit it, then call afterSubmit */
  | { kind: "submit"; state: FlowState }
  /** send the show's existing booking link (the E9-3 reply) */
  | { kind: "link"; state: FlowState }
  /** send the existing podcast list (step 0) */
  | { kind: "switch-show"; state: FlowState }
  // E9-5
  /** load the client's upcoming approved recordings, then call withRecordings */
  | { kind: "need-recordings"; state: FlowState }
  /** state.step is "submitting": cancel state.target, then call afterCancel */
  | { kind: "cancel"; state: FlowState }
  /** within 24 hours: notify the team, then call afterForward */
  | { kind: "forward"; state: FlowState; change: "cancel-request" | "move-request" };

/** What a cancellation by the bot came to (E9-5). */
export type CancelOutcome = "cancelled" | "not-active" | "error";

// ─── ids: a tap -> a structured event ──────────────────────────────────────

const P = "f:";

export const FLOW_ID = {
  go: `${P}go`,
  link: `${P}link`,
  switchShow: `${P}shows`,
  duration: (d: BookingDuration) => `${P}dur:${d}`,
  studioYes: `${P}st-yes`,
  studioOther: `${P}st-other`,
  studio: (s: BookableRoom) => `${P}st:${s}`,
  day: (d: string) => `${P}day:${d}`,
  moreDays: `${P}more-days`,
  hour: (start: string) => `${P}hr:${start}`,
  moreHours: `${P}more-hours`,
  noGuest: `${P}no-guest`,
  noNote: `${P}no-note`,
  confirm: `${P}confirm`,
  cancel: `${P}cancel`,
  back: `${P}back`,
  restart: `${P}restart`,
  // E9-5
  mine: `${P}mine`,
  recording: (id: string) => `${P}rec:${id}`,
  move: `${P}move`,
  cancelBooking: `${P}cxl`,
  confirmCancel: `${P}cxl-yes`,
  // E14
  broaden: `${P}broaden`,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^\d{2}:\d{2}$/;

/**
 * A button or list-row id -> an event, or null for anything that is not ours.
 *
 * Only the SHAPE is checked here; whether the value is acceptable right now is
 * the machine's question, answered against the state. A well-formed id for a
 * day that is no longer offered parses fine and is then refused by `reduce`.
 */
export function parseFlowId(raw: unknown): FlowEvent | null {
  if (typeof raw !== "string" || !raw.startsWith(P)) return null;
  const id = raw.slice(P.length);
  const simple: Record<string, FlowEvent> = {
    go: { type: "go" },
    link: { type: "link" },
    shows: { type: "switch-show" },
    "st-yes": { type: "studio-yes" },
    "st-other": { type: "studio-other" },
    "more-days": { type: "more-days" },
    "more-hours": { type: "more-hours" },
    "no-guest": { type: "no-guest" },
    "no-note": { type: "no-note" },
    confirm: { type: "confirm" },
    cancel: { type: "cancel" },
    back: { type: "back" },
    restart: { type: "restart" },
    mine: { type: "mine" },
    move: { type: "move" },
    cxl: { type: "cancel-booking" },
    "cxl-yes": { type: "confirm-cancel" },
    broaden: { type: "broaden" },
  };
  if (simple[id]) return simple[id];
  const [kind, ...rest] = id.split(":");
  const value = rest.join(":");
  if (kind === "dur" && /^\d+$/.test(value)) return { type: "duration", minutes: Number(value) };
  if (kind === "st" && value !== "") return { type: "studio", studio: value };
  if (kind === "day" && DATE_RE.test(value)) return { type: "day", date: value };
  if (kind === "hr" && HHMM_RE.test(value)) return { type: "hour", start: value };
  if (kind === "rec" && UUID_RE.test(value)) return { type: "recording", id: value };
  return null;
}

/** Typed text -> a navigation event when it is EXACTLY one of the nav words. */
export function textEvent(text: string): FlowEvent {
  // the nav words of EVERY language: a client who switched mid-conversation
  // may still type the other one, and neither word is anything else
  const t = text.replace(/\s+/g, " ").trim().toLowerCase();
  const words = (k: "back" | "restart") => Object.values(COPY).flatMap((c) => c.NAV_WORDS[k]);
  if (words("restart").includes(t)) return { type: "restart" };
  if (words("back").includes(t)) return { type: "back" };
  return { type: "text", text };
}

// ─── starting ──────────────────────────────────────────────────────────────

export type ShowInfo = {
  showId: string;
  showName: string;
  defaultStudio: string | null;
  multiShow: boolean;
  /** E9-5; absent = off */
  manageOn?: boolean;
  linkUrl?: string | null;
  /** E19; absent = Hebrew, off */
  lang?: Lang;
  bilingualOn?: boolean;
  /** E14; absent = off */
  freeTextOn?: boolean;
};

export function initialState(show: ShowInfo): FlowState {
  return {
    v: 1,
    step: "menu",
    showId: show.showId,
    showName: show.showName,
    // 🔴 `shows.default_studio` AS IT IS (owner decision 11.10, 4), read
    // through the SAME resolver the booking screen preselects with: variants
    // map to their room, TLV and anything unrecognised map to null — and null
    // means "ask which studio", never a guess.
    defaultStudio: validateStudio(bookableRoomForDefault(show.defaultStudio, STUDIOS)),
    multiShow: show.multiShow,
    duration: null,
    studio: null,
    days: [],
    dayPage: 0,
    date: null,
    hours: [],
    hourPage: 0,
    start: null,
    end: null,
    guest: null,
    note: null,
    notice: null,
    requestId: null,
    mode: "book",
    manageOn: show.manageOn ?? false,
    linkUrl: show.linkUrl ?? null,
    recordings: [],
    target: null,
    lang: isLang(show.lang) ? show.lang : DEFAULT_LANG,
    bilingualOn: show.bilingualOn ?? false,
    freeTextOn: show.freeTextOn ?? false,
    filter: null,
    durationFromDefault: false,
  };
}

/** The show, as `start` takes it, from a live state — so a restart keeps it. */
const showOf = (s: FlowState): ShowInfo => ({
  showId: s.showId,
  showName: s.showName,
  // already resolved; bookableRoomForDefault maps a canonical name to itself
  defaultStudio: s.defaultStudio,
  multiShow: s.multiShow,
  manageOn: s.manageOn,
  linkUrl: s.linkUrl,
  lang: s.lang,
  bilingualOn: s.bilingualOn,
  freeTextOn: s.freeTextOn,
});

/** A fresh conversation: the menu, optionally under a one-line notice. */
export function start(show: ShowInfo, notice: string | null = null): Transition {
  const s = { ...initialState(show), notice };
  return render(s);
}

// ─── rendering a step (PURE) ───────────────────────────────────────────────

const navRows = (C: BotCopy): FlowRow[] => [
  { id: FLOW_ID.back, title: C.NAV.back },
  { id: FLOW_ID.restart, title: C.NAV.restart },
];

const withNotice = (s: FlowState, body: string) => (s.notice ? `${s.notice}\n\n${body}` : body);

/** E14: is a written day range / time-of-day narrowing the lists? */
const dateFiltered = (s: FlowState) => !!s.filter && (!!s.filter.dateFrom || !!s.filter.dateTo);
const timeFiltered = (s: FlowState) => !!s.filter && (!!s.filter.timeFrom || !!s.filter.timeTo);

/**
 * The message for the state's current step. The notice is consumed here:
 * the returned state no longer carries it, so it is said exactly once.
 */
export function render(s: FlowState): Transition {
  const C = copy(s.lang);
  const body = (b: string) => withNotice(s, b);
  const out = (reply: FlowReply): Transition => ({ kind: "reply", state: { ...s, notice: null }, reply });

  switch (s.step) {
    case "menu": {
      // E9-5: with cancel/move on, "ההקלטות שלי" takes the link button's
      // place (Meta allows three) and the link moves into the body, where a
      // tap opens it just the same.
      const buttons: { id: string; title: string }[] = [
        { id: FLOW_ID.go, title: C.MENU.go },
        s.manageOn ? { id: FLOW_ID.mine, title: C.MENU.mine } : { id: FLOW_ID.link, title: C.MENU.link },
        ...(s.multiShow ? [{ id: FLOW_ID.switchShow, title: C.MENU.switchShow }] : []),
      ];
      // E19: the switch to the OTHER language — a button while there is room
      // for one (Meta: three), and a line telling how to type it when there
      // is not (a number with several podcasts already has three).
      const other: Lang = s.lang === "en" ? "he" : "en";
      const room = s.bilingualOn && buttons.length < 3;
      if (room) buttons.push({ id: langButtonId(other), title: C.LANG.switchButton });
      const hint = s.bilingualOn && !room ? C.LANG.switchHint : "";
      return out({
        type: "buttons",
        body: body((s.manageOn ? C.MENU.bodyWithLink(s.showName, s.linkUrl) : C.MENU.body(s.showName)) + hint),
        buttons,
      });
    }

    case "mine":
      return out({
        type: "list",
        body: body(C.MINE.body),
        button: C.MINE.button,
        sections: [
          {
            title: C.NAV.sectionChoices,
            rows: s.recordings.map((r) => ({
              id: FLOW_ID.recording(r.id),
              title: C.MINE.title(r.date, r.start),
              description: C.MINE.description(r.showName, r.studio),
            })),
          },
          { title: C.NAV.sectionNav, rows: navRows(C) },
        ],
      });

    case "manage": {
      const t = s.target as RecordingOption;
      return out({
        type: "buttons",
        body: body(C.MANAGE.body(t)),
        buttons: [
          { id: FLOW_ID.move, title: C.MANAGE.move },
          { id: FLOW_ID.cancelBooking, title: C.MANAGE.cancel },
          { id: FLOW_ID.back, title: C.NAV.back },
        ],
      });
    }

    case "cancel-confirm": {
      const t = s.target as RecordingOption;
      return out({
        type: "buttons",
        body: body(C.CANCEL_CONFIRM.body(t)),
        buttons: [
          { id: FLOW_ID.confirmCancel, title: C.CANCEL_CONFIRM.yes },
          { id: FLOW_ID.back, title: C.NAV.back },
        ],
      });
    }

    case "duration":
      return out({
        type: "list",
        body: body(C.DURATION.body),
        button: C.DURATION.button,
        sections: [
          {
            title: C.NAV.sectionChoices,
            rows: BOOKING_DURATIONS.map((d) => ({
              id: FLOW_ID.duration(d),
              title: C.DURATION.title(d),
              description: C.DURATION.description(d),
            })),
          },
          { title: C.NAV.sectionNav, rows: navRows(C) },
        ],
      });

    case "studio-default": {
      const d = preferredStudio(s) as BookableRoom;
      return out({
        type: "buttons",
        body: body(s.mode === "move" ? C.STUDIO_DEFAULT.moveBody(d) : C.STUDIO_DEFAULT.body(d)),
        buttons: [
          { id: FLOW_ID.studioYes, title: C.STUDIO_DEFAULT.yes(d) },
          { id: FLOW_ID.studioOther, title: C.STUDIO_DEFAULT.other },
          { id: FLOW_ID.back, title: C.NAV.back },
        ],
      });
    }

    case "studio":
      return out({
        type: "list",
        body: body(C.STUDIO.body),
        button: C.STUDIO.button,
        sections: [
          {
            title: C.NAV.sectionChoices,
            rows: BOOKABLE_ROOM_NAMES.map((r) => ({ id: FLOW_ID.studio(r), title: C.STUDIO.row(r) })),
          },
          { title: C.NAV.sectionNav, rows: navRows(C) },
        ],
      });

    case "day": {
      // E14: the written day range matched NOTHING. Every re-render of this
      // state (typed text, a stale tap, a language switch) says so again with
      // the broaden/back buttons — never an empty list that reads as "these
      // are the free days". Broadening stays the client's explicit tap.
      if (s.days.length === 0 && dateFiltered(s)) {
        return out({
          type: "buttons",
          body: body(C.NOTICE.noMatchDates),
          buttons: [
            { id: FLOW_ID.broaden, title: C.QUERY.broadenDays },
            { id: FLOW_ID.back, title: C.NAV.back },
          ],
        });
      }
      const page = s.days.slice(s.dayPage * PAGE_SIZE, (s.dayPage + 1) * PAGE_SIZE);
      const more = (s.dayPage + 1) * PAGE_SIZE < s.days.length;
      return out({
        type: "list",
        body: body(C.DAY.body(s.studio as string, s.duration as BookingDuration)),
        button: C.DAY.button,
        sections: [
          {
            title: C.NAV.sectionChoices,
            rows: [
              ...page.map((d) => ({ id: FLOW_ID.day(d), title: C.DAY.title(d) })),
              ...(more ? [{ id: FLOW_ID.moreDays, title: C.DAY.more }] : []),
            ],
          },
          { title: C.NAV.sectionNav, rows: navRows(C) },
        ],
      });
    }

    case "hour": {
      // E14: same rule as the days, for a written time-of-day
      if (s.hours.length === 0 && timeFiltered(s)) {
        return out({
          type: "buttons",
          body: body(C.NOTICE.noMatchHours),
          buttons: [
            { id: FLOW_ID.broaden, title: C.QUERY.broadenHours },
            { id: FLOW_ID.back, title: C.NAV.back },
          ],
        });
      }
      const page = s.hours.slice(s.hourPage * PAGE_SIZE, (s.hourPage + 1) * PAGE_SIZE);
      const more = (s.hourPage + 1) * PAGE_SIZE < s.hours.length;
      return out({
        type: "list",
        body: body(C.HOUR.body(s.date as string)),
        button: C.HOUR.button,
        sections: [
          {
            title: C.NAV.sectionChoices,
            rows: [
              ...page.map((h) => ({ id: FLOW_ID.hour(h.start), title: C.HOUR.title(h.start, h.end) })),
              ...(more ? [{ id: FLOW_ID.moreHours, title: C.HOUR.more }] : []),
            ],
          },
          { title: C.NAV.sectionNav, rows: navRows(C) },
        ],
      });
    }

    case "guest":
      return out({
        type: "buttons",
        body: body(C.GUEST.body),
        buttons: [
          { id: FLOW_ID.noGuest, title: C.GUEST.skip },
          { id: FLOW_ID.back, title: C.NAV.back },
          { id: FLOW_ID.restart, title: C.NAV.restart },
        ],
      });

    case "note":
      return out({
        type: "buttons",
        body: body(C.NOTE.body),
        buttons: [
          { id: FLOW_ID.noNote, title: C.NOTE.skip },
          { id: FLOW_ID.back, title: C.NAV.back },
          { id: FLOW_ID.restart, title: C.NAV.restart },
        ],
      });

    case "summary":
      if (s.mode === "move") {
        const t = s.target as RecordingOption;
        return out({
          type: "buttons",
          body: body(
            C.MOVE_SUMMARY.body({
              showName: t.showName,
              from: { dateIsrael: t.date, start: t.start, end: t.end, studio: t.studio },
              to: { dateIsrael: s.date as string, start: s.start as string, end: s.end as string, studio: s.studio as string },
            })
          ),
          buttons: [
            { id: FLOW_ID.confirm, title: C.MOVE_SUMMARY.confirm },
            { id: FLOW_ID.cancel, title: C.SUMMARY.cancel },
            { id: FLOW_ID.back, title: C.NAV.back },
          ],
        });
      }
      // E14: the default-length disclosure (owner, 16.10) and the invitation
      // to edit in free text — only where the layer is on AND parses (he)
      const freeText = s.freeTextOn && s.lang === "he";
      return out({
        type: "buttons",
        body: body(
          C.SUMMARY.body({
            showName: s.showName,
            dateIsrael: s.date as string,
            start: s.start as string,
            end: s.end as string,
            studio: s.studio as string,
            duration: s.duration as BookingDuration,
            guest: s.guest,
            note: s.note,
          }) +
            (freeText && s.durationFromDefault ? `\n${C.SUMMARY.durationDefault}` : "") +
            (freeText ? `\n\n${C.SUMMARY.editHint}` : "")
        ),
        buttons: [
          { id: FLOW_ID.confirm, title: C.SUMMARY.confirm },
          { id: FLOW_ID.cancel, title: C.SUMMARY.cancel },
          { id: FLOW_ID.back, title: C.NAV.back },
        ],
      });

    case "submitting":
      return out({ type: "text", body: C.OUTCOME.submitting });

    case "done":
      return out({ type: "text", body: body(C.OUTCOME.alreadySent) });
  }
}

// ─── the transitions (PURE) ────────────────────────────────────────────────

const go = (s: FlowState, patch: Partial<FlowState>): Transition => render({ ...s, ...patch });

/** Re-send the current step under a one-line notice. */
const again = (s: FlowState, notice: string): Transition => render({ ...s, notice });

/** Everything chosen from `step` onward, cleared — so "back" never keeps a stale later pick. */
function clearFrom(step: FlowStep): Partial<FlowState> {
  const order: FlowStep[] = ["duration", "studio", "day", "hour", "guest", "note"];
  const i = order.indexOf(step);
  const patch: Partial<FlowState> = {};
  if (i <= 0) Object.assign(patch, { duration: null });
  if (i <= 1) Object.assign(patch, { studio: null, days: [], dayPage: 0 });
  if (i <= 2) Object.assign(patch, { date: null, hours: [], hourPage: 0 });
  if (i <= 3) Object.assign(patch, { start: null, end: null });
  if (i <= 4) Object.assign(patch, { guest: null });
  if (i <= 5) Object.assign(patch, { note: null });
  return patch;
}

/** The room the "as usual?" question offers: the show's default, or — in a move — the original's. */
function preferredStudio(s: FlowState): BookableRoom | null {
  if (s.mode === "move") return validateStudio(s.target?.studio ?? null);
  return s.defaultStudio;
}

const studioStep = (s: FlowState): FlowStep => (preferredStudio(s) ? "studio-default" : "studio");

/** Leave a move: back to the recording it was about, nothing of the move kept. */
const leaveMove = (s: FlowState): Transition =>
  go(s, { ...clearFrom("duration"), mode: "book", step: "manage" });

/** Choosing a studio: the days come from availability, so ask for it. */
const chooseStudio = (s: FlowState, studio: BookableRoom): Transition => ({
  kind: "need-availability",
  state: { ...s, ...clearFrom("day"), studio, step: "day", dayPage: 0 },
});

/** One step back. Inside a paged list, one page back first. */
function back(s: FlowState): Transition {
  switch (s.step) {
    case "menu":
      return render(s);
    case "mine":
      return go(s, { step: "menu", recordings: [], target: null });
    case "manage":
      return go(s, { step: "mine", target: null });
    case "cancel-confirm":
      return go(s, { step: "manage" });
    case "duration":
      return go(s, { step: "menu", ...clearFrom("duration") });
    case "studio-default":
    case "studio":
      // from the free list back to the "as usual?" question, if there is one
      if (s.step === "studio" && preferredStudio(s)) return go(s, { step: "studio-default", ...clearFrom("studio") });
      // a move has no duration step to go back to: it goes back to the recording
      if (s.mode === "move") return leaveMove(s);
      return go(s, { step: "duration", ...clearFrom("studio") });
    case "day":
      if (s.dayPage > 0) return go(s, { dayPage: s.dayPage - 1 });
      return go(s, { step: studioStep(s), ...clearFrom("studio") });
    case "hour":
      if (s.hourPage > 0) return go(s, { hourPage: s.hourPage - 1 });
      // the stored days are still the right list to go back to
      return go(s, { step: "day", ...clearFrom("hour"), date: null, hours: [], hourPage: 0 });
    case "guest":
      return go(s, { step: "hour", start: null, end: null, guest: null });
    case "note":
      return go(s, { step: "guest", guest: null, note: null });
    case "summary":
      // a move skipped the guest and the note: back to the hours
      if (s.mode === "move") return go(s, { step: "hour", start: null, end: null });
      return go(s, { step: "note", note: null });
    case "submitting":
    case "done":
      return render(s);
  }
}

/**
 * One event -> the next transition. PURE.
 *
 * An event that does not belong to the current step is answered by re-sending
 * the current step under "this button is no longer active" — never by acting
 * on it. That one rule is what makes an old message's buttons harmless.
 */
export function reduce(s: FlowState, e: FlowEvent, ctx: { now?: Date } = {}): Transition {
  const C = copy(s.lang);
  // ── always available ──
  // E19: the language just changed (the driver already put the new one in
  // `s.lang`). Say so once, in the new language, over the same step — except
  // mid-submission, which only ever answers "בטיפול", and after a finished
  // booking, where the step is a dead end and the menu is the useful answer.
  if (e.type === "refresh") {
    if (s.step === "submitting") return render(s);
    if (s.step === "done") return start(showOf(s), C.LANG.switched);
    return again(s, C.LANG.switched);
  }
  if (e.type === "restart") {
    if (s.step === "submitting") return render(s);
    return start(showOf(s));
  }
  if (e.type === "back") return back(s);

  const stale = () => again(s, C.NOTICE.stale);
  // free text where a choice is expected: the current step again. This is the
  // exact seam where a future language layer plugs in — it would turn the text
  // into one of the structured events above instead.
  const pick = () => again(s, C.NOTICE.pickFromList);

  switch (s.step) {
    case "menu":
      if (e.type === "go") return go(s, { step: "duration", filter: null, durationFromDefault: false });
      if (e.type === "query") return menuQuery(s, e.q);
      if (e.type === "mine" && s.manageOn) {
        return { kind: "need-recordings", state: { ...s, step: "mine", recordings: [], target: null } };
      }
      if (e.type === "link") return { kind: "link", state: s };
      if (e.type === "switch-show" && s.multiShow) return { kind: "switch-show", state: s };
      if (e.type === "text") return render(s);
      return stale();

    case "duration": {
      if (e.type === "duration") {
        const d = validateDuration(e.minutes);
        // validateDuration maps absent to 90; an EVENT always states a value,
        // so only an exact member of the closed list is accepted
        if (d === null || d !== e.minutes) return stale();
        return go(s, { ...clearFrom("studio"), duration: d, step: studioStep(s) });
      }
      if (e.type === "text") return pick();
      return stale();
    }

    // ── E9-5: "ההקלטות שלי" ──
    case "mine":
      if (e.type === "recording") {
        const r = s.recordings.find((x) => x.id === e.id);
        if (!r) return stale();
        return go(s, { step: "manage", target: r });
      }
      if (e.type === "text") return pick();
      return stale();

    case "manage": {
      const t = s.target as RecordingOption;
      // 🔴 within 24 hours the bot does not act (owner rule 3): it forwards.
      // Checked here for an immediate answer, and AGAIN by the driver at
      // execution, against a fresh read.
      const late = ctx.now ? !selfServeAllowed(t.startIso, ctx.now) : false;
      if (e.type === "cancel-booking") {
        if (late) return { kind: "forward", state: { ...s, step: "submitting" }, change: "cancel-request" };
        return go(s, { step: "cancel-confirm" });
      }
      if (e.type === "move") {
        const d = validateDuration(t.durationMinutes ?? undefined);
        // a length that is not one of the three cannot go through the shared
        // path unchanged — a human moves it
        if (late || d === null || d !== t.durationMinutes) {
          return { kind: "forward", state: { ...s, step: "submitting" }, change: "move-request" };
        }
        return go(s, { ...clearFrom("duration"), mode: "move", duration: d, step: "studio-default", filter: null, durationFromDefault: false });
      }
      if (e.type === "text") return pick();
      return stale();
    }

    case "cancel-confirm":
      if (e.type === "confirm-cancel") {
        // the same claim as "לקבוע": "submitting" is saved under the version
        // lock before anything is cancelled
        return { kind: "cancel", state: { ...s, step: "submitting", notice: null } };
      }
      if (e.type === "text") return pick();
      return stale();

    case "studio-default":
      if (e.type === "studio-yes" && preferredStudio(s)) return chooseStudio(s, preferredStudio(s) as BookableRoom);
      if (e.type === "studio-other") return go(s, { step: "studio" });
      if (e.type === "studio") {
        const r = validateStudio(e.studio);
        return r ? chooseStudio(s, r) : stale();
      }
      if (e.type === "text") return pick();
      return stale();

    case "studio": {
      if (e.type === "studio") {
        const r = validateStudio(e.studio);
        return r ? chooseStudio(s, r) : stale();
      }
      if (e.type === "text") return pick();
      return stale();
    }

    case "day":
      if (e.type === "broaden") {
        // only as the answer to a zero-match: a stale tap otherwise
        if (s.days.length > 0 || !s.filter || (!s.filter.dateFrom && !s.filter.dateTo)) return stale();
        return {
          kind: "need-availability",
          state: { ...s, filter: { dateFrom: null, dateTo: null, timeFrom: s.filter.timeFrom, timeTo: s.filter.timeTo } },
        };
      }
      if (e.type === "day") {
        if (!s.days.includes(e.date)) return stale();
        // the hours are read FRESH for the chosen day, not from a cached grid
        return { kind: "need-availability", state: { ...s, date: e.date, hours: [], hourPage: 0, step: "hour" } };
      }
      if (e.type === "more-days") {
        if ((s.dayPage + 1) * PAGE_SIZE >= s.days.length) return stale();
        return go(s, { dayPage: s.dayPage + 1 });
      }
      if (e.type === "text") return pick();
      return stale();

    case "hour":
      if (e.type === "broaden") {
        if (s.hours.length > 0 || !s.filter || (!s.filter.timeFrom && !s.filter.timeTo)) return stale();
        return {
          kind: "need-availability",
          state: { ...s, filter: { dateFrom: s.filter.dateFrom, dateTo: s.filter.dateTo, timeFrom: null, timeTo: null } },
        };
      }
      if (e.type === "hour") {
        const h = s.hours.find((x) => x.start === e.start);
        if (!h) return stale();
        // a move keeps the original's guest and note: straight to "מ־… ל־…"
        if (s.mode === "move") {
          return go(s, { start: h.start, end: h.end, guest: s.target?.guest ?? null, note: s.target?.note ?? null, step: "summary" });
        }
        // E14: a slot re-choose AFTER the summary (an edit) keeps the guest
        // and note it kept — straight back to the updated summary, not
        // through questions that were already answered. ONLY with the layer on
        // and in Hebrew: off (or in English) a re-choose — e.g. after a slot
        // was taken at submission — asks the guest again, exactly as before E14
        if (s.freeTextOn && s.lang === "he" && (s.guest !== null || s.note !== null)) {
          return go(s, { start: h.start, end: h.end, step: "summary" });
        }
        return go(s, { start: h.start, end: h.end, step: "guest" });
      }
      if (e.type === "more-hours") {
        if ((s.hourPage + 1) * PAGE_SIZE >= s.hours.length) return stale();
        return go(s, { hourPage: s.hourPage + 1 });
      }
      if (e.type === "text") return pick();
      return stale();

    // ── owner decision 11.10 (3): ask, but never block on it ──
    case "guest":
      if (e.type === "no-guest") return go(s, { guest: null, step: "note" });
      if (e.type === "text") {
        // ANY free text here is the value — the same normaliser as the screen
        const g = normalizeGuest(e.text);
        if (!g.ok) return again(s, C.GUEST.tooLong);
        return go(s, { guest: g.value, step: "note" });
      }
      return stale();

    case "note":
      if (e.type === "no-note") return go(s, { note: null, step: "summary" });
      if (e.type === "text") {
        const n = normalizeNote(e.text);
        if (!n.ok) return again(s, C.NOTE.tooLong);
        return go(s, { note: n.value, step: "summary" });
      }
      return stale();

    case "summary":
      if (e.type === "edit") {
        // the layer parses Hebrew only, and a move's summary is not editable
        if (!s.freeTextOn || s.lang !== "he" || s.mode !== "book") return pick();
        return applyEdits(s, e.edits, e.dropped);
      }
      if (e.type === "confirm") {
        // 🔴 THE ONLY WAY INTO "submitting". The driver persists this state
        // under the version lock BEFORE it submits, so a second "לקבוע" —
        // a double tap, or the same tap delivered twice — finds the
        // conversation already submitting and makes nothing.
        return { kind: "submit", state: { ...s, step: "submitting", notice: null } };
      }
      if (e.type === "cancel") {
        const body = s.mode === "move" ? C.OUTCOME.moveAbandoned : C.OUTCOME.cancelled;
        return { kind: "reply", state: { ...s, step: "done", notice: null }, reply: { type: "text", body } };
      }
      if (e.type === "text") {
        // E14: where edits are invited, an unparsed text asks WHAT to change
        if (s.freeTextOn && s.lang === "he" && s.mode === "book") return again(s, C.NOTICE.editUnclear);
        return pick();
      }
      return stale();

    case "submitting":
      return render(s);

    case "done":
      // a stale "לקבוע" on the summary that already went through
      if (e.type === "confirm") return render(s);
      // anything else starts a new booking — a new message, a new request
      return start(showOf(s));
  }
}

// ─── E14: the free-language layer's transitions (PURE) ─────────────────────

/**
 * A free-text availability request at the menu. What it certainly said is
 * pre-filled; the reply SAYS what was understood (and what was dropped as
 * unclear); a length the client did not state is the DEFAULT — disclosed
 * again at the summary (owner, 16.10), changeable until they confirm, never
 * a silent guess.
 */
function menuQuery(s: FlowState, q: ParsedAvailability): Transition {
  const C = copy(s.lang);
  const echo = C.QUERY.echo(q);
  const notice = q.dropped.length ? (echo ? `${echo} ${C.QUERY.dropped(q.dropped)}` : C.QUERY.dropped(q.dropped)) : echo || null;
  const patch: Partial<FlowState> = {
    ...clearFrom("duration"),
    duration: q.duration ?? DEFAULT_BOOKING_DURATION,
    durationFromDefault: q.duration === null,
    filter:
      q.dateFrom || q.dateTo || q.timeFrom || q.timeTo
        ? { dateFrom: q.dateFrom, dateTo: q.dateTo, timeFrom: q.timeFrom, timeTo: q.timeTo }
        : null,
    notice,
  };
  // a room the client named is validated exactly like a tapped one
  if (q.studio) {
    return { kind: "need-availability", state: { ...s, ...patch, studio: q.studio, step: "day", dayPage: 0 } };
  }
  return go(s, { ...patch, step: studioStep(s) });
}

/**
 * Every certain edit from one summary message. The two free values are
 * validated by the SAME normalisers the screen uses; a slot change (length,
 * room, day, time) re-reads availability BEFORE anything new is offered.
 * A field that failed validation fails the WHOLE message — applying half of
 * what the client asked would silently drop the rest. What the parser could
 * not be sure of is SAID (`dropped`). And no edit ever confirms — the
 * "✅ לקבוע" button stays the only way into "submitting".
 */
function applyEdits(s: FlowState, edits: ParsedEdit[], dropped: string[]): Transition {
  const C = copy(s.lang);
  const tail = (dropped.length ? `\n${C.QUERY.dropped(dropped)}` : "") +
    (edits.some((e) => "alsoConfirm" in e && e.alsoConfirm) ? `\n${C.NOTICE.confirmByButton}` : "");

  // 1. validate EVERYTHING first — or change nothing at all
  let guest = s.guest;
  let note = s.note;
  let duration = s.duration;
  let studio = s.studio;
  let dayEdit: string | null = null;
  let timeEdit: string | null = null;
  for (const edit of edits) {
    switch (edit.field) {
      case "confirm-hint":
        break;
      case "guest": {
        const g = normalizeGuest(edit.value);
        if (!g.ok) return again(s, C.GUEST.tooLong + tail);
        guest = g.value;
        break;
      }
      case "note": {
        const n = normalizeNote(edit.value);
        if (!n.ok) return again(s, C.NOTE.tooLong + tail);
        note = n.value;
        break;
      }
      case "duration": {
        const d = validateDuration(edit.minutes);
        if (d === null || d !== edit.minutes) return again(s, C.NOTICE.editUnclear);
        duration = d;
        break;
      }
      case "studio": {
        const r = validateStudio(edit.studio);
        if (!r) return again(s, C.NOTICE.editUnclear);
        studio = r;
        break;
      }
      case "day": {
        if (!DATE_RE.test(edit.date)) return again(s, C.NOTICE.editUnclear);
        dayEdit = edit.date;
        break;
      }
      case "time-from": {
        if (!HHMM_RE.test(edit.hhmm)) return again(s, C.NOTICE.editUnclear);
        timeEdit = edit.hhmm;
        break;
      }
    }
  }
  if (edits.length === 1 && edits[0].field === "confirm-hint") return again(s, C.NOTICE.confirmByButton);

  // 2. what ACTUALLY changes — measured against the chosen slot and values,
  // not against the filter: writing a value that is already set is no change
  // (owner, 16.10), and "updated" is never said about a message that changed
  // nothing
  const slotChange = duration !== s.duration || studio !== s.studio || (dayEdit !== null && dayEdit !== s.date);
  const timeChange = !slotChange && timeEdit !== null && timeEdit !== s.start;
  const valueChange = guest !== s.guest || note !== s.note;
  if (!slotChange && !timeChange && !valueChange) {
    return again(s, (dropped.length ? C.NOTICE.unchanged : C.NOTICE.alreadySet) + tail);
  }

  // 3. apply — a slot change re-reads availability; values alone re-render.
  // A day/time the client named narrows the re-offered lists.
  let filter = s.filter;
  if (slotChange && (dayEdit !== null || timeEdit !== null)) {
    filter = {
      dateFrom: dayEdit ?? filter?.dateFrom ?? null,
      dateTo: dayEdit ?? filter?.dateTo ?? null,
      timeFrom: timeEdit ?? filter?.timeFrom ?? null,
      timeTo: timeEdit !== null ? null : filter?.timeTo ?? null,
    };
  } else if (timeChange) {
    filter = { dateFrom: filter?.dateFrom ?? s.date, dateTo: filter?.dateTo ?? s.date, timeFrom: timeEdit, timeTo: null };
  }
  const durationFromDefault = duration !== s.duration ? false : s.durationFromDefault;
  if (slotChange) {
    return {
      kind: "need-availability",
      state: { ...s, guest, note, duration, durationFromDefault, studio, filter, date: null, hours: [], hourPage: 0, start: null, end: null, step: "day", dayPage: 0, notice: (dropped.length ? C.NOTICE.changedPartialRechoose : C.NOTICE.changedRechoose) + tail },
    };
  }
  if (timeChange) {
    return {
      kind: "need-availability",
      state: { ...s, guest, note, filter, hours: [], hourPage: 0, start: null, end: null, step: "hour", notice: (dropped.length ? C.NOTICE.changedPartialRechoose : C.NOTICE.changedRechoose) + tail },
    };
  }
  return go(s, { guest, note, duration, durationFromDefault, notice: `${dropped.length ? C.NOTICE.changedPartial : C.NOTICE.changed}${tail}` });
}

// ─── fed by the driver (PURE) ──────────────────────────────────────────────

/**
 * Availability arrived (from loadAvailability, the same function /b/[token]
 * uses, projected by toPublicAvailability). Fill the step's options with the
 * SAME pure helpers the booking screen draws its grid with — clickableDays and
 * hoursFor — and render.
 */
export function withAvailability(s: FlowState, pub: PublicAvailability): Transition {
  const C = copy(s.lang);
  if (s.step === "day") {
    const all = clickableDays(pub.free, s.studio, pub.fromIsrael, pub.toIsrael);
    if (all.length === 0) {
      // nothing for this (length, room): back to choosing a room, saying why
      return render({
        ...s,
        ...clearFrom("studio"),
        step: "studio",
        notice: C.NOTICE.noDays(s.studio as string, s.duration as BookingDuration),
      });
    }
    // E14: the written day range narrows the list. If it narrows to NOTHING,
    // nothing outside the request is offered as if it matched — the client
    // explicitly chooses "כל הימים" to broaden (a fresh read), or goes back.
    const f = s.filter;
    if (f && (f.dateFrom || f.dateTo)) {
      const from = f.dateFrom ?? pub.fromIsrael;
      const to = f.dateTo ?? pub.toIsrael;
      const days = all.filter((d) => d >= from && d <= to);
      // zero-match: render() owns that message, so every re-render matches it
      if (days.length === 0) return render({ ...s, days: [], dayPage: 0, notice: null });
      return render({ ...s, days, dayPage: Math.min(s.dayPage, Math.floor((days.length - 1) / PAGE_SIZE)) });
    }
    return render({ ...s, days: all, dayPage: Math.min(s.dayPage, Math.floor((all.length - 1) / PAGE_SIZE)) });
  }

  if (s.step === "hour") {
    const allHours = hoursFor(pub.free, s.studio, s.date).map((h) => ({ start: h.startIsrael, end: h.endIsrael }));
    // E14: the written time-of-day narrows the list (same rule as the days)
    const fh = s.filter;
    const hours =
      fh && (fh.timeFrom || fh.timeTo)
        ? allHours.filter((h) => (!fh.timeFrom || h.start >= fh.timeFrom) && (!fh.timeTo || h.start < fh.timeTo))
        : allHours;
    if (hours.length === 0 && allHours.length > 0) {
      // E14: same rule as the days — broadening is the client's choice
      return render({ ...s, hours: [], hourPage: 0, notice: null });
    }
    if (hours.length === 0) {
      // the day filled up since the list was sent: the fresh days instead
      const days = clickableDays(pub.free, s.studio, pub.fromIsrael, pub.toIsrael);
      if (days.length === 0) {
        return render({
          ...s,
          ...clearFrom("studio"),
          step: "studio",
          notice: C.NOTICE.noDays(s.studio as string, s.duration as BookingDuration),
        });
      }
      return render({ ...s, step: "day", days, dayPage: 0, date: null, hours: [], hourPage: 0, notice: C.NOTICE.dayFull });
    }
    return render({ ...s, hours, hourPage: Math.min(s.hourPage, Math.floor((hours.length - 1) / PAGE_SIZE)) });
  }

  // availability for a step that does not use it — nothing to do but re-send
  return render(s);
}

/**
 * The shared submission answered. Approved and pending END the conversation;
 * "taken" goes back to the hours of the same day with fresh availability;
 * anything else returns to the summary so the client can simply try again.
 */
export function afterSubmit(s: FlowState, r: SubmitResult): Transition {
  const C = copy(s.lang);
  if (s.mode === "move") {
    const t = s.target as RecordingOption;
    if (r.ok) {
      const done: FlowState = { ...s, step: "done", requestId: r.request.id, notice: null };
      const body =
        r.request.status === "approved"
          ? C.OUTCOME.moved(t.showName, r.request.dateIsrael, r.request.startIsrael, r.request.studio)
          : // 🔴 the original STAYS until the new slot is approved (owner, 11.10)
            C.OUTCOME.movePending(r.request.dateIsrael, r.request.startIsrael);
      return { kind: "reply", state: done, reply: { type: "text", body } };
    }
    if (r.code === "original-gone") {
      return { kind: "reply", state: { ...s, step: "done", notice: null }, reply: { type: "text", body: C.OUTCOME.notActive } };
    }
  }

  if (r.ok) {
    const done: FlowState = { ...s, step: "done", requestId: r.request.id, notice: null };
    if (r.request.status === "approved") {
      return {
        kind: "reply",
        state: done,
        // in Hebrew, the EXISTING confirmation text (title.ts) — see copy.ts —
        // from the STORED values
        reply: {
          type: "text",
          body: C.OUTCOME.approved(s.showName, r.request.dateIsrael, r.request.startIsrael, r.request.studio),
        },
      };
    }
    return {
      kind: "reply",
      state: done,
      reply: { type: "text", body: C.OUTCOME.pending(s.showName, r.request.dateIsrael, r.request.startIsrael) },
    };
  }

  if (r.code === "taken") {
    return {
      kind: "need-availability",
      state: { ...s, step: "hour", start: null, end: null, hours: [], hourPage: 0, notice: C.NOTICE.slotTaken },
    };
  }
  if (r.code === "too-many") {
    return { kind: "reply", state: { ...s, step: "done", notice: null }, reply: { type: "text", body: C.OUTCOME.tooMany } };
  }
  if (r.code === "guest-too-long") {
    return render({ ...s, step: "guest", guest: null, notice: C.GUEST.tooLong });
  }
  return render({ ...s, step: "summary", notice: C.NOTICE.submitFailed });
}

// ─── the stored row ────────────────────────────────────────────────────────

/** Is a stored conversation still alive at `now`? */
export function isLive(expiresAt: string | null | undefined, now: Date): boolean {
  const t = Date.parse(expiresAt ?? "");
  return Number.isFinite(t) && t > now.getTime();
}

export function expiresAtFor(now: Date): string {
  return new Date(now.getTime() + FLOW_TTL_MS).toISOString();
}

/**
 * The jsonb back into a state — or null, which means "start fresh".
 *
 * Defensive on purpose: the row is ours, but a state written by an older
 * version of this file must not crash the webhook. Anything that does not
 * look exactly right is discarded, and the client simply gets the menu.
 */
export function parseFlowState(raw: unknown): FlowState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Partial<FlowState>;
  if (s.v !== 1) return null;
  if (typeof s.step !== "string" || !(FLOW_STEPS as readonly string[]).includes(s.step)) return null;
  if (typeof s.showId !== "string" || typeof s.showName !== "string") return null;
  if (!Array.isArray(s.days) || !Array.isArray(s.hours)) return null;
  if (typeof s.dayPage !== "number" || typeof s.hourPage !== "number") return null;
  // E9-5 fields, defaulted for a state saved by E9-4 (they expire in 30
  // minutes anyway, but a live one must not crash the webhook)
  return {
    ...s,
    mode: s.mode ?? "book",
    manageOn: s.manageOn ?? false,
    linkUrl: s.linkUrl ?? null,
    recordings: s.recordings ?? [],
    target: s.target ?? null,
    // E19 fields, defaulted for a state saved before E19
    lang: isLang(s.lang) ? s.lang : DEFAULT_LANG,
    bilingualOn: s.bilingualOn ?? false,
    // E14 fields, defaulted for a state saved before E14
    freeTextOn: s.freeTextOn ?? false,
    filter: s.filter ?? null,
    durationFromDefault: s.durationFromDefault ?? false,
  } as FlowState;
}

// ─── E9-5: fed by the driver (PURE) ────────────────────────────────────────

/** The client's upcoming approved recordings arrived. None -> the menu, saying so. */
export function withRecordings(s: FlowState, recordings: RecordingOption[]): Transition {
  const C = copy(s.lang);
  if (recordings.length === 0) {
    return render({ ...s, step: "menu", recordings: [], target: null, notice: C.NOTICE.noRecordings });
  }
  return render({ ...s, step: "mine", recordings: recordings.slice(0, MINE_MAX), target: null });
}

/** The bot's own cancellation answered. */
export function afterCancel(s: FlowState, outcome: CancelOutcome): Transition {
  const C = copy(s.lang);
  const t = s.target as RecordingOption;
  if (outcome === "cancelled") {
    return {
      kind: "reply",
      state: { ...s, step: "done", notice: null },
      reply: { type: "text", body: C.OUTCOME.bookingCancelled(t.showName, t.date, t.start) },
    };
  }
  if (outcome === "not-active") {
    return { kind: "reply", state: { ...s, step: "done", notice: null }, reply: { type: "text", body: C.OUTCOME.notActive } };
  }
  return render({ ...s, step: "manage", notice: C.NOTICE.manageFailed });
}

/** Within 24 hours: the team was told; the client is told that it was. */
export function afterForward(s: FlowState, change: "cancel-request" | "move-request"): Transition {
  const C = copy(s.lang);
  return {
    kind: "reply",
    state: { ...s, step: "done", mode: "book", notice: null },
    reply: { type: "text", body: change === "cancel-request" ? C.OUTCOME.forwardedCancel : C.OUTCOME.forwardedMove },
  };
}
