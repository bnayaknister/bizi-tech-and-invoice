import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import { driveDownloadUrl, gateDownloadForLink, loadVersionWithItem } from "@/lib/review/clientVersions";

// E13-6 — "download the original" (plan §4a, §9.2 E13-6 (d); owner 16.10:
// every link the client can respond on has a download). PUBLIC, account-less:
// the token is the credential, checked exactly like the page.
//
// Owner 17.10: the download is FROM DRIVE ONLY — a 302 to Drive's direct
// download of THAT version's file (drive_file_id), before and after Bunny
// deletes the media. Bunny is for playback only; nothing here touches Bunny's
// /original (that route and its edge-rule questions are gone). This replaces
// "download through the system" of 11.10. Not a proxy: the bytes never pass
// through a Vercel function. We stay in the middle only to check the token
// and leave the client_review_download trace.
//
// A plain-text answer on refusal: this is a navigation, not a fetch().
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const refuse = (msg: string, status: number) =>
  new NextResponse(msg, { status, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

export async function GET(_request: Request, { params }: { params: { token: string; versionId: string } }) {
  const state = await resolveLink(createAdminClient(), params.token);
  if (state.status !== "ok") return refuse("הלינק אינו זמין. פנו ל-Bizi Podclub.", 410);

  const admin = createTypedAdminClient();
  const found = await loadVersionWithItem(admin, params.versionId);
  if (!found) return refuse("הקובץ לא נמצא.", 404);
  const gate = gateDownloadForLink(state.link, state.production.review_reels_required, found.item, found.version);
  if (!gate.ok) return refuse("הקובץ אינו זמין להורדה בקישור הזה.", 404);

  // a trace of who downloaded what — never a reason to block the download
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: found.item.production_id,
    event_type: "client_review_download",
    payload: { version_id: found.version.id, number: found.version.number, link_id: state.link.id, source: "drive" },
  });

  return NextResponse.redirect(driveDownloadUrl(gate.driveFileId), { status: 302, headers: NO_STORE });
}
