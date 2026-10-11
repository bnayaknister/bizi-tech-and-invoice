import { BOOKING_DURATIONS, validateDuration, type BookingDuration } from "@/lib/booking/duration";
import {
  BOOKABLE_ROOM_NAMES,
  normalizeGuest,
  normalizeNote,
  validateStudio,
  type BookableRoom,
} from "@/lib/booking/request";
import { clickableDays, hoursFor } from "@/app/calendar/availability/booking";
import type { PublicAvailability } from "@/lib/booking/publicView";
import { approvedWhatsappText } from "@/lib/booking/title";
import { bookableRoomForDefault } from "@/lib/calendar/rooms";
import { STUDIOS } from "@/lib/calendar/studios";
import type { SubmitResult } from "@/lib/booking/submit";
import * as C from "./copy";

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

/** Meta allows 10 list rows IN TOTAL; 7 choices + "more" + back + restart. */
export const PAGE_SIZE = 7;

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
] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

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
  | { type: "restart" };

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
  | { kind: "switch-show"; state: FlowState };

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
} as const;

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
  };
  if (simple[id]) return simple[id];
  const [kind, ...rest] = id.split(":");
  const value = rest.join(":");
  if (kind === "dur" && /^\d+$/.test(value)) return { type: "duration", minutes: Number(value) };
  if (kind === "st" && value !== "") return { type: "studio", studio: value };
  if (kind === "day" && DATE_RE.test(value)) return { type: "day", date: value };
  if (kind === "hr" && HHMM_RE.test(value)) return { type: "hour", start: value };
  return null;
}

/** Typed text -> a navigation event when it is EXACTLY one of the nav words. */
export function textEvent(text: string): FlowEvent {
  const t = text.replace(/\s+/g, " ").trim();
  if ((C.NAV_WORDS.restart as readonly string[]).includes(t)) return { type: "restart" };
  if ((C.NAV_WORDS.back as readonly string[]).includes(t)) return { type: "back" };
  return { type: "text", text };
}

// ─── starting ──────────────────────────────────────────────────────────────

export function initialState(show: {
  showId: string;
  showName: string;
  defaultStudio: string | null;
  multiShow: boolean;
}): FlowState {
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
  };
}

/** A fresh conversation: the menu, optionally under a one-line notice. */
export function start(
  show: Parameters<typeof initialState>[0],
  notice: string | null = null
): Transition {
  const s = { ...initialState(show), notice };
  return render(s);
}

// ─── rendering a step (PURE) ───────────────────────────────────────────────

const navRows = (): FlowRow[] => [
  { id: FLOW_ID.back, title: C.NAV.back },
  { id: FLOW_ID.restart, title: C.NAV.restart },
];

const withNotice = (s: FlowState, body: string) => (s.notice ? `${s.notice}\n\n${body}` : body);

/**
 * The message for the state's current step. The notice is consumed here:
 * the returned state no longer carries it, so it is said exactly once.
 */
export function render(s: FlowState): Transition {
  const body = (b: string) => withNotice(s, b);
  const out = (reply: FlowReply): Transition => ({ kind: "reply", state: { ...s, notice: null }, reply });

  switch (s.step) {
    case "menu":
      return out({
        type: "buttons",
        body: body(C.MENU.body(s.showName)),
        buttons: [
          { id: FLOW_ID.go, title: C.MENU.go },
          { id: FLOW_ID.link, title: C.MENU.link },
          ...(s.multiShow ? [{ id: FLOW_ID.switchShow, title: C.MENU.switchShow }] : []),
        ],
      });

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
          { title: C.NAV.sectionNav, rows: navRows() },
        ],
      });

    case "studio-default": {
      const d = s.defaultStudio as BookableRoom;
      return out({
        type: "buttons",
        body: body(C.STUDIO_DEFAULT.body(d)),
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
            rows: BOOKABLE_ROOM_NAMES.map((r) => ({ id: FLOW_ID.studio(r), title: r })),
          },
          { title: C.NAV.sectionNav, rows: navRows() },
        ],
      });

    case "day": {
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
          { title: C.NAV.sectionNav, rows: navRows() },
        ],
      });
    }

    case "hour": {
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
          { title: C.NAV.sectionNav, rows: navRows() },
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
          })
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

