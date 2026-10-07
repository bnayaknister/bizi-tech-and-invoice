import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cleanAliasFor } from "@/lib/booking/alias";
import { eventTitle } from "@/lib/booking/title";
import { STUDIOS } from "@/lib/calendar/studios";
import { calendarEventIdFor } from "@/lib/calendar/write";
import { writeBookingCalendarEvent } from "@/lib/booking/writeCalendarEvent";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/bookings/[id]/retry-calendar — try the calendar write again,
// after it failed (feat/calendar-write, 7.10, E8, owner step 4).
// ═══════════════════════════════════════════════════════════════════════════
//
// Owner-only, same gate as approve/decline. Only valid for a request that is
// ALREADY approved AND whose calendar write has not already succeeded —
// `calendar_write_status` is 'failed' or still null (the approval's own
// write genuinely never ran — `show` was missing, which cannot happen in
// practice but the type allows it).
//
// ⚠️ NO CHANGE TO THE APPROVAL ITSELF. status/decided_at/decided_by are not
// touched — this route exists BECAUSE the approval already happened and must
// not be re-litigated by a calendar hiccup (see approve/route.ts's own note
// on why a write failure does not revert it).
//
// 🔴 THE SAME eventId, EVERY TIME. Re-derived from `calendarEventIdFor`, a
// PURE function of the booking's own id — never read back from whatever
// `calendar_event_id` happens to hold, so a retry can never accidentally
// mint a second id for the same booking. This is the whole idempotency
// contract: Google rejects a second event under an id that already exists
// (write.ts's 409 branch reads it back as success), so retrying is always
// safe regardless of what the FIRST attempt actually did.
//
// Shares `writeBookingCalendarEvent` with approve/route.ts — "אותה לוגיקה"
// (owner, step 4) — so a retry settles the same columns and writes the same
// audit event a first attempt would have.
//
// ⛔ AND, LIKE AN APPROVAL, IT CREATES NO PRODUCTION (owner correction,
// 7.10). Productions enter through the morning sync alone; the full
// reasoning, with the sync's own line numbers, is in
// lib/booking/writeCalendarEvent.ts's header.
//
// Untyped client throughout — 0099 is applied (7.10) and the generated types
// know its columns; this route simply never needed the typed one.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const GENERIC = "לא הצלחתי לנסות שוב. נסו שוב.";

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

  const admin = createAdminClient();

  // name/aliases ONLY — see approve/route.ts's own note on the seven billing
  // columns this select used to carry for a production it no longer creates.
  const { data: row, error: readErr } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,note,status,calendar_write_status,shows(name,aliases)")
    .eq("id", params.id)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: "הבקשה לא נמצאה" }, { status: 404, headers: NO_STORE });
  }
  if (row.status !== "approved") {
    return NextResponse.json(
      { error: "אפשר לנסות שוב רק על בקשה מאושרת." },
      { status: 409, headers: NO_STORE }
    );
  }
  if (row.calendar_write_status === "created") {
    return NextResponse.json(
      { error: "האירוע כבר נוצר ביומן — אין מה לנסות שוב." },
      { status: 409, headers: NO_STORE }
    );
  }

  const show = row.shows as unknown as { name: string; aliases: string[] | null } | null;
  if (!show) {
    console.error("bookings/retry-calendar: לבקשה אין תוכנית", row.id);
    return NextResponse.json({ error: GENERIC }, { status: 500, headers: NO_STORE });
  }

  const alias = cleanAliasFor({ name: show.name, aliases: show.aliases ?? [] }, STUDIOS) ?? show.name;
  const title = eventTitle({ alias, guest: row.guest, studio: row.studio });

  // the SAME deterministic id every time — see the header note on why this is
  // never read back from the stored column
  const eventId = calendarEventIdFor(row.id);
  await admin.from("booking_requests").update({ calendar_event_id: eventId }).eq("id", row.id);

  const written = await writeBookingCalendarEvent(admin, {
    bookingId: row.id,
    startAtIso: row.start_at,
    endAtIso: row.end_at,
    note: row.note,
    title,
    eventId,
    actorId: user.id,
  });

  return NextResponse.json(
    {
      ok: true,
      request: {
        id: row.id,
        calendarWriteStatus: written.status,
        calendarWriteError: written.error,
        calendarHtmlLink: written.htmlLink,
        calendarDryRun: written.dryRun,
      },
    },
    { headers: NO_STORE }
  );
}
