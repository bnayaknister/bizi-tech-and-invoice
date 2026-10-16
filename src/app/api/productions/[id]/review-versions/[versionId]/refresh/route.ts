import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { refreshVersion } from "@/lib/review/versions";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";

// E13-4 — the drawer calls this every 30 seconds for a version that is not
// final yet: finds the guid by title, reads the video, applies its state
// (lib/review/versions.ts applyVideoState). The polling fallback to the
// webhook of E13-5. Reads only at Bunny; writes only our version row.

export async function POST(_request: Request, { params }: { params: { id: string; versionId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_view_stages").eq("id", user.id).single();
  if (!profile?.can_view_stages) return NextResponse.json({ error: "אין הרשאת צפייה בשלבים" }, { status: 403 });

  try {
    const store = supabaseVersionStore(createTypedAdminClient());
    const res = await refreshVersion(params.id, params.versionId, { store });
    // an integrity check that did not end in a match leaves one line in the
    // Vercel log (16.10: the first mp3 sat in 'unchecked' for hours with
    // nothing to read). Status codes and reasons only — never a signed URL.
    if (res.log) console.warn(JSON.stringify({ tag: "review_integrity_not_matched", ...res.log }));
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: `רענון נכשל: ${describeError(e)}` }, { status: 500 });
  }
}
