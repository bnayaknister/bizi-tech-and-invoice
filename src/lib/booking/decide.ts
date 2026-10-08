import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadAvailability } from "./availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES, israelHHMM } from "./publicView";
import { approveErrorMessage, APPROVE_TAKEN_IN_CALENDAR } from "./queue";
import { cleanAliasFor } from "./alias";
import { eventTitle } from "./title";
import { durationFromRange, durationTag, type BookingDuration } from "./duration";
import { STUDIOS } from "@/lib/calendar/studios";
import { israelDateOf } from "@/lib/calendar/availability";
import { calendarEventIdFor } from "@/lib/calendar/write";
import { writeBookingCalendarEvent } from "./writeCalendarEvent";
import { recordBookingNotification, type PendingReason } from "@/lib/whatsapp/notify";

// ═══════════════════════════════════════════════════════════════════════════
// Approving one booking request — THE one implementation, for both callers.
// E9-2.
// ═══════════════════════════════════════════════════════════════════════════
//
// Two callers, and they must never disagree about what an approval is:
//   · POST /api/bookings/[id]/approve        — the owner presses the button
//   · POST /api/book/[token]/request         — the automatic approval
//
// This is the same split, and the same reason, as `writeCalendarEvent.ts`
// (:9-16): a second copy of "check three things, flip the status, write the
// event" is a copy that will eventually check two things. Before this file the
// whole sequence lived INSIDE the owner's route behind a cookie gate, which is
// precisely why the bot could not reuse it (E9 research, 8.10).
//
// ⛔ AND IT STILL CREATES NO PRODUCTION. Productions enter through ONE door —
// the 06:00 sync, over events of that same day. Unchanged, and the full
// reasoning with the sync's own line numbers is in writeCalendarEvent.ts's
// header. An automatic approval three weeks out must not put a production on
// the board three weeks early any more than a manual one must.
//
// ═══ 🔴 THE ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER ═══
//
//   1. three checks   still pending · not in the past · still free IN THE
//                     CALENDAR (a live ICS read — the one thing the database
//                     cannot check for itself)
//   2. FLIP to approved, with `.eq("status","pending")` re-asserted
//   3. write the calendar event, under the DETERMINISTIC id
//   4. on a write failure: revert to pending — but only when the caller asked
//
// The flip comes BEFORE the write, and that is the load-bearing decision.
// 0096's EXCLUDE constraint covers rows `where status = 'approved'` only
// (0096:193-196), so **the flip is what reserves the room**. Writing the event
// first would leave a one-or-two-second window in which two parallel requests
// for the same room both succeed — two different booking ids, therefore two
// different deterministic event ids, therefore TWO REAL EVENTS on a calendar
// that also carries the advertising company's recordings and from which we
// have no delete capability at all (write.ts:24-32). Flipping first makes the
// DATABASE the adjudicator: the second flip is refused with 23P01, which is
// already mapped to a sentence (queue.ts:266-269).
//
// And the revert is safe for one specific reason: `calendarEventIdFor` is a
// PURE function of the booking's own id (write.ts:155). A reverted request
// that is later approved again — by hand, from /bookings — reuses the SAME
// event id, and Google refuses a second event under an id that exists
// (write.ts's 409 branch reads it back as success). So "אסור ליצור כפילות"
// is held by two locks in the database and none in application logic:
//   · the deterministic id  -> one calendar event per booking, ever
//   · the EXCLUDE           -> one approved booking per room-and-slot, ever
//
// ═══ ⚠️ WHY THE MANUAL PATH DOES *NOT* REVERT ═══
// Owner decision 8.10: the automatic path reverts, the manual path is
// unchanged. That asymmetry is a parameter (`revertOnCalendarFailure`) and not
// a branch on "who called me", because the reason is about the human and not
// about the code path: when the owner pressed the button there is a person
// looking at a screen that already says "האישור נשמר, אך היצירה ביומן נכשלה
// — {שגיאה}. אפשר לנסות שוב", with a retry button next to it. Reverting under
// them would delete the thing they are reading. Nobody is looking at the
// automatic path.

