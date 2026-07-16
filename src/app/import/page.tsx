import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import ImportClient from "./ImportClient";

export default async function ImportPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_import) redirect("/");

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main>
        <ImportClient />
      </main>
    </div>
  );
}
