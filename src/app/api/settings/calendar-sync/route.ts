import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Owner-only toggle for app_settings.calendar_sync_enabled (0018) — the
// single flag that decides whether the cron/manual sync may touch the real
// calendar at all. RLS (app_settings_update: is_owner()) is the real gate;
// the role check here just turns a forged non-owner request into a clean
// 403 instead of a bare RLS rejection, same pattern as the other routes.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "owner") return NextResponse.json({ error: "רק הבעלים יכול לשנות הגדרה זו" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "ערך לא תקין" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("app_settings")
    .update({ calendar_sync_enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq("id", true)
    .select("calendar_sync_enabled")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!updated) return NextResponse.json({ error: "אין הרשאה לעדכן" }, { status: 403 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "app_settings",
    entity_id: "00000000-0000-0000-0000-000000000000",
    event_type: "calendar_sync_toggled",
    actor_id: user.id,
    payload: { enabled: body.enabled },
  });

  return NextResponse.json({ ok: true, calendar_sync_enabled: updated.calendar_sync_enabled });
}
