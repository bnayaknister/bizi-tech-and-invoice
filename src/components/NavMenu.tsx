"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import LineIcon from "@/components/LineIcon";
import SoundWaveLogo from "@/components/SoundWaveLogo";

/**
 * The header navigation menu (owner request 7.10: "reach every screen from
 * every screen"). Until now the only way between modules was the hub grid.
 *
 * ═══ ONE SOURCE OF TRUTH, AND WHY THE ITEMS ARE A PROP ═══
 * The items are NOT a list this file keeps. AppHeader passes exactly what the
 * hub renders — `MODULES.filter(m => m.hasAccess(profile))` — so whoever
 * cannot see a card cannot see a menu row, by construction rather than by two
 * lists agreeing. They arrive as a prop rather than being imported here
 * because this is a client component: importing `@/modules/registry` would
 * pull every module (and everything a module imports) into the browser
 * bundle. A plain serialisable {key,title,icon,href} crosses the boundary.
 *
 * ═══ NO COUNTS ═══
 * Deliberately absent, and reported to the owner rather than added: a card's
 * number comes from `ModuleDef.getMetric(supabase, profile)`, one database
 * round-trip per module (e.g. bookings.ts:33). The hub pays that once; a menu
 * in AppHeader would pay it on EVERY screen in the app.
 *
 * ═══ WORKS WITHOUT JS ═══
 * The links are always in the DOM — never behind `{open && …}` — and the
 * panel is hidden with CSS. globals.css opens it on hover and on keyboard
 * focus for as long as the root is missing `data-js="on"`, which this
 * component stamps on after mount. So: no JS → a CSS-only hover/focus menu;
 * JS → the `open` state below owns it, which is what lets Esc actually close
 * a panel whose trigger still holds focus.
 */

export type NavItem = { key: string; title: string; icon: string; href: string };

/**
 * The module whose screen we are on, or null. LONGEST href wins, which is the
 * whole reason this is a function and not `pathname === href`: /documents and
 * /documents/registry are two different modules, and a plain prefix test marks
 * both. Exactly one row is ever returned, so the highlight cannot double.
 */
export function activeKeyFor(items: NavItem[], pathname: string | null): string | null {
  if (!pathname) return null;
  let best: NavItem | null = null;
  for (const item of items) {
    const onIt = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (!onIt) continue;
    if (!best || item.href.length > best.href.length) best = item;
  }
  return best ? best.key : null;
}

const PANEL_ID = "navm-panel";

/** touch devices report `(hover: none)`; hover must not open the menu there */
function hoverCapable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover)").matches
  );
}

export default function NavMenu({
  items,
  animatedLogo = false,
}: {
  items: NavItem[];
  animatedLogo?: boolean;
}) {
  const pathname = usePathname();
  const activeKey = activeKeyFor(items, pathname);
  const [open, setOpen] = useState(false);
  const [jsReady, setJsReady] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => setJsReady(true), []);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      // back to the trigger, or the focus ring is stranded on a hidden link
      triggerRef.current?.focus();
    }
    function onOutside(e: Event) {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open]);

  return (
    <div
      data-navm="root"
      ref={rootRef}
      className="navm-root relative shrink-0"
      data-open={open ? "true" : "false"}
      data-js={jsReady ? "on" : undefined}
      onMouseEnter={() => {
        if (hoverCapable()) setOpen(true);
      }}
      onMouseLeave={() => {
        if (hoverCapable()) setOpen(false);
      }}
    >
      <div className="flex items-center gap-1.5">
        {/* unchanged behaviour: the logo is still a plain link home, open menu
            or not — the click is never intercepted */}
        <Link href="/" className="navm-logo flex items-center gap-2 shrink-0">
          <SoundWaveLogo size={22} animated={animatedLogo} />
          <span className="font-mono font-bold text-sm" dir="ltr">
            <span className="grad-text">Bizi Podclub</span>{" "}
            <span className="text-[var(--faint)] font-normal">Manage</span>
          </span>
        </Link>
        <button
          ref={triggerRef}
          type="button"
          aria-label="תפריט ניווט"
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={PANEL_ID}
          onClick={() => setOpen((v) => !v)}
          className="navm-trigger text-[var(--faint)] hover:text-[var(--violet-light)] transition-colors p-1 -m-1"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="navm-chevron"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </div>

      <nav
        id={PANEL_ID}
        aria-label="ניווט"
        className="navm-panel absolute top-full z-30 mt-2 rounded-xl border border-[var(--rule2)] shadow-2xl p-2"
        style={{
          // logical, so RTL opens from the logo's own (right) edge leftwards
          insetInlineStart: 0,
          background: "rgba(15,13,28,0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          width: "min(92vw, 28rem)",
          maxHeight: "min(70vh, 32rem)",
          overflowY: "auto",
        }}
      >
        {/* phone only: there is no mouse to leave, so give it an explicit X */}
        <div className="sm:hidden flex justify-end pb-1">
          <button
            type="button"
            aria-label="סגור תפריט"
            onClick={() => setOpen(false)}
            className="text-[var(--faint)] hover:text-[var(--ink)] transition-colors p-1"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5">
          {items.map((item) => {
            const active = item.key === activeKey;
            return (
              <Link
                key={item.key}
                href={item.href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`navm-item flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? "navm-item-active text-[var(--violet-light)] font-bold"
                    : "text-[var(--dim)] hover:bg-[var(--panel3)] hover:text-[var(--ink)]"
                }`}
              >
                <LineIcon name={item.icon} size={14} className="shrink-0" />
                <span>{item.title}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
