import { NextResponse } from "next/server";
import { createClient, createTypedClient } from "@/lib/supabase/server";
import { loadAvailability } from "@/lib/booking/availabilityServer";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/calendar/availability — the internal availability check.
// ═══════════════════════════════════════════════════════════════════════════
//
// READ ONLY, and in a stronger sense than usual: this route writes nothing
// anywhere. No table, no `events` row, no calendar. It reads the ICS feed and
// the APPROVED booking requests, and runs the pure computation over both.
//
// ⚠️ Approved requests were added 23.9 (3ב) and they change what this route
// MEANS: the owner's preview is no longer "what the calendar says", it is "what
// a client would be offered". A request the owner approved this morning closes
// its slot here immediately, before the event has been pasted into the
// calendar — which is 0096's rule, and the reason the preview is trustworthy
// at all. Pending requests do not block; see computeAvailability.
//
// Owner-only, using the gate that already exists — `profiles.role === "owner"`,
// the same check as /api/settings/calendar-sync and /api/settings/accountant-email.
// No new role, no new column. Stage 2 is explicitly "the owner verifies the
// numbers before a client ever sees them", so the narrowest existing gate is
// the right one; the public client route is stage 3 and is not this.
//
// ⚠️ THERE IS NO FALLBACK ON A FEED FAILURE, ON PURPOSE. A stale answer here is
// worse than no answer: availability that was true an hour ago is what
// double-books a studio. A feed error returns an error and NOTHING ELSE — no
// partial list, no cached slots, no empty array that a screen would render as
// "everything is free".

export const dynamic = "force-dynamic";

const ALLOWED_STEPS = [30, 90] as const;

export async function GET(request: Request) {
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

  // step is the owner's open question (30 vs 90), so it is a parameter — but a
  // CLOSED one. Anything else is a caller bug and must not be silently coerced
  // into a default: a grid the screen did not ask for would be read as fact.
  const raw = new URL(request.url).searchParams.get("step");
  const step = raw === null ? 30 : Number(raw);
  if (!ALLOWED_STEPS.includes(step as (typeof ALLOWED_STEPS)[number])) {
    return NextResponse.json(
      { error: "step חייב להיות 30 או 90" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    // ⚠️ THE SAME ASSEMBLY THE PUBLIC ROUTE USES — one feed read, one query for
    // approved requests, one computation. The owner's preview and the client's
    // screen must never disagree about what is free, and the only way to
    // guarantee that is for neither to own the assembly.
    const loaded = await loadAvailability(createTypedClient(), { now: new Date(), stepMinutes: step });
    const fetchedAt = new Date().toISOString();
    const result = loaded.result;

    return NextResponse.json(
      {
        fromIsrael: loaded.fromIsrael,
        toIsrael: loaded.toIsrael,
        step,
        fetchedAt,
        rooms: loaded.rooms,
        // Date objects would serialise to ISO strings anyway; the Israeli
        // wall-clock strings are what the screen shows, so they are what
        // crosses the wire. No timezone maths in the browser.
        free: result.free.map((s) => ({
          room: s.room,
          dateIsrael: s.dateIsrael,
          startIsrael: s.startIsrael,
          endIsrael: s.endIsrael,
        })),
        unknownRoomBlocks: result.unknownRoomBlocks,
        roomsRefused: result.roomsRefused,
        skipped: result.skipped,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    // The message is logged, not returned: the ICS URL is a secret and a fetch
    // failure loves to quote it back.
    console.error("availability: קריאת היומן נכשלה", e);
    return NextResponse.json(
      { error: "לא הצלחתי לקרוא את היומן" },
      { status: 502, headers: { "Cache-Control": "no-store" } }
    );
  }
}
