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
//
// ═══ BUG 2, FIXED HERE: `relative z-30` ═══ (owner, production, 7.10)
// "The menu is cut off under the global search row and other elements."
//
// 🔴 THE CAUSE IS THIS ELEMENT, not the panel's z-index. `backdrop-filter`
// makes an element a stacking context AND a containing block for positioned
// descendants, so EVERY z-index inside this header is local to it and nothing
// in here can paint above anything outside it. The header was
// `position: static` with `z-index: auto`, so it painted as an ordinary
// in-flow block — and `<main>`, its later sibling, painted over it. The nav
// panel hangs below the header's own box, so page content covered it at any
// z-index. GlobalSearch's dropdown has always had the same ceiling; it is
// just short enough to rarely reach content.
//
// `relative z-30` promotes the header's stacking context above the page. 30 is
// chosen against the layers that already exist in this codebase:
//    z-20  GlobalSearch results, ClientCombobox lists   (below)
//    z-30  THIS HEADER                                  <- here
//    z-40  the EntityDrawer backdrop                    (above)
//    z-50  the drawer panel, every full-screen modal    (above)
//    z-60  modals that must cover the drawer            (above)
//    z-70  the drawer's innermost dialogs               (above)
// So the header now covers page content, and every overlay that is supposed to
// block it still does. A higher number would put the header over the drawer's
// own dimming backdrop, which is the wrong direction: a modal must be able to
// cover the header.
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
      className="relative z-30 flex items-center gap-4 flex-wrap px-5 py-3 border-b border-[var(--rule)]"
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