const studioStep = (s: FlowState): FlowStep => (s.defaultStudio ? "studio-default" : "studio");

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
    case "duration":
      return go(s, { step: "menu", ...clearFrom("duration") });
    case "studio-default":
    case "studio":
      // from the free list back to the "as usual?" question, if there is one
      if (s.step === "studio" && s.defaultStudio) return go(s, { step: "studio-default", ...clearFrom("studio") });
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
export function reduce(s: FlowState, e: FlowEvent): Transition {
  // ── always available ──
  if (e.type === "restart") {
    if (s.step === "submitting") return render(s);
    return start({ showId: s.showId, showName: s.showName, defaultStudio: s.defaultStudio, multiShow: s.multiShow });
  }
  if (e.type === "back") return back(s);

  const stale = () => again(s, C.NOTICE.stale);
  // free text where a choice is expected: the current step again. This is the
  // exact seam where a future language layer plugs in — it would turn the text
  // into one of the structured events above instead.
  const pick = () => again(s, C.NOTICE.pickFromList);

  switch (s.step) {
    case "menu":
      if (e.type === "go") return go(s, { step: "duration" });
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

    case "studio-default":
      if (e.type === "studio-yes" && s.defaultStudio) return chooseStudio(s, s.defaultStudio);
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
      if (e.type === "hour") {
        const h = s.hours.find((x) => x.start === e.start);
        if (!h) return stale();
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
      if (e.type === "confirm") {
        // 🔴 THE ONLY WAY INTO "submitting". The driver persists this state
        // under the version lock BEFORE it submits, so a second "לקבוע" —
        // a double tap, or the same tap delivered twice — finds the
        // conversation already submitting and makes nothing.
        return { kind: "submit", state: { ...s, step: "submitting", notice: null } };
      }
      if (e.type === "cancel") {
        return { kind: "reply", state: { ...s, step: "done", notice: null }, reply: { type: "text", body: C.OUTCOME.cancelled } };
      }
      if (e.type === "text") return pick();
      return stale();

    case "submitting":
      return render(s);

    case "done":
      // a stale "לקבוע" on the summary that already went through
      if (e.type === "confirm") return render(s);
      // anything else starts a new booking — a new message, a new request
      return start({ showId: s.showId, showName: s.showName, defaultStudio: s.defaultStudio, multiShow: s.multiShow });
  }
}

// ─── fed by the driver (PURE) ──────────────────────────────────────────────

/**
 * Availability arrived (from loadAvailability, the same function /b/[token]
 * uses, projected by toPublicAvailability). Fill the step's options with the
 * SAME pure helpers the booking screen draws its grid with — clickableDays and
 * hoursFor — and render.
 */
export function withAvailability(s: FlowState, pub: PublicAvailability): Transition {
  if (s.step === "day") {
    const days = clickableDays(pub.free, s.studio, pub.fromIsrael, pub.toIsrael);
    if (days.length === 0) {
      // nothing for this (length, room): back to choosing a room, saying why
      return render({
        ...s,
        ...clearFrom("studio"),
        step: "studio",
        notice: C.NOTICE.noDays(s.studio as string, s.duration as BookingDuration),
      });
    }
    return render({ ...s, days, dayPage: Math.min(s.dayPage, Math.floor((days.length - 1) / PAGE_SIZE)) });
  }

  if (s.step === "hour") {
    const hours = hoursFor(pub.free, s.studio, s.date).map((h) => ({ start: h.startIsrael, end: h.endIsrael }));
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
  if (r.ok) {
    const done: FlowState = { ...s, step: "done", requestId: r.request.id, notice: null };
    if (r.request.status === "approved") {
      return {
        kind: "reply",
        state: done,
        // the EXISTING confirmation text (title.ts), from the STORED values
        reply: {
          type: "text",
          body: approvedWhatsappText({
            showName: s.showName,
            dateIsrael: r.request.dateIsrael,
            startIsrael: r.request.startIsrael,
            studio: r.request.studio,
          }),
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
  return s as FlowState;
}
