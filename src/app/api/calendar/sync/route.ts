import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAndParseIcs, parseIcsText, type CalendarEvent } from "@/lib/calendar/parse";
import { buildSyncPlan, type ExistingProductionRow } from "@/lib/calendar/sync";
import type { ShowForMatch } from "@/lib/calendar/match";

// Google Calendar sync (screens-spec §11, owner rules 2026-07-16):
//   GET  — Vercel Cron trigger. Authorizes via CRON_SECRET, always reads
//          the real STUDIO_ICS_URL.
//   POST — manual "sync now" button. Authorizes via the caller's own
//          session (can_edit_stages). May pass `icsText` to test against a
//          fake calendar instead of the real one — this is how the fake-ICS
//          verification runs before the real URL is ever wired in.
// Either path funnels into the same runSync() so cron and manual behave
// identically; only auth and the event source differ.
//
// Vercel Cron is UTC-only, no timezone support — but the owner wants
// exactly 06:00 Israel time year-round, across the DST transition.
// vercel.json fires this route twice daily (03:00 UTC and 04:00 UTC); one
// of the two lands on 06:00 Israel depending on the season, the other on
// 05:00 or 07:00. isIsraelSixAM() below is the gate: only the trigger that
// actually lands on local 06:00 proceeds. alreadySyncedToday() is a second,
// independent guard against any retry/duplicate firing running it twice.

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function israelNow(now: Date): { hour: number; date: string } {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(now)
  );
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now); // yyyy-mm-dd
  return { hour, date };
}

async function alreadySyncedToday(admin: ReturnType<typeof createAdminClient>, israelDate: string): Promise<boolean> {
  const { data } = await admin
    .from("events")
    .select("payload")
    .eq("entity_type", "calendar_cron")
    .eq("entity_id", NIL_UUID)
    .eq("event_type", "cron_sync_completed")
    .order("created_at", { ascending: false })
    .limit(1);
  return (data ?? []).some((e) => (e.payload as { date?: string } | null)?.date === israelDate);
}

type ShowRow = {
  id: string;
  name: string;
  aliases: string[] | null;
  client_id: string | null;
  billing_mode: string;
  default_studio: string | null;
  default_editor_id: string | null;
  active: boolean;
};

