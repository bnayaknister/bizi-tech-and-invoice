import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  buttonsPayload,
  isWhatsappDryRun,
  listPayload,
  sectionedListPayload,
  sendWhatsapp,
  textPayload,
} from "./client";
import { EXISTING_CLAIM_DETAILS, notifyClientRegistration, recordBookingNotification } from "./notify";
import { isRegistrationEnabled } from "@/lib/registration/switch";
import { ensureRegistrationLinkForWaId, registrationUrl } from "@/lib/registration/links";
import { israelDateOf } from "@/lib/calendar/availability";
import { bookingUrlForShow, showsForNumber, type ContactShow } from "@/lib/booking/contacts";
import type { InboundMessage } from "./webhook";
import { interactiveId, isFlowOn, runFlow } from "./flow/run";
import { getAppBaseUrl } from "@/lib/appUrl";
import type { FlowEvent, FlowReply } from "./flow/machine";
import { DEFAULT_LANG, copy, type Lang } from "./flow/copy";
import {
  isBilingualOn,
  languageFromMessage,
  languageFromSaved,
  languageQuestion,
  loadLang,
  saveLang,
} from "./lang";

// ═══════════════════════════════════════════════════════════════════════════
// What the bot says back. E9-3.
// ═══════════════════════════════════════════════════════════════════════════
//
// Three outcomes, and the owner's decisions fix all three:
//   known, ONE podcast    -> free text with that podcast's booking link
//   known, SEVERAL        -> an interactive list; the pick gets the link
//   unknown               -> a neutral sentence + a template to the OWNER ONLY
//
// ═══ 🔴 FREE TEXT IS LEGAL HERE, AND ONLY HERE ═══
// Meta allows free-form messages only inside the 24-hour customer-service
// window, counted from the client's OWN last message. Every reply in this file
// is sent in direct response to an inbound message, i.e. with a window that
// opened milliseconds ago — so none of them needs an approved template. The
// notifications in notify.ts are the opposite case (business-initiated, no
// window) and are templates for exactly that reason. The distinction is not a
// style choice; sending free text outside the window silently fails with a
// 131047 and the client never learns anything.
//
// ⛔ AND THE BOT DOES NOT UNDERSTAND TEXT. It does not read "I want Tuesday"
// and it does not answer questions. E9-4 adds a booking CONVERSATION of
// buttons and lists (./flow), behind WHATSAPP_BOOKING_FLOW; with the switch
// off, any message from a known number gets the E9-3 answer — your link, or
// your list. Free-language understanding is a later layer, designed to feed
// the conversation's structured events (owner decision 11.10).
//
// ⛔ AND CANCELLATIONS ARE NOT HANDLED YET (owner: a later stage). A client who
// writes "לבטל" gets the ordinary link reply. That is a known gap, stated
// rather than half-built: a cancellation path that notifies nobody is worse
// than one that does not exist.

// The words — the neutral sentence, the link reply, the list — live in the
// dictionary (./flow/copy.ts, `REPLY`), in both languages (E19).

/**
 * The id carried on a list row, and read back when the client taps it.
 *
 * 🔴 PREFIXED, AND PARSED STRICTLY. Meta echoes this string back verbatim in
 * `interactive.list_reply.id`, which means it is attacker-controllable in
 * principle — a crafted inbound payload could put anything here. So it is
 * never used as a show id directly: the prefix is required, the remainder must
 * be a uuid, and the row is then looked up against THIS number's own
 * permissions before anything is sent. A client cannot tap their way into
 * another client's podcast.
 */
const ROW_PREFIX = "show:";

