import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { linkDocumentToJob } from "@/lib/documents/reconcile";

// The gaps screen's one-click assignment (owner spec 2026-07-26, step B).
// The bookkeeper confirms a match the system proposed — "כל שיוך = לחיצה אחת".
// can_edit_money only (Shiri). Every assignment is evented inside
// linkDocumentToJob. The match itself is computed server-side; the client
// only sends which document goes to which job.
export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { docId?: string; jobId?: string };
  if (!body.docId || !body.jobId) return NextResponse.json({ error: "חסרים פרטי שיוך" }, { status: 400 });

  const admin = createAdminClient();
  const res = await linkDocumentToJob(admin, {
    docId: body.docId,
    jobId: body.jobId,
    actorId: user.id,
    auto: false,
  });
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, state: res.state });
}
