import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { requireStudioAdmin } from "@/lib/registration/gate";
import { loadRegistrationReview } from "@/lib/registration/review";
import { realMorning } from "@/lib/registration/morningPort";

// GET — one registration for the approval screen, with its server-side checks.
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const g = await requireStudioAdmin();
  if (!g.ok) return g.res;
  const review = await loadRegistrationReview(createTypedAdminClient(), realMorning, params.id);
  if (!review) return NextResponse.json({ error: "ההרשמה לא נמצאה" }, { status: 404 });
  return NextResponse.json(review, { headers: { "Cache-Control": "no-store" } });
}
