import { getSessionAndProfile } from "@/lib/profile";
import { redirect } from "next/navigation";
import SoundWaveLogo from "@/components/SoundWaveLogo";
import SignOutButton from "@/components/SignOutButton";

export default async function PendingPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (profile?.approved) redirect("/");

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="glass-card w-full max-w-md text-center" style={{ padding: "36px 32px" }}>
        <span className="corner-glow" style={{ ["--glow-color" as string]: "rgba(192,132,252,0.24)" }} />
        <div className="glass-content">
          <div className="flex justify-center mb-4">
            <SoundWaveLogo size={34} animated />
          </div>
          <h1 className="text-lg font-bold mb-2">ממתין לאישור</h1>
          <p className="text-[var(--dim)] text-sm leading-relaxed mb-5">
            החשבון שלך (<span className="font-mono" dir="ltr">{profile?.email}</span>) נוצר בהצלחה, אבל עוד לא אושר.
            <br />
            בעל המערכת יקצה לך תפקיד והרשאות, ואז תוכל להיכנס.
          </p>
          <SignOutButton />
        </div>
      </div>
    </main>
  );
}
