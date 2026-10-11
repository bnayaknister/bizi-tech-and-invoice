/**
 * E17-3 — "הרשאות הזמנת חדרים" is Bnaya and Eli's (studio_admin) only, to view
 * AND to edit, and the /clients pending tab is theirs too. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_booking_contacts_access.tsx
 *
 * ═══ F19 ═══
 * No database, no network, no dev server. `global.fetch` throws, and the
 * renders are renderToString — effects never run, so the self-fetching card
 * cannot reach its route even when it is drawn.
 *
 * ═══ WHAT IS PROVED, AND HOW ═══
 *   1. the predicate, per role — the one function the route, the drawer's
 *      response and the /clients loader all ask
 *   2. the /clients screen, rendered: the tab is drawn 0 times without the flag
 *      and exactly once with it (rule 56 — counts, not "contains"); the
 *      "ממתינים לאישור" tab likewise; a pending card carries its badge and no
 *      Morning block
 *   3. the server side, read from source: the route gates on that predicate and
 *      no longer on the money flags; the entity route sends the flag; the
 *      drawer draws the card only on an explicit `true`
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import ClientsScreen, { PENDING_BADGE } from "../src/app/clients/ClientsScreen";
import { buildClientList, NOT_MAPPED } from "../src/lib/clients/overview";
import { clientFieldMeta } from "../src/lib/clients/fields";
import { BOOKING_CONTACTS_FORBIDDEN, canManageBookingContacts } from "../src/lib/clients/access";
import type { Profile } from "../src/lib/profile";
import type { ClientsScreenData } from "../src/app/clients/data";

global.fetch = (() => {
  throw new Error("F19: this suite must not perform any fetch");
}) as unknown as typeof fetch;

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
const countOf = (html: string, needle: string) => html.split(needle).length - 1;

const base: Profile = {
  id: "u", name: "x", email: "x@x", role: "owner", approved: true,
  can_view_money: true, can_edit_money: true, can_view_stages: true, can_edit_stages: true,
  can_manage_users: true, can_import: true, studio_admin: false,
};

// ═══ 1. the predicate ═══════════════════════════════════════════════════════
console.log("\n── 1. who may see and edit the tab");
check("studio_admin (Bnaya / Eli): yes", canManageBookingContacts({ ...base, studio_admin: true }), true);
check("an owner with every money flag but not studio_admin (Shiri): NO", canManageBookingContacts(base), false);
const bookkeeper: Profile = { ...base, role: "bookkeeper", can_manage_users: false };
const tech: Profile = { ...base, role: "tech", can_view_money: false, can_edit_money: false };
check("a bookkeeper with money sight: NO", canManageBookingContacts(bookkeeper), false);
check("a tech: NO", canManageBookingContacts(tech), false);
check("an UNAPPROVED studio_admin: NO", canManageBookingContacts({ ...base, studio_admin: true, approved: false }), false);
check("no profile: NO", canManageBookingContacts(null), false);

// ═══ 2. the screen, rendered ═════════════════════════════════════════════════
console.log("\n── 2. /clients, rendered");
{
  const noop = () => {};
  const stubRouter = {
    back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop,
  } as unknown as React.ContextType<typeof AppRouterContext>;
  const render = (node: React.ReactNode) =>
    renderToString(<AppRouterContext.Provider value={stubRouter}>{node}</AppRouterContext.Provider>);

  const rows = buildClientList(
    [
      { id: "c1", name: "גל אורן", normalized_name: "גל אורן", morning_client_id: "m1", merged_into: null, status: "active" },
      { id: "c9", name: "נרשם חדש", normalized_name: "נרשם חדש", morning_client_id: null, merged_into: null, status: "pending" },
    ],
    [{ id: "s1", name: "הפודקאסט של גל", client_id: "c1", active: true }],
    [],
    "2026-10-11"
  );
  const card = {
    id: "c1", name: "גל אורן", status: "active",
    entity: { id: "c1", name: "גל אורן" },
    fields: clientFieldMeta(base),
    shows: [], contracts: [], debt: 0, debtJobs: [], documents: [], productions: [],
  };
  const data = (over: Partial<ClientsScreenData>): ClientsScreenData => ({
    rows, card, canEditMoney: true, canSeePending: false, canManageBookingContacts: false, canCreateRegistrationLink: false, matchedRegistrations: [], today: "2026-10-11", ...over,
  });
  const TAB = 'data-block="booking-contacts"';

  const shiri = render(<ClientsScreen data={data({})} />);
  check("not studio_admin: the booking tab is drawn ZERO times", countOf(shiri, TAB), 0);
  check("not studio_admin: no 'ממתינים לאישור' tab", countOf(shiri, ">ממתינים לאישור<"), 0);
  check("not studio_admin: the pending client is in no list", countOf(shiri, ">נרשם חדש<"), 0);

  const bnaya = render(<ClientsScreen data={data({ canSeePending: true, canManageBookingContacts: true })} />);
  check("studio_admin: the booking tab is drawn exactly once", countOf(bnaya, TAB), 1);
  check("studio_admin: the 'ממתינים לאישור' tab once", countOf(bnaya, ">ממתינים לאישור<"), 1);
  check("studio_admin: the pending client is NOT in the default 'פעילים' list", countOf(bnaya, ">נרשם חדש<"), 0);

  const pendingCard = { ...card, id: "c9", name: "נרשם חדש", status: "pending" };
  const pend = render(<ClientsScreen data={data({ canSeePending: true, canManageBookingContacts: true, card: pendingCard })} />);
  check("a pending card carries the badge once (header)", countOf(pend, PENDING_BADGE), 1);
  check("a pending card does not say 'not mapped' — it says pending", countOf(pend, NOT_MAPPED), 0);
  // "מתוך מורנינג" is the header line of both Morning blocks. The active card
  // must carry it (otherwise the zero below proves nothing).
  const activeCard = render(<ClientsScreen data={data({ canSeePending: true, canManageBookingContacts: true })} />);
  check("an active card DOES carry the Morning blocks (control)", countOf(activeCard, "מתוך מורנינג") > 0, true);
  check("a pending card offers no Morning block", countOf(pend, "מתוך מורנינג"), 0);
}

// ═══ 3. the server side, from source ═════════════════════════════════════════
console.log("\n── 3. the route, the drawer and its response");
{
  const root = join(__dirname, "..", "src");
  const code = (p: string) =>
    readFileSync(join(root, p), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

  const route = code("app/api/clients/[id]/booking-contacts/route.ts");
  check("route: gates on canManageBookingContacts", route.includes("canManageBookingContacts(profile)"), true);
  check("route: reads studio_admin", route.includes('.select("approved,studio_admin")'), true);
  check("route: no longer gates on can_view_money", route.includes("can_view_money"), false);
  check("route: no longer gates on can_edit_money", route.includes("can_edit_money"), false);
  check("route: every handler runs the gate first (3 handlers, 3 gates)", countOf(route, "const g = await gate();"), 3);
  check("route: the refusal is the shared sentence", route.includes("BOOKING_CONTACTS_FORBIDDEN"), true);
  check("the refusal sentence", BOOKING_CONTACTS_FORBIDDEN, "הרשאות הזמנת חדרים — לבניה ולאלי בלבד");

  const entity = code("app/api/entity/[type]/[id]/route.ts");
  check("entity GET: sends the flag from the same predicate", entity.includes("canManageBookingContacts: canManageBookingContacts(profile)"), true);

  const drawer = code("components/EntityDrawer.tsx");
  check(
    "drawer: draws the card only on an explicit true",
    drawer.includes("data.canManageBookingContacts === true && <ClientBookingContactsCard"),
    true
  );
  check("drawer: exactly one place renders the card", countOf(drawer, "<ClientBookingContactsCard"), 1);

  const screen = code("app/clients/ClientsScreen.tsx");
  check("/clients: exactly one place renders the card", countOf(screen, "<ClientBookingContactsCard"), 1);
}

console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
process.exit(failed === 0 ? 0 : 1);
