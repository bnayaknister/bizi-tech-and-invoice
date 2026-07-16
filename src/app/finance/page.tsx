import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import ModulePlaceholder from "@/components/ModulePlaceholder";

export default async function FinancePage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");
  if (!profile.can_view_money) redirect("/");

  return (
    <div>
      <ModulePlaceholder
        profile={profile}
        icon="finance"
        title="כספים"
        stepNote="מסך חיובים/חשבוניות/גבייה/ייצוא CSV הוא שלב 6."
      />
      <div className="max-w-5xl mx-auto px-6 -mt-4">
        <Link
          href="/finance/link"
          className="inline-block text-sm border border-[var(--rule)] rounded px-4 py-2 hover:bg-[var(--panel3)]"
        >
          🔗 קישור חיובים להפקות
        </Link>
      </div>
    </div>
  );
}
