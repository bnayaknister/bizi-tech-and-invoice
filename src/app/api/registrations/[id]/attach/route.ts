import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { requireStudioAdmin } from "@/lib/registration/gate";
import { attachRegistration } from "@/lib/registration/approve";

// POST — a registration matched to an existing card: its numbers to an
// existing podcast of that client, or a new podcast under it. No new client,
// no Morning (E17-5).
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const g = await requireStudioAdmin();
  if (!g.ok) return g.res;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const outcome = await attachRegistration(createTypedAdminClient(), { registrationId: params.id, actorId: g.userId, raw: body });
  const status = outcome.kind === "done" ? 200 : outcome.kind === "error" ? 500 : 409;
  return NextResponse.json({ outcome }, { status, headers: { "Cache-Control": "no-store" } });
}
