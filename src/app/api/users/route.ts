import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PRESETS, isPresetRole } from "@/lib/users/presets";
import { createAccessLink, linkErrorMessage } from "@/lib/users/accessLink";
import { requireUsersOwner } from "@/lib/users/ownerGate";

// Add a user — owner only (U1-4). The owner picks a role (admin / tech /
// bookkeeper; owner is never offered — it is set by hand) and one of two ways
// to send the first sign-in (U1-5):
//   invite : Supabase sends the invite email (Hebrew template → /auth/confirm)
//   link   : no email; we return our own /auth/confirm link for the owner to
//            copy (see lib/users/accessLink — never Supabase's action_link)
// Right after creation, with the service role, the new profile gets
// approved=true, the role, the name and the role's preset flags — so the
// person lands straight in the app, never on "ממתין לאישור". The handle_new_user
// trigger has already created the profile row (approved=false) by then.
// auth.uid() is null for the service role, so trg_guard_profile_permissions
// does not apply.
export async function POST(request: Request) {
  const supabase = createClient();
  const gate = await requireUsersOwner(supabase);
  if ("response" in gate) return gate.response;

  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    name?: string;
    role?: string;
    mode?: string;
  };
  const email = (body.email ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "כתובת מייל לא תקינה" }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "חסר שם" }, { status: 400 });
  if (!isPresetRole(body.role)) return NextResponse.json({ error: "יש לבחור תפקיד" }, { status: 400 });
  if (body.mode !== "invite" && body.mode !== "link") {
    return NextResponse.json({ error: "אופן שליחה לא מוכר" }, { status: 400 });
  }
  const preset = PRESETS[body.role];

  const admin = createAdminClient();
  let newId: string;
  let link: string | null = null;

  if (body.mode === "invite") {
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { name } });
    if (error || !data.user) {
      return NextResponse.json({ error: linkErrorMessage(error?.message) }, { status: error?.status ?? 400 });
    }
    newId = data.user.id;
  } else {
    const res = await createAccessLink(admin, request, { email, kind: "invite", name });
    if ("error" in res) return NextResponse.json({ error: res.error }, { status: res.status });
    newId = res.userId;
    link = res.url;
  }

  const { error: profErr } = await admin
    .from("profiles")
    .update({ approved: true, role: preset.role, name, ...preset.flags })
    .eq("id", newId);
  if (profErr) {
    // the account exists but is still pending — say so instead of a silent half
    return NextResponse.json(
      { error: `המשתמש נוצר, אבל קביעת התפקיד נכשלה: ${profErr.message}. אפשר לקבוע אותו ידנית ברשימה.` },
      { status: 500 }
    );
  }

  await admin.from("events").insert({
    entity_type: "profile",
    entity_id: newId,
    event_type: "user_added",
    actor_id: gate.userId,
    payload: { email, mode: body.mode, role: preset.role },
  });

  return NextResponse.json({ ok: true, id: newId, link });
}
