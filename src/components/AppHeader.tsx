import Link from "next/link";
import GlobalSearch from "@/components/GlobalSearch";
import NavMenu, { type NavItem } from "@/components/NavMenu";
import SignOutButton from "@/components/SignOutButton";
import type { Profile } from "@/lib/profile";
import { MODULES } from "@/modules/registry";

// Dropped into every authenticated screen so global search is truly global.
// `animatedLogo` is passed only on the hub (DESIGN.md §3.1) — working
// screens keep the logo static so nothing dances next to live money.
//
// The logo is also the navigation menu's trigger (owner 7.10). The item list
// is built HERE, server-side, from the same expression src/app/page.tsx uses
// to build the hub grid — `MODULES.filter(m => m.hasAccess(profile))` — so
// the menu and the cards cannot disagree about who sees what. getMetric is
// NOT called: that is one query per module, which the hub pays once and a
// header would pay on every screen.
export default function AppHeader({
  profile,
  animatedLogo = false,
}: {
  profile: Profile;
  animatedLogo?: boolean;
}) {
  const navItems: NavItem[] = MODULES.filter((m) => m.hasAccess(profile)).map(
    ({ key, title, icon, href }) => ({ key, title, icon, href })
  );

  return (
    <header
      className="flex items-center gap-4 flex-wrap px-5 py-3 border-b border-[var(--rule)]"
      style={{ background: "rgba(15, 13, 28, 0.6)", backdropFilter: "blur(16px)" }}
    >
      <NavMenu items={navItems} animatedLogo={animatedLogo} />
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
