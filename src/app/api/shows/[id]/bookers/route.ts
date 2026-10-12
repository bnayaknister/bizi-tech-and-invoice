import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { displayWaId } from "@/lib/whatsapp/phone";
import { BOOKING_CONTACTS_FORBIDDEN, canManageBookingContacts } from "@/lib/clients/access";
import { BOOKER_ERROR, validateBooker } from "@/lib/booking/bookers";

// ═══════════════════════════════════════════════════════════════════════════
// E22 — "מורשים לקבוע הקלטות" of ONE show, from the show screen.
//
// The same rows as the client card's tab (`booking_contacts`, 0103), reached
// by show instead of by client — so a show WITHOUT a client (an internal
// production) can have bookers too. studio_admin only, to read as well as to
// edit: the same predicate as the client card's tab (owner, 11.10, E17).
//
// ⚠️ UNTYPED ADMIN CLIENT, ON PURPOSE AND TEMPORARILY: `email` is 0111's, and
// database.types.ts learns it only after the owner's gen types. Switch to
// createTypedAdminClient then — the casts below are what that removes.
// ═══════════════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type BookerRow = { id: string; show_id: string; name: string; wa_id: string; email: string | null };

async function gate(): Promise<{ ok: true; userId: string } | { ok: false; res: NextResponse }> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) };
  const { data: profile } = await supabase.from("profiles").select("approved,studio_admin").eq("id", user.id).single();
  if (!profile?.approved) return { ok: false, res: NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 }) };
  if (!canManageBookingContacts(profile)) {
    return { ok: false, res: NextResponse.json({ error: BOOKING_CONTACTS_FORBIDDEN }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}

const view = (r: BookerRow) => ({ id: r.id, name: r.name, waId: r.wa_id, display: displayWaId(r.wa_id), email: r.email });

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("booking_contacts")
    .select("id,show_id,name,wa_id,email")
    .eq("show_id", params.id)
    .order("name");
  if (error) {
    console.error("show-bookers: הקריאה נכשלה", error);
    return NextResponse.json({ error: "לא הצלחתי לקרוא את המורשים" }, { status: 500, headers: NO_STORE });
  }
  return NextResponse.json({ bookers: ((data ?? []) as BookerRow[]).map(view) }, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const v = validateBooker(body);
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400, headers: NO_STORE });

  const admin = createAdminClient();
  const { data: show } = await admin.from("shows").select("id").eq("id", params.id).maybeSingle();
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404, headers: NO_STORE });

  const { data, error } = await admin
    .from("booking_contacts")
    .insert({ show_id: params.id, name: v.value.name, wa_id: v.value.waId, email: v.value.email, created_by: g.userId })
    .select("id,show_id,name,wa_id,email")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json({ error: BOOKER_ERROR.duplicate, field: "phone" }, { status: 409, headers: NO_STORE });
    }
    console.error("show-bookers: ההוספה נכשלה", error);
    return NextResponse.json({ error: "לא הצלחתי להוסיף את המורשה" }, { status: 500, headers: NO_STORE });
  }
  const row = data as BookerRow;
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "booking_contact_added",
    actor_id: g.userId,
    payload: { contact_id: row.id, name: row.name, wa_id: row.wa_id, has_email: !!row.email, via: "show" },
  });
  return NextResponse.json({ booker: view(row) }, { headers: NO_STORE });
}

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const bookerId = typeof body.bookerId === "string" ? body.bookerId : "";
  if (!bookerId) return NextResponse.json({ error: "חסר מזהה מורשה" }, { status: 400, headers: NO_STORE });
  const v = validateBooker(body);
  if (!v.ok) return NextResponse.json({ error: v.error, field: v.field }, { status: 400, headers: NO_STORE });

  const admin = createAdminClient();
  const { data: before } = await admin
    .from("booking_contacts")
    .select("id,show_id,name,wa_id,email")
    .eq("id", bookerId)
    .maybeSingle();
  if (!before || (before as BookerRow).show_id !== params.id) {
    return NextResponse.json({ error: "המורשה לא נמצא בתוכנית הזו" }, { status: 404, headers: NO_STORE });
  }
  const { data, error } = await admin
    .from("booking_contacts")
    .update({ name: v.value.name, wa_id: v.value.waId, email: v.value.email })
    .eq("id", bookerId)
    .select("id,show_id,name,wa_id,email")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json({ error: BOOKER_ERROR.duplicate, field: "phone" }, { status: 409, headers: NO_STORE });
    }
    console.error("show-bookers: העדכון נכשל", error);
    return NextResponse.json({ error: "לא הצלחתי לעדכן את המורשה" }, { status: 500, headers: NO_STORE });
  }
  const row = data as BookerRow;
  const b = before as BookerRow;
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "booking_contact_updated",
    actor_id: g.userId,
    payload: {
      contact_id: row.id,
      name: { from: b.name, to: row.name },
      wa_id: { from: b.wa_id, to: row.wa_id },
      email_changed: (b.email ?? null) !== (row.email ?? null),
    },
  });
  return NextResponse.json({ booker: view(row) }, { headers: NO_STORE });
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  const bookerId = new URL(request.url).searchParams.get("bookerId")?.trim() ?? "";
  if (!bookerId) return NextResponse.json({ error: "חסר מזהה מורשה" }, { status: 400, headers: NO_STORE });

  const admin = createAdminClient();
  const { data: row } = await admin.from("booking_contacts").select("id,show_id,name,wa_id").eq("id", bookerId).maybeSingle();
  if (!row || (row as BookerRow).show_id !== params.id) {
    return NextResponse.json({ error: "המורשה לא נמצא בתוכנית הזו" }, { status: 404, headers: NO_STORE });
  }
  const { error } = await admin.from("booking_contacts").delete().eq("id", bookerId);
  if (error) {
    console.error("show-bookers: המחיקה נכשלה", error);
    return NextResponse.json({ error: "לא הצלחתי למחוק את המורשה" }, { status: 500, headers: NO_STORE });
  }
  const r = row as BookerRow;
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "booking_contact_removed",
    actor_id: g.userId,
    payload: { contact_id: r.id, name: r.name, wa_id: r.wa_id, via: "show" },
  });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
