import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAndParseIcs, parseIcsText, type CalendarEvent } from "@/lib/calendar/parse";
import { buildSyncPlan, type ExistingProductionRow } from "@/lib/calendar/sync";
import { extractGuestFromTitle, type ShowForMatch } from "@/lib/calendar/match";

// Google Calendar sync (screens-spec §11, owner rules 2026-07-16/17):
//   GET  — Vercel Cron trigger. Authorizes via CRON_SECRET, always reads
//          the real STUDIO_ICS_URL.
//   POST — manual "sync now" button. Authorizes via the caller's own
//          session (can_edit_stages). May pass `icsText` to test against a
//          fake calendar instead of the real one — this is how the fake-ICS
//          verification runs, and it's exempt from the on/off gate below
//          (a test never touches the real calendar regardless).
// Either path funnels into the same runSync() so cron and manual behave
// identically; only auth and the event source differ.
//
// Vercel Cron is UTC-only, no timezone support — but the owner wants
// exactly 06:00 Israel time year-round, across the DST transition.
// vercel.json fires this route twice daily (03:00 UTC and 04:00 UTC); one
// of the two lands on 06:00 Israel depending on the season, the other on
// 05:00 or 07:00. israelNow() below is the gate: only the trigger that
// actually lands on local 06:00 proceeds. alreadySyncedToday() is a second,
// independent guard against any retry/duplicate firing running it twice.
//
// Window (owner decision 2026-07-17): "today only" — a production is
// created on the morning of its own recording day, never ahead, never
// behind. The real calendar turned out to hold 8 years of history, and an
// earlier grace-window design still let months-ahead bookings in (found
// in review) — today's Israel calendar day, exactly, closes both gaps.
//
// calendar_sync_enabled (app_settings, owner decision 2026-07-17): the
// owner is still populating show aliases: until this flag is on, neither
// the cron nor a real manual sync may touch the live calendar at all.

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// "HH:MM" in Israel local time — stored on the production so two same-day
// recordings of the same show read differently on the card (screens-spec,
// multi-episode session support, owner request 2026-07-17).
function israelTimeHHMM(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function israelNow(now: Date): { hour: number; date: string } {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", hour: "2-digit", hour12: false }).format(now)
  );
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now); // yyyy-mm-dd
  return { hour, date };
}

