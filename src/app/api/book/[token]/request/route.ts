import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveBookingLink } from "@/lib/booking/links";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES } from "@/lib/booking/publicView";
import {
  findDuplicatePending,
  linkRateLimitReached,
  LINK_RATE_WINDOW_MS,
  matchSlot,
  normalizeGuest,
  normalizeNote,
  pendingLimitReached,
  validateStudio,
  type ExistingRequest,
} from "@/lib/booking/request";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/book/[token]/request — PUBLIC. The token is the only credential.
// ═══════════════════════════════════════════════════════════════════════════
//
// The ONLY write a client can cause anywhere in this system, and it inserts
// exactly one row with `status = 'pending'`. It cannot approve, cannot touch
// the calendar, cannot reach any other table. Everything it decides lives in
// @/lib/booking/request as pure functions; this file authenticates the token,
// asks those functions, and forwards their answer.
//
// ⚠️ AVAILABILITY IS RECOMPUTED HERE, SERVER-SIDE, and the client's opinion of
// which slots are free is never consulted. The page fetched its grid some
// seconds or minutes ago; between then and now the owner may have approved
// somebody else. The end time likewise comes from the SLOT and not from the
// body — see matchSlot.
//
// ⚠️ EVERY SENTENCE BELOW IS APPROVED COPY, WORD FOR WORD (owner, 23.9). The
// generic failure is deliberately vague: a stranger holding a link must not be
// able to tell a rate limit from a database error from a bad token, because
// each distinction is a probe that tells them something about the studio.

export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

const COPY = {
  taken: "המועד הזה נתפס בינתיים. בחרו מועד אחר.",
  tooMany: "יש כבר כמה בקשות שממתינות לאישור. נחזור אליכם עליהן קודם.",
  guestTooLong: "שם האורח ארוך מדי.",
  generic: "לא הצלחנו לשלוח את הבקשה. נסו שוב בעוד כמה דקות.",
} as const;

const fail = (message: string, status: number) =>
  NextResponse.json({ error: message }, { status, headers: HEADERS });

export async function POST(request: Request, { params }: { params: { token: string } }) {
  const admin = createTypedAdminClient();

  const link = await resolveBookingLink(admin, params.token);
  // A dead token gets the GENERIC sentence, not a "link expired" one: the page
  // already renders the dead-link screen, and an API that distinguishes states
  // is a probe. Same reasoning as resolveBookingLink's single failure value.
  if (link.status !== "ok") return fail(COPY.generic, 404);

  const body = (await request.json().catch(() => ({}))) as {
    studio?: unknown;
    startIsrael?: unknown;
    endIsrael?: unknown;
    guest?: unknown;
    note?: unknown;
  };

  const studio = validateStudio(body.studio);
  if (!studio) return fail(COPY.generic, 400);

  // The guest is the ONE field with its own sentence, because it is the one a
  // client can get wrong by typing: everything else on this screen is chosen
  // from a list. A generic failure there would leave them retrying a form that
  // can never succeed.
  const guest = normalizeGuest(body.guest);
  if (!guest.ok) return fail(COPY.guestTooLong, 400);

  const note = normalizeNote(body.note);
  if (!note.ok) return fail(COPY.generic, 400);

  let free;
  try {
    const loaded = await loadAvailability(admin, { now: new Date(), stepMinutes: PUBLIC_SLOT_STEP_MINUTES });
    free = loaded.result.free;
  } catch (e) {
    // Logged, never returned — the ICS URL is a secret. And NOT treated as "the
    // slot is free": a feed we cannot read is a feed we cannot book against.
    console.error("book/request: חישוב הזמינות נכשל", e);
    return fail(COPY.generic, 502);
  }

  const match = matchSlot(free, { studio, startIsrael: body.startIsrael, endIsrael: body.endIsrael });
  if (!match.ok) {
    // "Taken in the meantime" covers every shape of no: a slot that really was
    // just taken, a malformed time, a day outside the window, an end that
    // disagrees. They are one thing from where the client sits — this moment is
    // not bookable — and the screen's next action is identical for all of them.
    return fail(COPY.taken, 409);
  }
  const slot = match.slot;

  // ── the brakes, all read in ONE query per axis, before any write ───────────
  const { data: showRows, error: showErr } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,status,created_at")
    .eq("show_id", link.link.show_id)
    .eq("status", "pending");
  if (showErr) {
    console.error("book/request: קריאת הבקשות הממתינות נכשלה", showErr);
    return fail(COPY.generic, 500);
  }
  const pendingForShow = (showRows ?? []) as ExistingRequest[];

  // ⚠️ THE DUPLICATE CHECK COMES BEFORE THE LIMITS, and the order is deliberate.
  // A double-tapped phone, or a client reopening the link on the request they
  // already sent, is NOT a fourth request — it is the one they can already see.
  // Checking the limit first would answer "you have too many requests" to
  // somebody whose second tap created nothing, which is both false and
  // unfixable from their side. Nothing is inserted on this path, so no limit is
  // being bypassed: returning the existing row is the honest answer.
  const duplicate = findDuplicatePending(pendingForShow, { studio, start: slot.start });
  if (duplicate) {
    return NextResponse.json(
      {
        ok: true,
        duplicate: true,
        request: {
          id: duplicate.id,
          studio,
          dateIsrael: slot.dateIsrael,
          startIsrael: slot.startIsrael,
          endIsrael: slot.endIsrael,
          guest: guest.value,
          status: "pending",
        },
      },
      { headers: HEADERS }
    );
  }

  if (pendingLimitReached(pendingForShow)) return fail(COPY.tooMany, 429);

  const since = new Date(Date.now() - LINK_RATE_WINDOW_MS).toISOString();
  const { data: linkRows, error: linkErr } = await admin
    .from("booking_requests")
    .select("id,studio,start_at,status,created_at")
    .eq("link_id", link.link.id)
    .gte("created_at", since);
  if (linkErr) {
    console.error("book/request: קריאת קצב הקישור נכשלה", linkErr);
    return fail(COPY.generic, 500);
  }
  // The window is applied in SQL AND re-applied by the pure function. The same
  // doubled guard as clickableDays, and for the same reason: the assertable
  // copy is the one that decides, and a hand-built row set cannot slip past it.
  if (linkRateLimitReached((linkRows ?? []) as ExistingRequest[], new Date())) {
    return fail(COPY.tooMany, 429);
  }

  // ── the one write ─────────────────────────────────────────────────────────
  const { data: inserted, error: insErr } = await admin
    .from("booking_requests")
    .insert({
      show_id: link.link.show_id,
      link_id: link.link.id,
      studio,
      start_at: slot.start.toISOString(),
      // from the SLOT, never from the body
      end_at: slot.end.toISOString(),
      guest: guest.value,
      note: note.value,
      // `status` is the column DEFAULT ('pending'), and decided_at stays null —
      // 0096's booking_requests_decided_chk enforces that pairing.
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    console.error("book/request: ההכנסה נכשלה", insErr);
    return fail(COPY.generic, 500);
  }

  return NextResponse.json(
    {
      ok: true,
      duplicate: false,
      request: {
        id: inserted.id,
        studio,
        dateIsrael: slot.dateIsrael,
        startIsrael: slot.startIsrael,
        endIsrael: slot.endIsrael,
        guest: guest.value,
        status: "pending",
      },
    },
    { headers: HEADERS }
  );
}
