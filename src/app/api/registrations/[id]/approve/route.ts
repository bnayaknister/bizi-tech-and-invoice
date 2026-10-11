import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { requireStudioAdmin } from "@/lib/registration/gate";
import { approveRegistration } from "@/lib/registration/approve";
import { realMorning } from "@/lib/registration/morningPort";

// POST — approve a new registration (E17-5). The order of operations and why
// a retry is safe: lib/registration/approve.ts. The answer is `{ outcome }`;
// the screen turns each kind into its sentence.
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const g = await requireStudioAdmin();
  if (!g.ok) return g.res;
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const outcome = await approveRegistration(createTypedAdminClient(), realMorning, {
    registrationId: params.id,
    actorId: g.userId,
    raw: body,
    linkMorningId: typeof body.linkMorningId === "string" ? body.linkMorningId : null,
  });
  const status = outcome.kind === "approved" || outcome.kind === "dry-run" ? 200 : outcome.kind === "error" ? 500 : 409;
  return NextResponse.json({ outcome }, { status, headers: { "Cache-Control": "no-store" } });
}
