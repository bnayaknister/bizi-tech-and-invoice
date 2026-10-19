import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";
import { hasOwnerAccess } from "@/lib/roles";

export default async function ArchivePage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!hasOwnerAccess(profile)) redirect("/");

  return (
    <ModulePlaceholder
      profile={profile}
      icon="archive"
      title="ארכיון"
      stepNote="מסך חיפוש בארכיון (owner בלבד, קריאה בלבד) ייבנה בהמשך — לא נדרש בסדר הביצוע המפורש."
    />
  );
}
