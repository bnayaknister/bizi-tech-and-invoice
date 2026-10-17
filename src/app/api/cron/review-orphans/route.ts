import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { runOrphanSweep } from "@/lib/review/bunnySync";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";

// GET — Vercel Cron, DAILY (vercel.json; owner 17.10). E13-5 (c)(5): lists the
// whole Bunny library (read-only, pages of 100) against our bunny_video_ids. A
// bizi-<uuid> video older than an hour with no row is reported once as
// review_orphan_video; one whose version waits without a guid is linked. Never
// deletes anything at Bunny. Authorised like purge-registrations.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  try {
    const out = await runOrphanSweep({ store: supabaseVersionStore(createTypedAdminClient()) });
    console.log(JSON.stringify({ tag: "cron_review_orphans", ...out }));
    return NextResponse.json(out);
  } catch (e) {
    console.warn(JSON.stringify({ tag: "cron_review_orphans", error: describeError(e) }));
    return NextResponse.json({ error: describeError(e) }, { status: 500 });
  }
}
