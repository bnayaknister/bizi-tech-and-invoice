import { NextResponse } from "next/server";
import { getSessionAndProfile } from "@/lib/profile";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { getAppBaseUrl } from "@/lib/appUrl";
import { canCreateRegistrationLink } from "@/lib/clients/access";
import { isRegistrationEnabled } from "@/lib/registration/switch";
import { createManualRegistrationLink, registrationUrl } from "@/lib/registration/links";

// POST /api/clients/registration-links — "קישור הרשמה חדש" (E17-4).
// studio_admin only, and only while REGISTRATION_ENABLED is on (a link to a
// page that answers 404 would be a link to nowhere). No number on the link:
// the visitor types both authorised numbers, and they arrive unverified.

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const { user, profile } = await getSessionAndProfile();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401, headers: NO_STORE });
  if (!canCreateRegistrationLink(profile, isRegistrationEnabled())) {
    return NextResponse.json({ error: "קישורי הרשמה — לבניה ולאלי בלבד, כשההרשמה פתוחה" }, { status: 403, headers: NO_STORE });
  }

  const now = new Date();
  const res = await createManualRegistrationLink(createTypedAdminClient(), user.id, now);
  if (!res.ok) return NextResponse.json({ error: "לא הצלחתי ליצור קישור" }, { status: 500, headers: NO_STORE });

  await createTypedAdminClient().from("events").insert({
    entity_type: "registration_link",
    entity_id: res.linkId,
    event_type: "registration_link_created",
    actor_id: user.id,
    payload: { expires_at: res.expiresAt },
  });

  return NextResponse.json(
    { url: registrationUrl(getAppBaseUrl(request), res.token), expiresAt: res.expiresAt },
    { headers: NO_STORE }
  );
}
