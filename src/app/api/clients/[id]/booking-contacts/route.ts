import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PHONE_ERROR, displayWaId, toWaId } from "@/lib/whatsapp/phone";

// ═══════════════════════════════════════════════════════════════════════════
// "הרשאות הזמנת חדרים" — who may book a room for each of this client's shows.
// GET / POST / DELETE. E9-3, owner decision 8.10 (rule ד).
// ═══════════════════════════════════════════════════════════════════════════
//
// ═══ 🔴 THE GATE IS can_view_money / can_edit_money, AND IT IS NOT A NEW ONE ═══
// The same two flags that already guard the client NAME (entities.ts:158,
// `edit: "money"`) and the Morning contact block
// (`api/clients/[id]/contacts/route.ts:20-25`). The reason is not that phone
// numbers are financial — they are not — but that this card sits INSIDE the
// client card, and RLS `clients_view` is `can_view_money()` at row level, so
// nobody below that flag can reach a client card at all. A third, looser gate
// here would be a gate that lets somebody read rows belonging to a client
// whose card they cannot open.
//
// ⚠️ A `can_view_stages` user (production staff) therefore cannot see this
// card. Worth knowing: they CAN see shows, so an operational reading of "who
// may book" would arguably belong to them. That is a product question, not a
// code one — flagged in the report rather than decided here.
//
// ═══ SERVICE ROLE FOR EVERY READ AND WRITE ═══
// 0103 revokes everything from every session role and carries no policy, so
// the table is unreachable from a browser by construction. The permission
// check above is the whole authorisation, which is why it is the first thing
// in every handler.
//
// ⚠️ UNTYPED CLIENT: 0103 is applied by hand and `database.types.ts` is
// regenerated only afterwards (README step 3). Same choice as the webhook
// route before 0101.
//
// ═══ 🔴 WHY THE SHOWS ARE READ TOO, AND NOT JUST THE CONTACTS ═══
// The card is a table PER PODCAST, including the podcasts that have nobody
// authorised yet — those are the interesting rows, because they are the ones
// where the bot cannot answer anyone. A response shaped as "contacts grouped
// by show" would silently omit them.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type Gate =
  | { ok: true; canEdit: boolean; userId: string }
  | { ok: false; res: NextResponse };

