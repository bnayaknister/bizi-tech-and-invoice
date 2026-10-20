import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { hasOwnerAccess } from "@/lib/roles";
import { showClientNameOn, withShowClientName } from "@/lib/shows/clientLabel";
import type { Json } from "@/lib/supabase/database.types";

// "הצג שם לקוח בשורת ההפקה" — owner and admin only (owner 20.10). The only
// writer of shows.settings: /api/shows/update no longer accepts `settings`.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role,approved").eq("id", user.id).single();
  if (!profile?.approved || !hasOwnerAccess(profile)) {
    return NextResponse.json({ error: "ההגדרה הזו — לבעלים ולאדמין בלבד" }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { show_client_name?: unknown };
  if (typeof body.show_client_name !== "boolean") {
    return NextResponse.json({ error: "ערך לא תקין" }, { status: 400 });
  }

  const admin = createTypedAdminClient();
  const { data: show } = await admin.from("shows").select("id,name,settings").eq("id", params.id).maybeSingle();
  if (!show) return NextResponse.json({ error: "התוכנית לא נמצאה" }, { status: 404 });
  const before = showClientNameOn(show.settings);
  const settings = withShowClientName(show.settings, body.show_client_name);

  const { error } = await admin.from("shows").update({ settings: settings as Json }).eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await admin.from("events").insert({
    entity_type: "show",
    entity_id: params.id,
    event_type: "show_display_updated",
    actor_id: user.id,
    payload: { show_client_name: { from: before, to: body.show_client_name } },
  });
  return NextResponse.json({ ok: true, settings });
}