export function showRowId(showId: string): string {
  return `${ROW_PREFIX}${showId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseShowRowId(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith(ROW_PREFIX)) return null;
  const id = raw.slice(ROW_PREFIX.length).trim();
  return UUID_RE.test(id) ? id : null;
}

// ─── the decision (PURE) ────────────────────────────────────────────────────

export type ReplyPlan =
  | { kind: "link"; show: ContactShow }
  | { kind: "list"; shows: ContactShow[] }
  | { kind: "neutral" };

/**
 * What to say, given who this is and what they tapped. PURE.
 *
 * ⚠️ A TAPPED ROW IS HONOURED **ONLY** IF IT IS ONE OF THEIR OWN SHOWS. That
 * check is here and not at the call site, because it is the security property
 * of this whole path: `pickedShowId` came from Meta echoing a string back, and
 * the authorisation is `shows` — the rows that this number actually owns. A
 * pick that is not in the list falls through to the list again rather than
 * erroring, which is also the right behaviour for a genuinely stale tap on an
 * old message after the owner removed the permission.
 */
export function planReply(shows: ContactShow[], pickedShowId: string | null): ReplyPlan {
  if (shows.length === 0) return { kind: "neutral" };

  if (pickedShowId) {
    const picked = shows.find((s) => s.showId === pickedShowId);
    if (picked) return { kind: "link", show: picked };
  }

  if (shows.length === 1) return { kind: "link", show: shows[0] };
  return { kind: "list", shows };
}

/** The rows for the list message, in the order `showsForNumber` sorted them. */
export function listRowsFor(shows: ContactShow[]): { id: string; title: string; description?: string }[] {
  return shows.map((s) => ({
    id: showRowId(s.showId),
    // `listPayload` truncates to Meta's 24/72 limits; the FULL name goes in
    // the description so a long show name is still readable by the client.
    title: s.showName,
    description: s.showName,
  }));
}

// ─── the impure half ────────────────────────────────────────────────────────

/**
 * The reply's own `wamid`, derived from the INBOUND message's id.
 *
 * 🔴 THIS IS THE "DO NOT ANSWER TWICE" LOCK. Meta re-delivers any webhook that
 * did not get a 200, so the same client message arrives more than once as a
 * matter of course. The route's first lock is the inbound upsert (a
 * re-delivery inserts zero rows, so we never get here) — and this is the
 * second: even if the route were restructured, the reply row collides on the
 * unique index and `recordAndSend` sends nothing.
 */
export function replyWamid(inboundWamid: string): string {
  return `local:reply:${inboundWamid}`;
}

type ReplyKind = ReplyPlan["kind"] | "flow" | "lang" | "join";

export type ReplyOutcome =
  | { sent: true; kind: ReplyKind }
  | { sent: false; reason: "duplicate" | "dry-run" | "no-url" | "send-failed" | "error"; kind: ReplyKind };

/** A conversation reply -> the Graph payload. PURE. */
export function flowPayload(to: string, reply: FlowReply): Record<string, unknown> {
  if (reply.type === "text") return textPayload({ to, body: reply.body });
  if (reply.type === "buttons") return buttonsPayload({ to, body: reply.body, buttons: reply.buttons });
  return sectionedListPayload({ to, body: reply.body, button: reply.button, sections: reply.sections });
}

/**
 * Record the reply, then send it. Same order, and the same reason, as
 * `recordBookingNotification`: a visible `queued` row beats a message in a
 * client's phone that our log has never heard of.
 *
 * 🔴 IT NEVER THROWS. The caller is a webhook that owes Meta a 200 within
 * seconds; an exception here would turn a delivered message into a retry
 * storm.
 */
async function recordAndSend(
  admin: SupabaseClient<Database>,
  input: {
    inboundWamid: string;
    waId: string;
    body: string;
    payload: Record<string, unknown>;
    kind: ReplyKind;
    /** the Graph message type when it is not implied by `kind` */
    type?: "text" | "interactive";
    meta: Record<string, unknown>;
  }
): Promise<ReplyOutcome> {
  const dryRun = isWhatsappDryRun();
  const wamid = replyWamid(input.inboundWamid);

  try {
    const { data, error } = await admin
      .from("wa_messages")
      .upsert(
        [
          {
            wamid,
            direction: "out",
            wa_id: input.waId,
            // not a template: a free-text or interactive reply inside the
            // 24-hour window. `template_name` stays null, which 0101's pair
            // CHECK permits for an outbound row.
            type: input.type ?? (input.kind === "list" ? "interactive" : "text"),
            body: input.body,
            template_name: null,
            status: dryRun ? "dry_run" : "queued",
            payload: { kind: `reply:${input.kind}`, in_reply_to: input.inboundWamid, ...input.meta } as Json,
          },
        ],
        { onConflict: "wamid", ignoreDuplicates: true }
      )
      .select("wamid");

    if (error) {
      console.error("wa/reply: רישום התשובה נכשל", error);
      return { sent: false, reason: "error", kind: input.kind };
    }
    if ((data ?? []).length === 0) {
      // Already answered this exact inbound message. The whole point.
      return { sent: false, reason: "duplicate", kind: input.kind };
    }
  } catch (e) {
    console.error("wa/reply: רישום התשובה זרק", e);
    return { sent: false, reason: "error", kind: input.kind };
  }

  if (dryRun) return { sent: false, reason: "dry-run", kind: input.kind };

  const result = await sendWhatsapp(input.payload);
  const at = new Date().toISOString();
  if (result.ok && !result.dryRun) {
    await admin
      .from("wa_messages")
      .update({ status: "sent", provider_wamid: result.providerWamid, status_at: at })
      .eq("wamid", wamid);
    return { sent: true, kind: input.kind };
  }
  if (!result.ok) {
    console.error("wa/reply: שליחת התשובה נכשלה", result.error);
    await admin
      .from("wa_messages")
      .update({ status: "failed", error: result.error, status_at: at })
      .eq("wamid", wamid);
  }
  return { sent: false, reason: "send-failed", kind: input.kind };
}

/**
 * Answer one inbound message.
 *
 * ⛔ NEVER THROWS, and the route depends on it — see recordAndSend.
 */
export async function replyToInbound(
  admin: SupabaseClient<Database>,
  request: Request,
  message: InboundMessage,
  /**
   * E19, internal: set only when answering a message the client wrote BEFORE
   * choosing a language. `replyKey` is the language tap's own wamid — the
   * original's reply key is already taken by the language question — and
   * `lang` is the language just chosen, so the question is not asked again.
   */
  resumed?: { replyKey: string; lang: Lang }
): Promise<ReplyOutcome> {
  try {
    const waId = message.waId;
    const replyKey = resumed?.replyKey ?? message.wamid;
    if (!waId) {
      // A sender we could not normalise cannot be matched against
      // `booking_contacts` (whose `wa_id` is canonical by CHECK), so it is
      // treated as unknown — which is the honest answer, not a failure. Its
      // language cannot be stored either: Hebrew.
      return await replyUnknown(admin, message, "unknown", { lang: DEFAULT_LANG, replyKey }, request);
    }

    // ── E19: the language, BEFORE anything else ─────────────────────────
    let lang: Lang = resumed?.lang ?? DEFAULT_LANG;
    let eventOverride: FlowEvent | undefined;
    if (!resumed && isBilingualOn()) {
      const r = await resolveLanguage(admin, request, message, waId);
      if (r.kind === "answered") return r.outcome;
      lang = r.lang;
      eventOverride = r.eventOverride;
    }
    const ctx: Ctx = { lang, replyKey };

    const shows = await showsForNumber(admin, waId);
    const picked =
      message.type === "interactive"
        ? parseShowRowId(
            (
              (message.raw as { interactive?: { list_reply?: { id?: unknown } } } | null)?.interactive
                ?.list_reply ?? {}
            ).id
          )
        : null;

    // ── E9-4: the booking conversation, when it is switched on ──────────
    if (isFlowOn() && shows.length > 0) {
      const flow = await runFlow(admin, {
        waId,
        message,
        shows,
        pickedShowId: picked,
        now: new Date(),
        baseUrl: getAppBaseUrl(request),
        lang,
        eventOverride,
      });
      if (flow.kind === "drop") return { sent: false, reason: "duplicate", kind: "flow" };
      if (flow.kind === "shows") return await sendShowList(admin, waId, shows, ctx);
      if (flow.kind === "link") return await sendLink(admin, request, waId, flow.show, ctx);
      if (flow.kind === "send") {
        return await recordAndSend(admin, {
          inboundWamid: replyKey,
          waId,
          body: flow.reply.body,
          payload: flowPayload(waId, flow.reply),
          kind: "flow",
          type: flow.reply.type === "text" ? "text" : "interactive",
          meta: flow.meta,
        });
      }
      // "fallback": the conversation store is unreachable (0104 not applied
      // yet, or a database error) — answer exactly as E9-3 does, below.
    }

    const plan = planReply(shows, picked);

    if (plan.kind === "neutral") return await replyUnknown(admin, message, waId, ctx, request);
    if (plan.kind === "list") return await sendShowList(admin, waId, plan.shows, ctx);
    return await sendLink(admin, request, waId, plan.show, ctx);
  } catch (e) {
    console.error("wa/reply: התשובה זרקה", e);
    return { sent: false, reason: "error", kind: "neutral" };
  }
}

/** The language and the reply key every sender below writes with (E19). */
type Ctx = { lang: Lang; replyKey: string };

/** The E9-3 podcast list (step 0 of the conversation too). */
async function sendShowList(
  admin: SupabaseClient<Database>,
  waId: string,
  shows: ContactShow[],
  ctx: Ctx
): Promise<ReplyOutcome> {
  const C = copy(ctx.lang);
  return await recordAndSend(admin, {
    inboundWamid: ctx.replyKey,
    waId,
    body: C.REPLY.listBody,
    payload: listPayload({
      to: waId,
      body: C.REPLY.listBody,
      button: C.REPLY.listButton,
      sectionTitle: C.REPLY.listSection,
      rows: listRowsFor(shows),
    }),
    kind: "list",
    meta: { show_ids: shows.map((s) => s.showId) },
  });
}

/** The E9-3 link reply — and its no-link path, which tells the owner. */
async function sendLink(
  admin: SupabaseClient<Database>,
  request: Request,
  waId: string,
  show: ContactShow,
  ctx: Ctx
): Promise<ReplyOutcome> {
  const C = copy(ctx.lang);
  const url = await bookingUrlForShow(admin, request, show.showId);
  if (!url.ok) {
    // 🔴 NO LINK, AND THE CLIENT IS NOT LEFT IN SILENCE. The alias gate is
    // the realistic case (a show whose every name contains a room name), and
    // it needs a human: the owner adds an alias. The client gets the neutral
    // sentence, the owner gets told. Inventing a link is not an option —
    // see bookingUrlForShow's note on why the gate exists.
    console.error("wa/reply: אין קישור הזמנה לתוכנית", show.showId, url.reason);
    await recordBookingNotification(admin, {
      kind: "unknown-contact",
      subjectId: `no-link:${show.showId}`,
      waId,
      excerpt: `אין קישור הזמנה לתוכנית ${show.showName} (${url.reason}). הוסיפו לה שם חלופי.`,
      onlyOwner: true,
    });
    const neutral = await recordAndSend(admin, {
      inboundWamid: ctx.replyKey,
      waId,
      body: C.REPLY.neutral,
      payload: textPayload({ to: waId, body: C.REPLY.neutral }),
      kind: "link",
      meta: { no_link_for_show: show.showId, reason: url.reason },
    });
    return neutral.sent ? { sent: false, reason: "no-url", kind: "link" } : neutral;
  }

  const body = C.REPLY.link(show.showName, url.url);
  return await recordAndSend(admin, {
    inboundWamid: ctx.replyKey,
    waId,
    body,
    payload: textPayload({ to: waId, body }),
    kind: "link",
    meta: { show_id: show.showId },
  });
}

/**
 * The unknown-number path: a neutral sentence to them, a template to the owner.
 *
 * ⚠️ THE NEUTRAL SENTENCE CONFIRMS NOTHING. It does not say "we don't know
 * you", and it does not say "we do": a stranger probing the bot learns the
 * same thing either way, which is the same reasoning `resolveBookingLink`
 * applies to a dead token (links.ts:44-49).
 *
 * ⚠️ AND THE OWNER'S NOTICE GOES TO THE OWNER ALONE (owner decision 9.10 sends
 * BOOKING notices to both recipients; this one is an operational nudge about a
 * stranger's phone number, and Eli has nothing to do with it).
 */
async function replyUnknown(
  admin: SupabaseClient<Database>,
  message: InboundMessage,
  waId: string,
  ctx: Ctx,
  request: Request
): Promise<ReplyOutcome> {
  // E17-4: with registration on, the offer replaces BOTH halves of the old
  // answer — see replyUnknownWithOffer for why the owner's notice moves too.
  if (isRegistrationEnabled() && waId !== "unknown") {
    return await replyUnknownWithOffer(admin, message, waId, ctx, request);
  }

  // the owner's notice first: if the reply fails, the owner should still hear
  // about the message. Its own deterministic wamid is keyed on the INBOUND
  // message, so one notice per message and no storm from a re-delivery.
  // (E19: a message answered after the language question is the SAME inbound
  // message, so the notice already sent when the question went out is not
  // sent twice.)
  await notifyUnknown(admin, message, waId);

  if (waId === "unknown") {
    // Nowhere to send a reply to — the sender did not normalise. The owner's
    // notice above is the whole outcome.
    return { sent: false, reason: "no-url", kind: "neutral" };
  }

  const C = copy(ctx.lang);
  return await recordAndSend(admin, {
    inboundWamid: ctx.replyKey,
    waId,
    body: C.REPLY.neutral,
    payload: textPayload({ to: waId, body: C.REPLY.neutral }),
    kind: "neutral",
    meta: { unknown_contact: true },
  });
}

// ─── E17-4: the registration offer ──────────────────────────────────────────

/** The two buttons' ids. Prefixed like `lang:` and `f:`, and never parsed further. */
export const JOIN_NEW_ID = "join:new";
export const JOIN_EXISTING_ID = "join:existing";

export type UnknownPlan = "offer" | "link" | "existing";

/** What an unassociated number gets, given what it tapped. PURE. */
export function planUnknownReply(tappedId: string | null): UnknownPlan {
  if (tappedId === JOIN_NEW_ID) return "link";
  if (tappedId === JOIN_EXISTING_ID) return "existing";
  return "offer";
}

/**
 * The unassociated number, registration ON (E17-4).
 *
 * ═══ 🔴 ONE NOTICE PER EVENT, NEVER TWO AT ONCE ═══
 * Before E17-4 every message from an unknown number paged the owner
 * (`bizi_unknown_contact`, keyed per inbound message). With the offer, that
 * notice would be followed seconds later by the button's own notice — two
 * messages about one number in the same moment. So, while the switch is on,
 * the notice is carried by what the person DOES, not by their writing:
 *   · writes anything      -> the offer; NO notice (nothing has happened yet);
 *   · taps "פתיחת לקוח חדש" -> their link; NO notice — the registration form
 *                             notifies when it is SENT, with the details;
 *   · taps "אני כבר לקוח"   -> ONE notice, keyed per number per Israeli day,
 *                             so tapping again does not page anyone twice.
 * The language question (askLanguage) skips its notice too, for the same reason.
 *
 * ⚠️ THE PRICE, STATED: a stranger who writes once and never taps is not
 * reported. Their message is in `wa_messages`, and anyone who wants to reach
 * the studio has the two buttons in front of them.
 */
async function replyUnknownWithOffer(
  admin: SupabaseClient<Database>,
  message: InboundMessage,
  waId: string,
  ctx: Ctx,
  request: Request
): Promise<ReplyOutcome> {
  const C = copy(ctx.lang).JOIN;
  const plan = planUnknownReply(interactiveId(message));

  if (plan === "link") {
    const link = await ensureRegistrationLinkForWaId(admin, waId, new Date());
    if (!link.ok) {
      // no link and no silence: the owner hears about this one
      await notifyUnknown(admin, message, waId);
      return await recordAndSend(admin, {
        inboundWamid: ctx.replyKey,
        waId,
        body: C.linkFailed,
        payload: textPayload({ to: waId, body: C.linkFailed }),
        kind: "join",
        meta: { join: "link-failed" },
      });
    }
    const body = C.link(registrationUrl(getAppBaseUrl(request), link.token));
    return await recordAndSend(admin, {
      inboundWamid: ctx.replyKey,
      waId,
      body,
      payload: textPayload({ to: waId, body }),
      kind: "join",
      // the token is in `body` already (it is what the client receives); the
      // meta carries only whether it was minted now
      meta: { join: "link", link_created: link.created },
    });
  }

  if (plan === "existing") {
    await notifyClientRegistration(admin, {
      event: "existing-claim",
      subjectId: `existing-claim:${waId}:${israelDateOf(new Date())}`,
      registrationId: null,
      name: null,
      podcast: null,
      waId,
      details: EXISTING_CLAIM_DETAILS,
    });
    return await recordAndSend(admin, {
      inboundWamid: ctx.replyKey,
      waId,
      body: C.existingReply,
      payload: textPayload({ to: waId, body: C.existingReply }),
      kind: "join",
      meta: { join: "existing" },
    });
  }

  return await recordAndSend(admin, {
    inboundWamid: ctx.replyKey,
    waId,
    body: C.offerBody,
    payload: buttonsPayload({
      to: waId,
      body: C.offerBody,
      buttons: [
        { id: JOIN_NEW_ID, title: C.newClient },
        { id: JOIN_EXISTING_ID, title: C.existingClient },
      ],
    }),
    kind: "join",
    type: "interactive",
    meta: { join: "offer", unknown_contact: true },
  });
}

/** The owner's notice about an unknown number — keyed on the inbound message. */
async function notifyUnknown(admin: SupabaseClient<Database>, message: InboundMessage, waId: string): Promise<void> {
  await recordBookingNotification(admin, {
    kind: "unknown-contact",
    subjectId: message.wamid,
    waId: waId === "unknown" ? message.rawFrom || "unknown" : waId,
    excerpt: message.body ?? "",
    onlyOwner: true,
  });
}

// ─── E19: the language ──────────────────────────────────────────────────────

type LanguageResolution =
  | { kind: "answered"; outcome: ReplyOutcome }
  | { kind: "lang"; lang: Lang; eventOverride?: FlowEvent };

/**
 * Which language to answer in — or, for a number that never chose, the
 * question itself. See ./lang.ts for the rules.
 *
 *   1. a tap on a language button   -> save it; answer the message it was
 *                                      asked about (if any), else re-send
 *                                      the current step in the new language
 *   2. "English" / "עברית" typed    -> save it; re-send the current step
 *   3. a saved language             -> use it
 *   4. none                         -> ask, and nothing else
 *
 * A read failure is Hebrew without a question (the store never silences the
 * bot); a write failure still answers in the language just chosen.
 */
async function resolveLanguage(
  admin: SupabaseClient<Database>,
  request: Request,
  message: InboundMessage,
  waId: string
): Promise<LanguageResolution> {
  const said = languageFromMessage({ interactiveId: interactiveId(message), type: message.type, body: message.body });
  if (said) {
    await saveLang(admin, waId, said.lang, new Date());
    if (said.kind === "resume") {
      const original = await loadPendingInbound(admin, waId, said.pending);
      if (original) {
        return {
          kind: "answered",
          outcome: await replyToInbound(admin, request, original, { replyKey: message.wamid, lang: said.lang }),
        };
      }
      // the held message is gone or is not this number's: re-send the step
    }
    return { kind: "lang", lang: said.lang, eventOverride: { type: "refresh" } };
  }

  const fromSaved = languageFromSaved(await loadLang(admin, waId));
  if (fromSaved.kind === "use") return { kind: "lang", lang: fromSaved.lang };
  return { kind: "answered", outcome: await askLanguage(admin, message, waId) };
}

/**
 * The language question: two buttons, each carrying the id of the message
 * that is being held, so the choice can answer it.
 *
 * An UNKNOWN number's owner notice goes out now, not after the choice — a
 * stranger who never taps must still reach the owner.
 */
async function askLanguage(admin: SupabaseClient<Database>, message: InboundMessage, waId: string): Promise<ReplyOutcome> {
  const shows = await showsForNumber(admin, waId);
  // E17-4: with registration on, an unknown number's notice comes from its
  // tap, not from its writing (see replyUnknownWithOffer)
  if (shows.length === 0 && !isRegistrationEnabled()) await notifyUnknown(admin, message, waId);

  const reply: FlowReply = languageQuestion(message.wamid);
  return await recordAndSend(admin, {
    inboundWamid: message.wamid,
    waId,
    body: reply.body,
    payload: flowPayload(waId, reply),
    kind: "lang",
    type: "interactive",
    meta: { lang_question: true },
  });
}

/**
 * The message a client wrote before choosing a language, re-read from our own
 * log. 🔴 ONLY IF IT IS THEIRS: the wamid came back inside a button id, which
 * is attacker-controllable in principle, so it must be an INBOUND row of THIS
 * number — never somebody else's message answered into this chat.
 */
async function loadPendingInbound(
  admin: SupabaseClient<Database>,
  waId: string,
  wamid: string
): Promise<InboundMessage | null> {
  try {
    const { data, error } = await admin
      .from("wa_messages")
      .select("wamid,wa_id,type,body,payload")
      .eq("wamid", wamid)
      .eq("direction", "in")
      .eq("wa_id", waId)
      .maybeSingle();
    if (error || !data) return null;
    return { wamid: data.wamid, waId, rawFrom: waId, type: data.type ?? "text", body: data.body, raw: data.payload };
  } catch (e) {
    console.error("wa/reply: קריאת ההודעה הממתינה זרקה", e);
    return null;
  }
}
