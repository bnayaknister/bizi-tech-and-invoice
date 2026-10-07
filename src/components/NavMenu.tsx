"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * How long the menu survives the pointer leaving it.
 *
 * 🔴 NOT a nicety. Without it a diagonal mouse path — down-and-left towards a
 * row, the natural movement in RTL — leaves the trigger for a frame before it
 * reaches the panel, and the menu shuts in the user's face. 200ms is long
 * enough to cross any gap a hand makes and short enough that a deliberate
 * "move away" still feels immediate. Cancelled the instant the pointer comes
 * back inside.
 */
const CLOSE_DELAY_MS = 200;

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
  const closeTimer = useRef<number | null>(null);
  /**
   * Set by Escape, and the reason it has to exist: Escape closes the menu AND
   * returns focus to the trigger — which is inside the root, so the focus
   * handler below would immediately reopen what the user just dismissed. The
   * flag suppresses exactly that one reopen, and is cleared by the next real
   * intent (pointer entering, the trigger being clicked, focus leaving).
   */
  const escaped = useRef(false);

  useEffect(() => setJsReady(true), []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
  }, [cancelClose]);
  const closeNow = useCallback(() => {
    cancelClose();
    setOpen(false);
  }, [cancelClose]);
  /** leave-with-grace: the pointer gets CLOSE_DELAY_MS to come back */
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  // a pending timer must not fire into an unmounted component
  useEffect(() => cancelClose, [cancelClose]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      escaped.current = true;
      cancelClose();
      setOpen(false);
      // back to the trigger, or the focus ring is stranded on a hidden link
      triggerRef.current?.focus();
    }
    function onOutside(e: Event) {
      const root = rootRef.current;
      if (root && !root.contains(e.target as Node)) {
        cancelClose();
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open, cancelClose]);

  return (
    <div
      data-navm="root"
      ref={rootRef}
      className="navm-root relative shrink-0"
      data-open={open ? "true" : "false"}
      data-js={jsReady ? "on" : undefined}
      onMouseEnter={() => {
        if (!hoverCapable()) return;
        escaped.current = false;
        openNow();
      }}
      onMouseLeave={() => {
        if (hoverCapable()) closeSoon();
      }}
      // onFocus/onBlur in React ARE focusin/focusout — they bubble, so these
      // fire for the trigger and for every row inside the panel. That is what
      // keeps the menu open while a keyboard user Tabs through it, and it is
      // the same behaviour the no-JS `:focus-within` rule gives.
      onFocus={(e) => {
        cancelClose();
        if (escaped.current) return;
        // 🔴 KEYBOARD focus only. A pointer press ALSO focuses the trigger, and
        // opening on that fights the click that follows it: focus opens, the
        // click toggles, and the net result is a menu that shuts the instant
        // you tap it. Measured on a 390px touch viewport — one tap produced one
        // click and left the menu closed.
        //
        // `:focus-visible` is exactly the distinction the browser already
        // draws — set for keyboard focus, unset for a mouse or touch press on
        // a button — so the keyboard path keeps the behaviour the no-JS
        // `:focus-within` rule gives, and the pointer path leaves the click as
        // the only opener. Guarded: an engine without the selector throws from
        // `matches`, and the safe default is "do not open" (the click still
        // does).
        const el = e.target as HTMLElement;
        try {
          if (el.matches(":focus-visible")) openNow();
        } catch {
          /* no :focus-visible support — the click opens it */
        }
      }}
      onBlur={(e) => {
        // focus moved somewhere OUTSIDE the menu — close at once. No grace
        // period here: unlike a mouse, focus does not travel through a gap.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          escaped.current = false;
          closeNow();
        }
      }}
    >
      <div className="navm-bar flex items-center gap-1.5">
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
          onClick={() => {
            escaped.current = false;
            cancelClose();
            setOpen((v) => !v);
          }}
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

      {/* ═══ THE BRIDGE ═══
          🔴 This wrapper is the bug fix, not a tidy-up. The panel used to be
          `top-full mt-2` — and a MARGIN is not part of any element's hit area,
          so the 8px between the logo and the panel belonged to neither. Moving
          the pointer down crossed it, `mouseleave` fired on the root, the menu
          closed, and it was unreachable: by the time the pointer arrived the
          panel was already `visibility:hidden; pointer-events:none`.

          The same 8px is now PADDING on this wrapper. Padding IS hit area, and
          the wrapper is a descendant of the root, so the pointer never leaves
          the hover subject on its way down. The visual gap is unchanged — the
          panel's own background still starts 8px below the logo.

          It is also what carries the visibility, so while the menu is closed
          the bridge is `pointer-events:none` too and an invisible strip under
          the logo cannot hold the menu open. See globals.css. */}
      <div className="navm-pop absolute top-full" style={{ insetInlineStart: 0 }}>
      <nav
        id={PANEL_ID}
        aria-label="ניווט"
        className="navm-panel rounded-xl border border-[var(--rule2)] shadow-2xl p-2"
        style={{
          background: "rgba(15,13,28,0.92)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          // 92vw keeps a gutter on a phone; the max-width is belt-and-braces
          // for a wrapped header, where the root may not sit at the screen edge
          width: "min(92vw, 28rem)",
          maxWidth: "calc(100vw - 2rem)",
          // a long list scrolls INSIDE the panel rather than off the screen
          maxHeight: "min(70vh, 32rem)",
          overflowY: "auto",
        }}
      >
        {/* phone only: there is no mouse to leave, so give it an explicit X */}
        <div className="sm:hidden flex justify-end pb-1">
          <button
            type="button"
            aria-label="סגור תפריט"
            onClick={closeNow}
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
                onClick={closeNow}
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
    </div>
  );
}
