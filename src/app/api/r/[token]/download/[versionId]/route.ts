import { NextResponse } from "next/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { resolveLink } from "@/lib/review/links";
import { driveDownloadUrl, gateDownloadForLink, loadVersionWithItem } from "@/lib/review/clientVersions";
import { probeDriveDownload, unavailablePage } from "@/lib/review/driveAvailability";

// E13-6 — "download the original" (plan §4a, §9.2 E13-6 (d); owner 16.10:
// every link the client can respond on has a download). PUBLIC, account-less:
// the token is the credential, checked exactly like the page.
//
// Owner 17.10: the download is FROM DRIVE ONLY — a 302 to Drive's direct
// download of THAT version's file (drive_file_id), before and after Bunny
// deletes the media. Bunny is for playback only; nothing here touches Bunny's
// /original. This replaces "download through the system" of 11.10. Not a
// proxy: the bytes never pass through a Vercel function. The route stays in
// the middle (owner 17.10, after the device test) to check the token, leave
// the client_review_download trace, and check the file is still there.
//
// The check (owner 17.10): before the 302, an anonymous one-byte probe of the
// same Drive address (lib/review/driveAvailability). A file that is clearly
// gone — deleted, trashed, no longer shared — gets OUR Hebrew page instead of
// Google's English error, and a client_review_download_missing event. If the
// check itself fails, the download goes on to Drive as before.
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

  const base = { version_id: found.version.id, number: found.version.number, link_id: state.link.id };
  const probe = await probeDriveDownload(gate.driveFileId);

  if (probe.state === "unavailable") {
    // a trace for the team — never a reason to fail the page itself
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: found.item.production_id,
      event_type: "client_review_download_missing",
      payload: { ...base, drive_file_id: gate.driveFileId, reason: probe.reason, http_status: probe.httpStatus },
    });
    return new NextResponse(unavailablePage(`/r/${encodeURIComponent(params.token)}`), {
      status: 404,
      headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // a trace of who downloaded what — never a reason to block the download
  await admin.from("events").insert({
    entity_type: "production",
    entity_id: found.item.production_id,
    event_type: "client_review_download",
    payload: { ...base, source: "drive", probe: probe.state === "ok" ? "ok" : `unknown: ${probe.detail}` },
  });

  return NextResponse.redirect(driveDownloadUrl(gate.driveFileId), { status: 302, headers: NO_STORE });
}
