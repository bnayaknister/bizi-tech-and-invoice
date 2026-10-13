import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, createTypedAdminClient } from "@/lib/supabase/admin";
import { handleBoardArchive } from "@/lib/productions/boardArchive";

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/productions/board-archive — Q10, the kanban's "הופץ" archive.
//   { action: "archive" | "archive_bulk" | "restore", ids: string[] }
// studio_admin only (owner decision 13.10 #5). View-only: it writes the two
// board_archived_* columns and nothing else — never status, money,
// merged_into, jobs.dismissed or a document. The logic and the gate live in
// lib/productions/boardArchive.ts, where the suite reaches them.
// ═══════════════════════════════════════════════════════════════════════════
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("profiles").select("approved,studio_admin").eq("id", user.id).single()
    : { data: null };
  const body = await request.json().catch(() => null);

  try {
    const r = await handleBoardArchive(
      { userId: user?.id ?? null, profile: profile ?? null, body },
      { admin: createTypedAdminClient(), untyped: createAdminClient() }
    );
    return NextResponse.json(r.json, { status: r.status, headers: NO_STORE });
  } catch (e) {
    console.error("board-archive: נכשל", e);
    return NextResponse.json({ error: "הארכוב נכשל" }, { status: 500, headers: NO_STORE });
  }
}
