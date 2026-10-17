import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { handleBunnyWebhook } from "@/lib/review/bunnySync";
import { supabaseVersionStore } from "@/lib/review/versionStore";
import { describeError } from "@/lib/bunny/errors";

// E13-5 — Bunny Stream's webhook (plan §9.2 E13-5 (b), lib/review/bunnySync.ts).
// PUBLIC: Bunny sends no session (listed in middleware.ts beside /api/wa/).
// The gate is the HMAC-SHA256 signature over the RAW body with the library's
// read-only key — checked before anything else is read. Reads Bunny, writes
// only our version row and events; works the same whatever BUNNY_DRY_RUN says.
//
//   200  handled, ignored (another library, a title that is not ours), or already final
//   400  signed, but the body is not the shape Bunny documents
//   401  signature missing, malformed or wrong — no detail in the answer
//   503  BUNNY_STREAM_READONLY_KEY is not configured — never "accept everything"
//   500  a failure while handling a valid call — the hourly cron retries it
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  // 🔴 RAW, AND BEFORE ANYTHING ELSE: the signature covers the bytes Bunny sent.
  const raw = await request.text();
  try {
    const store = supabaseVersionStore(createTypedAdminClient());
    const res = await handleBunnyWebhook(raw, request.headers, { store });
    // one line per call, so a missed or rejected delivery is visible in Vercel. Never the key, never the raw body.
    if (res.log) console.log(JSON.stringify({ tag: "bunny_webhook", status: res.status, ...res.log }));
    return NextResponse.json(res.body, { status: res.status, headers: NO_STORE });
  } catch (e) {
    console.warn(JSON.stringify({ tag: "bunny_webhook", status: 500, error: describeError(e) }));
    return NextResponse.json({ ok: false }, { status: 500, headers: NO_STORE });
  }
}
