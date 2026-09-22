import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import { createClient } from "@/lib/supabase/server";
import { bookableRoomForDefault } from "@/lib/calendar/rooms";
import { STUDIOS } from "@/lib/calendar/studios";
import AppHeader from "@/components/AppHeader";
import AvailabilityClient from "./AvailabilityClient";
import type { Show } from "./AvailabilityBody";

// Stage 2 of client-booked recordings: the OWNER previews what a client would
// see, before any client link exists (the public link is stage 3, not this).
// Owner-only through the gate that already existed — `profile.role !== "owner"`,
// the same three lines as /settings and /archive.
//
// This page performs the ONE database read on this screen: the show list for the
// preview selector. Read-only, no filter beyond ordering. Everything else comes
// from /api/calendar/availability, which reads the ICS feed and writes nothing.
export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (profile.role !== "owner") redirect("/");

  const supabase = createClient();
  const { data: rows } = await supabase
    .from("shows")
    .select("id,name,default_studio")
    .order("name", { ascending: true });

  // The default room is resolved HERE, once, rather than in the browser: it is a
  // pure mapping of a stored column onto the canonical room list, and doing it
  // server-side keeps `default_studio` — a value the client has no business
  // seeing, since TLV and unrecognised spellings both resolve to "no default" —
  // out of the payload entirely.
  const shows: Show[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    name: (r.name as string) ?? "—",
    defaultRoom: bookableRoomForDefault(r.default_studio as string | null, STUDIOS),
  }));

  return (
    <>
      <AppHeader profile={profile} />
      <main>
        <AvailabilityClient shows={shows} />
      </main>
    </>
  );
}
