import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { runRegistrationPurge } from "@/lib/registration/approve";

// GET — Vercel Cron, daily (vercel.json). Deletes registrations rejected more
// than 30 days ago and their rejected client rows (0108); a client row with
// links is kept and evented. Logs COUNTS only. Authorised exactly like
// /api/documents/sync: `Authorization: Bearer ${CRON_SECRET}`.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  const out = await runRegistrationPurge(createTypedAdminClient(), new Date());
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 });
  return NextResponse.json(out);
}