// ═══════════════════════════════════════════════════════════════════════════
// PURE — the rules. No client, no clock, no env. This is the half the suite
// can assert with zero database (F19).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The switch. E9-2, owner-approved: the automatic approval runs ONLY when
 * `BOOKING_AUTO_APPROVE` is exactly `"true"`.
 *
 * 🔴 NOTE THE DIRECTION, AND THAT IT IS *NOT* A COPY-PASTE SLIP. The dry-run
 * switches are `!== "false"` (default ON); this one is `=== "true"` (default
 * OFF). Both default to the SAFE side, which is the actual rule (40) — and the
 * safe side is the opposite in the two cases:
 *
 *   dry run default ON   -> an unset variable sends nothing
 *   auto-approve default OFF -> an unset variable writes nothing to the
 *                               calendar, and every request lands in the queue
 *                               exactly as it did before E9-2
 *
 * A `!== "false"` here would mean that any deployment nobody configured — a
 * preview, a fresh environment, a teammate's `.env.local` — starts writing
 * real events to the studio's shared calendar on a stranger's click. That is
 * the failure this direction exists to prevent.
 *
 * Read at CALL time, never cached: same reason as the other two switches.
 */
export function isAutoApproveOn(): boolean {
  return process.env.BOOKING_AUTO_APPROVE === "true";
}

export type SameDayRow = { start_at: string; status: string };

/**
 * How many APPROVED requests this show already has on that Israeli date.
 *
 * ⚠️ THE CALLER SCOPES BY SHOW; this function does not know about shows. The
 * rule is per podcast (owner, rule א), and the query that feeds it filters
 * `show_id` — the same doubled shape as `toApprovedRequests` and
 * `clickableDays`, where SQL narrows the fetch and the pure function is the
 * copy that can be asserted.
 *
 * ⚠️ AND THE COMPARISON IS ON THE ISRAELI DATE, not on a UTC one. A recording
 * at 23:30 Israel time is on a UTC date that is already tomorrow for two or
 * three hours every night; counting in UTC would let a show book twice on one
 * Israeli evening, which is exactly the thing rule א forbids.
 *
 * Only `approved` counts. Two PENDING requests on one day is a normal state
 * (0096's own note: two clients asking for the same slot is routine), and
 * counting them would make the second request block the third while the first
 * two are still undecided.
 */
export function approvedSameDayCount(rows: SameDayRow[] | null | undefined, dateIsrael: string): number {
  let n = 0;
  for (const r of rows ?? []) {
    if (r?.status !== "approved") continue;
    const t = Date.parse(r.start_at);
    if (!Number.isFinite(t)) continue;
    if (israelDateOf(new Date(t)) === dateIsrael) n++;
  }
  return n;
}

export type AutoApproveVerdict =
  | { auto: true }
  | { auto: false; reason: "switch-off" | "second-same-day" };

/**
 * Should this brand-new request approve itself?
 *
 * Rule א (owner, 8.10): ONE slot per day per podcast approves automatically. A
 * second request for the same podcast on the same day stays pending and the
 * owner is told it is a second booking that day.
 *
 * ⚠️ Rule ב is enforced by ABSENCE: there is no weekly limit here, because the
 * owner ruled there is none ("מותר להזמין כמה ימים שונים בשבוע"). A show may
 * take Sunday, Tuesday and Thursday and all three auto-approve. Writing a
 * weekly counter "just in case" would be inventing a rule nobody asked for.
 *
 * ⚠️ AND A LONG RECORDING COUNTS AS THE DAY'S SLOT (rule ג, last sentence) —
 * which needs no code at all: the count is of approved requests on the date,
 * and a 240-minute one is one request.
 */
