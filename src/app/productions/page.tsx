import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function ProductionsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_stages) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="productions"
      title="הפקות"
      stepNote="הקנבן (6 עמודות, גרירה, bulk edit) הוא שלב 5."
    />
  );
}
