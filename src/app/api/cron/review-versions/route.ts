import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { runVersionsCron } from "@/lib/review/bunnySync";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";
import { sweepUnsentComments } from "@/lib/review/attentionFlags";

// GET — Vercel Cron, HOURLY (vercel.json; owner 17.10). E13-5 (c): every Bunny
// version that is not final yet — guid by title, the video's state, the
// integrity check (unchecked retried each run, reported after 3 days), 24h
// without a guid → failed (0117), a video Bunny lost → failed. At most 50 per
// run, oldest fetch first. Reads Bunny only. Authorised exactly like
// purge-registrations: `Authorization: Bearer ${CRON_SECRET}`.
//
// + E13-8c (owner 18.10), riding this cron instead of a new one: comments a
// client left on a LIVE link and never sent for 24 hours light the red dot
// ("הלקוח השאיר הערות ולא שלח"), once per (link, newest comment)
// (lib/review/attentionFlags). Its own try: a failure there never fails the
// Bunny sync above, and the other way round.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  try {
    const admin = createTypedAdminClient();
    const out = await runVersionsCron({ store: supabaseVersionStore(admin) });
    console.log(JSON.stringify({ tag: "cron_review_versions", ...out }));
    let unsent: { lit: number; skipped: number } | { error: string };
    try {
      unsent = await sweepUnsentComments(admin, Date.now());
      console.log(JSON.stringify({ tag: "cron_review_unsent_comments", ...unsent }));
    } catch (e) {
      unsent = { error: describeError(e) };
      console.warn(JSON.stringify({ tag: "cron_review_unsent_comments", error: describeError(e) }));
    }
    return NextResponse.json({ ...out, unsent_comments: unsent });
  } catch (e) {
    console.warn(JSON.stringify({ tag: "cron_review_versions", error: describeError(e) }));
    return NextResponse.json({ error: describeError(e) }, { status: 500 });
  }
}
