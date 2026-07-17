import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findClientMatch, normalizeClientName } from "@/lib/clients/match";

// Smart client field backend (owner request 2026-07-17): search-and-create
// for the client picker used everywhere a client is chosen (show card,
// EntityDrawer, orphan-show assignment). Creating/assigning a client is
// money classification — clients_insert RLS already requires
// can_edit_money() (or can_import(), for the CSV importer's own path), so
// the insert itself runs through the caller's own session; this route just
// turns a non-money-permission attempt into a clean 403 first.
//
// Body: { name: string, force?: boolean }
//   - exact match (post-normalization) -> returns it, never creates a
//     second row for the same client under a different spelling
//   - close-but-not-exact -> returns { needsConfirmation, suggestion }
//     instead of creating anything, UNLESS force=true (the user explicitly
//     said "no, really create new" after seeing the suggestion)
//   - otherwise -> creates with billing_mode='per_episode',
//     payment_terms='immediate', everything else left for the client card
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { name?: string; force?: boolean };
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "שם לקוח חסר" }, { status: 400 });

  const admin = createAdminClient();
  const { data: existing, error: existingErr } = await admin.from("clients").select("id,name,normalized_name");
  if (existingErr) return NextResponse.json({ error: existingErr.message }, { status: 400 });

  const match = findClientMatch(name, existing ?? []);
  if (match && "exact" in match) {
    return NextResponse.json({ ok: true, client: { id: match.exact.id, name: match.exact.name }, created: false });
  }
  if (match && "suggestion" in match && !body.force) {
    return NextResponse.json({
      ok: true,
      needsConfirmation: true,
      suggestion: { id: match.suggestion.id, name: match.suggestion.name },
    });
  }

  const { data: created, error: insertErr } = await supabase
    .from("clients")
    .insert({
      name,
      normalized_name: normalizeClientName(name),
      billing_mode: "per_episode",
      payment_terms: "immediate",
    })
    .select("id,name")
    .single();
  if (insertErr) {
    // race: someone else created the same normalized_name between our
    // lookup and this insert — the unique index rejects it; fetch and
    // return that row instead of surfacing a raw DB conflict
    if (insertErr.code === "23505") {
      const { data: race } = await admin
        .from("clients")
        .select("id,name")
        .eq("normalized_name", normalizeClientName(name))
        .maybeSingle();
      if (race) return NextResponse.json({ ok: true, client: race, created: false });
    }
    return NextResponse.json({ error: insertErr.message }, { status: 400 });
  }

  await admin.from("events").insert({
    entity_type: "client",
    entity_id: created.id,
    event_type: "client_created",
    actor_id: user.id,
    payload: { name, forced: !!body.force },
  });

  return NextResponse.json({ ok: true, client: created, created: true });
}
