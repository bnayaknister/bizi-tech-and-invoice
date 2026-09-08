import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getClientContacts } from "@/lib/morning/client";
import { RECIPIENT_CAP } from "@/lib/documents/recipients";

// The client card's contact block: emails, phone, contact person and the
// read-only `send` flag, read LIVE from Morning.
//
// A ROUTE OF ITS OWN, not part of GET /api/entity/client/[id] — deliberately.
// The drawer opens on five entity types and is the hot path of several screens;
// a Morning call has a 15s deadline (morning/client.ts MORNING_TIMEOUT_MS), so
// hanging the whole card on it would mean Morning being down = no client card
// at all. The card renders its seven DB fields immediately and this block
// arrives beside them, exactly the way the recipient picker loads on open
// (documents/pending/[id]/recipients/route.ts) rather than with the screen.
//
// A failed Morning read is NOT an error here: clientFetchFailed says so and the
// block renders its own state. Same contract as fetchClientEmails.
//
// GATE: can_view_money to read, can_edit_money to write — the gate that already
// guards the client NAME (entities.ts:158, `edit: "money"`), because contact
// details travel with the name. Not a third gate: RLS `clients_view` is
// can_view_money() at row level, so a viewer below it never reaches a client
// card in the first place.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase
    .from("profiles")
    .select("can_view_money,can_edit_money")
    .eq("id", user.id)
    .single();
  if (!profile?.can_view_money) return NextResponse.json({ error: "אין הרשאת צפייה בכספים" }, { status: 403 });

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("clients")
    .select("id,morning_client_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });

  const morningClientId = (row.morning_client_id as string | null) ?? null;

  // Unmapped client: the block shows locked, and says why. We do NOT create the
  // client in Morning from here (owner rule — creation is a write to the books
  // and lives behind its own double-confirmed flow), and we do NOT keep the
  // values locally instead: `clients` has no email or phone column, and giving
  // it one would make a second source of truth for a fact Morning owns.
  if (!morningClientId) {
    return NextResponse.json({
      linked: false,
      contacts: null,
      clientFetchFailed: false,
      canEdit: false,
      recipientCap: RECIPIENT_CAP,
    });
  }

  const { contacts, ok } = await getClientContacts(morningClientId);

  return NextResponse.json({
    linked: true,
    morningClientId,
    contacts,
    clientFetchFailed: !ok,
    // nothing is editable while the read failed: an empty form over an unknown
    // remote state is how someone saves [] over three real addresses.
    canEdit: !!profile.can_edit_money && ok,
    recipientCap: RECIPIENT_CAP,
  });
}
