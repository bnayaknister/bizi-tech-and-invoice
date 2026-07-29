import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Edit the accountant / bookkeeping default recipient (owner spec 2026-07-29).
// The value lives on the app_settings singleton (0048) and drives the document
// recipient defaults. Owner-only, matching app_settings_update's is_owner RLS —
// this route just returns a clean error and validates the format. Empty clears
// it (then documents simply carry no accountant default).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "owner") return NextResponse.json({ error: "בעל העסק בלבד" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { email?: string };
  const email = (body.email ?? "").trim();
  if (email !== "" && !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "כתובת מייל לא תקינה" }, { status: 400 });
  }

  const value = email === "" ? null : email;
  const { error } = await supabase
    .from("app_settings")
    .update({ accountant_email: value, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, accountant_email: value });
}
