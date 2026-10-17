import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import { gateVersionForLink, loadVersionWithItem } from "@/lib/review/clientVersions";
import { signedOriginalUrl } from "@/lib/bunny/sign";

// E13-6 — the full-quality download (plan §4, §9.2 E13-6 (d); owner 16.10:
// every link the client can respond on has a download). PUBLIC, account-less:
// the token is the credential, checked exactly like the page. 302 to Bunny's
// /original — the exact bytes pulled from Drive (hash_match / size_match) —
// signed for THAT path only, valid 10 minutes. Not a proxy: a 7GB file never
// passes through a Vercel function. The browser follows the redirect from our
// page, so it carries our origin as Referer, which the pull zone requires.
//
// A plain-text answer on refusal: this is a navigation, not a fetch().
export const dynamic = "force-dynamic";

const DOWNLOAD_TTL_SECONDS = 600;
const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (msg: string, status: number) =>
  new NextResponse(msg, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(_request: Request, { params }: { params: { token: string; versionId: string } }) {
  const state = await resolveLink(createAdminClient(), params.token);
  if (state.status !== "ok") return refuse("הלינק אינו זמין. פנו ל-Bizi Podclub.", 410);

  const admin = createTypedAdminClient();
  const found = await loadVersionWithItem(admin, params.versionId);
  if (!found) return refuse("הקובץ לא נמצא.", 404);
  const gate = gateVersionForLink(state.link, state.production.review_reels_required, found.item, found.version);
  if (!gate.ok) return refuse("הקובץ אינו זמין להורדה בקישור הזה.", 404);

  // a trace of who downloaded what — never a reason to block the download
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: found.item.production_id,
    event_type: "client_review_download",
    payload: { version_id: found.version.id, number: found.version.number, link_id: state.link.id },
  });

  const { url } = signedOriginalUrl(found.version.bunny_video_id as string, DOWNLOAD_TTL_SECONDS);
  return NextResponse.redirect(url, { status: 302, headers: NO_STORE });
}
