import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { planUnrecordedCheck, unrecordedLine, minusDays, UNRECORDED_LOOKBACK_DAYS, type UnrecordedRow } from "@/lib/productions/unrecorded";
import { enqueueWorkOrderWhenPerformed } from "@/lib/documents/workOrderOnRecorded";
import { recordBookingNotification } from "@/lib/whatsapp/notify";

// ═══════════════════════════════════════════════════════════════════════════
// /api/cron/unrecorded-check — B38-2, the 21:00 safety net (owner, 21.10).
// ═══════════════════════════════════════════════════════════════════════════
//
// Two Vercel crons (18:00 and 19:00 UTC) and an Israel-hour gate, the pattern
// the calendar sync uses: whichever of the two lands on 21:00 Israel runs, so
// the change to winter time needs nobody. `?force=1` (with the secret) runs it
// at any hour — for a manual check.
//
//   1. the corrective sweep — a billable production of the last 14 days that is
//      performed and has no work order gets one now (enqueueWorkOrderWhenPerformed:
//      idempotent, never a second order, a rejected one is never re-queued)
//   2. the list — billable productions of today and the 13 days before it,
//      not cancelled, not marked "הוקלט" → one WhatsApp to the owner
//      (bizi_ops_alert; until Meta approves it the send is skipped, the event
//      below and the radar card carry it)
//
// Nothing is ever issued in Morning here: an order is QUEUED for a human.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function israelNow(now: Date): { hour: number; date: string } {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(now));
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
  return { hour, date };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }
  const force = new URL(request.url).searchParams.get("force") === "1";
  const { hour, date } = israelNow(new Date());
  if (!force && hour !== 21) return NextResponse.json({ ok: true, skipped: "not-21-israel", israelHour: hour });

  const admin = createAdminClient();
  try {
    const from = minusDays(date, UNRECORDED_LOOKBACK_DAYS - 1);
    const { data: rows, error } = await admin
      .from("productions")
      .select("id,kind,legacy,status,record_date,record_time,podcast_name,guest,show_id,cancelled_at,merged_into")
      .gte("record_date", from)
      .lte("record_date", date)
      .is("cancelled_at", null)
      .is("merged_into", null);
    if (error) throw new Error(error.message);
    const showIds = Array.from(new Set((rows ?? []).map((r) => r.show_id).filter(Boolean))) as string[];
    const { data: shows, error: sErr } = showIds.length
      ? await admin.from("shows").select("id,billing_mode").in("id", showIds)
      : { data: [], error: null };
    if (sErr) throw new Error(sErr.message);
    const modes = new Map((shows ?? []).map((s) => [s.id as string, (s.billing_mode as string | null) ?? null]));
    const plan = planUnrecordedCheck((rows ?? []) as UnrecordedRow[], modes, date);

    // 1. the sweep
    const swept: Record<string, number> = {};
    for (const p of plan.toSweep) {
      const r = await enqueueWorkOrderWhenPerformed(admin, p.id);
      const k = r.status === "skipped" ? `skipped:${r.reason}` : r.status;
      swept[k] = (swept[k] ?? 0) + 1;
    }

    // 2. the list
    let notify: unknown = null;
    if (plan.unrecorded.length > 0) {
      notify = await recordBookingNotification(admin, {
        kind: "ops-alert",
        subjectId: `unrecorded:${date}`,
        audience: "owner",
        title: `${plan.unrecorded.length} הקלטות לא סומנו "הוקלט"`,
        details: unrecordedLine(plan.unrecorded),
        action: "לסמן \"פרק · הקלטה\" בהפקה שהוקלטה, או לבטל הפקה שלא קרתה — עד אז לא נוצרת הזמנת עבודה",
      });
    }

    await admin.from("events").insert({
      entity_type: "schema",
      entity_id: "00000000-0000-0000-0000-000000000000",
      event_type: "cron_unrecorded_check",
      payload: {
        date,
        forced: force,
        unrecorded: plan.unrecorded.length,
        unrecorded_ids: plan.unrecorded.map((p) => p.id),
        swept,
        notify,
      },
    });
    console.log(JSON.stringify({ tag: "cron_unrecorded_check", date, unrecorded: plan.unrecorded.length, swept, notify }));
    return NextResponse.json({ ok: true, date, unrecorded: plan.unrecorded.length, swept, notify });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.warn(JSON.stringify({ tag: "cron_unrecorded_check", error: detail }));
    return NextResponse.json({ error: detail }, { status: 500 });
  }
}
