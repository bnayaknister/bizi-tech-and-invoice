import Link from "next/link";
import GlobalSearch from "@/components/GlobalSearch";
import SignOutButton from "@/components/SignOutButton";
import SoundWaveLogo from "@/components/SoundWaveLogo";
import type { Profile } from "@/lib/profile";

// Dropped into every authenticated screen so global search is truly global.
// `animatedLogo` is passed only on the hub (DESIGN.md §3.1) — working
// screens keep the logo static so nothing dances next to live money.
export default function AppHeader({
  profile,
  animatedLogo = false,
}: {
  profile: Profile;
  animatedLogo?: boolean;
}) {
  return (
    <header
      className="flex items-center gap-4 flex-wrap px-5 py-3 border-b border-[var(--rule)]"
      style={{ background: "rgba(15, 13, 28, 0.6)", backdropFilter: "blur(16px)" }}
    >
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <SoundWaveLogo size={22} animated={animatedLogo} />
        <span className="font-mono font-bold text-sm" dir="ltr">
          <span className="grad-text">BiziPodclub</span> <span className="text-[var(--faint)] font-normal">Manage</span>
        </span>
      </Link>
      <GlobalSearch />
      <span className="flex-1" />
      {profile.can_import && (
        <Link href="/import" className="text-xs text-[var(--dim)] hover:text-[var(--violet-light)]">
          ייבוא
        </Link>
      )}
      <span className="text-xs text-[var(--dim)]">{profile.name || profile.email}</span>
      <SignOutButton />
    </header>
  );
}
