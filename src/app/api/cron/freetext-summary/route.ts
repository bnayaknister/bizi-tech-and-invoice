import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { israelDate, israelHour } from "@/lib/dates";
import { recordBookingNotification } from "@/lib/whatsapp/notify";
import { isFreeTextOn, parseFreeTextAllowlist } from "@/lib/whatsapp/flow/run";
import {
  FREETEXT_BOOKING_EVENT,
  FREETEXT_EVENT,
  MONITOR_STARTED_EVENT,
  MONITOR_SUMMARY_EVENT,
  countDay,
  monitorDay,
  summaryParams,
} from "@/lib/whatsapp/freetextMonitor";

// ═══════════════════════════════════════════════════════════════════════════
// /api/cron/freetext-summary — E14-3, the first two weeks of free text for
// everyone (owner, 22.10).
// ═══════════════════════════════════════════════════════════════════════════
//
// Two Vercel crons (18:30 and 19:30 UTC) and an Israel-hour gate — whichever
// lands on 21:30 Israel runs (the unrecorded-check pattern; winter time needs
// nobody). `?force=1` (with the secret) runs it at any hour.
//
//   · STARTS BY ITSELF: the first evening the layer is open to everyone
//     (WHATSAPP_BOOKING_FREETEXT=true and no allowlist) writes
//     `freetext_monitor_started` with that date — once.
//   · STOPS BY ITSELF after 14 days (monitorDay → null): nothing is sent.
//   · ONE WhatsApp to the OWNER only (bizi_ops_alert, audience "owner"): the
//     day's counts. The texts themselves never travel by WhatsApp — they are
//     on the owner's screen (/settings/freetext). A `freetext_monitor_summary`
//     event keeps the numbers whatever happened to the message.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  const now = new Date();
  const force = new URL(request.url).searchParams.get("force") === "1";
  if (!force && israelHour(now) !== 21) return NextResponse.json({ ok: true, skipped: "not-21-israel" });

  const admin = createAdminClient();
  const today = israelDate(now);
  try {
    // 1. when did the monitoring start? (it starts the first evening the layer is open to everyone)
    const { data: started, error: sErr } = await admin
      .from("events")
      .select("payload")
      .eq("event_type", MONITOR_STARTED_EVENT)
      .order("created_at", { ascending: true })
      .limit(1);
    if (sErr) throw new Error(sErr.message);
    let startDate = ((started?.[0]?.payload ?? null) as { date?: string } | null)?.date ?? null;
    if (!startDate) {
      const openToAll = isFreeTextOn() && parseFreeTextAllowlist(process.env.WHATSAPP_FREETEXT_ALLOWLIST).all;
      if (!openToAll) return NextResponse.json({ ok: true, skipped: "not-open-to-everyone" });
      startDate = today;
      await admin.from("events").insert({
        entity_type: "wa_freetext",
        entity_id: crypto.randomUUID(),
        event_type: MONITOR_STARTED_EVENT,
        payload: { date: today, days: 14 },
      });
    }

    const day = monitorDay(startDate, today);
    if (day === null) return NextResponse.json({ ok: true, skipped: "monitoring-ended", started: startDate });

    // 2. the day's events (a 30-hour window, then the Israeli date decides)
    const { data: rows, error } = await admin
      .from("events")
      .select("event_type,created_at,payload")
      .in("event_type", [FREETEXT_EVENT, FREETEXT_BOOKING_EVENT])
      .gte("created_at", new Date(now.getTime() - 30 * 3600_000).toISOString());
    if (error) throw new Error(error.message);
    const counts = countDay((rows ?? []).filter((r) => israelDate(new Date(r.created_at)) === today));

    // 3. the owner only
    const p = summaryParams(day, today, counts);
    const notify = await recordBookingNotification(admin, {
      kind: "ops-alert",
      subjectId: `freetext:${today}`,
      audience: "owner",
      title: p.title,
      details: p.details,
      action: p.action,
    });

    await admin.from("events").insert({
      entity_type: "wa_freetext",
      entity_id: crypto.randomUUID(),
      event_type: MONITOR_SUMMARY_EVENT,
      payload: { date: today, day, started: startDate, forced: force, ...counts, notify } as never,
    });
    console.log(JSON.stringify({ tag: "cron_freetext_summary", date: today, day, ...counts }));
    return NextResponse.json({ ok: true, date: today, day, counts, notify });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(JSON.stringify({ tag: "cron_freetext_summary", error: detail }));
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
