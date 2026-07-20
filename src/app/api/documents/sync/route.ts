import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDocumentPull } from "@/lib/documents/registry";
import { morningEnv } from "@/lib/morning/client";

// Daily pull of documents issued directly in Morning (owner spec, addition 1):
// keeps the registry current when the bookkeeper works straight in Morning.
//
//   GET  — Vercel Cron. Authorized via CRON_SECRET (same pattern as the
//          calendar sync). Runs once a day; the pull itself only asks Morning
//          for documents since the last run.
//   POST — manual "pull now", session-authorized (can_edit_money).
//
// The pull is READ-ONLY against Morning, so it is safe regardless of
// MORNING_DRY_RUN. Every run is evented.

async function logPull(admin: ReturnType<typeof createAdminClient>, eventType: string, payload: Record<string, unknown>) {
  try {
    await admin.from("events").insert({
      entity_type: "documents_pull",
      entity_id: "00000000-0000-0000-0000-000000000000",
      event_type: eventType,
      payload,
    });
  } catch {
    /* bookkeeping must not break the pull */
  }
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isVercelCron =
    request.headers.get("x-vercel-cron-schedule") !== null ||
    (request.headers.get("user-agent") ?? "").startsWith("vercel-cron/");

  const admin = createAdminClient();
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    if (isVercelCron) {
      await logPull(admin, "documents_pull_failed", {
        reason: cronSecret ? "authorization-mismatch" : "CRON_SECRET-not-set",
      });
    }
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }

  try {
    const summary = await runDocumentPull(admin);
    await logPull(admin, "documents_pull_completed", { trigger: "cron", env: morningEnv(), ...summary });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : "שגיאת משיכה";
    await logPull(admin, "documents_pull_failed", { trigger: "cron", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_money").eq("id", user.id).single();
  if (!profile?.can_edit_money) return NextResponse.json({ error: "אין הרשאת עריכת כספים" }, { status: 403 });

  const admin = createAdminClient();
  try {
    const summary = await runDocumentPull(admin);
    await logPull(admin, "documents_pull_completed", { trigger: "manual", env: morningEnv(), actor: user.id, ...summary });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : "שגיאת משיכה";
    await logPull(admin, "documents_pull_failed", { trigger: "manual", error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
