import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, createMorningClient, MorningError, morningEnv, isDryRun } from "@/lib/morning/client";
import { normalizeClientName } from "@/lib/clients/match";
import { backfillDocumentClients } from "@/lib/documents/backfill";

// Create a client in Morning and map it — the single shared "צור לקוח במורנינג"
// action behind the ClientPicker (owner spec). Two modes, one route:
//   • map-existing: client_id given → create a Morning client for THAT client
//     of ours (Feature 5 behaviour).
//   • brand-new:    no client_id → create OUR client too (deduped against ours),
//     then the Morning client, map, and return the new client_id to select.
//
// Double-gated: confirm=false only checks for duplicates (Morning by name/taxId,
// ours by normalized name) and creates nothing. confirm=true creates. A found
// Morning duplicate can be adopted with map_to_morning_id (no new Morning
// record). createMorningClient honours DRY_RUN. can_edit_money; every step
// evented.
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
    name?: string;
    taxId?: string;
    email?: string;
    phone?: string;
    address?: string;
    confirm?: boolean;
    map_to_morning_id?: string;
  };
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "חסר שם לקוח" }, { status: 400 });

  const admin = createAdminClient();

  // if mapping an existing client of ours, it must exist and be unmapped
  if (body.client_id) {
    const { data: c } = await admin.from("clients").select("id,morning_client_id").eq("id", body.client_id).maybeSingle();
    if (!c) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
    if (c.morning_client_id) return NextResponse.json({ error: "הלקוח כבר ממופה למורנינג" }, { status: 409 });
  }

  // duplicate check against real Morning clients
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
  const target = normalizeClientName(name);
  const morningDup =
    morning.find((m) => body.taxId && m.taxId && m.taxId === body.taxId) ||
    morning.find((m) => normalizeClientName(m.name) === target) ||
    null;

  // in brand-new mode, also look for an existing client of OURS by name
  let existingClient: { id: string; name: string; morning_client_id: string | null } | null = null;
  if (!body.client_id) {
    const { data: ours } = await admin.from("clients").select("id,name,normalized_name,morning_client_id");
    existingClient =
      (ours ?? []).map((c) => ({ id: c.id as string, name: c.name as string, normalized_name: c.normalized_name as string, morning_client_id: (c.morning_client_id as string | null) ?? null }))
        .find((c) => (c.normalized_name || normalizeClientName(c.name)) === target) ?? null;
  }

  // gate 1: report duplicates, create nothing
  if (!body.confirm) {
    return NextResponse.json({
      needs_confirmation: true,
      duplicate: morningDup ? { id: morningDup.id, name: morningDup.name, taxId: morningDup.taxId ?? null } : null,
      existing_client: existingClient ? { id: existingClient.id, name: existingClient.name, mapped: !!existingClient.morning_client_id } : null,
    });
  }

  // ---- confirm=true: resolve our client, then the Morning id, then map ----
  let ourClientId = body.client_id ?? null;
  if (!ourClientId) {
    if (existingClient) {
      if (existingClient.morning_client_id) {
        return NextResponse.json({ error: `הלקוח '${existingClient.name}' כבר קיים וממופה למורנינג`, existing_client_id: existingClient.id }, { status: 409 });
      }
      ourClientId = existingClient.id; // reuse the unmapped existing client
    } else {
      const { data: created, error: insErr } = await admin
        .from("clients")
        .insert({ name, normalized_name: target })
        .select("id")
        .single();
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 400 });
      ourClientId = created.id as string;
      await admin.from("events").insert({
        entity_type: "client", entity_id: ourClientId, event_type: "client_created",
        actor_id: user.id, payload: { name, source: "morning_create" },
      });
    }
  }

  // adopt an existing Morning client, or create a new one (DRY_RUN → synthetic)
  let morningId: string;
  let dryRun = false;
  if (body.map_to_morning_id) {
    morningId = body.map_to_morning_id;
  } else {
    try {
      const res = await createMorningClient({ name, taxId: body.taxId ?? null, phone: body.phone ?? null, address: body.address ?? null, emails: body.email ? [body.email] : undefined });
      morningId = res.id;
      dryRun = res.dryRun;
    } catch (e) {
      const message = e instanceof Error ? e.message : "יצירת לקוח במורנינג נכשלה";
      await admin.from("events").insert({
        entity_type: "client", entity_id: ourClientId, event_type: "morning_client_create_failed",
        actor_id: user.id, payload: { name, error: message },
      });
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const { error: mapErr } = await admin.from("clients").update({ morning_client_id: morningId }).eq("id", ourClientId);
  if (mapErr) {
    return NextResponse.json(
      { error: mapErr.code === "23505" ? "מזהה מורנינג זה כבר משויך ללקוח אחר" : mapErr.message },
      { status: 409 }
    );
  }

  await admin.from("events").insert({
    entity_type: "client", entity_id: ourClientId,
    event_type: body.map_to_morning_id ? "morning_client_mapped" : "morning_client_created",
    actor_id: user.id,
    payload: { morning_client_id: morningId, name, tax_id: body.taxId ?? null, adopted: !!body.map_to_morning_id, dry_run: dryRun, env: morningEnv() },
  });

  const { resolved } = await backfillDocumentClients(admin, { morningClientId: morningId });

  return NextResponse.json({ ok: true, client_id: ourClientId, morning_client_id: morningId, dryRun: dryRun || isDryRun(), backfilled: resolved });
}
