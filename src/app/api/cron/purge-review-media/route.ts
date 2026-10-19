import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { describeError } from "@/lib/bunny/errors";
import { PURGE_MAX_PER_RUN, isPurgeLive, runPurge, summaryPayload, supabasePurgeDeps, writeRunEvent } from "@/lib/review/purge";

// GET — Vercel Cron, NIGHTLY (vercel.json; owner 18.10, (ה)2). E13-10: Bunny
// media of items approved 90+ days ago (lib/review/purge). Authorised exactly
// like purge-registrations: `Authorization: Bearer ${CRON_SECRET}`.
//
//   REVIEW_PURGE_LIVE !== "true" → REPORT: every check, no DELETE (the default)
//   ?limit=N   1..20 — the owner's first live run is ?limit=1
//   ?report=1  report even when live
// Every run writes one review_media_purge_run event; /radar reads the last.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  const url = new URL(request.url);
  const asked = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(asked) && asked >= 1 ? Math.min(asked, PURGE_MAX_PER_RUN) : PURGE_MAX_PER_RUN;
  const live = isPurgeLive() && url.searchParams.get("report") !== "1";
  try {
    const admin = createTypedAdminClient();
    const summary = await runPurge(supabasePurgeDeps(admin, { nowMs: Date.now(), live, limit }));
    await writeRunEvent(admin, summary);
    const payload = summaryPayload(summary);
    const body = { limit, ...payload };
    console.log(JSON.stringify({ tag: "cron_review_purge", mode: summary.mode, limit, counts: payload.counts }));
    return NextResponse.json(body);
  } catch (e) {
    console.warn(JSON.stringify({ tag: "cron_review_purge", error: describeError(e) }));
    return NextResponse.json({ error: describeError(e) }, { status: 500 });
  }
}
