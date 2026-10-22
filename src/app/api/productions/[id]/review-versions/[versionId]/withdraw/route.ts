import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { withdrawVersion } from "@/lib/review/versions";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";
import { hasOwnerAccess } from "@/lib/roles";

// 0122 (owner 22.10) — withdraw a review version sent by mistake: the client
// never sees it again, its row / number / comments / approvals stay, and its
// Bunny video is deleted (lib/review/versions.ts withdrawVersion).
// Owner / admin only, with a reason.

export async function POST(request: Request, { params }: { params: { id: string; versionId: string } }) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!hasOwnerAccess(profile)) return NextResponse.json({ error: "בעלים או אדמין בלבד" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { reason?: unknown };
  try {
    const store = supabaseVersionStore(createTypedAdminClient());
    const res = await withdrawVersion({ productionId: params.id, versionId: params.versionId, userId: user.id, reason: body.reason }, { store });
    return NextResponse.json(res.body, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: `ההסרה נכשלה: ${describeError(e)}` }, { status: 500 });
  }
}
