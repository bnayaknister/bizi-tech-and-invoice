import { createHash } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { parseIcsText, type CalendarEvent } from "@/lib/calendar/parse";
import { matchTitleToShow, type ShowForMatch } from "@/lib/calendar/match";
import { roomsInTitle } from "@/lib/calendar/rooms";
import { STUDIOS } from "@/lib/calendar/studios";
import { ACTIVE_CLIENT, excludeShowsOfInactiveClients } from "@/lib/clients/status";

// ═══════════════════════════════════════════════════════════════════════════
// E9-6 — recordings the TEAM wrote into the shared calendar by hand (owner,
// 22.10). Not booking_requests: no row in the system, no guest, no link.
// ═══════════════════════════════════════════════════════════════════════════
//
// Two readers:
//   · "📋 ההקלטות שלי" lists them beside the bot's own, marked "נקבע ע"י
//     הצוות" — date, time, length and room only. NEVER the event's title or
//     a guest: the title is the team's text, and it can carry another
//     podcast's guest.
//   · the automatic-approval rule א ("one recording per podcast per day")
//     counts them, so a podcast the team already booked twice that day is not
//     auto-approved a third time.
//
// WHICH EVENT IS WHOSE: exactly the 06:00 sync's rule — the title matched
// against EVERY active show of an active (or no) client, the longest alias
// winning (matchTitleToShow). Matched against all shows and only THEN
// narrowed to the number's own, so an alias that is a substring of another
// show's title cannot hand that show's recording to this number.
//
// NOT A TEAM RECORDING: an event the system wrote itself (its iCalUID is on a
// booking_requests row — that recording is already listed / counted as a
// request), an all-day event, a recurring master, an event with no end.

export type TeamRecording = {
  uid: string;
  showId: string;
  start: Date;
  end: Date;
  /** the bookable room named in the title / location, or null when none is */
  room: string | null;
};

/** A stable UUID for a calendar uid — the bot's list ids accept UUIDs only. PURE. */
export function uuidFromUid(uid: string): string {
  const h = createHash("sha1").update(`team-calendar:${uid}`).digest("hex");
  // shaped as a version-5 UUID (variant 10xx)
  const v = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${v}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** The team's recordings in [from, to). PURE. */
export function teamRecordingsFromFeed(
  events: CalendarEvent[],
  shows: ShowForMatch[],
  systemUids: ReadonlySet<string>,
  window: { from: Date; to: Date }
): TeamRecording[] {
  const out: TeamRecording[] = [];
  for (const e of events) {
    if (!e.start || !e.end || e.recurrence || e.allDay) continue;
    if (e.end <= e.start) continue;
    if (e.start < window.from || e.start >= window.to) continue;
    if (e.uid && systemUids.has(e.uid)) continue;
    const m = matchTitleToShow(e.title, shows);
    if (!m) continue;
    const rooms = roomsInTitle(`${e.title} ${e.location ?? ""}`, STUDIOS);
    out.push({ uid: e.uid, showId: m.show.id, start: e.start, end: e.end, room: rooms[0] ?? null });
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Read-only, never cached (the availability read's own rule). */
async function fetchFeed(url: string): Promise<CalendarEvent[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`קריאת היומן נכשלה: ${res.status}`);
  return parseIcsText(await res.text());
}

/** The shows the sync matches against: active, of an active client or of none. */
async function loadMatchShows(admin: SupabaseClient<Database>): Promise<ShowForMatch[]> {
  const [{ data: shows, error: sErr }, { data: inactive, error: cErr }] = await Promise.all([
    admin.from("shows").select("id,name,aliases,active,client_id"),
    // clients-status: reads the NON-active ids on purpose — their shows are dropped below
    admin.from("clients").select("id").neq("status", ACTIVE_CLIENT),
  ]);
  if (sErr) throw new Error(`קריאת התוכניות נכשלה: ${sErr.message}`);
  if (cErr) throw new Error(`קריאת הלקוחות נכשלה: ${cErr.message}`);
  const rows = (shows ?? []) as { id: string; name: string; aliases: string[] | null; active: boolean; client_id: string | null }[];
  return excludeShowsOfInactiveClients(rows, new Set((inactive ?? []).map((c) => c.id as string)))
    .filter((s) => s.active)
    .map((s) => ({ id: s.id, name: s.name, aliases: s.aliases ?? [] }));
}

/** iCalUIDs of events the system wrote (any request status). */
async function loadSystemUids(admin: SupabaseClient<Database>, from: Date): Promise<Set<string>> {
  const { data, error } = await admin
    .from("booking_requests")
    .select("calendar_event_uid")
    .not("calendar_event_uid", "is", null)
    .gte("end_at", from.toISOString());
  if (error) throw new Error(`קריאת אירועי המערכת נכשלה: ${error.message}`);
  return new Set((data ?? []).map((r) => r.calendar_event_uid as string).filter(Boolean));
}

/**
 * The team's recordings in [from, to), optionally only for `showIds`. ONE read
 * of the feed. THROWS on any failure — each caller decides its own safe side
 * (the list shows the system's recordings only; rule א does not auto-approve).
 */
export async function loadTeamRecordings(
  admin: SupabaseClient<Database>,
  opts: { from: Date; to: Date; showIds?: string[] }
): Promise<TeamRecording[]> {
  const url = process.env.STUDIO_ICS_URL;
  if (!url) throw new Error("STUDIO_ICS_URL לא מוגדר");
  const [events, shows, systemUids] = await Promise.all([fetchFeed(url), loadMatchShows(admin), loadSystemUids(admin, opts.from)]);
  const all = teamRecordingsFromFeed(events, shows, systemUids, opts);
  return opts.showIds ? all.filter((r) => opts.showIds!.includes(r.showId)) : all;
}
