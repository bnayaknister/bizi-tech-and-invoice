import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function RadarPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="radar"
      title="רדאר"
      stepNote="המסך המלא (VU + התראות + חוב לגבייה/התחייבות פתוחה) הוא שלב 4."
    />
  );
}
