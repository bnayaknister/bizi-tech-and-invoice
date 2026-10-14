import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { handleBoardEligibility } from "@/lib/productions/boardArchive";
import { perfTimer } from "@/lib/perf/timing";

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/productions/board-archive/eligibility — T37.
// Q10's archive eligibility for every "הופץ" card, fetched by the kanban AFTER
// it has rendered (it used to cost the page 660ms in series). studio_admin
// only; the logic lives in lib/productions/boardArchive.ts.
// ═══════════════════════════════════════════════════════════════════════════
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const perf = perfTimer("/api/productions/board-archive/eligibility");
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  perf.lap("getUser");
  const { data: profile } = user
    ? await supabase.from("profiles").select("approved,studio_admin").eq("id", user.id).single()
    : { data: null };
  perf.lap("profile");

  try {
    const r = await handleBoardEligibility({ userId: user?.id ?? null, profile: profile ?? null }, { admin: createTypedAdminClient(), perf });
    const headers: Record<string, string> = { ...NO_STORE };
    if (perf.on) headers["Server-Timing"] = perf.done({ status: r.status });
    return NextResponse.json(r.json, { status: r.status, headers });
  } catch (e) {
    console.error("board-archive/eligibility: נכשל", e);
    return NextResponse.json({ error: "טעינת הזכאות נכשלה" }, { status: 500, headers: NO_STORE });
  }
}
