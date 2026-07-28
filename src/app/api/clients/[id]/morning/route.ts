import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, MorningError } from "@/lib/morning/client";

// Everything the show-card "לקוח מורנינג" field needs for ONE client (owner
// spec — Feature 5): its current Morning mapping + the searchable list of
// Morning clients. Reads run against real Morning even in DRY_RUN (a mapping
// built from fake data is worthless). can_edit_money — the field both reads and
// maps.
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const { data: client } = await admin
    .from("clients")
    .select("id,name,morning_client_id")
    .eq("id", params.id)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });

  let morning;
  try {
    morning = await listClients();
  } catch (e) {
    const err = e instanceof MorningError ? e : null;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "שליפת לקוחות ממורנינג נכשלה", needs_credentials: err?.status === 0 },
      { status: 502 }
    );
  }

  const mid = client.morning_client_id as string | null;
  const current = mid ? { id: mid, name: morning.find((m) => m.id === mid)?.name ?? null } : null;

  return NextResponse.json({
    client: { id: client.id, name: client.name },
    current,
    morning_clients: morning.map((m) => ({ id: m.id, name: m.name, taxId: m.taxId ?? null })),
  });
}
