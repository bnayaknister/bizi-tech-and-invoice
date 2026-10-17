import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import { gateVersionForLink, loadVersionWithItem } from "@/lib/review/clientVersions";
import { signedPlaybackUrl, PLAYBACK_TTL_SECONDS } from "@/lib/bunny/sign";

// E13-6 — re-sign one version's playback (plan §9.2 E13-6 (b), Q4). PUBLIC,
// account-less: the token is the credential, checked exactly like the page
// (resolveLink, then the same scope + playable gate). The player calls this
// when the CDN answers 403 — a 4-hour token ran out mid-episode — and carries
// on from the same second. Returns a URL, never redirects.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, { params }: { params: { token: string } }) {
  const versionId = new URL(request.url).searchParams.get("version") ?? "";
  const state = await resolveLink(createAdminClient(), params.token);
  if (state.status !== "ok") return NextResponse.json({ error: "הלינק אינו זמין" }, { status: 410, headers: NO_STORE });

  const found = await loadVersionWithItem(createTypedAdminClient(), versionId);
  if (!found) return NextResponse.json({ error: "הגרסה לא נמצאה" }, { status: 404, headers: NO_STORE });
  const gate = gateVersionForLink(state.link, state.production.review_reels_required, found.item, found.version);
  if (!gate.ok) return NextResponse.json({ error: "הגרסה לא זמינה בקישור הזה" }, { status: 404, headers: NO_STORE });

  const signed = signedPlaybackUrl(found.version.bunny_video_id as string, PLAYBACK_TTL_SECONDS);
  return NextResponse.json({ url: signed.url, expires: signed.expires }, { headers: NO_STORE });
}