async function gate(): Promise<Gate> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, res: NextResponse.json({ error: "לא מחובר" }, { status: 401 }) };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_view_money,can_edit_money,approved")
    .eq("id", user.id)
    .single();
  if (!profile?.approved) {
    return { ok: false, res: NextResponse.json({ error: "החשבון ממתין לאישור" }, { status: 403 }) };
  }
  if (!profile.can_view_money) {
    return { ok: false, res: NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 }) };
  }
  return { ok: true, canEdit: !!profile.can_edit_money, userId: user.id };
}

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;

  const admin = createAdminClient();

  // every show of this client, including the ones with nobody authorised
  const { data: showRows, error: showErr } = await admin
    .from("shows")
    .select("id,name,active")
    .eq("client_id", params.id)
    .order("name");
  if (showErr) {
    console.error("booking-contacts: קריאת התוכניות נכשלה", showErr);
    return NextResponse.json({ error: "לא הצלחתי לקרוא את התוכניות" }, { status: 500, headers: NO_STORE });
  }

  const shows = (showRows ?? []) as { id: string; name: string; active: boolean }[];
  const ids = shows.map((s) => s.id);

  let contacts: { id: string; show_id: string; name: string; wa_id: string }[] = [];
  if (ids.length > 0) {
    const { data, error } = await admin
      .from("booking_contacts")
      .select("id,show_id,name,wa_id")
      .in("show_id", ids)
      .order("name");
    if (error) {
      console.error("booking-contacts: קריאת אנשי הקשר נכשלה", error);
      return NextResponse.json({ error: "לא הצלחתי לקרוא את אנשי הקשר" }, { status: 500, headers: NO_STORE });
    }
    contacts = (data ?? []) as typeof contacts;
  }

  return NextResponse.json(
    {
      canEdit: g.canEdit,
      shows: shows.map((s) => ({
        id: s.id,
        name: s.name,
        active: s.active,
        contacts: contacts
          .filter((c) => c.show_id === s.id)
          .map((c) => ({
            id: c.id,
            name: c.name,
            waId: c.wa_id,
            // formatted on the SERVER, so the screen never re-implements the
            // display rule and the two cannot drift
            display: displayWaId(c.wa_id),
          })),
      })),
    },
    { headers: NO_STORE }
  );
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  if (!g.canEdit) {
    return NextResponse.json({ error: "אין הרשאת עריכה" }, { status: 403, headers: NO_STORE });
  }

  const body = (await request.json().catch(() => ({}))) as {
    showId?: unknown;
    name?: unknown;
    phone?: unknown;
  };

  const showId = typeof body.showId === "string" ? body.showId.trim() : "";
  if (showId === "") {
    return NextResponse.json({ error: "חסר מזהה תוכנית" }, { status: 400, headers: NO_STORE });
  }

  const name = typeof body.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (name === "" || Array.from(name).length > 120) {
    return NextResponse.json({ error: "שם איש הקשר חסר או ארוך מדי." }, { status: 400, headers: NO_STORE });
  }

  // 🔴 THE CONVERSION HAPPENS HERE, ONCE, ON THE WAY IN. `050-123-4567` becomes
  // `972501234567`, and THAT is what is stored — because the stored value is
  // what an inbound message is matched against. A refusal carries its own
  // sentence rather than a generic one: this is the one field the owner can get
  // wrong by typing, so they need to know what is wrong with it.
  const phone = toWaId(body.phone);
  if (!phone.ok) {
    return NextResponse.json({ error: PHONE_ERROR[phone.reason] }, { status: 400, headers: NO_STORE });
  }

  const admin = createAdminClient();

  // ⚠️ THE SHOW MUST BELONG TO THIS CLIENT. Without this check the route would
  // let anyone who can edit one client attach a contact to ANY show by id —
  // the client id in the URL would be decoration. Re-asserted against the
  // database rather than trusted from the request.
  const { data: show, error: showErr } = await admin
    .from("shows")
    .select("id,client_id,name")
    .eq("id", showId)
    .maybeSingle();
  if (showErr || !show) {
    return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404, headers: NO_STORE });
  }
  if ((show as { client_id: string | null }).client_id !== params.id) {
    return NextResponse.json(
      { error: "התוכנית אינה של הלקוח הזה" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { data: inserted, error } = await admin
    .from("booking_contacts")
    .insert({ show_id: showId, name, wa_id: phone.waId, created_by: g.userId })
    .select("id,show_id,name,wa_id")
    .single();

  if (error) {
    // 23505 = 0103's unique index on (show_id, wa_id). It has just prevented
    // the same person being authorised twice for one podcast, which would make
    // the bot show that podcast twice in the picker.
    if ((error as { code?: string }).code === "23505") {
      return NextResponse.json(
        { error: "המספר הזה כבר רשום לפודקאסט הזה." },
        { status: 409, headers: NO_STORE }
      );
    }
    console.error("booking-contacts: ההוספה נכשלה", error);
    return NextResponse.json({ error: "לא הצלחתי להוסיף את איש הקשר" }, { status: 500, headers: NO_STORE });
  }

  const row = inserted as { id: string; show_id: string; name: string; wa_id: string };
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: row.show_id,
    event_type: "booking_contact_added",
    actor_id: g.userId,
    payload: { contact_id: row.id, name: row.name, wa_id: row.wa_id },
  });

  return NextResponse.json(
    {
      contact: { id: row.id, showId: row.show_id, name: row.name, waId: row.wa_id, display: displayWaId(row.wa_id) },
    },
    { headers: NO_STORE }
  );
}

export async function DELETE(request: Request, { params }: { params: { id: string } }) {
  const g = await gate();
  if (!g.ok) return g.res;
  if (!g.canEdit) {
    return NextResponse.json({ error: "אין הרשאת עריכה" }, { status: 403, headers: NO_STORE });
  }

  const contactId = new URL(request.url).searchParams.get("contactId")?.trim() ?? "";
  if (contactId === "") {
    return NextResponse.json({ error: "חסר מזהה איש קשר" }, { status: 400, headers: NO_STORE });
  }

  const admin = createAdminClient();

  // Same ownership re-assertion as POST, in the other direction: the row is
  // read, its show is read, and the show must belong to the client in the URL.
  const { data: row, error: readErr } = await admin
    .from("booking_contacts")
    .select("id,show_id,name,wa_id,shows(client_id)")
    .eq("id", contactId)
    .maybeSingle();
  if (readErr || !row) {
    return NextResponse.json({ error: "איש הקשר לא נמצא" }, { status: 404, headers: NO_STORE });
  }
  const r = row as unknown as {
    id: string;
    show_id: string;
    name: string;
    wa_id: string;
    shows?: { client_id: string | null } | null;
  };
  if ((r.shows?.client_id ?? null) !== params.id) {
    return NextResponse.json({ error: "איש הקשר אינו של הלקוח הזה" }, { status: 403, headers: NO_STORE });
  }

  const { error } = await admin.from("booking_contacts").delete().eq("id", contactId);
  if (error) {
    console.error("booking-contacts: המחיקה נכשלה", error);
    return NextResponse.json({ error: "לא הצלחתי למחוק את איש הקשר" }, { status: 500, headers: NO_STORE });
  }

  // ⚠️ The audit row carries the number, because the row itself is gone. "Who
  // could book this podcast last month" is otherwise unanswerable after a
  // delete, and a removed permission is exactly the kind of thing somebody
  // asks about later.
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: r.show_id,
    event_type: "booking_contact_removed",
    actor_id: g.userId,
    payload: { contact_id: r.id, name: r.name, wa_id: r.wa_id },
  });

  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