export function autoApproveVerdict(input: {
  switchOn: boolean;
  approvedSameDay: number;
}): AutoApproveVerdict {
  if (!input.switchOn) return { auto: false, reason: "switch-off" };
  if (input.approvedSameDay >= 1) return { auto: false, reason: "second-same-day" };
  return { auto: true };
}

/** The verdict's refusal mapped to the sentence the owner's notification carries. */
export function pendingReasonFor(reason: "second-same-day"): PendingReason {
  return reason;
}

// ═══════════════════════════════════════════════════════════════════════════
// IMPURE — the shared approval.
// ═══════════════════════════════════════════════════════════════════════════

/** Owner-facing copy, moved here with the logic it belongs to. */
export const APPROVE_COPY = {
  generic: "לא הצלחתי לאשר את הבקשה. נסו שוב.",
  notFound: "הבקשה לא נמצאה",
  notPending: "הבקשה כבר טופלה. רעננו את המסך.",
  past: "המועד של הבקשה כבר עבר. אפשר רק לדחות אותה.",
  feed: "לא הצלחתי לקרוא את היומן, ולכן לא אישרתי. נסו שוב.",
} as const;

export type ApprovedRequestView = {
  id: string;
  showName: string;
  studio: string;
  dateIsrael: string;
  startIsrael: string;
  endIsrael: string;
  startIso: string;
  endIso: string;
  guest: string | null;
  note: string | null;
  title: string;
  /** minutes, derived from the two instants — there is no duration column */
  durationMinutes: number | null;
  durationTag: string | null;
  calendarWriteStatus: "created" | "failed" | null;
  calendarWriteError: string | null;
  calendarHtmlLink: string | null;
  calendarDryRun: boolean;
};

export type ApproveResult =
  | {
      ok: true;
      /**
       * approved                 — flipped and the event exists (or a dry run)
       * approved-calendar-failed — flipped, event failed, row LEFT approved
       *                            (the manual path)
       * reverted-to-pending      — flipped, event failed, row put back
       *                            (the automatic path)
       */
      outcome: "approved" | "approved-calendar-failed" | "reverted-to-pending";
      request: ApprovedRequestView;
    }
  | {
      ok: false;
      code: "not-found" | "not-pending" | "past" | "feed-unreadable" | "taken-in-calendar" | "exclusion" | "failed";
      message: string;
      /** the HTTP status the owner's route has always answered for this case */
      status: number;
    };

