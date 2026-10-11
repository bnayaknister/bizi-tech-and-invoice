import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES, toPublicAvailability } from "@/lib/booking/publicView";
import { ensureBookingLink } from "@/lib/booking/links";
import { submitBookingRequest } from "@/lib/booking/submit";
import { cancelApprovedBooking, factsOf } from "@/lib/booking/cancel";
import { DELETE_DETAILS, forwardedDetails, selfServeAllowed } from "@/lib/booking/manage";
import { durationFromRange } from "@/lib/booking/duration";
import { israelHHMM } from "@/lib/booking/publicView";
import { israelDateOf } from "@/lib/calendar/availability";
import { notifyBookingChange } from "../notify";
import type { ContactShow } from "@/lib/booking/contacts";
import type { InboundMessage } from "../webhook";
import { copy, type Lang } from "./copy";
import { isBilingualOn } from "../lang";
import {
  afterCancel,
  afterForward,
  afterSubmit,
  withRecordings,
  type CancelOutcome,
  type RecordingOption,
  isLive,
  parseFlowId,
  reduce,
  render,
  start,
  textEvent,
  withAvailability,
  type FlowEvent,
  type FlowReply,
  type FlowState,
  type Transition,
} from "./machine";
import { loadConversation, saveConversation } from "./store";

// ═══════════════════════════════════════════════════════════════════════════
// The booking conversation's DRIVER — the only impure part of E9-4.
// ═══════════════════════════════════════════════════════════════════════════
//
// It reads the conversation row, hands the machine one structured event, and
// satisfies the machine's requests: fresh availability (loadAvailability —
// the same function /b/[token] uses, live feed read), a submission
// (submitBookingRequest — the same path the screen uses), the link (the E9-3
// reply). It decides NOTHING about the conversation itself.
//
// It does not SEND either: it returns what to send, and reply.ts records and
// sends it under the reply de-dup key it already uses for every reply. So the
// order is always: state saved -> message sent. A message whose state was
// never saved would be a message the next tap cannot be validated against.

/**
 * The activation switch (rule 40 precedent: OFF unless exactly "true").
 *
 * 🔴 WHY A SWITCH AT ALL: a push to main deploys to the LIVE bot before the
 * owner applies 0104. With the switch off, the bot keeps its E9-3 behaviour
 * (the booking link) and this file is never reached; the owner turns it on
 * after the apply. And even with it on, a missing table falls back to the
 * link (see store.ts) rather than silencing the bot.
 */
export function isFlowOn(): boolean {
  return process.env.WHATSAPP_BOOKING_FLOW === "true";
}

/**
 * E9-5's activation switch — cancel and move through the bot. Same direction
 * as the one above (rule 40: OFF unless exactly "true"), and for the same
 * reason: the push reaches the live bot before 0105 is applied. Off, the menu
 * is exactly E9-4's.
 */
export function isManageOn(): boolean {
  return process.env.WHATSAPP_BOOKING_MANAGE === "true";
}

export type FlowOutcome =
  | { kind: "send"; reply: FlowReply; meta: Record<string, unknown> }
  /** send the show's booking link — the E9-3 reply, including its no-link path */
  | { kind: "link"; show: ContactShow }
  /** send the existing podcast list */
  | { kind: "shows" }
  /** a concurrent delivery already handled this conversation: send nothing */
  | { kind: "drop" }
  /** the conversation store is unreachable: answer exactly as E9-3 did */
  | { kind: "fallback" };

/** The interactive id Meta echoed back, if any. */
export function interactiveId(message: InboundMessage): string | null {
  const i = (message.raw as { interactive?: { button_reply?: { id?: unknown }; list_reply?: { id?: unknown } } } | null)
    ?.interactive;
  const id = i?.button_reply?.id ?? i?.list_reply?.id;
  return typeof id === "string" ? id : null;
}

/**
 * One inbound message -> one structured event. PURE.
 *
 * A tap becomes its parsed event; typed text becomes a nav event or `text`;
 * an image, a sticker, a voice note — anything without text — becomes empty
 * text, which every step answers by re-sending itself.
 */
export function eventFromMessage(message: InboundMessage): FlowEvent {
  const tapped = parseFlowId(interactiveId(message));
  if (tapped) return tapped;
  if (message.type === "text") return textEvent(message.body ?? "");
  return { type: "text", text: "" };
}

