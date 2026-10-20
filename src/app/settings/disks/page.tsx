import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import { hasOwnerAccess } from "@/lib/roles";
import { loadDisks } from "@/lib/disks.server";
import DisksClient from "./DisksClient";

// B35: the recording disks the technician picks from. Owner/admin only,
// like the rest of /settings.
export const dynamic = "force-dynamic";

export default async function DisksPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!hasOwnerAccess(profile)) redirect("/");

  const disks = await loadDisks();
  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <DisksClient initialDisks={disks} />
      </main>
    </div>
  );
}
