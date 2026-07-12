import Link from "next/link";
import GlobalSearch from "@/components/GlobalSearch";
import SignOutButton from "@/components/SignOutButton";
import type { Profile } from "@/lib/profile";

// Meant to be dropped into every authenticated screen — the hub today,
// and every module page as they get built — so global search really is
// global, not just a hub feature.
export default function AppHeader({ profile }: { profile: Profile }) {
  return (
    <header className="flex items-center gap-4 flex-wrap px-5 py-3 border-b border-[var(--rule)] bg-[var(--panel2)]">
      <Link href="/" className="flex items-center gap-2 shrink-0">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2" y="9" width="2.5" height="6" rx="1" fill="#3FD68C" />
          <rect x="6.5" y="5" width="2.5" height="14" rx="1" fill="#3FD68C" />
          <rect x="11" y="2" width="2.5" height="20" rx="1" fill="#F2B441" />
          <rect x="15.5" y="6" width="2.5" height="12" rx="1" fill="#FF4D4D" />
          <rect x="20" y="10" width="2.5" height="4" rx="1" fill="#56C8E8" />
        </svg>
        <span className="font-black text-sm">ביזי סטודיו</span>
      </Link>
      <GlobalSearch />
      <span className="flex-1" />
      <span className="text-xs text-[var(--dim)]">{profile.name || profile.email}</span>
      <SignOutButton />
    </header>
  );
}
