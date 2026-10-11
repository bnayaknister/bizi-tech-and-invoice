import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { requireStudioAdmin } from "@/lib/registration/gate";
import { pendingRegistrationCount } from "@/lib/registration/review";

// GET — how many registrations wait (new + matched). Feeds the once-a-session
// popup (E17-5). studio_admin only: the table is closed to every session.
export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireStudioAdmin();
  if (!g.ok) return g.res;
  const count = await pendingRegistrationCount(createTypedAdminClient());
  return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
}
