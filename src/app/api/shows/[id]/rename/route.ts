import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasOwnerAccess } from "@/lib/roles";
import { planShowRename } from "@/lib/shows/rename";

// Renaming a show — owner and admin only (owner, 20.10). The ONLY path that
// changes shows.name: /api/shows/update no longer accepts `name`, so the old
// name is always kept as an alias (see lib/shows/rename.ts) and calendar
// matching keeps working for events still titled the old way.
//
// Nothing is renamed retroactively: productions/stages keep their display
// copy (podcast_name), documents and Morning keep what they were issued with.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!hasOwnerAccess(profile)) {
    return NextResponse.json({ error: "שינוי שם תוכנית — לבעלים ולאדמין בלבד" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
  const admin = createAdminClient();

  // read with the service role: the duplicate check must see EVERY show
  const { data: all, error: readErr } = await admin.from("shows").select("id,name,aliases");
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  const current = (all ?? []).find((s) => s.id === params.id);
  if (!current) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });

  const plan = planShowRename(current, body.name, all ?? []);
  if (!plan.ok) {
    return NextResponse.json({ error: plan.error, code: plan.code }, { status: plan.code === "duplicate" ? 409 : 400 });
  }

  // conditional on the name we read: two renames at once -> the second is
  // told, instead of silently overwriting the first and losing its alias.
  // Service role: the role check above IS the permission (an admin may rename
  // whatever their can_edit_* flags), and only name + aliases are written.
  const { data: updated, error } = await admin
    .from("shows")
    .update({ name: plan.name, aliases: plan.aliases })
    .eq("id", params.id)
    .eq("name", current.name)
    .select("id,name,aliases");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: "השם השתנה בינתיים — רעננו את המסך ונסו שוב", code: "conflict" }, { status: 409 });
  }

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "show_renamed",
    actor_id: user.id,
    payload: { from: current.name, to: plan.name, alias_added: plan.aliasAdded, aliases: plan.aliases },
  });

  return NextResponse.json({ ok: true, show: updated[0], aliasAdded: plan.aliasAdded });
}