const showInfo = (show: ContactShow, multiShow: boolean, linkUrl: string | null, lang: Lang) => ({
  showId: show.showId,
  showName: show.showName,
  defaultStudio: show.defaultStudio ?? null,
  multiShow,
  manageOn: isManageOn(),
  linkUrl,
  lang,
  bilingualOn: isBilingualOn(),
});

/** A booking row -> the option "ההקלטות שלי" offers. PURE. */
export function toRecordingOption(r: {
  id: string;
  show_id: string;
  studio: string;
  start_at: string;
  end_at: string;
  guest: string | null;
  note: string | null;
  showName: string;
}): RecordingOption {
  const start = new Date(r.start_at);
  return {
    id: r.id,
    showId: r.show_id,
    showName: r.showName,
    studio: r.studio,
    date: israelDateOf(start),
    start: israelHHMM(start),
    end: israelHHMM(new Date(r.end_at)),
    startIso: r.start_at,
    durationMinutes: durationFromRange(r.start_at, r.end_at),
    guest: r.guest,
    note: r.note,
  };
}

/** The upcoming APPROVED recordings of this number's own podcasts, soonest first. */
async function loadRecordings(
  admin: SupabaseClient<Database>,
  showIds: string[],
  showNames: Map<string, string>,
  now: Date
): Promise<RecordingOption[] | null> {
  const { data, error } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,note")
    .in("show_id", showIds)
    .eq("status", "approved")
    .gte("start_at", now.toISOString())
    .order("start_at", { ascending: true })
    .limit(20);
  if (error) {
    console.error("wa/flow: קריאת ההקלטות נכשלה", error.message);
    return null;
  }
  return (data ?? []).map((r) => toRecordingOption({ ...r, showName: showNames.get(r.show_id) ?? "" }));
}

/** The original of a move/cancel, read FRESH — never trusted from the stored state. */
async function readTarget(admin: SupabaseClient<Database>, id: string) {
  const { data } = await admin
    .from("booking_requests")
    .select("id,show_id,status,studio,start_at,end_at,guest,calendar_event_uid,shows(name)")
    .eq("id", id)
    .maybeSingle();
  return data;
}

/**
 * Run one message through the conversation.
 *
 * @param pickedShowId a podcast chosen from the E9-3 list, already parsed —
 *   and honoured only if it is one of `shows`, this number's own podcasts.
 */
