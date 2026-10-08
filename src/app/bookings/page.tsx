import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createAdminClient } from "@/lib/supabase/admin";
import AppHeader from "@/components/AppHeader";
import { cleanAliasFor } from "@/lib/booking/alias";
import { splitQueue, type QueueRow } from "@/lib/booking/queue";
import { STUDIOS } from "@/lib/calendar/studios";
import BookingsClient from "./BookingsClient";

// The owner's request queue (3ג). Owner-only through the gate that already
// existed — the same three lines as /calendar/availability, /settings and
// /archive. A hidden module card is not an authorisation, so the page repeats
// the check and so do both routes.
//
// Everything about TIME is decided here, on the server, once: `splitQueue`
// takes `now` as an argument and the browser receives finished view models. A
// client that re-derived "has this passed?" from its own clock would show a
// different screen to an owner whose laptop is an hour out.
export const dynamic = "force-dynamic";

export default async function BookingsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (profile.role !== "owner") redirect("/");

  // 0099 is applied (7.10) and database.types.ts was regenerated, so the two
  // calendar_write_* columns below are known to the generated types; the
  // untyped client is kept here only because this page never needed the
  // typed one. `production_id` is NOT selected: an approval does not create
  // a production (owner correction 7.10 — see
  // lib/booking/writeCalendarEvent.ts), so that column is never written and
  // reading it would only ever yield null.
  const admin = createAdminClient();

  // ⚠️ The service-role client, and `guest` and `note` are in the select.
  // On the PUBLIC side those two columns are kept out of every payload
  // deliberately; here they are the whole point — the owner is the one person
  // who is supposed to read them, and the guest is what the calendar title is
  // built from.
  const { data: rows } = await admin
    .from("booking_requests")
    .select("id,show_id,studio,start_at,end_at,guest,note,status,created_at,decided_by,calendar_write_status,calendar_write_error,shows(name,aliases)")
    .order("start_at", { ascending: false })
    // A ceiling well above the 30 history rows the screen shows, so the split
    // is done over a superset rather than over a window that might not contain
    // the 30 newest decided rows. Cheap: the table gains a handful of rows a week.
    .limit(400);

  const queueRows: QueueRow[] = (rows ?? []).map((r) => {
    const show = r.shows as unknown as { name: string; aliases: string[] | null } | null;
    return {
      id: r.id,
      show_id: r.show_id,
      showName: show?.name ?? "—",
      studio: r.studio,
      start_at: r.start_at,
      end_at: r.end_at,
      guest: r.guest,
      note: r.note,
      status: r.status,
      created_at: r.created_at,
      // The clean alias, resolved HERE — the calendar title is built from it in
      // ./queue, and the approve route builds the same title the same way from
      // the same function. A show with no clean alias never got a link and so
      // has no requests; the raw name is the fallback, and the owner sees the
      // title before pasting it either way.
      // ⚠️ the fallback chain is IDENTICAL to the approve route's, character for
      // character. Both build the title from the same function on the same
      // inputs, so they agree by construction — and they must, because the
      // owner copies the title from this screen and the route claims to have
      // produced the same one. `showName` above falls back to "—" for display;
      // an alias must not, or the title would carry a dash.
      alias: cleanAliasFor({ name: show?.name ?? "", aliases: show?.aliases ?? [] }, STUDIOS) ?? show?.name ?? "",
      calendarWriteStatus: (r.calendar_write_status as "created" | "failed" | null) ?? null,
      calendarWriteError: (r.calendar_write_error as string | null) ?? null,
      // 🔴 NULL ON AN APPROVED ROW MEANS AUTOMATIC (E9-2). Selected for the
      // first time here: before the automatic path existed, every approval had
      // an actor and the column had nothing to say.
      decidedBy: (r.decided_by as string | null) ?? null,
    };
  });

  const { waiting, history } = splitQueue(queueRows, new Date());

  return (
    <>
      <AppHeader profile={profile} />
      <main>
        <BookingsClient waiting={waiting} history={history} />
      </main>
    </>
  );
}
