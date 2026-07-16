import AppHeader from "@/components/AppHeader";
import LineIcon from "@/components/LineIcon";
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
        <div className="border border-[var(--rule)] rounded-lg bg-[var(--panel2)] p-10 text-center">
          <div className="flex justify-center mb-3 text-[var(--violet-light)]">
            <LineIcon name={icon} size={30} />
          </div>
          <h1 className="font-bold mb-2">{title}</h1>
          <p className="text-[var(--dim)] text-sm">{stepNote}</p>
        </div>
      </main>
    </div>
  );
}
