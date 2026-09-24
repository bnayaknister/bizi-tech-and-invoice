import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { israelHHMM } from "@/lib/booking/publicView";
import { israelDateOf } from "@/lib/calendar/availability";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/decline — the owner declines one request.
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, same gate. Writes the same three columns as approve and nothing
// else.
//
// ⚠️ NO TIME CHECK, AND NO CALENDAR CHECK — the asymmetry with approve is the
// point. A request whose moment has already passed still owes the client an
// answer: their own screen says "ממתינה לאישור" until somebody decides, and
// leaving it that way forever is the one outcome worse than a late no. And
// nothing about the calendar can make a decline wrong, so the feed is never
// read here: a decline must not be blocked by an ICS fetch failing.
//
// Only a PENDING row can be declined. Declining an approved one would silently
// free a slot the client has already been told is theirs; that needs a
// different, deliberate action and does not exist yet.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const GENERIC = "לא הצלחתי לדחות את הבקשה. נסו שוב.";

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
    .select("id,show_id,studio,start_at,end_at,guest,status,shows(name)")
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

  const { error: updErr } = await admin
    .from("booking_requests")
    .update({ status: "declined", decided_at: new Date().toISOString(), decided_by: user.id })
    .eq("id", row.id)
    // re-asserted, same reason as approve: another tab may have decided it.
    .eq("status", "pending");
  if (updErr) {
    console.error("bookings/decline: העדכון נכשל", updErr);
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }

  const start = new Date(row.start_at);
  const show = row.shows as unknown as { name: string } | null;

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_request_declined",
    actor_id: user.id,
    payload: { request_id: row.id, studio: row.studio, start_at: row.start_at },
  });

  return NextResponse.json(
    {
      ok: true,
      request: {
        id: row.id,
        showName: show?.name ?? "",
        studio: row.studio,
        dateIsrael: israelDateOf(start),
        startIsrael: israelHHMM(start),
      },
    },
    { headers: NO_STORE }
  );
}
