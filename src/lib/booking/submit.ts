import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { loadAvailability } from "./availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES } from "./publicView";
import { validateDuration, durationTag } from "./duration";
import { autoApproveNewRequest } from "./decide";
import {
  duplicateWrite,
  findDuplicatePending,
  linkRateLimitReached,
  LINK_RATE_WINDOW_MS,
  matchSlot,
  normalizeGuest,
  normalizeNote,
  pendingLimitReached,
  validateStudio,
  type ExistingRequest,
} from "./request";

// ═══════════════════════════════════════════════════════════════════════════
// Submit one booking request — THE ONE PATH, for every channel.
// ═══════════════════════════════════════════════════════════════════════════
//
// Until E9-4 this body lived inside POST /api/book/[token]/request. The bot's
// booking conversation must go through exactly the same steps (owner decision
// 11.10, rule 5: same validation, same "one slot a day per podcast", same
// BOOKING_AUTO_APPROVE, same notifications, same calendar write through
// decide.ts — zero duplicated logic), so the body moved here VERBATIM and both
// callers now call it:
//   · the public route, after resolving the token to a link
//   · the bot, after resolving the show to its live link (ensureBookingLink)
//
// 🔴 THE LINK IS STILL REQUIRED. `booking_requests.link_id` is NOT NULL
// (0096), and the per-link rate brake (ten a day) counts the bot's requests
// against the same link as the screen's — a number that hammers the bot is the
// same leak as a link that is hammered, and it gets the same brake.
//
// ⚠️ EVERY INPUT IS TAKEN RAW (`unknown`) AND VALIDATED HERE, in the order the
// route always used. The bot sends values it chose from its own lists, so it
// could skip validation — and must not: "the same path" means the same checks,
// and a bot bug must be refused exactly like a hand-crafted request would be.
//
// It never throws for a business outcome; each refusal is a `code`, and the
// route maps codes to its approved sentences and HTTP statuses.

export type SubmitInput = {
  showId: string;
  linkId: string;
  showName: string;
  studio: unknown;
  /** "YYYY-MM-DD HH:MM", Israel wall clock */
  startIsrael: unknown;
  /** optional; when given it is CHECKED against the slot, never trusted */
  endIsrael?: unknown;
  guest: unknown;
  note: unknown;
  durationMinutes: unknown;
  now?: Date;
};

export type SubmittedRequest = {
  id: string;
  studio: string;
  dateIsrael: string;
  startIsrael: string;
  endIsrael: string;
  guest: string | null;
  status: "approved" | "pending";
};

export type SubmitResult =
  | { ok: true; duplicate: boolean; request: SubmittedRequest }
  | { ok: false; code: "bad-input" | "guest-too-long" | "feed-failed" | "taken" | "too-many" | "error" };

