import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, createMorningClient, MorningError, morningEnv, isDryRun } from "@/lib/morning/client";
import { normalizeClientName } from "@/lib/clients/match";
import { backfillDocumentClients } from "@/lib/documents/backfill";

// Create a NEW Morning client and map one of ours to it (owner spec — Feature
// 5). A real creation is a write to the owner's books, so it is double-gated:
//   • confirm=false → duplicate check only. Returns any close Morning match so
//     the operator can map to it instead. Nothing is created.
//   • confirm=true  → create in Morning (DRY_RUN honoured) + map immediately.
// can_edit_money. Every step evented.
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
    phone?: string;
    email?: string;
    confirm?: boolean;
  };
  if (!body.client_id) return NextResponse.json({ error: "חסר מזהה לקוח" }, { status: 400 });
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "חסר שם לקוח" }, { status: 400 });

  const admin = createAdminClient();
  const { data: client } = await admin.from("clients").select("id,morning_client_id").eq("id", body.client_id).maybeSingle();
  if (!client) return NextResponse.json({ error: "הלקוח לא נמצא" }, { status: 404 });
  if (client.morning_client_id) return NextResponse.json({ error: "הלקוח כבר ממופה למורנינג" }, { status: 409 });

  // duplicate check against real Morning clients (name or taxId)
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
  const dup =
    morning.find((m) => body.taxId && m.taxId && m.taxId === body.taxId) ||
    morning.find((m) => normalizeClientName(m.name) === target) ||
    null;

  // gate 1 / gate 2: without an explicit confirm we only REPORT (a duplicate,
  // or a "ready to create" go-ahead). Nothing is created until confirm=true.
  if (!body.confirm) {
    return NextResponse.json({
      needs_confirmation: true,
      duplicate: dup ? { id: dup.id, name: dup.name, taxId: dup.taxId ?? null } : null,
    });
  }

  // create in Morning (DRY_RUN → synthetic id, no real client)
  let created;
  try {
    created = await createMorningClient({ name, taxId: body.taxId ?? null, phone: body.phone ?? null, emails: body.email ? [body.email] : undefined });
  } catch (e) {
    const message = e instanceof Error ? e.message : "יצירת לקוח במורנינג נכשלה";
    await admin.from("events").insert({
      entity_type: "client", entity_id: body.client_id, event_type: "morning_client_create_failed",
      actor_id: user.id, payload: { name, error: message },
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // map ours to the new Morning client (UNIQUE guards a double-map)
  const { error: mapErr } = await admin.from("clients").update({ morning_client_id: created.id }).eq("id", body.client_id);
  if (mapErr) {
    return NextResponse.json(
      { error: mapErr.code === "23505" ? "מזהה מורנינג זה כבר משויך ללקוח אחר" : mapErr.message },
      { status: 409 }
    );
  }

  await admin.from("events").insert({
    entity_type: "client", entity_id: body.client_id, event_type: "morning_client_created",
    actor_id: user.id,
    payload: { morning_client_id: created.id, name, tax_id: body.taxId ?? null, dry_run: created.dryRun, env: morningEnv() },
  });

  // resolve any registry docs that predate this mapping, scoped to the new id
  const { resolved } = await backfillDocumentClients(admin, { morningClientId: created.id });

  return NextResponse.json({ ok: true, morning_client_id: created.id, dryRun: created.dryRun || isDryRun(), backfilled: resolved });
}
