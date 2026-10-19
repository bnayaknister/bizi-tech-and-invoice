import { redirect } from "next/navigation";
import { getSessionAndProfile } from "@/lib/profile";
import AppHeader from "@/components/AppHeader";
import ChangePasswordClient from "./ChangePasswordClient";

export const dynamic = "force-dynamic";

// U1-7: "החלפת סיסמה" from the header's user menu — every role.
export default async function ChangePasswordPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (!profile?.approved) redirect("/pending");

  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main className="flex justify-center p-6">
        <ChangePasswordClient />
      </main>
    </div>
  );
}
