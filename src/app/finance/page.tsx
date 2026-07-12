import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function FinancePage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="💰"
      title="כספים"
      stepNote="מסך חיובים/חשבוניות/גבייה/ייצוא CSV הוא שלב 6."
    />
  );
}
