import { getSessionAndProfile } from "@/lib/profile";
import { redirect } from "next/navigation";

export default async function PendingPage() {
  const { user, profile } = await getSessionAndProfile();
  if (!user) redirect("/login");
  if (profile?.approved) redirect("/");

  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center border border-[var(--rule)] rounded bg-[var(--panel2)] p-10">
        <div className="text-2xl mb-3">⏳</div>
        <h1 className="text-lg font-bold mb-2">ממתין לאישור</h1>
        <p className="text-[var(--dim)] text-sm leading-relaxed">
          החשבון שלך ({profile?.email}) נוצר בהצלחה, אבל עוד לא אושר.
          <br />
          פנה לבעלים של המערכת כדי לקבל הרשאות.
        </p>
      </div>
    </main>
  );
}
