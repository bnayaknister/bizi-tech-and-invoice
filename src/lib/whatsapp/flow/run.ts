import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES, toPublicAvailability } from "@/lib/booking/publicView";
import { ensureBookingLink } from "@/lib/booking/links";
import { submitBookingRequest } from "@/lib/booking/submit";
import type { ContactShow } from "@/lib/booking/contacts";
import type { InboundMessage } from "../webhook";
import { NOTICE } from "./copy";
import {
  afterSubmit,
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

const showInfo = (show: ContactShow, multiShow: boolean) => ({
  showId: show.showId,
  showName: show.showName,
  defaultStudio: show.defaultStudio ?? null,
  multiShow,
});

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
  }
): Promise<FlowOutcome> {
  const { waId, message, shows, now } = input;
  const multi = shows.length > 1;

  const loaded = await loadConversation(admin, waId);
  if (!loaded.ok) return { kind: "fallback" };
  const row = loaded.row;
  const version = row ? row.version : null;

  // 🔴 A LIVE CONVERSATION IS RE-AUTHORISED ON EVERY MESSAGE. If the owner
  // removed this number from the show since the conversation began, the stored
  // state names a show this number may no longer book — it is discarded.
  const live: FlowState | null =
    row?.state && isLive(row.expiresAt, now) && shows.some((s) => s.showId === row.state!.showId) ? row.state : null;

  const event = eventFromMessage(message);
  let t: Transition;
  let fresh = false;

  if (input.pickedShowId) {
    const show = shows.find((s) => s.showId === input.pickedShowId);
    if (!show) return { kind: "shows" };
    t = start(showInfo(show, multi));
    fresh = true;
  } else if (live) {
    t = reduce(live, event);
  } else {
    // step 0 (owner, E9-3): several podcasts and no conversation -> the list
    if (multi) return { kind: "shows" };
    // a tap on a conversation that expired: say so once, then start over
    const tappedOld = parseFlowId(interactiveId(message)) !== null;
    t = start(showInfo(shows[0], false), tappedOld ? NOTICE.expired : null);
    fresh = true;
  }

  // A new conversation for a show that cannot get a link (the alias gate)
  // could never be submitted. The E9-3 path already handles that case — it
  // tells the owner and answers the client neutrally — so it goes there now,
  // rather than at the end of a ten-tap conversation.
  if (fresh) {
    const link = await ensureBookingLink(admin, t.state.showId, null);
    if (!link.ok) {
      const show = shows.find((s) => s.showId === t.state.showId) as ContactShow;
      return { kind: "link", show };
    }
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
        const avail = await loadAvailability(admin, {
          now,
          stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
          durationMinutes: t.state.duration ?? undefined,
        });
        t = withAvailability(t.state, toPublicAvailability(avail.result, avail, avail.rooms));
      } catch (e) {
        // Logged, never quoted — the ICS URL is a secret. Nothing is saved: the
        // stored state is still the step before, so the client's next tap on
        // the same message simply tries again.
        console.error("wa/flow: קריאת הזמינות נכשלה", e);
        return { kind: "send", reply: { type: "text", body: NOTICE.feedFailed }, meta: { flow_error: "feed" } };
      }
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
        const back = render({ ...t.state, step: "summary", notice: NOTICE.submitFailed });
        return { kind: "send", reply: (back as Extract<Transition, { kind: "reply" }>).reply, meta: { flow_error: "claim" } };
      }
      currentVersion = saved.version;

      const s = t.state;
      const link = await ensureBookingLink(admin, s.showId, null);
      const result = link.ok
        ? await submitBookingRequest(admin, {
            showId: s.showId,
            linkId: link.linkId,
            showName: s.showName,
            studio: s.studio,
            startIsrael: `${s.date} ${s.start}`,
            endIsrael: s.end,
            guest: s.guest,
            note: s.note,
            durationMinutes: s.duration,
            now,
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
