import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { sendForReview } from "@/lib/review/versions";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";
import { resolveDownloadMissing } from "@/lib/review/downloadAttention";
import { driveFileViewUrl } from "@/lib/review/itemLinks";

// E13-4 — "שלח לביקורת": a Drive link → a Bunny review version (plan §5,
// lib/review/versions.ts). Same permission model as review-items: an
// operational action gated by can_edit_stages, then the service role writes.
// The client sees nothing new until the player (E13-6).

// the Drive folder walk + one Bunny request + a short wait for the guid
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { kind?: unknown; reel_index?: unknown; drive_url?: unknown };
  try {
    const store = supabaseVersionStore(createTypedAdminClient());
    const res = await sendForReview(
      { productionId: params.id, kind: body.kind, reelIndex: body.reel_index, driveUrl: body.drive_url, userId: user.id },
      { store }
    );
    // E13-6 (owner 17.10): a new version for an item puts out the red dot a
    // missing Drive file of that item lit. Best-effort, never fails the send.
    const sentId = res.status === 200 ? (res.body as { version?: { id?: unknown } }).version?.id : null;
    // Its own try: the send already happened, so a failure here must not
    // reach the catch below and report "not sent".
    if (typeof sentId === "string") {
      try {
        const admin = createTypedAdminClient();
        const { data: sent } = await admin.from("client_review_versions").select("item_id,drive_file_id").eq("id", sentId).maybeSingle();
        if (sent?.item_id) await resolveDownloadMissing(admin, params.id, { itemId: sent.item_id }, "new_version");
        // owner 18.10: one link per deliverable — the item's old link (0057)
        // follows the version just sent, so the two drawer fields never disagree
        if (sent?.item_id && sent.drive_file_id) {
          const { error: linkErr } = await admin
            .from("client_review_items")
            .update({ media_link: driveFileViewUrl(sent.drive_file_id) })
            .eq("id", sent.item_id)
            .eq("production_id", params.id);
          if (linkErr) throw new Error(linkErr.message);
        }
      } catch (e) {
        console.warn(JSON.stringify({ tag: "review_download_missing_resolve_failed", production_id: params.id, error: describeError(e) }));
      }
    }
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    // a failure to CHECK (Google token, Drive 5xx, DB) — nothing was sent to Bunny
    return NextResponse.json({ error: `השליחה לא בוצעה: ${describeError(e)}` }, { status: 500 });
  }
}
