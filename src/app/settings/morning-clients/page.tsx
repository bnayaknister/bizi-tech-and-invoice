import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import MorningClientsClient from "./MorningClientsClient";

// Client mapping lives under settings — it's a one-time-ish money-admin task,
// not a daily screen. Money edit only: a mapping decides which real client a
// document bills.
export const dynamic = "force-dynamic";

export default async function MorningClientsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_edit_money) redirect("/");

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <MorningClientsClient />
    </div>
  );
}
