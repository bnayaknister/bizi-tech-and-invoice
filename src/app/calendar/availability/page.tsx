import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import AvailabilityClient from "./AvailabilityClient";

// Stage 2 of client-booked recordings: the OWNER verifies the computation
// before any client sees it. Owner-only, using the gate that already exists —
// `profile.role !== "owner"` redirects, the same three lines as /settings and
// /archive. No new role and no new column: there was already an owner-only
// tier, and stage 2 is exactly what it is for.
//
// The public client-facing link is stage 3 and is deliberately not this page.
// Nothing here writes: the route it calls reads the ICS feed and computes.
export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (profile.role !== "owner") redirect("/");

  return (
    <>
      <AppHeader profile={profile} />
      <main className="max-w-6xl mx-auto p-6">
        <AvailabilityClient />
      </main>
    </>
  );
}
