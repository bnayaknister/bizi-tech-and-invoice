import { NextResponse } from "next/server";
import { createTypedAdminClient } from "@/lib/supabase/admin";
import { isRegistrationEnabled } from "@/lib/registration/switch";
import { clientIpFrom, submitRegistration } from "@/lib/registration/submit";

// POST /api/join/submit — the registration form (E17-4). Public: the token in
// the BODY is the only credential. All decisions are in
// lib/registration/submit.ts; this reads the request and answers.
//
// The answer is `{ result }` with HTTP 200 for every outcome a visitor can
// cause (thanks / dead / invalid / slow), so the status code says no more than
// the body — a 404 for a dead token would tell a prober what the screen hides.

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

export async function POST(request: Request) {
  if (!isRegistrationEnabled()) return new NextResponse(null, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.token !== "string") {
    return NextResponse.json({ result: "dead" }, { headers: HEADERS });
  }

  try {
    const out = await submitRegistration(createTypedAdminClient(), {
      token: body.token,
      body,
      ip: clientIpFrom(request.headers),
      now: new Date(),
    });
    if (out.kind === "invalid") return NextResponse.json({ result: "invalid", errors: out.errors }, { headers: HEADERS });
    if (out.kind === "error") return NextResponse.json({ result: "error" }, { status: 500, headers: HEADERS });
    return NextResponse.json({ result: out.kind }, { headers: HEADERS });
  } catch (e) {
    // never the body in the log: it is personal data
    console.error("join/submit: זרק", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ result: "error" }, { status: 500, headers: HEADERS });
  }
}
