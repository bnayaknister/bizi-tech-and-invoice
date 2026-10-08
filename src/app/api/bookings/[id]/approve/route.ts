import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { approveBookingRequest } from "@/lib/booking/decide";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/approve — the owner approves one request.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, through the gate that already exists.
//
// ═══ REWRITTEN, E9-2 (8.10): THE LOGIC MOVED, THE BEHAVIOUR DID NOT ═══
// Everything this route used to do inline — the three checks, the status flip,
// the title, the audit event, the calendar write — now lives in
// `@/lib/booking/decide.ts`, because the AUTOMATIC approval has to do exactly
// the same things and a second copy of it would be a copy that drifts. That
// extraction was the E9 research's own recommendation, for the reason this
// file demonstrated: the sequence was trapped inside a route behind a cookie
// gate, so nothing without a cookie could reuse it.
//
// 🔴 WHAT THIS ROUTE STILL OWNS, AND MUST: the owner gate, and the HTTP
// shape. Every status code and every sentence below is the one this route has
// always answered — they are not re-derived from the result, they are mapped
// from it, and `decide.ts` carries them so the two callers cannot disagree
// about what "already handled" means.
//
// 🔴 `revertOnCalendarFailure: false` — AND THAT IS THE ASYMMETRY, DELIBERATE
// (owner decision 8.10). A calendar failure does NOT revert a manual
// approval: there is a person looking at a screen that already says "האישור
// נשמר, אך היצירה ביומן נכשלה — {שגיאה}. אפשר לנסות שוב" with a retry button
// under it, and reverting would delete the thing they are reading. The
// automatic path passes `true`, because nobody is watching it.
//
// ⛔ AND IT STILL CREATES NO PRODUCTION. One door: the 06:00 sync. See
// lib/booking/writeCalendarEvent.ts's header.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

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

  const result = await approveBookingRequest(createTypedAdminClient(), {
    id: params.id,
    // the REAL actor. `decided_by` is null only on the automatic path, which is
    // what makes null mean "automatic" in the audit trail.
    actorId: user.id,
    revertOnCalendarFailure: false,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status, headers: NO_STORE });
  }

  // The same object this route has always returned — BookingsBody reads every
  // one of these fields. `durationMinutes`/`durationTag` are the two new ones
  // (E9-2, rule ג), so the just-approved panel can show a 3-hour booking as a
  // 3-hour booking rather than as a time range the owner has to subtract.
  return NextResponse.json({ ok: true, request: result.request }, { headers: NO_STORE });
}
