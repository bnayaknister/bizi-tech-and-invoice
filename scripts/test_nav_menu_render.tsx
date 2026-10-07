/**
 * The header navigation menu (owner 7.10: reach every screen from every
 * screen). Renders the REAL AppHeader, per role, per pathname.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_nav_menu_render.tsx
 *
 * ═══ F19 ═══
 * Creates no users, writes nothing, reads no database, opens no socket and
 * needs no dev server. The one thing it touches outside memory is
 * src/app/globals.css, read-only, because the "closed by default" claim is
 * half CSS and a test that only looked at the HTML could not see it.
 *
 * The supabase env vars below are set to junk ON PURPOSE and only if absent:
 * AppHeader renders SignOutButton, which constructs a browser supabase client
 * at render time (SignOutButton.tsx:8). Constructing one makes no request —
 * @supabase/ssr only validates that the two strings exist — so junk keeps the
 * suite offline while still letting the real header render. `require` instead
 * of a static import because imports hoist above this and the client would be
 * built from undefined.
 *
 * ═══ WHY THESE ASSERTIONS COUNT (rule 56) ═══
 * The whole risk in this change is arithmetic, not appearance. "The link is
 * in the menu" passes just as well when the link is in the menu twice, and
 * "the current screen is highlighted" passes when two rows are highlighted —
 * which is exactly what a naive `pathname.startsWith(href)` does to
 * /documents/registry, since /documents is a DIFFERENT module. So every
 * assertion here is an occurrence count against an exact expected number.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import GlobalSearch from "../src/components/GlobalSearch";
import SignOutButton from "../src/components/SignOutButton";
import Link from "next/link";
import NavMenu, { activeKeyFor, type NavItem } from "../src/components/NavMenu";
import { MODULES } from "../src/modules/registry";
import type { Profile } from "../src/lib/profile";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1/ztest-not-contacted";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "ztest-anon-key-not-a-secret";
const AppHeader = (
  require("../src/components/AppHeader") as {
    default: React.ComponentType<{ profile: Profile; animatedLogo?: boolean }>;
  }
).default;

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}\n       got:  ${g}\n       want: ${w}`);
  }
}

/** visible text: undo React's <!-- --> text separators and entity escaping */
const seen = (html: string) =>
  html.replace(/<!--.*?-->/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const countOf = (html: string, needle: string) => seen(html).split(needle).length - 1;

// Every capability ON, so `role` is the only thing separating these profiles —
// the same fixture shape test_nav_availability_render.tsx uses.
const base: Omit<Profile, "role"> = {
  id: "00000000-0000-0000-0000-000000000000",
  name: "ZTEST",
  email: "ztest@example.com",
  approved: true,
  can_view_money: true,
  can_edit_money: true,
  can_view_stages: true,
  can_edit_stages: true,
  can_manage_users: true,
  can_import: true,
};
const owner: Profile = { ...base, role: "owner" };
const tech: Profile = { ...base, role: "tech" };
const bookkeeper: Profile = { ...base, role: "bookkeeper" };
const noMoneyTech: Profile = { ...base, role: "tech", can_view_money: false, can_edit_money: false };

// SignOutButton calls useRouter, which throws without the App Router
// context — the same stub test_registry_header_render.tsx uses. None of its
// methods is ever reached: nothing in this suite clicks anything.
const noop = () => {};
const stubRouter = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} as unknown as React.ContextType<typeof AppRouterContext>;

const inApp = (node: React.ReactNode, pathname: string | null) =>
  renderToString(
    <AppRouterContext.Provider value={stubRouter}>
      <PathnameContext.Provider value={pathname}>{node}</PathnameContext.Provider>
    </AppRouterContext.Provider>
  );

const renderHeader = (profile: Profile, pathname: string | null = null) =>
  inApp(<AppHeader profile={profile} />, pathname);

/** what the HUB puts on screen for this profile — the list the menu must equal */
const hubModules = (profile: Profile) => MODULES.filter((m) => m.hasAccess(profile));

