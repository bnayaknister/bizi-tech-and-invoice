import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseIcsText } from "@/lib/calendar/parse";
import { findLiveSeriesInWindow } from "@/lib/calendar/series";
import { computeAvailability, israelInstant } from "@/lib/calendar/availability";
import { bookingWindowFor } from "@/lib/calendar/bookingWindow";
import { STUDIOS } from "@/lib/calendar/studios";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/calendar/availability — the internal availability check.
// ═══════════════════════════════════════════════════════════════════════════
//
// READ ONLY, and in a stronger sense than usual: this route writes nothing
// anywhere. No table, no `events` row, no calendar. It reads the ICS feed and
// runs the pure computation over it. The ONLY database call is the session
// lookup that authorises the caller.
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

  const url = process.env.STUDIO_ICS_URL;
  if (!url) {
    return NextResponse.json(
      { error: "STUDIO_ICS_URL לא מוגדר" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }

  // The window is computed HERE, from the server's clock, and never accepted
  // from the caller: "not today" and "at most 8 weeks" are owner rules, not
  // client preferences.
  const { fromIsrael, toIsrael } = bookingWindowFor(new Date());

  try {
    // ⚠️ ONE FETCH, DELIBERATELY. The obvious shape here is
    // `fetchAndParseIcs(url)` for the events plus a second fetch for the raw
    // text the series gate needs (EXDATE and RECURRENCE-ID never reach
    // CalendarEvent). Two fetches are two different feeds: the owner moves an
    // event between them and the busy blocks come from one calendar while the
    // series refusals come from another. Nothing would error — the screen would
    // just be quietly incoherent. fetchAndParseIcs is a two-line wrapper over
    // fetch + parseIcsText, so the text is read once and both derive from it.
    const icsText = await fetchIcsText(url);
    const events = parseIcsText(icsText);
    const fetchedAt = new Date().toISOString();

    const from = israelInstant(fromIsrael, 0, 0);
    const to = new Date(israelInstant(toIsrael, 0, 0).getTime() + 86_400_000);
    const liveSeries = findLiveSeriesInWindow(icsText, from, to, STUDIOS);

    const result = computeAvailability(events, liveSeries, STUDIOS, {
      fromIsrael,
      toIsrael,
      openDays: [0, 1, 2, 3, 4], // Sun–Thu; Friday and Saturday are closed
      openHour: 9,
      closeHour: 19,
      slotMinutes: 90,
      slotStepMinutes: step,
    });

    return NextResponse.json(
      {
        fromIsrael,
        toIsrael,
        step,
        fetchedAt,
        rooms: STUDIOS.filter((s) => s.bookable).map((s) => s.canonical),
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

// Read-only fetch of the secret calendar URL, same as fetchAndParseIcs does —
// never writes to it. Kept local so the single-fetch guarantee above is visible
// in one place.
async function fetchIcsText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`קריאת יומן נכשלה: ${res.status}`);
  return res.text();
}