export async function approveBookingRequest(
  admin: SupabaseClient<Database>,
  input: {
    id: string;
    /** the owner's profile id, or NULL for an automatic approval — see below */
    actorId: string | null;
    revertOnCalendarFailure: boolean;
    now?: Date;
  }
): Promise<ApproveResult> {
  const now = input.now ?? new Date();

  // name/aliases ONLY — the title is all the show is read for. An approval
  // creates no production, so the seven billing columns this select used to
  // carry are not here (see writeCalendarEvent.ts's header).
  const { data: row, error: readErr } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,note,status,shows(name,aliases)")
    .eq("id", input.id)
    .maybeSingle();
  if (readErr || !row) {
    return { ok: false, code: "not-found", message: APPROVE_COPY.notFound, status: 404 };
  }
  if (row.status !== "pending") {
    return { ok: false, code: "not-pending", message: APPROVE_COPY.notPending, status: 409 };
  }

  const start = new Date(row.start_at);
  const end = new Date(row.end_at);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return { ok: false, code: "failed", message: APPROVE_COPY.generic, status: 500 };
  }
  if (start.getTime() < now.getTime()) {
    return { ok: false, code: "past", message: APPROVE_COPY.past, status: 409 };
  }

  const dateIsrael = israelDateOf(start);
  const startIsrael = israelHHMM(start);
  const endIsrael = israelHHMM(end);

  // ── still free in the calendar? ──────────────────────────────────────────
  // 🔴 A LIVE READ OF THE FEED, EVERY TIME — including on the automatic path,
  // milliseconds after the request route computed availability for the insert.
  // That is not a wasted round trip: `includeApproved: false` asks a DIFFERENT
  // question than the insert did. The insert asked "is this slot offerable";
  // this asks "is this slot still free IN THE CALENDAR", excluding approved
  // requests because this request is itself about to become one (and already
  // is, if a tab double-clicked).
  try {
    const loaded = await loadAvailability(admin, {
      now,
      stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
      // the booking's OWN length, not the default: a 240-minute request must
      // be checked against a 240-minute slot, or the grid it is matched
      // against is not the grid it was booked from.
      durationMinutes: (durationFromRange(row.start_at, row.end_at) ?? undefined) as
        | BookingDuration
        | undefined,
      includeApproved: false,
    });
    const stillFree = loaded.result.free.some(
      (s) => s.room === row.studio && s.dateIsrael === dateIsrael && s.startIsrael === startIsrael
    );
    if (!stillFree) {
      return {
        ok: false,
        code: "taken-in-calendar",
        message: APPROVE_TAKEN_IN_CALENDAR,
        status: 409,
      };
    }
  } catch (e) {
    // A feed we cannot read is a feed we cannot approve against. NOT treated as
    // "free" — that is how a studio gets double-booked.
    console.error("decide: קריאת הזמינות נכשלה", e);
    return { ok: false, code: "feed-unreadable", message: APPROVE_COPY.feed, status: 502 };
  }

  // ── 🔴 THE FLIP. This is what reserves the room — see the header. ─────────
  //
  // ⚠️ `decided_by` IS NULL FOR AN AUTOMATIC APPROVAL, and that null is the
  // RECORD of it being automatic. 0096 made the column nullable and
  // `booking_requests_decided_chk` (0096:171) constrains only `decided_at`, so
  // nothing had to change in the schema for this — and nothing should: a
  // sentinel profile row called "the bot" would be a fake person in an audit
  // trail, and an env var holding a profile id would be a second place for the
  // owner's identity to drift from `profiles`.
  const { error: updErr } = await admin
    .from("booking_requests")
    .update({ status: "approved", decided_at: now.toISOString(), decided_by: input.actorId })
    .eq("id", row.id)
    // re-asserted in the WHERE clause: between the read above and this write
    // another tab — or the owner — may have decided the same row.
    .eq("status", "pending");

  if (updErr) {
    // 23P01 = 0096's EXCLUDE firing. It has just PREVENTED a double-booked
    // studio, which is the whole reason the flip comes first.
    const mapped = approveErrorMessage((updErr as { code?: string }).code);
    if (mapped) return { ok: false, code: "exclusion", message: mapped, status: 409 };
    console.error("decide: העדכון נכשל", updErr);
    return { ok: false, code: "failed", message: APPROVE_COPY.generic, status: 500 };
  }

  const show = row.shows as unknown as { name: string; aliases: string[] | null } | null;
  const alias =
    cleanAliasFor({ name: show?.name ?? "", aliases: show?.aliases ?? [] }, STUDIOS) ?? show?.name ?? "";
  const title = eventTitle({ alias, guest: row.guest, studio: row.studio });

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_request_approved",
    // null for an automatic approval — `events.actor_id` is nullable (0002:306)
    actor_id: input.actorId,
    payload: {
      request_id: row.id,
      studio: row.studio,
      start_at: row.start_at,
      guest: row.guest,
      // 🔵 the one new fact in this audit row: whether a human did it.
      automatic: input.actorId === null,
    },
  });

  // ── the calendar write ───────────────────────────────────────────────────
  let calendarWriteStatus: "created" | "failed" | null = null;
  let calendarWriteError: string | null = null;
  let calendarHtmlLink: string | null = null;
  let calendarDryRun = false;
  let reverted = false;

  if (show) {
    // step א: the deterministic id, saved BEFORE the network call — a timeout
    // inside the write leaves us not knowing whether Google received it, and
    // this row is what lets a retry safely reuse the SAME id.
    const eventId = calendarEventIdFor(row.id);
    await admin.from("booking_requests").update({ calendar_event_id: eventId }).eq("id", row.id);

    const written = await writeBookingCalendarEvent(admin, {
      bookingId: row.id,
      startAtIso: row.start_at,
      endAtIso: row.end_at,
      note: row.note,
      title,
      eventId,
      actorId: input.actorId,
    });
    calendarWriteStatus = written.status;
    calendarWriteError = written.error;
    calendarHtmlLink = written.htmlLink;
    calendarDryRun = written.dryRun;

    // ── 🔴 THE REVERT (owner decision 8.10, automatic path only) ───────────
    if (written.status === "failed" && input.revertOnCalendarFailure) {
      // `decided_at` MUST go back to null with the status, or
      // booking_requests_decided_chk refuses the update — the pairing is the
      // constraint, not a convention.
      const { error: revErr } = await admin
        .from("booking_requests")
        .update({ status: "pending", decided_at: null, decided_by: null })
        .eq("id", row.id)
        // only revert what WE just approved: if a human approved it in the
        // meantime, their decision stands.
        .eq("status", "approved");
      if (revErr) {
        // The row is approved with no calendar event and we could not put it
        // back. Loud, because /bookings will show it as approved-but-failed
        // and the retry button is then the only way through — which is exactly
        // the manual path's behaviour, so nothing is lost but the symmetry.
        console.error("decide: החזרה ל-pending נכשלה", revErr);
      } else {
        reverted = true;
        // ⚠️ `calendar_write_status`/`calendar_write_error` are left as
        // 'failed'/the message ON PURPOSE. The request is pending again, and
        // the screen needs to be able to say WHY it came back.
        await admin.from("events").insert({
          entity_type: "booking_request",
          entity_id: row.id,
          event_type: "booking_auto_approve_reverted",
          actor_id: null,
          payload: { request_id: row.id, error: calendarWriteError },
        });
      }
    }
  }

  const durationMinutes = durationFromRange(row.start_at, row.end_at);

  return {
    ok: true,
    outcome: reverted
      ? "reverted-to-pending"
      : calendarWriteStatus === "failed"
        ? "approved-calendar-failed"
        : "approved",
    request: {
      id: row.id,
      showName: show?.name ?? "",
      studio: row.studio,
      dateIsrael,
      startIsrael,
      endIsrael,
      startIso: row.start_at,
      endIso: row.end_at,
      guest: row.guest,
      note: row.note,
      title,
      durationMinutes,
      durationTag: durationTag(row.start_at, row.end_at),
      calendarWriteStatus,
      calendarWriteError,
      calendarHtmlLink,
      calendarDryRun,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The automatic path, as the public request route calls it.
// ═══════════════════════════════════════════════════════════════════════════

export type AutoApproveOutcome =
  | { approved: true; request: ApprovedRequestView }
  | { approved: false; reason: "switch-off" | "second-same-day" | "slot-taken" | "calendar-failed" | "error" };

/**
 * Decide and, if eligible, approve — then notify.
 *
 * 🔴 IT NEVER THROWS, AND THE PUBLIC ROUTE DEPENDS ON THAT. By the time this
 * is called the client's request row already exists and the client is owed a
 * `200`. A failure here must leave the row exactly as it is — pending, which
 * is a perfectly good state and the one every request had before E9-2 — and
 * must never turn a successful booking into an error on a client's screen.
 *
 * ⚠️ `switch-off` SENDS NO NOTIFICATION. With the switch off the system
 * behaves exactly as it did before this feature: everything queues, and the
 * owner reads /bookings. Messaging him about it would be a notification about
 * nothing having happened.
 */
export async function autoApproveNewRequest(
  admin: SupabaseClient<Database>,
  input: {
    bookingId: string;
    showId: string;
    showName: string;
    dateIsrael: string;
    startIsrael: string;
    endIsrael: string;
    studio: string;
    guest: string | null;
    durationTag: string | null;
    now?: Date;
  }
): Promise<AutoApproveOutcome> {
  try {
    const switchOn = isAutoApproveOn();

    // ── rule א, checked SERVER-SIDE (owner requirement 4) ─────────────────
    // Read even when the switch is off? No — nothing is decided then, and a
    // round trip that cannot change the answer is a round trip on the client's
    // critical path. The switch is checked first for that reason.
    let approvedSameDay = 0;
    if (switchOn) {
      const { data, error } = await admin
        .from("booking_requests")
        .select("start_at,status")
        .eq("show_id", input.showId)
        .eq("status", "approved");
      if (error) {
        // Cannot prove the day is free of an approved recording -> do not
        // approve. The safe direction is the queue.
        console.error("decide/auto: קריאת המאושרות של התוכנית נכשלה", error);
        return { approved: false, reason: "error" };
      }
      approvedSameDay = approvedSameDayCount(data, input.dateIsrael);
    }

    const verdict = autoApproveVerdict({ switchOn, approvedSameDay });

    const facts = {
      showName: input.showName,
      dateIsrael: input.dateIsrael,
      startIsrael: input.startIsrael,
      endIsrael: input.endIsrael,
      studio: input.studio,
      durationTag: input.durationTag,
      guest: input.guest,
    };

    if (!verdict.auto) {
      if (verdict.reason === "second-same-day") {
        await recordBookingNotification(admin, {
          kind: "booking-pending",
          bookingId: input.bookingId,
          facts,
          reason: "second-same-day",
        });
      }
      return { approved: false, reason: verdict.reason };
    }

    const result = await approveBookingRequest(admin, {
      id: input.bookingId,
      // 🔴 null — the record of "automatic". See the note on the flip.
      actorId: null,
      revertOnCalendarFailure: true,
      now: input.now,
    });

    if (!result.ok) {
      // Every refusal here means the row is still pending. The two the owner
      // named get a notification; the rest are logged — `not-pending` and
      // `not-found` on a row we inserted microseconds ago are bugs, not
      // business events, and a message about them would mean nothing to him.
      if (result.code === "taken-in-calendar" || result.code === "exclusion") {
        await recordBookingNotification(admin, {
          kind: "booking-pending",
          bookingId: input.bookingId,
          facts,
          reason: "slot-taken",
        });
        return { approved: false, reason: "slot-taken" };
      }
      console.error("decide/auto: האישור האוטומטי נדחה —", result.code, result.message);
      return { approved: false, reason: "error" };
    }

    if (result.outcome === "reverted-to-pending") {
      await recordBookingNotification(admin, {
        kind: "booking-pending",
        bookingId: input.bookingId,
        facts: { ...facts, durationTag: result.request.durationTag },
        reason: "calendar-failed",
      });
      return { approved: false, reason: "calendar-failed" };
    }

    await recordBookingNotification(admin, {
      kind: "booking-approved",
      bookingId: input.bookingId,
      // the STORED row's own facts, not the caller's copy of them — the same
      // rule BookClient follows about the server's answer being the truth
      facts: {
        showName: result.request.showName || input.showName,
        dateIsrael: result.request.dateIsrael,
        startIsrael: result.request.startIsrael,
        endIsrael: result.request.endIsrael,
        studio: result.request.studio,
        durationTag: result.request.durationTag,
        guest: result.request.guest,
      },
    });
    return { approved: true, request: result.request };
  } catch (e) {
    // The last line of defence for the client's 200.
    console.error("decide/auto: האישור האוטומטי זרק", e);
    return { approved: false, reason: "error" };
  }
}
