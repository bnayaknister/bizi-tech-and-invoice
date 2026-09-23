import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveBookingLink } from "@/lib/booking/links";
import { loadAvailability } from "@/lib/booking/availabilityServer";
import { toPublicAvailability, PUBLIC_SLOT_STEP_MINUTES } from "@/lib/booking/publicView";

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

export async function GET(_request: Request, { params }: { params: { token: string } }) {
  const admin = createTypedAdminClient();

  const link = await resolveBookingLink(admin, params.token);
  if (link.status !== "ok") {
    // One answer for unknown, revoked and malformed alike — see resolveBookingLink.
    return NextResponse.json({ error: "הקישור אינו פעיל" }, { status: 404, headers: HEADERS });
  }

  try {
    const loaded = await loadAvailability(admin, {
      now: new Date(),
      stepMinutes: PUBLIC_SLOT_STEP_MINUTES,
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
