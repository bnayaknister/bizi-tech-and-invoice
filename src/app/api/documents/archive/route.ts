import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { autoArchiveUnassigned, findAutoArchivable } from "@/lib/documents/archive";

// Bulk auto-archive by the fixed criterion (owner spec — Feature A). Unassigned
// documents whose Morning client isn't in the app, older than 90 days, with no
// job. can_edit_money.
//   GET  — count only (how many qualify right now), archives nothing.
//   POST — archive them all; reversible; one summary event.
export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const ids = await findAutoArchivable(admin);
  return NextResponse.json({ qualifying: ids.length });
}

export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  const { archived } = await autoArchiveUnassigned(admin, user.id);
  return NextResponse.json({ ok: true, archived });
}