export async function submitBookingRequest(
  admin: SupabaseClient<Database>,
  input: SubmitInput
): Promise<SubmitResult> {
  const now = input.now ?? new Date();

  const studio = validateStudio(input.studio);
  if (!studio) return { ok: false, code: "bad-input" };

  // The chosen length (E9-2, rule ג). Absent = 90, which is what every
  // request meant before the picker existed; a stated-but-invalid value is a
  // refusal, because our own screens cannot produce one.
  const duration = validateDuration(input.durationMinutes);
  if (duration === null) return { ok: false, code: "bad-input" };

  // The guest is the ONE field with its own sentence, because it is the one a
  // client can get wrong by typing.
  const guest = normalizeGuest(input.guest);
  if (!guest.ok) return { ok: false, code: "guest-too-long" };

  const note = normalizeNote(input.note);
  if (!note.ok) return { ok: false, code: "bad-input" };

  let free;
  try {
    // 🔴 FOR THE CHOSEN LENGTH. `matchSlot` below takes the END from the slot
    // it finds, so this single parameter is what makes a 240-minute request
    // store a 240-minute range — and what makes a start that would run past
    // 19:00 simply not be in `free` to match.
    const loaded = await loadAvailability(admin, {
      now,
      stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
      durationMinutes: duration,
    });
    free = loaded.result.free;
  } catch (e) {
    // Logged, never returned — the ICS URL is a secret. And NOT treated as "the
    // slot is free": a feed we cannot read is a feed we cannot book against.
    console.error("booking/submit: חישוב הזמינות נכשל", e);
    return { ok: false, code: "feed-failed" };
  }

  const match = matchSlot(free, { studio, startIsrael: input.startIsrael, endIsrael: input.endIsrael });
  // "Taken in the meantime" covers every shape of no: a slot that really was
  // just taken, a malformed time, a day outside the window, an end that
  // disagrees. They are one thing from where the client sits.
  if (!match.ok) return { ok: false, code: "taken" };
  const slot = match.slot;

  // ── the brakes, all read in ONE query per axis, before any write ───────────
  const { data: showRows, error: showErr } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,status,created_at")
    .eq("show_id", input.showId)
    .eq("status", "pending");
  if (showErr) {
    console.error("booking/submit: קריאת הבקשות הממתינות נכשלה", showErr);
    return { ok: false, code: "error" };
  }
  const pendingForShow: ExistingRequest[] = showRows ?? [];

  // ⚠️ THE DUPLICATE CHECK COMES BEFORE THE LIMITS, and the order is deliberate.
  // A double-tapped phone — or a double-tapped "✅ לקבוע" in the bot — is NOT a
  // fourth request, it is the one already sent. Nothing is inserted on this
  // path, so no limit is being bypassed.
  const duplicate = findDuplicatePending(pendingForShow, { studio, start: slot.start });
  if (duplicate) {
    // ⚠️ A RE-SEND IS AN EDIT (bug found by hand 24.9) — see duplicateWrite.
    const write = duplicateWrite(duplicate, { guest: guest.value, note: note.value });
    const { error: updErr } = await admin
      .from("booking_requests")
      .update({ guest: write.guest, note: write.note })
      .eq("id", write.id)
      // re-asserted in the WHERE clause: an owner who decided it in between
      // must not have their decision quietly overwritten by a retry.
      .eq("status", "pending");
    if (updErr) {
      console.error("booking/submit: עדכון בקשה כפולה נכשל", updErr);
      return { ok: false, code: "error" };
    }
    return {
      ok: true,
      duplicate: true,
      request: {
        id: duplicate.id,
        studio,
        dateIsrael: slot.dateIsrael,
        startIsrael: slot.startIsrael,
        endIsrael: slot.endIsrael,
        // the value now IN the row
        guest: write.guest,
        status: "pending",
      },
    };
  }

  if (pendingLimitReached(pendingForShow)) return { ok: false, code: "too-many" };

  const since = new Date(now.getTime() - LINK_RATE_WINDOW_MS).toISOString();
  const { data: linkRows, error: linkErr } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,status,created_at")
    .eq("link_id", input.linkId)
    .gte("created_at", since);
  if (linkErr) {
    console.error("booking/submit: קריאת קצב הקישור נכשלה", linkErr);
    return { ok: false, code: "error" };
  }
  // The window is applied in SQL AND re-applied by the pure function — the
  // assertable copy is the one that decides.
  if (linkRateLimitReached(linkRows ?? [], now)) return { ok: false, code: "too-many" };

  // ── the one write ─────────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from("booking_requests")
    .insert({
      show_id: input.showId,
      link_id: input.linkId,
      studio,
      start_at: slot.start.toISOString(),
      // from the SLOT, never from the caller
      end_at: slot.end.toISOString(),
      guest: guest.value,
      note: note.value,
      // `status` is the column DEFAULT ('pending'); decided_at stays null —
      // 0096's booking_requests_decided_chk enforces that pairing.
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    console.error("booking/submit: ההכנסה נכשלה", insErr);
    return { ok: false, code: "error" };
  }

  // ═══ THE AUTOMATIC APPROVAL (E9-2, owner decision 8.10) ═══
  // Every decision is in @/lib/booking/decide, which the owner's own approve
  // button calls too. It cannot throw and cannot fail this request: every
  // refusal inside leaves the row `pending`. It runs AFTER the brakes — the
  // duplicate branch above returned early, so one row means one approval.
  const auto = await autoApproveNewRequest(admin, {
    bookingId: inserted.id,
    showId: input.showId,
    showName: input.showName,
    dateIsrael: slot.dateIsrael,
    startIsrael: slot.startIsrael,
    endIsrael: slot.endIsrael,
    studio,
    guest: guest.value,
    durationTag: durationTag(slot.start.toISOString(), slot.end.toISOString()),
  });

  return {
    ok: true,
    duplicate: false,
    request: {
      id: inserted.id,
      studio,
      dateIsrael: slot.dateIsrael,
      startIsrael: slot.startIsrael,
      endIsrael: slot.endIsrael,
      guest: guest.value,
      // 🔴 THE REAL STATUS — an approved booking that reports "pending" would
      // tell the one person who needs to know the opposite of the database.
      status: auto.approved ? "approved" : "pending",
    },
  };
}
