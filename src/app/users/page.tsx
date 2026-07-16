import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function UsersPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_manage_users) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="users"
      title="משתמשים"
      stepNote="מסך אישור משתמשים ותיבות הרשאה הוא שלב 7."
    />
  );
}
