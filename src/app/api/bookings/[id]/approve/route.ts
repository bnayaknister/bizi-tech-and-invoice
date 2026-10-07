import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient, createAdminClient } from "@/lib/supabase/admin";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES, israelHHMM } from "@/lib/booking/publicView";
import { approveErrorMessage, APPROVE_TAKEN_IN_CALENDAR } from "@/lib/booking/queue";
import { cleanAliasFor } from "@/lib/booking/alias";
import { eventTitle } from "@/lib/booking/title";
import { STUDIOS } from "@/lib/calendar/studios";
import { israelDateOf } from "@/lib/calendar/availability";
import { calendarEventIdFor } from "@/lib/calendar/write";
import { writeBookingCalendarEvent } from "@/lib/booking/writeCalendarEvent";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/approve — the owner approves one request.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, through the gate that already exists.
//
// ═══ UPDATED, feat/calendar-write (7.10, E8) ═══
// Writing exactly three columns was the WHOLE route until now — this comment
// is corrected rather than left to describe a version of the route that no
// longer exists. The owner still pastes nothing: the route now writes the
// event to the shared Google Calendar itself (lib/calendar/write.ts).
// `eventTitle`/`cleanAliasFor` below are UNCHANGED from before this feature —
// the title the calendar event gets is the exact same string the owner used
// to paste by hand.
//
// ⛔ AND IT CREATES NO PRODUCTION (owner correction, 7.10). An earlier draft
// of this route did, on the strength of a "מתווה א׳" decision that was never
// actually made — it was an unapproved recommendation. Productions enter
// through ONE door: the morning sync, over events of that same day. A
// booking approved three weeks out would otherwise appear on the
// productions board three weeks early, times every future booking. The full
// reasoning, with the sync's own line numbers, is in
// lib/booking/writeCalendarEvent.ts's header.
//
// 🔴 A calendar-write failure does NOT fail the approval. The three-column
// write above still happens and is kept; the calendar write is reported
// separately (`calendar_write_status`/`calendar_write_error`), with
// POST /api/bookings/[id]/retry-calendar as the way to try again — see that
// route for why "the approval reverts" is not an option once it is recorded.
//
// ⚠️ THREE CHECKS BEFORE THE *APPROVAL* WRITE, and each one exists because the
// screen the owner clicked on was rendered some time ago:
//
//   still pending      they may have declined it in another tab, or the client
//                      may have... no: a client cannot change a status. But a
//                      second click on the same button can, and re-approving
//                      an approved row would move decided_at and lose when the
//                      decision was actually made.
//   not in the past    approving a slot that has already gone produces a
//                      calendar event in the past and a production for a
//                      recording that never happened.
//   free in the CALENDAR  the owner may have booked that room by hand since.
//                      This is the one thing the database cannot check for
//                      itself, which is why it is checked here — see the note
//                      on loadAvailability's includeApproved.
//
// The fourth guarantee — that two approved requests never overlap in one room —
// is 0096's EXCLUDE constraint, deliberately NOT re-implemented here. Two
// approvals in two tabs would both read "free" and both write; only the
// database can refuse the second one. 23P01 is mapped to a sentence.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const GENERIC = "לא הצלחתי לאשר את הבקשה. נסו שוב.";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role,approved").eq("id", user.id).single();
  if (!profile?.approved) return NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 });
  if (profile.role !== "owner") {
    return NextResponse.json({ error: "המסך הזה פתוח לבעלים בלבד" }, { status: 403 });
  }

  const admin = createTypedAdminClient();

  // name/aliases ONLY — the title is all the show is read for. The seven
  // extra billing columns this select carried briefly (client_id,
  // billing_mode, default_studio, camera_count, default_editor_id,
  // has_episode, reels_count) existed to create a production here; an
  // approval does not create one (owner correction 7.10 — see
  // lib/booking/writeCalendarEvent.ts's header), so they are gone.
  const { data: row, error: readErr } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,note,status,shows(name,aliases)")
    .eq("id", params.id)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404, headers: NO_STORE });
  }
  if (row.status !== "pending") {
    return NextResponse.json(
      { error: "הבקשה כבר טופלה. רעננו את המסך." },
      { status: 409, headers: NO_STORE }
    );
  }

  const start = new Date(row.start_at);
  const end = new Date(row.end_at);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }
  if (start.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "המועד של הבקשה כבר עבר. אפשר רק לדחות אותה." },
      { status: 409, headers: NO_STORE }
    );
  }

  const dateIsrael = israelDateOf(start);
  const startIsrael = israelHHMM(start);
  const endIsrael = israelHHMM(end);

  // ── still free in the calendar? ──────────────────────────────────────────
  try {
    const loaded = await loadAvailability(admin, {
      now: new Date(),
      stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
      // calendar ONLY — this request is itself an approved-request-to-be
      includeApproved: false,
    });
    const stillFree = loaded.result.free.some(
      (s) => s.room === row.studio && s.dateIsrael === dateIsrael && s.startIsrael === startIsrael
    );
    if (!stillFree) {
      return NextResponse.json({ error: APPROVE_TAKEN_IN_CALENDAR }, { status: 409, headers: NO_STORE });
    }
  } catch (e) {
    // A feed we cannot read is a feed we cannot approve against. NOT treated as
    // "free" — that is how a studio gets double-booked.
    console.error("bookings/approve: קריאת הזמינות נכשלה", e);
    return NextResponse.json(
      { error: "לא הצלחתי לקרוא את היומן, ולכן לא אישרתי. נסו שוב." },
      { status: 502, headers: NO_STORE }
    );
  }

  // ── the write ────────────────────────────────────────────────────────────
  const { error: updErr } = await admin
    .from("booking_requests")
    .update({ status: "approved", decided_at: new Date().toISOString(), decided_by: user.id })
    .eq("id", row.id)
    // ⚠️ re-asserted in the WHERE clause. Between the read above and this write
    // another tab may have decided the same row; `.eq("status","pending")` makes
    // the database refuse it rather than us overwriting a decision.
    .eq("status", "pending");

  if (updErr) {
    // 23P01 = 0096's EXCLUDE firing. It has just PREVENTED a double-booked
    // studio, so the owner gets a sentence about what happened.
    const mapped = approveErrorMessage((updErr as { code?: string }).code);
    if (mapped) return NextResponse.json({ error: mapped }, { status: 409, headers: NO_STORE });
    console.error("bookings/approve: העדכון נכשל", updErr);
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }

  const show = row.shows as unknown as { name: string; aliases: string[] | null } | null;
  // The alias gate ran when the link was created, so a show without a clean
  // alias has no link and therefore no requests. Falling back to the raw name
  // keeps this from throwing if that ever stops being true — the owner can see
  // and edit the title before pasting it, which is the safety net.
  const alias = cleanAliasFor({ name: show?.name ?? "", aliases: show?.aliases ?? [] }, STUDIOS) ?? show?.name ?? "";
  const title = eventTitle({ alias, guest: row.guest, studio: row.studio });

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_request_approved",
    actor_id: user.id,
    payload: { request_id: row.id, studio: row.studio, start_at: row.start_at, guest: row.guest },
  });

  // ═══════════════════════════════════════════════════════════════════════
  // THE CALENDAR WRITE (feat/calendar-write, 7.10, E8)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // 🔴 THE EVENT, AND NOTHING ELSE. No production is created here: that
  // happens on the recording morning, in the sync, from this very event —
  // one door, unchanged since 2026-07-17 (owner correction 7.10; the full
  // reasoning, with the sync's own line numbers, is in
  // lib/booking/writeCalendarEvent.ts's header).
  //
  // ⚠️ `untyped` is `createAdminClient()`, scoped to the 0099 columns, so
  // the shared write function can take a plain `SupabaseClient` either
  // factory satisfies. Everything ELSE in this route stays on the typed
  // client above, unchanged.
  const untyped = createAdminClient();

  let calendarWriteStatus: "created" | "failed" | null = null;
  let calendarWriteError: string | null = null;
  let calendarHtmlLink: string | null = null;
  let calendarDryRun = false;

  if (show) {
    // step א: the deterministic id, saved BEFORE the network call. A timeout
    // inside writeBookingCalendarEvent leaves us not knowing whether Google
    // received the request; this row is what lets a retry safely reuse the
    // SAME id (write.ts's 409 branch), rather than risk a second event.
    const eventId = calendarEventIdFor(row.id);
    await untyped.from("booking_requests").update({ calendar_event_id: eventId }).eq("id", row.id);

    // the write, the columns it settles, and the audit event. Shared with
    // retry-calendar/route.ts so a retry is not a second, drifting copy.
    const written = await writeBookingCalendarEvent(untyped, {
      bookingId: row.id,
      startAtIso: row.start_at,
      endAtIso: row.end_at,
      note: row.note,
      title,
      eventId,
      actorId: user.id,
    });
    calendarWriteStatus = written.status;
    calendarWriteError = written.error;
    calendarHtmlLink = written.htmlLink;
    calendarDryRun = written.dryRun;
  }

  return NextResponse.json(
    {
      ok: true,
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
        // built on the SERVER from the stored row — the screen never assembles
        // a title out of its own state
        title,
        // the four UI states (see BookingsBody.tsx): created / failed /
        // dry-run / "not yet attempted" (show was null — cannot happen in
        // practice, since a request with no show has no alias and so no link,
        // but the type is nullable and this keeps the response honest about it)
        calendarWriteStatus,
        calendarWriteError,
        calendarHtmlLink,
        calendarDryRun,
      },
    },
    { headers: NO_STORE }
  );
}
