import AppHeader from "@/components/AppHeader";
import IconTile from "@/components/IconTile";
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
        <div className="glass-card text-center" style={{ padding: "40px" }}>
          <span className="corner-glow" style={{ ["--glow-color" as string]: "rgba(192,132,252,0.22)" }} />
          <div className="glass-content">
            <div className="flex justify-center mb-4">
              <IconTile icon={icon} accent="violet" size={48} iconSize={24} />
            </div>
            <h1 className="font-bold mb-2">{title}</h1>
            <p className="text-[var(--dim)] text-sm">{stepNote}</p>
          </div>
        </div>
      </main>
    </div>
  );
}
