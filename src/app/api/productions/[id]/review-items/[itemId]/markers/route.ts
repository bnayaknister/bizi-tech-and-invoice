import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { loadCommentHistory } from "@/lib/review/commentHistory";
import { displayDateTime } from "@/lib/dates";
import {
  MARKER_FILE_FORMAT,
  MARKER_FILE_VERSION,
  MARKER_FPS,
  buildFcp7Xml,
  buildMarkers,
  framesToTimecode,
  markerFileName,
  parseTimecodeOffset,
  type BiziMarkerFile,
} from "@/lib/review/markerExport";

// E13-11 — "⬇ מרקרים ל-Premiere" (plan §9.2 E13-11; owner decisions 18.10).
// GET ?format=json|xml &scope=open|all &offset=<MM:SS | HH:MM:SS:FF> [&version=<uuid>]
//
// The team's download, from the drawer: the item's pins as Premiere markers.
// json → the "Bizi · מרקרים" UXP panel adds them to the OPEN sequence;
// xml  → FCP7 XML for File › Import (a new sequence) — the no-install fallback.
// Same gate as the rest of the review panel (can_edit_stages), then the
// service role reads the 0114 tables (closed to every session).
// Read-only: nothing is written, nothing is marked.
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: { id: string; itemId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "xml" ? "xml" : "json";
  const scope = url.searchParams.get("scope") === "all" ? "all" : "open";
  const off = parseTimecodeOffset(url.searchParams.get("offset") ?? "");
  if (!off.ok) return NextResponse.json({ error: off.error }, { status: 400 });

  const admin = createTypedAdminClient();
  const { data: prod } = await admin.from("productions").select("id,podcast_name").eq("id", params.id).maybeSingle();
  if (!prod) return NextResponse.json({ error: "ההפקה לא נמצאה" }, { status: 404 });

  let history;
  try {
    history = await loadCommentHistory(admin, params.id);
  } catch {
    return NextResponse.json({ error: "שגיאה בטעינת ההערות" }, { status: 500 });
  }
  const item = history.find((i) => i.id === params.itemId);
  if (!item) return NextResponse.json({ error: "הפריט לא נמצא בהפקה" }, { status: 404 });

  // the version: ?version= when given, else the item's newest numbered version
  const { data: versions } = await admin
    .from("client_review_versions")
    .select("id,number,original_filename")
    .eq("item_id", item.id)
    .not("number", "is", null)
    .order("number", { ascending: false });
  const wanted = url.searchParams.get("version");
  const version = (versions ?? []).find((v) => (wanted ? v.id === wanted : true));
  if (!version) return NextResponse.json({ error: "לפריט אין גרסה" }, { status: 404 });

  const markers = buildMarkers({
    comments: item.comments.filter((c) => c.author_kind === "client"),
    versionId: version.id,
    scope,
    offsetFrames: off.frames,
    versionNumber: version.number,
    fileName: version.original_filename,
    formatDate: (iso) => displayDateTime(iso) ?? iso,
  });

  const file: BiziMarkerFile = {
    format: MARKER_FILE_FORMAT,
    version: MARKER_FILE_VERSION,
    fps: MARKER_FPS,
    production: prod.podcast_name ?? "",
    item: item.label,
    version_number: version.number,
    file_name: version.original_filename,
    scope,
    offset_frames: off.frames,
    offset_timecode: framesToTimecode(off.frames),
    generated_at: new Date().toISOString(),
    markers,
  };

  const name = markerFileName(prod.id, item.kind, item.reel_index, version.number, format);
  const body =
    format === "xml"
      ? buildFcp7Xml(file, `Bizi · ${file.production} · ${item.label} · v${version.number ?? ""} · מרקרים`)
      : JSON.stringify(file, null, 2);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": format === "xml" ? "application/xml; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