export async function runFlow(
  admin: SupabaseClient<Database>,
  input: {
    waId: string;
    message: InboundMessage;
    shows: ContactShow[];
    pickedShowId: string | null;
    now: Date;
    /** the app's public base URL, for the link in the menu */
    baseUrl: string;
    /** E19: the number's language, already resolved by the reply layer */
    lang: Lang;
    /**
     * E19: an event the reply layer decided on instead of the message's own —
     * `refresh` after a language switch, whose text ("English") must never
     * reach a step that reads free text as a value (the guest's name).
     */
    eventOverride?: FlowEvent;
  }
): Promise<FlowOutcome> {
  const { waId, message, shows, now } = input;
  const C = copy(input.lang);
  const multi = shows.length > 1;

  const loaded = await loadConversation(admin, waId);
  if (!loaded.ok) return { kind: "fallback" };
  const row = loaded.row;
  const version = row ? row.version : null;

  // 🔴 A LIVE CONVERSATION IS RE-AUTHORISED ON EVERY MESSAGE. If the owner
  // removed this number from the show since the conversation began, the stored
  // state names a show this number may no longer book — it is discarded.
  const live: FlowState | null =
    row?.state &&
    isLive(row.expiresAt, now) &&
    shows.some((s) => s.showId === row.state!.showId) &&
    // E9-5: the recording being cancelled or moved may belong to ANOTHER of
    // this number's podcasts — and that permission is re-checked too
    (!row.state.target || shows.some((s) => s.showId === row.state!.target!.showId))
      ? row.state
      : null;

  const event = input.eventOverride ?? eventFromMessage(message);

  /**
   * A new conversation. The link is resolved FIRST: a show that cannot get
   * one (the alias gate) could never be submitted, and the E9-3 path already
   * handles that — it tells the owner and answers the client neutrally. And
   * the menu carries the link in its body (E9-5), so it must exist before the
   * menu is rendered.
   */
  const fresh = async (show: ContactShow, notice: string | null): Promise<Transition | null> => {
    const link = await ensureBookingLink(admin, show.showId, null);
    if (!link.ok) return null;
    return start(showInfo(show, multi, `${input.baseUrl}/b/${link.token}`, input.lang), notice);
  };

  let t: Transition;
  if (input.pickedShowId) {
    const show = shows.find((s) => s.showId === input.pickedShowId);
    if (!show) return { kind: "shows" };
    const f = await fresh(show, null);
    if (!f) return { kind: "link", show };
    t = f;
  } else if (live) {
    // the switches are read on every message: turning one off takes effect at
    // once — and so is the language (E19): the saved preference wins over the
    // one the conversation started in, so a switch applies mid-conversation
    t = reduce({ ...live, manageOn: isManageOn(), lang: input.lang, bilingualOn: isBilingualOn() }, event, { now });
  } else {
    // step 0 (owner, E9-3): several podcasts and no conversation -> the list
    if (multi) return { kind: "shows" };
    // a tap on a conversation that expired: say so once, then start over
    const tappedOld = parseFlowId(interactiveId(message)) !== null;
    const notice = event.type === "refresh" ? C.LANG.switched : tappedOld ? C.NOTICE.expired : null;
    const f = await fresh(shows[0], notice);
    if (!f) return { kind: "link", show: shows[0] };
    t = f;
  }

  let currentVersion = version;
  let submitted = false;

  for (let guard = 0; guard < 4 && t.kind !== "reply"; guard++) {
    if (t.kind === "link" || t.kind === "switch-show") {
      const saved = await saveConversation(admin, waId, t.state, currentVersion, now);
      if (saved.kind === "conflict") return { kind: "drop" };
      if (t.kind === "switch-show") return { kind: "shows" };
      const show = shows.find((s) => s.showId === t.state.showId) as ContactShow;
      return { kind: "link", show };
    }

    if (t.kind === "need-availability") {
      try {
        // a move: the original must not block its own slots (owner, 11.10)
        let ignore: { requestId: string; calendarUid: string | null } | undefined;
        if (t.state.mode === "move" && t.state.target) {
          const original = await readTarget(admin, t.state.target.id);
          if (original?.status === "approved") {
            ignore = { requestId: original.id, calendarUid: original.calendar_event_uid };
          }
        }
        const avail = await loadAvailability(admin, {
          now,
          stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
          durationMinutes: t.state.duration ?? undefined,
          ignore,
        });
        t = withAvailability(t.state, toPublicAvailability(avail.result, avail, avail.rooms));
      } catch (e) {
        // Logged, never quoted — the ICS URL is a secret. Nothing is saved: the
        // stored state is still the step before, so the client's next tap on
        // the same message simply tries again.
        console.error("wa/flow: קריאת הזמינות נכשלה", e);
        return { kind: "send", reply: { type: "text", body: C.NOTICE.feedFailed }, meta: { flow_error: "feed" } };
      }
      continue;
    }

    if (t.kind === "need-recordings") {
      const recs = await loadRecordings(
        admin,
        shows.map((s) => s.showId),
        new Map(shows.map((s) => [s.showId, s.showName])),
        now
      );
      if (recs === null) {
        return { kind: "send", reply: { type: "text", body: C.NOTICE.manageFailed }, meta: { flow_error: "recordings" } };
      }
      t = withRecordings(t.state, recs);
      continue;
    }

    if (t.kind === "forward" || t.kind === "cancel") {
      // the same claim as a submission: only the delivery that wins acts
      const claimed = await saveConversation(admin, waId, t.state, currentVersion, now);
      if (claimed.kind === "conflict") return { kind: "drop" };
      if (claimed.kind === "error") return { kind: "fallback" };
      currentVersion = claimed.version;
      submitted = true;

      const target = t.state.target as RecordingOption;
      const row = await readTarget(admin, target.id);
      if (!row || row.status !== "approved") {
        t = afterCancel(t.state, "not-active");
        continue;
      }
      const facts = factsOf({ ...row, showName: row.shows?.name ?? target.showName });

      // 🔴 THE 24-HOUR RULE, AGAIN, ON A FRESH READ — whatever the machine
      // decided when the button was tapped.
      const late = !selfServeAllowed(row.start_at, now);
      if (t.kind === "forward" || late) {
        const change = t.kind === "forward" ? t.change : "cancel-request";
        await notifyBookingChange(admin, {
          change,
          bookingId: row.id,
          facts,
          details: forwardedDetails(waId, change === "cancel-request" ? "cancel" : "move"),
        });
        t = afterForward(t.state, change);
        continue;
      }

      const cancelled = await cancelApprovedBooking(admin, { id: row.id, actorId: null, now, source: "bot" });
      let outcome: CancelOutcome = "error";
      if (cancelled.ok) {
        outcome = "cancelled";
        await notifyBookingChange(admin, {
          change: "client-cancelled",
          bookingId: row.id,
          facts: cancelled.request.facts,
          details: DELETE_DETAILS[cancelled.calendar.outcome],
        });
      } else if (cancelled.code === "not-approved") {
        outcome = "not-active";
      }
      t = afterCancel(t.state, outcome);
      continue;
    }

    if (t.kind === "submit") {
      // 🔴 "submitting" IS SAVED FIRST, under the version lock. Only the
      // delivery that wins this write submits; a double tap loses it and
      // sends nothing.
      const saved = await saveConversation(admin, waId, t.state, currentVersion, now);
      if (saved.kind === "conflict") return { kind: "drop" };
      if (saved.kind === "error") {
        // could not claim the submission -> do not submit; the summary again
        const back = render({ ...t.state, step: "summary", notice: C.NOTICE.submitFailed });
        return { kind: "send", reply: (back as Extract<Transition, { kind: "reply" }>).reply, meta: { flow_error: "claim" } };
      }
      currentVersion = saved.version;

      const s = t.state;

      // ── E9-5: a move — the original read fresh, and the 24-hour rule again ──
      if (s.mode === "move" && s.target) {
        const original = await readTarget(admin, s.target.id);
        if (!original || original.status !== "approved") {
          submitted = true;
          t = afterSubmit(s, { ok: false, code: "original-gone" });
          continue;
        }
        if (!selfServeAllowed(original.start_at, now)) {
          await notifyBookingChange(admin, {
            change: "move-request",
            bookingId: original.id,
            facts: factsOf({ ...original, showName: original.shows?.name ?? s.target.showName }),
            details: forwardedDetails(waId, "move"),
          });
          submitted = true;
          t = afterForward(s, "move-request");
          continue;
        }
      }

      // a move books for the ORIGINAL's show — in a multi-podcast number that
      // need not be the show the conversation started with
      const showId = s.mode === "move" && s.target ? s.target.showId : s.showId;
      const showName = s.mode === "move" && s.target ? s.target.showName : s.showName;
      const link = await ensureBookingLink(admin, showId, null);
      const result = link.ok
        ? await submitBookingRequest(admin, {
            showId,
            linkId: link.linkId,
            showName,
            studio: s.studio,
            startIsrael: `${s.date} ${s.start}`,
            endIsrael: s.end,
            guest: s.guest,
            note: s.note,
            durationMinutes: s.duration,
            now,
            replacing: s.mode === "move" && s.target ? { id: s.target.id } : undefined,
          })
        : ({ ok: false, code: "error" } as const);
      submitted = true;
      t = afterSubmit(s, result);
      continue;
    }
  }

  if (t.kind !== "reply") {
    // unreachable by construction (every request resolves in one round); a
    // safe answer rather than a silent bot if that ever stops being true
    console.error("wa/flow: המכונה לא הגיעה לתשובה", t.kind);
    return { kind: "fallback" };
  }

  const saved = await saveConversation(admin, waId, t.state, currentVersion, now);
  if (!submitted) {
    if (saved.kind === "conflict") return { kind: "drop" };
    if (saved.kind === "error") return { kind: "fallback" };
  } else if (saved.kind !== "saved") {
    // 🔴 A REQUEST NOW EXISTS, so the client is told its outcome whatever
    // happened to this write. The row stays "submitting", which answers any
    // further tap with "בטיפול" until it expires — never with a second request.
    console.error("wa/flow: שמירת התוצאה אחרי ההגשה נכשלה", saved.kind);
  }

  return {
    kind: "send",
    reply: t.reply,
    meta: { flow_step: t.state.step, show_id: t.state.showId, request_id: t.state.requestId },
  };
}
