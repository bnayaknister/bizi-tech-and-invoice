import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveBookingLink } from "@/lib/booking/links";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { toPublicAvailability, PUBLIC_SLOT_STEP_MINUTES } from "@/lib/booking/publicView";
import { validateDuration } from "@/lib/booking/duration";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/book/[token]/availability — PUBLIC. The token is the only credential.
// ═══════════════════════════════════════════════════════════════════════════
//
// Read-only: no table is written, no `events` row, nothing. It runs on the
// service role because the caller has no account at all — the same shape as the
// /r/ review endpoints, and the reason `booking_links.token` is unreadable from
// any session role.
//
// 🔴 THE STEP IS NOT A PARAMETER HERE. The internal route accepts 30 or 90
// because the owner is still choosing between the two grids; a client is not
// choosing anything, and an endpoint a stranger can call should have one shape
// and one cost. It is PUBLIC_SLOT_STEP_MINUTES, defined once in
// @/lib/booking/publicView and imported — not re-typed as a literal here.
//
// 🔴 WHAT COMES BACK IS BUILT BY `toPublicAvailability`, NOT ASSEMBLED HERE.
// The internal payload carries `unknownRoomBlocks` and `skipped`, and both
// carry the TITLE and UID of real calendar events. Forwarding them would hand
// every link-holder a readable index of the studio's bookings — other clients'
// names included. The projection is a named function with a suite that counts
// those strings at zero; an object literal in a route is not.
//
// ⚠️ NO FALLBACK ON A FEED FAILURE — 502 and no data. An empty `free` array
// would render on the client screen as "nothing is available", which loses the
// booking while looking like an answer.

export const dynamic = "force-dynamic";

/** Referrer-Policy on every response: a booking token must not travel in a Referer header. */
const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function GET(request: Request, { params }: { params: { token: string } }) {
  const admin = createTypedAdminClient();

  // ⚠️ THE TOKEN IS RESOLVED FIRST, AND THE DURATION ONLY AFTERWARDS.
  // Validating the query string first would answer 400 for a bad `minutes` on a
  // DEAD token and 404 for a good one — a two-answer oracle that tells a
  // stranger probing tokens which of theirs is real. resolveBookingLink's whole
  // point is that every dead-token state looks identical; a 400 that arrives
  // earlier than the 404 would undo it.
  const link = await resolveBookingLink(admin, params.token);
  if (link.status !== "ok") {
    // One answer for unknown, revoked and malformed alike — see resolveBookingLink.
    return NextResponse.json({ error: "הקישור אינו פעיל" }, { status: 404, headers: HEADERS });
  }


  // 🔴 THE DURATION *IS* A PARAMETER, UNLIKE THE STEP (E9-2, rule ג). The
  // note above says a public endpoint should have one shape and one cost, and
  // that still holds for the step — but the length is now the client's own
  // choice, and the grid genuinely differs: a 240-minute recording has far
  // fewer legal starts than a 90-minute one. Serving one grid and letting the
  // screen filter it would be the version that lies, because a start that fits
  // 90 minutes may run past closing at 240.
  //
  // ⚠️ VALIDATED AGAINST A CLOSED LIST, never clamped: `validateDuration`
  // returns the default for an ABSENT value and null for a stated-but-wrong
  // one, and the two are answered differently — 400 for the second, because a
  // grid computed for a length nobody approved is worse than no grid.
  const duration = validateDuration(new URL(request.url).searchParams.get("minutes"));
  if (duration === null) {
    return NextResponse.json({ error: "אורך הקלטה אינו תקין" }, { status: 400, headers: HEADERS });
  }

  try {
    const loaded = await loadAvailability(admin, {
      now: new Date(),
      stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
      durationMinutes: duration,
    });
    return NextResponse.json(
      toPublicAvailability(loaded.result, loaded, loaded.rooms),
      { headers: HEADERS }
    );
  } catch (e) {
    // Logged, never returned: the ICS URL is a secret and a fetch failure loves
    // to quote it back into the message.
    console.error("book/availability: קריאת הזמינות נכשלה", e);
    return NextResponse.json({ error: "לא הצלחנו לטעון את המועדים" }, { status: 502, headers: HEADERS });
  }
}
