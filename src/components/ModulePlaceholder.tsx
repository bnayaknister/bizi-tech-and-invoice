import AppHeader from "@/components/AppHeader";
import type { Profile } from "@/lib/profile";

export default function ModulePlaceholder({
  profile,
  icon,
  title,
  stepNote,
}: {
  profile: Profile;
  icon: string;
  title: string;
  stepNote: string;
}) {
  return (
    <div className="min-h-screen">
      <AppHeader profile={profile} />
      <main className="max-w-3xl mx-auto p-6">
        <div className="border border-[var(--rule)] rounded bg-[var(--panel2)] p-10 text-center">
          <div className="text-3xl mb-3">{icon}</div>
          <h1 className="font-bold mb-2">{title}</h1>
          <p className="text-[var(--dim)] text-sm">{stepNote}</p>
        </div>
      </main>
    </div>
  );
}
