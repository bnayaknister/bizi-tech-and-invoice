import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createReviewLink } from "@/lib/review/links";

// "צור לינק אישור" — an operational action (can_edit_stages) taken when a
// production is ready for the client. Supersedes any live link and mints a
// new one (14-day expiry). Returns the URL + a ready-made WhatsApp/email text.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as {
    reels_included?: boolean;
    episode_link?: string;
    reels_link?: string;
  };

  const admin = createAdminClient();
  const { data: prod } = await admin
    .from("productions")
    .select("id,podcast_name,split_index,split_count")
    .eq("id", params.id)
    .maybeSingle();
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  // derive the public base URL from the request (works in prod + preview)
  const origin = new URL(request.url).origin;

  const result = await createReviewLink(admin, params.id, {
    createdBy: user.id,
    baseUrl: origin,
    reelsIncluded: body.reels_included ?? true,
    episodeLink: body.episode_link?.trim() || null,
    reelsLink: body.reels_link?.trim() || null,
  });

  await admin.from("events").insert({
    entity_type: "production",
    entity_id: params.id,
    event_type: "client_review_link_created",
    actor_id: user.id,
    payload: { token_expires_at: result.expiresAt, reels_included: body.reels_included ?? true },
  });

  const showName = prod.podcast_name ?? "הפקה";
  const shareText = `היי, הפרק של ${showName} מוכן לצפייה ואישור: ${result.url}`;

  return NextResponse.json({
    ok: true,
    url: result.url,
    expires_at: result.expiresAt,
    share: {
      text: shareText,
      whatsapp: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
      mailto: `mailto:?subject=${encodeURIComponent(`אישור פרק — ${showName}`)}&body=${encodeURIComponent(shareText)}`,
    },
  });
}
