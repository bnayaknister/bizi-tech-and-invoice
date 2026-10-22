import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { resendVersion } from "@/lib/review/versions";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";

// owner 22.10 — the resend button of a version that is stuck (not ready an
// hour after it was sent) or failed: the version is marked failed, its Bunny
// video deleted, and the same Drive file sent again to the same item
// (lib/review/versions.ts resendVersion). Same gate as sending: can_edit_stages.

export const maxDuration = 60;

export async function POST(_request: Request, { params }: { params: { id: string; versionId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });
  try {
    const store = supabaseVersionStore(createTypedAdminClient());
    const res = await resendVersion({ productionId: params.id, versionId: params.versionId, userId: user.id }, { store });
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: `השליחה מחדש נכשלה: ${describeError(e)}` }, { status: 500 });
  }
}
