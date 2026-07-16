import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function ContractsPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="contracts"
      title="חוזים"
      stepNote="מסך חוזים ואבני דרך הוא שלב 6."
    />
  );
}
