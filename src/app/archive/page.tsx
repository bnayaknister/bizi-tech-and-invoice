import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function ArchivePage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (profile.role !== "owner") redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="🗄️"
      title="ארכיון"
      stepNote="מסך חיפוש בארכיון (owner בלבד, קריאה בלבד) ייבנה בהמשך — לא נדרש בסדר הביצוע המפורש."
    />
  );
}