async function runSync(events: CalendarEvent[]) {
  const admin = createAdminClient();

  const { data: shows } = await admin
    .from("shows")
    .select("id,name,aliases,client_id,billing_mode,default_studio,default_editor_id,active");
  const showRows = (shows ?? []) as ShowRow[];
  // only active shows open the gate — an archived/retired show's old alias
  // shouldn't start pulling in new recordings again
  const showsForMatch: ShowForMatch[] = showRows
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, aliases: s.aliases ?? [] }));
  const showById = new Map(showRows.map((s) => [s.id, s]));

  const { data: existingRows } = await admin
    .from("productions")
    .select("id,calendar_uid,status,calendar_removed")
    .not("calendar_uid", "is", null);
  const existingByUid = new Map(
    (existingRows ?? []).map((r) => [r.calendar_uid as string, r as ExistingProductionRow])
  );
  const existingIds = (existingRows ?? []).map((r) => r.id);

  // "touched" = any event logged against the production that ISN'T the
  // sync's own bookkeeping — exactly "אין events של שינוי ידני"
  let touchedIds = new Set<string>();
  if (existingIds.length) {
    const { data: evRows } = await admin
      .from("events")
      .select("entity_id,event_type")
      .eq("entity_type", "production")
      .in("entity_id", existingIds);
    touchedIds = new Set(
      (evRows ?? []).filter((e) => !String(e.event_type).startsWith("calendar_")).map((e) => e.entity_id)
    );
  }

  // the studio's real calendar turned out to hold years of history (owner
  // dry-check, 2026-07-16) — never CREATE from anything older than a small
  // grace window; already-tracked productions are exempt (see sync.ts)
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - 2);
  cutoffDate.setUTCHours(0, 0, 0, 0);

  const plan = buildSyncPlan(events, showsForMatch, existingByUid, touchedIds, cutoffDate);

  let created = 0, updated = 0, flaggedChanged = 0, flaggedRemoved = 0, unflaggedRemoved = 0;

  for (const action of plan.toCreate) {
    const show = showById.get(action.show.id);
    if (!show) continue;
    const kind = show.billing_mode === "contract" ? "contract" : show.billing_mode === "per_episode" && show.client_id ? "client" : "internal";
    const recordDate = action.event.start ? action.event.start.toISOString().slice(0, 10) : null;
    const { data: inserted, error } = await admin
      .from("productions")
      .insert({
        podcast_name: show.name,
        show_id: show.id,
        client_id: show.client_id,
        kind,
        record_date: recordDate,
        studio: action.event.location || show.default_studio || null,
        calendar_uid: action.event.uid,
        calendar_synced_at: new Date().toISOString(),
        legacy: false,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    created++;
    // "עורך קבוע" — auto-assign to the edit steps the 6-stage trigger just created
    if (show.default_editor_id && inserted) {
      await admin.from("stages").update({ assignee_id: show.default_editor_id }).eq("production_id", inserted.id).eq("step", "edit");
    }
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: inserted!.id,
      event_type: "calendar_created",
      payload: { calendar_uid: action.event.uid, title: action.event.title, show: show.name },
    });
  }

  for (const action of plan.toUpdate) {
    const recordDate = action.event.start ? action.event.start.toISOString().slice(0, 10) : null;
    const patch: Record<string, unknown> = { calendar_synced_at: new Date().toISOString() };
    if (recordDate) patch.record_date = recordDate;
    if (action.event.location) patch.studio = action.event.location;
    const { error } = await admin.from("productions").update(patch).eq("id", action.productionId);
    if (error) throw new Error(error.message);
    updated++;
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: action.productionId,
      event_type: "calendar_updated",
      payload: { calendar_uid: action.event.uid, patch },
    });
  }

  for (const row of plan.toFlagChanged) {
    const { error } = await admin.from("productions").update({ calendar_changed: true }).eq("id", row.productionId);
    if (error) throw new Error(error.message);
    flaggedChanged++;
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: row.productionId,
      event_type: "calendar_flagged_changed",
      payload: {},
    });
  }

  for (const id of plan.toFlagRemoved) {
    const { error } = await admin.from("productions").update({ calendar_removed: true }).eq("id", id);
    if (error) throw new Error(error.message);
    flaggedRemoved++;
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: id,
      event_type: "calendar_flagged_removed",
      payload: {},
    });
  }

  for (const id of plan.toUnflagRemoved) {
    await admin.from("productions").update({ calendar_removed: false }).eq("id", id);
    unflaggedRemoved++;
  }

  return {
    created,
    updated,
    flaggedChanged,
    flaggedRemoved,
    unflaggedRemoved,
    skippedNoMatch: plan.skippedNoMatch,
    skippedTooOld: plan.skippedTooOld,
  };
}

// Vercel Cron triggers with GET, twice daily (03:00 + 04:00 UTC — see the
// DST note above). Vercel injects `Authorization: Bearer $CRON_SECRET`
// automatically when CRON_SECRET is set.
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "לא מורשה" }, { status: 401 });
  }

  const { hour, date } = israelNow(new Date());
  if (hour !== 6) {
    return NextResponse.json({ ok: true, skipped: "not-6am-israel", israelHour: hour });
  }

  const admin = createAdminClient();
  if (await alreadySyncedToday(admin, date)) {
    return NextResponse.json({ ok: true, skipped: "already-synced-today", israelDate: date });
  }

  const url = process.env.STUDIO_ICS_URL;
  if (!url) return NextResponse.json({ error: "STUDIO_ICS_URL לא מוגדר" }, { status: 500 });
  try {
    const events = await fetchAndParseIcs(url);
    const summary = await runSync(events);
    await admin.from("events").insert({
      entity_type: "calendar_cron",
      entity_id: NIL_UUID,
      event_type: "cron_sync_completed",
      payload: { date, ...summary },
    });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "שגיאת סנכרון" }, { status: 500 });
  }
}

// Manual "סנכרן עכשיו" button. Session-authenticated; accepts an optional
// `icsText` override so the whole pipeline can be exercised against a fake
// calendar before the real STUDIO_ICS_URL is ever configured.
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const testIcsText = typeof body.icsText === "string" ? body.icsText : null;

  try {
    let events: CalendarEvent[];
    if (testIcsText) {
      events = parseIcsText(testIcsText);
    } else {
      const url = process.env.STUDIO_ICS_URL;
      if (!url) return NextResponse.json({ error: "STUDIO_ICS_URL לא מוגדר" }, { status: 500 });
      events = await fetchAndParseIcs(url);
    }
    const summary = await runSync(events);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "שגיאת סנכרון" }, { status: 500 });
  }
}
