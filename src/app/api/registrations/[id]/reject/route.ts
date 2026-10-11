import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { requireStudioAdmin } from "@/lib/registration/gate";
import { rejectRegistration } from "@/lib/registration/approve";

// POST — reject. Nothing is sent to the client and nothing is created in
// Morning (owner decision 11.10); the details are purged 30 days later.
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const g = await requireStudioAdmin();
  if (!g.ok) return g.res;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const outcome = await rejectRegistration(createTypedAdminClient(), {
    registrationId: params.id,
    actorId: g.userId,
    reason: body.reason,
  });
  const status = outcome.kind === "done" ? 200 : outcome.kind === "error" ? 500 : 409;
  return NextResponse.json({ outcome }, { status, headers: { "Cache-Control": "no-store" } });
}