// an item's title renders as <span>TITLE</span>. The delimiters are load
// bearing: "מסמכים" is a prefix of "מסמכים לאישור", so a bare substring count
// would report the docregistry row twice.
const titleCount = (html: string, title: string) => countOf(html, `>${title}</span>`);
// Every menu row's opening <a>, in order. Matched rather than counted by a
// fixed needle because React emits attributes in JSX order (aria-current,
// class, href), and an assertion that hard-codes that order tests React's
// serialiser instead of the menu.
const itemTags = (html: string) => seen(html).match(/<a\b[^>]*class="navm-item [^"]*"[^>]*>/g) ?? [];
const hrefCount = (html: string, href: string) => countOf(html, `href="${href}"`);

console.log("\n=== the menu is the hub's list, not a second list ===");
{
  // if two modules shared a title or an href, "exactly once" would be
  // meaningless — so that is established before it is relied on
  check("registry titles are distinct", MODULES.length, new Set(MODULES.map((m) => m.title)).size);
  check("registry hrefs are distinct", MODULES.length, new Set(MODULES.map((m) => m.href)).size);

  for (const [label, profile] of [
    ["owner", owner],
    ["tech", tech],
    ["bookkeeper", bookkeeper],
    ["tech without money", noMoneyTech],
  ] as const) {
    const html = renderHeader(profile);
    const visible = hubModules(profile);

    // 1. every module the hub shows appears ONCE — never twice
    const wrongTitle = visible.filter((m) => titleCount(html, m.title) !== 1);
    check(`${label}: every hub module is in the menu exactly once`, wrongTitle.map((m) => m.key), []);
    const wrongHref = visible.filter((m) => hrefCount(html, m.href) !== 1);
    check(`${label}: every hub module's href appears exactly once`, wrongHref.map((m) => m.key), []);

    // 2. a module this profile may NOT see appears zero times
    const hidden = MODULES.filter((m) => !m.hasAccess(profile));
    const leakedTitle = hidden.filter((m) => titleCount(html, m.title) !== 0);
    check(`${label}: unauthorised modules appear 0 times (title)`, leakedTitle.map((m) => m.key), []);
    const leakedHref = hidden.filter((m) => hrefCount(html, m.href) !== 0);
    check(`${label}: unauthorised modules appear 0 times (href)`, leakedHref.map((m) => m.key), []);

    // 3. the menu holds NOTHING ELSE: row count == hub count. This is the
    //    assertion a hand-written second list would fail.
    check(`${label}: menu row count equals hub card count`, countOf(html, 'class="navm-item '), visible.length);
  }

  // the named case the owner would notice: bookings is owner-only
  const asTech = renderHeader(tech);
  check("tech: בקשות הקלטה zero times", titleCount(asTech, "בקשות הקלטה"), 0);
  check("owner: בקשות הקלטה once", titleCount(renderHeader(owner), "בקשות הקלטה"), 1);
}

console.log("\n=== the current screen is marked exactly once ===");
{
  // every module's own screen, plus the sub-routes that live under one
  const cases: [string, string | null][] = [
    ...MODULES.map((m) => [m.href, m.key] as [string, string]),
    ["/documents/registry", "docregistry"],
    ["/documents/gaps", "documents"],
    ["/documents/accrued", "documents"],
    ["/settings/morning-clients", "settings"],
    ["/finance/link", "finance"],
    ["/shows/assign", "shows"],
    ["/calendar/availability", "availability"],
    ["/", null],
    ["/import", null],
    ["/pending", null],
    [null as unknown as string, null],
  ];
  const items: NavItem[] = hubModules(owner).map(({ key, title, icon, href }) => ({ key, title, icon, href }));
  for (const [pathname, expectedKey] of cases) {
    check(`activeKeyFor(${pathname}) = ${expectedKey}`, activeKeyFor(items, pathname), expectedKey);
  }

  // and in the DOM: one aria-current, on the right row, or none off-module
  for (const [pathname, expectedKey] of cases) {
    if (pathname == null) continue;
    const html = renderHeader(owner, pathname);
    const want = expectedKey ? 1 : 0;
    check(`${pathname}: aria-current="page" ${want} time(s)`, countOf(html, 'aria-current="page"'), want);
    if (expectedKey) {
      const mod = MODULES.find((m) => m.key === expectedKey)!;
      // the marked row is THAT module's row — the marker and the href in one
      // and the same tag, so a highlight on the wrong row cannot pass
      const marked = itemTags(html).filter((t) => t.includes('aria-current="page"'));
      check(`${pathname}: the marked row is ${expectedKey}`, marked.map((t) => t.includes(`href="${mod.href}"`)), [true]);
    }
  }

  // /documents vs /documents/registry is the trap: longest href wins, and the
  // SHORTER module must not also light up
  const onRegistry = renderHeader(owner, "/documents/registry");
  check("on /documents/registry only one row is marked", countOf(onRegistry, 'aria-current="page"'), 1);
  check(
    "on /documents/registry the מסמכים לאישור row is NOT marked",
    itemTags(onRegistry).filter((t) => t.includes('aria-current="page"') && t.includes('href="/documents"')).length,
    0
  );
}

