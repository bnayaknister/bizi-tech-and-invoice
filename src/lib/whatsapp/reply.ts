import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { isWhatsappDryRun, listPayload, sendWhatsapp, textPayload } from "./client";
import { recordBookingNotification } from "./notify";
import { bookingUrlForShow, showsForNumber, type ContactShow } from "@/lib/booking/contacts";
import type { InboundMessage } from "./webhook";

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
// and it does not answer questions. Any message from a known number gets the
// same answer — your link, or your list — because the owner's flow puts slot
// selection on the visual screen. Natural-language understanding is E4 (the AI
// agent), deliberately not here.
//
// ⛔ AND CANCELLATIONS ARE NOT HANDLED YET (owner: a later stage). A client who
// writes "לבטל" gets the ordinary link reply. That is a known gap, stated
// rather than half-built: a cancellation path that notifies nobody is worse
// than one that does not exist.

/** Approved copy (owner, 8.10), word for word. */
export const NEUTRAL_REPLY = "היי! קיבלנו את ההודעה, נחזור אליך בהקדם 🙂";

/** Approved copy — the one-podcast reply. */
export function linkReplyBody(showName: string, url: string): string {
  return `היי! לקביעת הקלטה ל${showName} — בחרו מועד כאן:\n${url}`;
}

/** The list message's own three strings. */
export const LIST_COPY = {
  body: "היי! לאיזה פודקאסט לקבוע הקלטה?",
  button: "בחירת פודקאסט",
  section: "הפודקאסטים שלכם",
} as const;

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

export type ReplyOutcome =
  | { sent: true; kind: ReplyPlan["kind"] }
  | { sent: false; reason: "duplicate" | "dry-run" | "no-url" | "send-failed" | "error"; kind: ReplyPlan["kind"] };

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
    kind: ReplyPlan["kind"];
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
            type: input.kind === "list" ? "interactive" : "text",
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
  message: InboundMessage
): Promise<ReplyOutcome> {
  try {
    const waId = message.waId;
    if (!waId) {
      // A sender we could not normalise cannot be matched against
      // `booking_contacts` (whose `wa_id` is canonical by CHECK), so it is
      // treated as unknown — which is the honest answer, not a failure.
      return await replyUnknown(admin, message, "unknown");
    }

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

    const plan = planReply(shows, picked);

    if (plan.kind === "neutral") return await replyUnknown(admin, message, waId);

    if (plan.kind === "list") {
      return await recordAndSend(admin, {
        inboundWamid: message.wamid,
        waId,
        body: LIST_COPY.body,
        payload: listPayload({
          to: waId,
          body: LIST_COPY.body,
          button: LIST_COPY.button,
          sectionTitle: LIST_COPY.section,
          rows: listRowsFor(plan.shows),
        }),
        kind: "list",
        meta: { show_ids: plan.shows.map((s) => s.showId) },
      });
    }

    const url = await bookingUrlForShow(admin, request, plan.show.showId);
    if (!url.ok) {
      // 🔴 NO LINK, AND THE CLIENT IS NOT LEFT IN SILENCE. The alias gate is
      // the realistic case (a show whose every name contains a room name), and
      // it needs a human: the owner adds an alias. The client gets the neutral
      // sentence, the owner gets told. Inventing a link is not an option —
      // see bookingUrlForShow's note on why the gate exists.
      console.error("wa/reply: אין קישור הזמנה לתוכנית", plan.show.showId, url.reason);
      await recordBookingNotification(admin, {
        kind: "unknown-contact",
        subjectId: `no-link:${plan.show.showId}`,
        waId,
        excerpt: `אין קישור הזמנה לתוכנית ${plan.show.showName} (${url.reason}). הוסיפו לה שם חלופי.`,
        onlyOwner: true,
      });
      const neutral = await recordAndSend(admin, {
        inboundWamid: message.wamid,
        waId,
        body: NEUTRAL_REPLY,
        payload: textPayload({ to: waId, body: NEUTRAL_REPLY }),
        kind: "link",
        meta: { no_link_for_show: plan.show.showId, reason: url.reason },
      });
      return neutral.sent ? { sent: false, reason: "no-url", kind: "link" } : neutral;
    }

    const body = linkReplyBody(plan.show.showName, url.url);
    return await recordAndSend(admin, {
      inboundWamid: message.wamid,
      waId,
      body,
      payload: textPayload({ to: waId, body }),
      kind: "link",
      meta: { show_id: plan.show.showId },
    });
  } catch (e) {
    console.error("wa/reply: התשובה זרקה", e);
    return { sent: false, reason: "error", kind: "neutral" };
  }
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
  waId: string
): Promise<ReplyOutcome> {
  // the owner's notice first: if the reply fails, the owner should still hear
  // about the message. Its own deterministic wamid is keyed on the INBOUND
  // message, so one notice per message and no storm from a re-delivery.
  await recordBookingNotification(admin, {
    kind: "unknown-contact",
    subjectId: message.wamid,
    waId: waId === "unknown" ? message.rawFrom || "unknown" : waId,
    excerpt: message.body ?? "",
    onlyOwner: true,
  });

  if (waId === "unknown") {
    // Nowhere to send a reply to — the sender did not normalise. The owner's
    // notice above is the whole outcome.
    return { sent: false, reason: "no-url", kind: "neutral" };
  }

  return await recordAndSend(admin, {
    inboundWamid: message.wamid,
    waId,
    body: NEUTRAL_REPLY,
    payload: textPayload({ to: waId, body: NEUTRAL_REPLY }),
    kind: "neutral",
    meta: { unknown_contact: true },
  });
}
