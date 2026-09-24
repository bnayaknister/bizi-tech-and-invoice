import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { PUBLIC_SLOT_STEP_MINUTES, israelHHMM } from "@/lib/booking/publicView";
import { approveErrorMessage, APPROVE_TAKEN_IN_CALENDAR } from "@/lib/booking/queue";
import { cleanAliasFor } from "@/lib/booking/alias";
import { eventTitle } from "@/lib/booking/title";
import { STUDIOS } from "@/lib/calendar/studios";
import { israelDateOf } from "@/lib/calendar/availability";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/approve — the owner approves one request.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, through the gate that already exists. Writes exactly three
// columns on exactly one row and touches nothing else: no calendar, no
// production, no document. The calendar event is still the owner's paste
// (0096), and this route's real output is the TITLE they paste.
//
// ⚠️ THREE CHECKS BEFORE THE WRITE, and each one exists because the screen the
// owner clicked on was rendered some time ago:
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

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_request_approved",
    actor_id: user.id,
    payload: { request_id: row.id, studio: row.studio, start_at: row.start_at, guest: row.guest },
  });

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
        title: eventTitle({ alias, guest: row.guest, studio: row.studio }),
      },
    },
    { headers: NO_STORE }
  );
}
