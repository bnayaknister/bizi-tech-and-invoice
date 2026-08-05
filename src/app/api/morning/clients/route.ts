import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { listClients, MorningError } from "@/lib/morning/client";
import { normalizeClientName, levenshtein } from "@/lib/clients/match";
import { backfillDocumentClients } from "@/lib/documents/backfill";

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

  const { data: ours } = await supabase
    .from("clients")
    .select("id,name,normalized_name,morning_client_id,merged_into")
    .order("name");

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
  const morningById = new Map(morning.map((m) => [m.id, m]));

  // who else maps to each Morning client — many of ours → one Morning entity
  // is legitimate (owner, 2026-07-20), so a shared mapping is labelled, not
  // forbidden
  const ourNamesByMorningId = new Map<string, string[]>();
  for (const c of ours ?? []) {
    if (!c.morning_client_id) continue;
    const arr = ourNamesByMorningId.get(c.morning_client_id) ?? [];
    arr.push(c.name);
    ourNamesByMorningId.set(c.morning_client_id, arr);
  }

  const nameById = new Map((ours ?? []).map((c) => [c.id as string, c.name as string]));

  const rows = (ours ?? []).map((c) => {
    // A row retired by a merge is shown, not hidden: hiding it would clean the
    // list at the cost of the one fact the operator needed on 3.8 — that these
    // rows are unmapped ON PURPOSE. It comes back locked, with the survivor's
    // name, and never with a suggestion.
    if (c.merged_into) {
      return {
        ...c,
        suggestion: null,
        mapped_name: null,
        mapped_tax_id: null,
        mapped_missing: false,
        shared_with: [],
        merged_into_name: nameById.get(c.merged_into as string) ?? null,
      };
    }
    if (c.morning_client_id) {
      // resolve the name/taxId of what it's mapped to so the row can show
      // it — and flag a mapping that points at a Morning client that no
      // longer exists (deleted there), which the operator must re-do
      const m = morningById.get(c.morning_client_id);
      const sharedWith = (ourNamesByMorningId.get(c.morning_client_id) ?? []).filter((n) => n !== c.name);
      return {
        ...c,
        suggestion: null,
        mapped_name: m?.name ?? null,
        mapped_tax_id: m?.taxId ?? null,
        mapped_missing: !m,
        shared_with: sharedWith,
      };
    }
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
    // set true after the operator confirmed the shared-mapping warning
    confirm_shared?: boolean;
  };
  if (!body.client_id) return NextResponse.json({ error: "חסר מזהה לקוח" }, { status: 400 });

  const admin = createAdminClient();

  // A row retired by a merge may not be mapped, at any confirmation level.
  // The CHECK in 0051 already makes it impossible; this is here so the answer
  // is a sentence the operator can act on instead of a constraint violation.
  // Unmapping (null) stays allowed — it is the direction that repairs.
  if (body.morning_client_id) {
    const { data: target } = await admin
      .from("clients")
      .select("merged_into")
      .eq("id", body.client_id)
      .maybeSingle();
    const mergedInto = (target?.merged_into as string | null) ?? null;
    if (mergedInto) {
      // a second plain lookup rather than an embedded resource: the join name
      // would depend on the FK's generated identifier, and this path must not
      // be the thing that discovers it is wrong
      const { data: keeper } = await admin.from("clients").select("name").eq("id", mergedInto).maybeSingle();
      const into = (keeper?.name as string | null) ?? "לקוח אחר";
      return NextResponse.json(
        { error: `השורה מוזגה אל '${into}' ואינה בשימוש — אין למפות אותה. מפו את '${into}' במקומה.` },
        { status: 409 }
      );
    }
  }

  // Sharing one Morning client across several of ours is legitimate (owner,
  // 2026-07-20), but must be a DELIBERATE choice, not a silent one. When the
  // target Morning client is already mapped by other clients of ours, refuse
  // the FIRST attempt with a 409 that names them; the caller shows the
  // warning and retries with confirm_shared:true. This is awareness, not a
  // block — the second call goes through. (Unmapping, morning_client_id=null,
  // skips the check entirely.)
  if (body.morning_client_id && !body.confirm_shared) {
    const { data: already } = await admin
      .from("clients")
      .select("name")
      .eq("morning_client_id", body.morning_client_id)
      .neq("id", body.client_id);
    const sharedWith = (already ?? []).map((r) => r.name as string);
    if (sharedWith.length) {
      return NextResponse.json(
        {
          error: "לקוח מורנינג זה כבר משויך",
          needs_confirmation: true,
          shared_with: sharedWith,
        },
        { status: 409 }
      );
    }
  }

  const { error } = await admin
    .from("clients")
    .update({ morning_client_id: body.morning_client_id || null })
    .eq("id", body.client_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: body.client_id,
    event_type: body.morning_client_id ? "morning_client_mapped" : "morning_client_unmapped",
    actor_id: user.id,
    payload: {
      morning_client_id: body.morning_client_id ?? null,
      morning_client_name: body.morning_client_name ?? null,
      shared: !!body.confirm_shared,
    },
  });

  // The mapping's whole point: old documents pulled before this mapping existed
  // are "לא משויך" only because the pull never re-touched them. Resolve them NOW,
  // scoped to just this Morning client (owner spec 2026-07-27).
  let backfilled = 0;
  if (body.morning_client_id) {
    backfilled = (await backfillDocumentClients(admin, { morningClientId: body.morning_client_id })).resolved;
  }

  return NextResponse.json({ ok: true, backfilled });
}