console.log("\n=== closed by default on the server, links still in the DOM ===");
{
  const html = renderHeader(owner, "/radar");
  check("the root reports closed", countOf(html, 'data-open="false"'), 1);
  check("the root is never rendered open", countOf(html, 'data-open="true"'), 0);
  // data-js is stamped on in an effect, so a server render must not carry it:
  // that is what keeps the CSS-only fallback live for a no-JS client
  check("no data-js on the server render", countOf(html, "data-js"), 0);
  check("the trigger reports collapsed", countOf(html, 'aria-expanded="false"'), 1);
  check("the trigger is never expanded on the server", countOf(html, 'aria-expanded="true"'), 0);

  // the links are PRESENT even though the panel is closed — the whole point:
  // no `{open && …}` anywhere, so the menu works with JavaScript off
  const visible = hubModules(owner);
  check(
    "every link is in the closed panel's DOM",
    visible.filter((m) => hrefCount(html, m.href) !== 1).map((m) => m.key),
    []
  );
  check("the panel element is present once", countOf(html, 'class="navm-panel '), 1);

  // ...and it is CSS that hides it. Asserted against globals.css, because the
  // HTML above cannot tell a hidden panel from a visible one.
  const css = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");
  // 🔴 .navm-pop, NOT .navm-panel. The visibility moved onto the bridge when
  // bug 1 was fixed, and it has to live there: if only the panel were
  // click-through while closed, the bridge would be an invisible 8px strip
  // under the logo that holds the menu open.
  const popRule = css.slice(css.indexOf(".navm-pop {"), css.indexOf(".navm-root[data-open="));
  check(".navm-pop is hidden", /visibility:\s*hidden/.test(popRule), true);
  check(".navm-pop is click-through while hidden", /pointer-events:\s*none/.test(popRule), true);
  check(
    "the only unconditional reveal is data-open",
    /\.navm-root\[data-open="true"\]\s*>\s*\.navm-pop\s*\{[^}]*visibility:\s*visible/.test(css),
    true
  );
  // the hover and focus fallbacks are gated on the absence of data-js, so JS,
  // once mounted, is the single owner of open/closed (and Esc can close)
  check(
    "the hover fallback is JS-gated and hover-gated",
    /@media \(hover: hover\) \{\s*\.navm-root:not\(\[data-js="on"\]\):hover/.test(css),
    true
  );
  check(
    "the focus fallback is JS-gated",
    /\.navm-root:not\(\[data-js="on"\]\):focus-within/.test(css),
    true
  );
}

console.log("\n=== 🔴 bug 1: one hover wrapper, and no dead gap to cross ===");
{
  const html = renderHeader(owner, "/radar");
  const css = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");
  const nav = readFileSync(join(__dirname, "..", "src", "components", "NavMenu.tsx"), "utf8");

  // ── the structure: trigger row AND panel inside ONE hover subject ──
  // The root is the element that carries the mouse handlers and that the CSS
  // `:hover` rule names. Both the bar and the bridge must be inside it, or
  // moving the pointer from one to the other leaves the subject.
  const rootOpen = html.indexOf('<div data-navm="root"');
  const barAt = html.indexOf('class="navm-bar ');
  const popAt = html.indexOf('class="navm-pop ');
  const panelAt = html.indexOf('id="navm-panel"');
  check("the root is present once", countOf(html, '<div data-navm="root"'), 1);
  check("the trigger row is present once", countOf(html, 'class="navm-bar '), 1);
  check("the bridge is present once", countOf(html, 'class="navm-pop '), 1);
  check("the bar is inside the root", rootOpen >= 0 && barAt > rootOpen, true);
  check("the bridge is inside the root, after the bar", popAt > barAt, true);
  check("the panel is inside the bridge", panelAt > popAt, true);
  // the bridge is a CHILD of the root — the `>` in the CSS rules depends on it
  check(
    "the bridge is a direct child of the root",
    /<div data-navm="root"[^>]*>\s*(<!--.*?-->)?\s*<div class="navm-bar [^"]*">[\s\S]*?<div class="navm-pop /.test(seen(html)),
    true
  );

  // ── the dead gap is gone ──
  // 🔴 THE BUG: `mt-2` is a MARGIN, and margin is not hit area. The 8px
  // between the logo and the panel belonged to no element, so crossing it
  // fired mouseleave on the root and the menu closed before it could be used.
  check("the panel no longer carries the margin gap", /navm-panel[^"]*\bmt-2\b/.test(html), false);
  check("no element in the menu carries mt-2 any more", countOf(html, "mt-2"), 0);
  // the same 8px is now PADDING on the bridge, which IS hit area
  const popRule = css.slice(css.indexOf(".navm-pop {"), css.indexOf(".navm-root[data-open="));
  check("the bridge pads the gap instead", /padding-top:\s*8px/.test(popRule), true);

  // ── the CSS layer (no JS) keeps it open on hover of the WRAPPER ──
  // the subject of :hover must be the root, not the logo: hovering the panel
  // is hovering a descendant of the root, which keeps :hover true
  check(
    "the hover rule's subject is the root, and it reveals the bridge",
    /@media \(hover: hover\) \{\s*\.navm-root:not\(\[data-js="on"\]\):hover\s*>\s*\.navm-pop\s*\{[^}]*visibility:\s*visible/.test(css),
    true
  );
  check("no rule hangs the menu off the logo's own hover", /\.navm-logo:hover/.test(css), false);
  check(
    "the focus rule's subject is also the root",
    /\.navm-root:not\(\[data-js="on"\]\):focus-within\s*>\s*\.navm-pop\s*\{[^}]*visibility:\s*visible/.test(css),
    true
  );

  // ── the JS layer: leave with grace, and focus holds it open ──
  const navCode = nav.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("a close delay exists", /CLOSE_DELAY_MS\s*=\s*(\d+)/.test(navCode), true);
  check(
    "the delay is 200ms",
    (/CLOSE_DELAY_MS\s*=\s*(\d+)/.exec(navCode) ?? [])[1],
    "200"
  );
  check("leaving schedules the close, not an immediate one", navCode.includes("closeSoon()"), true);
  check("re-entering cancels it", navCode.includes("cancelClose()"), true);
  // mouseleave must NOT call setOpen(false) directly any more — that is the
  // diagonal-mouse bug
  check(
    "onMouseLeave no longer closes immediately",
    /onMouseLeave=\{\(\) => \{\s*if \(hoverCapable\(\)\) closeSoon\(\);/.test(nav),
    true
  );
  // focus keeps it open while the keyboard is inside it
  check("focus is handled on the root", /onFocus=\{/.test(nav), true);
  check("focus leaving the root closes it", /relatedTarget/.test(nav), true);
  // and Esc still closes WITHOUT the returned focus reopening it
  check("Esc sets the no-reopen guard", /escaped\.current = true/.test(navCode), true);
  check("the guard is consulted before reopening on focus", /if \(escaped\.current\)/.test(navCode), true);
  check("Esc still returns focus to the trigger", navCode.includes("triggerRef.current?.focus()"), true);
}

console.log("\n=== 🔴 bug 2: the chosen layer, and nothing clipping above it ===");
{
  const css = readFileSync(join(__dirname, "..", "src", "app", "globals.css"), "utf8");
  const header = readFileSync(join(__dirname, "..", "src", "components", "AppHeader.tsx"), "utf8");
  const nav = readFileSync(join(__dirname, "..", "src", "components", "NavMenu.tsx"), "utf8");
  const html = renderHeader(owner, "/radar");

  // ── the header is what was promoted ──
  // 🔴 THE BUG: backdrop-filter makes the header a stacking context, so no
  // z-index on a descendant can escape it. The header was static/auto and
  // <main>, its later sibling, painted over it.
  check("the header is positioned", /className="relative z-30 /.test(header), true);
  check("the header's layer is 30", countOf(header, 'className="relative z-30 '), 1);
  check("the rendered header carries it", countOf(html, 'class="relative z-30 '), 1);

  // ── and 30 is the right slot, measured against what exists ──
  // This is not a magic number: these are the layers in the codebase today.
  // If a new overlay appears below 40, this is where it gets noticed.
  const src = ["src/components/EntityDrawer.tsx", "src/components/GlobalSearch.tsx"].map((rel) =>
    readFileSync(join(__dirname, "..", ...rel.split("/")), "utf8")
  );
  check("GlobalSearch's dropdown is still z-20", /className="absolute z-20 /.test(src[1]), true);
  check("the drawer's backdrop is still z-40", src[0].includes("fixed inset-0 z-40"), true);
  check("the drawer's panel is still z-50", src[0].includes("z-50 w-full max-w-md"), true);
  check("the drawer's dialogs are still z-[60]/z-[70]", src[0].includes("z-[70]"), true);
  // the header must sit ABOVE the page's dropdowns and BELOW every overlay
  check("30 is above GlobalSearch's 20", 30 > 20, true);
  check("30 is below the drawer backdrop's 40", 30 < 40, true);

  // ── inside the header, the bridge beats the other dropdown ──
  const popRule = css.slice(css.indexOf(".navm-pop {"), css.indexOf(".navm-root[data-open="));
  check("the bridge has its own z-index", /z-index:\s*40/.test(popRule), true);
  // the panel itself must NOT keep a competing one
  check("the panel carries no z-index class", /navm-panel[^"]*\bz-\d/.test(html), false);

  // ── nothing in the ancestor chain clips or traps the panel ──
  // chain: body > div.min-h-screen > header > .navm-root > .navm-pop > nav
  check("the header does not clip", /className="relative z-30[^"]*overflow/.test(header), false);
  check("the header has no transform", /transform/.test(header), false);
  check("the header has no contain", /contain:/.test(header), false);
  // .navm-root is `relative shrink-0` and nothing else — no overflow, no
  // transform, no filter, so it is NOT a stacking context of its own and the
  // bridge's z-index resolves in the header's context as intended
  check(
    "the root is only positioned, nothing more",
    /className="navm-root relative shrink-0"/.test(nav),
    true
  );
  check("the root does not clip", /navm-root[^"]*overflow/.test(nav), false);
  for (const prop of ["overflow", "transform", "filter", "contain"]) {
    const rootRule = css.slice(css.indexOf(".navm-root"), css.indexOf(".navm-pop {"));
    check(`globals.css adds no ${prop} to .navm-root`, new RegExp(`\\.navm-root[^{]*\\{[^}]*${prop}:`).test(rootRule), false);
  }

  // ── the phone: never wider than the screen, scrolls inside ──
  check("the panel is capped to the viewport", /maxWidth: "calc\(100vw - 2rem\)"/.test(nav), true);
  check("the panel is capped to 92vw", /width: "min\(92vw, 28rem\)"/.test(nav), true);
  check("a long list scrolls inside the panel", /overflowY: "auto"/.test(nav), true);
  check("the panel has a max height", /maxHeight: "min\(70vh, 32rem\)"/.test(nav), true);
  // the bridge must not clip the panel's shadow or its scroll
  check("the bridge sets no overflow", /overflow/.test(popRule), false);
}

console.log("\n=== accessibility and the approved wordings ===");
{
  const html = renderHeader(owner, "/radar");
  check("the trigger's label is the approved string", countOf(html, 'aria-label="תפריט ניווט"'), 1);
  check("the panel is a nav labelled ניווט", countOf(html, '<nav id="navm-panel" aria-label="ניווט"'), 1);
  check("the trigger says it has a popup", countOf(html, 'aria-haspopup="true"'), 1);
  check("the trigger controls the panel", countOf(html, 'aria-controls="navm-panel"'), 1);
  // plain anchors, not buttons with onClick: that is what "works without JS"
  // and "Tab between the items" both reduce to
  check("every row is an <a>", itemTags(html).length, hubModules(owner).length);
  // and nothing else carries the row class — if a row were a <button> with an
  // onClick it would be counted here but not above
  check("no non-anchor carries the row class", countOf(html, 'class="navm-item '), itemTags(html).length);
  // the item names are EXACTLY the hub card names — not a re-worded copy
  check(
    "item names are the module titles verbatim",
    hubModules(owner).filter((m) => titleCount(html, m.title) !== 1).length,
    0
  );
}

console.log("\n=== regression: the rest of the header is untouched ===");
{
  /**
   * The header as it was before this commit, minus the logo link — the logo
   * moved INSIDE the menu root, so it is the one part that legitimately
   * changed place. Everything else is compared byte for byte against the new
   * header with the menu subtree excised. A reordered search box, a dropped
   * ייבוא link or a changed header class all fail here.
   */
  const AppHeaderBefore = ({ profile }: { profile: Profile }) => {
    return (
      <header
        // ⚠️ WIDENED 7.10 WITH `relative z-30`, and that is the deliberate
        // change this assertion exists to force someone to make. The header
        // creates a stacking context (backdrop-filter), so the nav panel could
        // not paint above page content at any z-index of its own — the header
        // itself had to be promoted. The assertion's INTENT is unchanged and is
        // still what is checked: everything in the header that is not the logo
        // or the menu is byte-identical. Only the header's own layer moved.
        className="relative z-30 flex items-center gap-4 flex-wrap px-5 py-3 border-b border-[var(--rule)]"
        style={{ background: "rgba(15, 13, 28, 0.6)", backdropFilter: "blur(16px)" }}
      >
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
  };

  /** cut out <div data-navm="root" …>…</div> by counting div depth */
  const stripNavMenu = (html: string): string => {
    const start = html.indexOf('<div data-navm="root"');
    if (start < 0) return html;
    let i = start;
    let depth = 0;
    let end = -1;
    while (i < html.length) {
      if (html.startsWith("</div>", i)) {
        depth -= 1;
        if (depth === 0) {
          end = i + 6;
          break;
        }
        i += 6;
        continue;
      }
      if (html.startsWith("<div", i) && /[\s>]/.test(html[i + 4])) {
        depth += 1;
        i += 4;
        continue;
      }
      i += 1;
    }
    check("the menu subtree is balanced and locatable", end > start, true);
    return html.slice(0, start) + html.slice(end);
  };

  for (const [label, profile] of [
    ["owner", owner],
    ["tech without money", noMoneyTech],
    ["importer off", { ...owner, can_import: false } as Profile],
  ] as const) {
    const before = inApp(<AppHeaderBefore profile={profile} />, "/radar");
    const after = stripNavMenu(renderHeader(profile, "/radar"));
    check(`${label}: header outside the menu is byte-identical`, after, before);
  }

  // the logo itself still behaves as it did: one link, straight to the hub
  const html = renderHeader(owner, "/radar");
  check("the logo still links home, exactly once", hrefCount(html, "/"), 1);
  check("the wordmark is unchanged", countOf(html, ">Bizi Podclub</span>"), 1);
  check("the Manage half is unchanged", countOf(html, ">Manage</span>"), 1);
  check("the logo link is not nested in an anchor", countOf(html, "<a><a"), 0);

  // AppHeader is used on ~20 screens; none of them pass items, so a missing
  // default would be a build error rather than a silent empty menu
  check("the hub still asks for the animated logo", renderHeader(owner).includes("navm-logo"), true);
}

console.log("\n=== no counts: the menu costs zero extra queries ===");
{
  // getMetric is never referenced outside the hub. If a future change puts a
  // badge in the header, this fails and the owner gets told before it ships.
  // comments stripped first: both files DISCUSS getMetric and the registry at
  // length, and a grep over the prose would fail on the documentation itself
  const code = (file: string) =>
    readFileSync(join(__dirname, "..", "src", "components", file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const headerCode = code("AppHeader.tsx");
  const menuCode = code("NavMenu.tsx");
  check("AppHeader still imports the registry (it is the source)", headerCode.includes("modules/registry"), true);
  check("AppHeader never calls getMetric", headerCode.includes("getMetric("), false);
  check("NavMenu never calls getMetric", menuCode.includes("getMetric("), false);
  // and the client component does not drag the registry into the browser bundle
  check("NavMenu does not import the module registry", menuCode.includes("modules/registry"), false);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
