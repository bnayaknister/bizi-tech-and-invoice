import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// stage-level fields vs money fields — the DB trigger (trg_guard_show_money)
// is the real enforcement; this check just returns a clean error instead of
// a raw postgres exception
const STAGE_FIELDS = new Set(["name", "aliases", "active", "is_oneoff", "default_studio", "default_editor_id", "color"]);
// billing_mode + client_id are money classification — both guarded by DB
// triggers (0008 trg_guard_show_money, 0012 trg_guard_show_billing)
const MONEY_FIELDS = new Set(["default_rate", "client_id", "billing_mode"]);

export async function POST(request: Request) {
  const { id, patch } = (await request.json()) as {
    id: string;
    patch: Record<string, unknown>;
  };
  if (!id || !patch || Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "חסר id או שדות לעדכון" }, { status: 400 });
  }

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });

  const { data: profile } = await supabase
    .from("profiles")
    .select("can_edit_stages,can_edit_money")
    .eq("id", user.id)
    .single();

  for (const key of Object.keys(patch)) {
    if (MONEY_FIELDS.has(key)) {
      if (!profile?.can_edit_money) {
        return NextResponse.json({ error: "רק בעל הרשאת עריכת כספים יכול לשנות מחיר או לקוח" }, { status: 403 });
      }
    } else if (STAGE_FIELDS.has(key)) {
      if (!profile?.can_edit_stages && !profile?.can_edit_money) {
        return NextResponse.json({ error: "אין הרשאת עריכה" }, { status: 403 });
      }
    } else {
      return NextResponse.json({ error: `שדה לא מוכר: ${key}` }, { status: 400 });
    }
  }

  const { data: updated, error } = await supabase
    .from("shows")
    .update(patch)
    .eq("id", id)
    .select("id,name,aliases,active,is_oneoff,default_studio,color,client_id,billing_mode")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("events").insert({
    entity_type: "show",
    entity_id: id,
    event_type: "show_updated",
    actor_id: user.id,
    payload: { fields: Object.keys(patch), patch },
  });

  return NextResponse.json({ ok: true, show: updated });
}