// [start, end) of today's Israel calendar day, as UTC instants — used both
// to filter the fetched calendar events and to scope which already-synced
// productions are even eligible for update/flag/removed handling.
function israelDayWindow(now: Date): { date: string; start: Date; end: Date } {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem" }).format(now);
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const offsetStr = offsetParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+2";
  const offsetHours = Number(offsetStr.replace("GMT", "")) || 2;
  const start = new Date(`${date}T00:00:00.000${offsetHours >= 0 ? "+" : "-"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { date, start, end };
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

async function syncEnabled(admin: ReturnType<typeof createAdminClient>): Promise<boolean> {
  const { data } = await admin.from("app_settings").select("calendar_sync_enabled").eq("id", true).maybeSingle();
  return data?.calendar_sync_enabled === true;
}

type ShowRow = {
  id: string;
  name: string;
  aliases: string[] | null;
  client_id: string | null;
  billing_mode: string;
  default_studio: string | null;
  camera_count: number | null;
  default_editor_id: string | null;
  active: boolean;
};

async function runSync(events: CalendarEvent[], todayIsraelDate: string) {
  const admin = createAdminClient();

  const { data: shows } = await admin
    .from("shows")
    .select("id,name,aliases,client_id,billing_mode,default_studio,camera_count,default_editor_id,active");
  const showRows = (shows ?? []) as ShowRow[];
  // only active shows open the gate — an archived/retired show's old alias
  // shouldn't start pulling in new recordings again
  const showsForMatch: ShowForMatch[] = showRows
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, aliases: s.aliases ?? [] }));
  const showById = new Map(showRows.map((s) => [s.id, s]));

  // "today only": existing productions are eligible for update/flag/removed
  // handling ONLY if their own record_date is today — a production from
  // another day is invisible to this run either way, so it can never be
  // wrongly flagged "removed" just for falling outside a scan it was never
  // part of to begin with
  // merged-away productions (calendar duplicate merged, or split undone) are
  // soft-hidden from the board — they must stay invisible to the sync too
  const { data: existingRows } = await admin
    .from("productions")
    .select("id,calendar_uid,status,calendar_removed")
    .not("calendar_uid", "is", null)
    .is("merged_into", null)
    .eq("record_date", todayIsraelDate);
  const existingByUid = new Map(
    (existingRows ?? []).map((r) => [r.calendar_uid as string, r as ExistingProductionRow])
  );
  const existingIds = (existingRows ?? []).map((r) => r.id);

  // Split siblings deliberately share one calendar_uid (screens-spec: a
  // technician-split production stays linked to the source calendar event),
  // so existingByUid above only ever holds one representative row per uid.
  // Expand any per-uid flag/unflag action to every row sharing that uid, or
  // a removed/changed calendar event would only ever be caught on whichever
  // sibling buildSyncPlan happened to see.
  const siblingIdsByUid = new Map<string, string[]>();
  const uidByProductionId = new Map<string, string>();
  for (const r of existingRows ?? []) {
    const uid = r.calendar_uid as string;
    uidByProductionId.set(r.id, uid);
    const arr = siblingIdsByUid.get(uid) ?? [];
    arr.push(r.id);
    siblingIdsByUid.set(uid, arr);
  }
  const expandToSiblings = (id: string): string[] => {
    const uid = uidByProductionId.get(id);
    return uid ? siblingIdsByUid.get(uid) ?? [id] : [id];
  };

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

  const plan = buildSyncPlan(events, showsForMatch, existingByUid, touchedIds);

  let created = 0, updated = 0, flaggedChanged = 0, flaggedRemoved = 0, unflaggedRemoved = 0;

  for (const action of plan.toCreate) {
    const show = showById.get(action.show.id);
    if (!show) continue;
    const kind = show.billing_mode === "contract" ? "contract" : show.billing_mode === "per_episode" && show.client_id ? "client" : "internal";
    const recordDate = action.event.start ? action.event.start.toISOString().slice(0, 10) : todayIsraelDate;
    const { data: inserted, error } = await admin
      .from("productions")
      .insert({
        podcast_name: show.name,
        show_id: show.id,
        client_id: show.client_id,
        kind,
        record_date: recordDate,
        record_time: action.event.start ? israelTimeHHMM(action.event.start) : null,
        guest: extractGuestFromTitle(action.event.title, action.alias),
        // LOCATION on the calendar event overrides the show's default —
        // camera_count has no such override, it's a straight copy
        studio: action.event.location || show.default_studio || null,
        camera_count: show.camera_count,
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
    const patch: Record<string, unknown> = { calendar_synced_at: new Date().toISOString() };
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

  const changedIds = new Set(plan.toFlagChanged.flatMap((row) => expandToSiblings(row.productionId)));
  for (const id of Array.from(changedIds)) {
    const { error } = await admin.from("productions").update({ calendar_changed: true }).eq("id", id);
    if (error) throw new Error(error.message);
    flaggedChanged++;
    await admin.from("events").insert({
      entity_type: "production",
      entity_id: id,
      event_type: "calendar_flagged_changed",
      payload: {},
    });
  }

  const removedIds = new Set(plan.toFlagRemoved.flatMap((id) => expandToSiblings(id)));
  for (const id of Array.from(removedIds)) {
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

  const unflaggedIds = new Set(plan.toUnflagRemoved.flatMap((id) => expandToSiblings(id)));
  for (const id of Array.from(unflaggedIds)) {
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
  if (!(await syncEnabled(admin))) {
    return NextResponse.json({ ok: true, skipped: "calendar-sync-disabled" });
  }
  if (await alreadySyncedToday(admin, date)) {
    return NextResponse.json({ ok: true, skipped: "already-synced-today", israelDate: date });
  }

  const url = process.env.STUDIO_ICS_URL;
  if (!url) return NextResponse.json({ error: "STUDIO_ICS_URL לא מוגדר" }, { status: 500 });
  try {
    const { start, end } = israelDayWindow(new Date());
    const allEvents = await fetchAndParseIcs(url);
    const events = allEvents.filter((e) => e.start && e.start >= start && e.start < end);
    const summary = await runSync(events, date);
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
// calendar — that path is exempt from calendar_sync_enabled, since a test
// never reads the real calendar regardless of the flag.
export async function POST(request: Request) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "לא מחובר" }, { status: 401 });
  const { data: profile } = await supabase.from("profiles").select("can_edit_stages").eq("id", user.id).single();
  if (!profile?.can_edit_stages) return NextResponse.json({ error: "אין הרשאת עריכת שלבים" }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const testIcsText = typeof body.icsText === "string" ? body.icsText : null;

  const admin = createAdminClient();
  if (!testIcsText && !(await syncEnabled(admin))) {
    return NextResponse.json({ error: "סנכרון היומן כבוי (calendar_sync_enabled=false)" }, { status: 403 });
  }

  try {
    const { date, start, end } = israelDayWindow(new Date());
    let events: CalendarEvent[];
    if (testIcsText) {
      events = parseIcsText(testIcsText).filter((e) => !e.start || (e.start >= start && e.start < end));
    } else {
      const url = process.env.STUDIO_ICS_URL;
      if (!url) return NextResponse.json({ error: "STUDIO_ICS_URL לא מוגדר" }, { status: 500 });
      const allEvents = await fetchAndParseIcs(url);
      events = allEvents.filter((e) => e.start && e.start >= start && e.start < end);
    }
    const summary = await runSync(events, date);
    // a real (non-test) manual run — logged separately from cron_sync_completed
    // (which alreadySyncedToday() keys off) so the settings screen can show
    // "last sync run" across both trigger sources without touching that gate
    if (!testIcsText) {
      await admin.from("events").insert({
        entity_type: "calendar_cron",
        entity_id: NIL_UUID,
        event_type: "manual_sync_completed",
        actor_id: user.id,
        payload: { date, ...summary },
      });
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "שגיאת סנכרון" }, { status: 500 });
  }
}
