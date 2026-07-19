import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, MorningError } from "@/lib/morning/client";
import { normalizeClientName, levenshtein } from "@/lib/clients/match";

// Client mapping: "my client X = Morning client Y".
//
// GET  — our clients + Morning's, plus a SUGGESTED match per unmapped
//        client. A suggestion is never applied automatically (owner rule
//        2026-07-19: "הצעה בלבד — אני מאשר"); it is only ever rendered.
// POST — persist one confirmed mapping.
//
// Reads run against the real Morning API even in DRY_RUN: there is nothing
// to damage and a mapping built from fake data would be worthless.

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const { data: ours } = await supabase.from("clients").select("id,name,normalized_name,morning_client_id").order("name");

  let morning;
  try {
    morning = await listClients();
  } catch (e) {
    const err = e instanceof MorningError ? e : null;
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "שליפת לקוחות ממורנינג נכשלה",
        status: err?.status ?? null,
        // the common first-run case: keys not configured yet
        needs_credentials: err?.status === 0,
      },
      { status: 502 }
    );
  }

  const takenMorningIds = new Set((ours ?? []).map((c) => c.morning_client_id).filter(Boolean) as string[]);

  const rows = (ours ?? []).map((c) => {
    if (c.morning_client_id) return { ...c, suggestion: null };
    const target = normalizeClientName(c.name);
    let best: { id: string; name: string; distance: number } | null = null;
    for (const m of morning) {
      // never suggest a Morning client already claimed by another of ours —
      // that would quietly merge two clients' billing
      if (takenMorningIds.has(m.id)) continue;
      const d = levenshtein(target, normalizeClientName(m.name));
      if (!best || d < best.distance) best = { id: m.id, name: m.name, distance: d };
    }
    // only offer a suggestion that is actually close; a bad guess sitting in
    // the UI invites a careless confirm
    const threshold = Math.max(2, Math.floor(target.length * 0.25));
    return { ...c, suggestion: best && best.distance <= threshold ? best : null };
  });

  return NextResponse.json({
    ok: true,
    clients: rows,
    morning_clients: morning.map((m) => ({ id: m.id, name: m.name, taxId: m.taxId ?? null })),
    unmapped: rows.filter((r) => !r.morning_client_id).length,
  });
}

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    client_id?: string;
    morning_client_id?: string | null;
    morning_client_name?: string;
  };
  if (!body.client_id) return NextResponse.json({ error: "חסר מזהה לקוח" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("clients")
    .update({ morning_client_id: body.morning_client_id || null })
    .eq("id", body.client_id);

  if (error) {
    // UNIQUE violation: this Morning client is already mapped to another of
    // our clients. Refusing is the point — see migration 0025.
    const dup = error.code === "23505";
    return NextResponse.json(
      { error: dup ? "לקוח זה במורנינג כבר משויך ללקוח אחר אצלנו" : error.message },
      { status: dup ? 409 : 400 }
    );
  }

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: body.client_id,
    event_type: body.morning_client_id ? "morning_client_mapped" : "morning_client_unmapped",
    actor_id: user.id,
    payload: { morning_client_id: body.morning_client_id ?? null, morning_client_name: body.morning_client_name ?? null },
  });

  return NextResponse.json({ ok: true });
}
