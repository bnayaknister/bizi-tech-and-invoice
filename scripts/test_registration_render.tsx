/**
 * E17-4 — the registration page as rendered, and the switch's 404. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_registration_render.tsx
 *
 * ═══ F19 ═══
 * renderToString only: no server, no database, no network (`global.fetch`
 * throws). With the switch off, the page and the route are asked to answer
 * BEFORE they reach anything that would read the database — which is the
 * property under test.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import JoinForm, { JOIN_FORM_TITLE } from "../src/app/join/[token]/JoinForm";
import { JOIN_DEAD, JOIN_THANKS_BODY, JOIN_THANKS_TITLE, JoinDeadLink, JoinThanks, BRAND } from "../src/app/join/[token]/JoinScreens";
import JoinPage, { metadata } from "../src/app/join/[token]/page";
import { POST as submitPOST } from "../src/app/api/join/submit/route";
import ClientsScreen, { NEW_LINK_LABEL } from "../src/app/clients/ClientsScreen";
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
const TOKEN = "A".repeat(43);

async function main() {
  console.log("\n── 1. the form");
  {
    const manual = renderToString(<JoinForm token={TOKEN} lockedNumber={null} whatsappNumber={null} />);
    check("title once", countOf(manual, `>${JOIN_FORM_TITLE}<`), 1);
    check("brand once", countOf(manual, `>${BRAND}<`), 1);
    check("RTL", manual.includes('dir="rtl"'), true);
    for (const label of ["שם (עסק או פרטי)", "ח.פ / ע.מ / ת.ז", "מייל", "טלפון", "שם הפודקאסט", "מספר וואטסאפ"]) {
      check(`required field "${label}" once`, countOf(manual, `>${label}<`), 1);
    }
    check("optional fields: address + contact", [countOf(manual, ">כתובת<"), countOf(manual, ">שם איש קשר<")], [1, 1]);
    check("required markers: 7 (name, ח.פ, mail, phone, podcast, booking name, booking number)", countOf(manual, "> *<"), 7);
    check("privacy checkbox links to /privacy", countOf(manual, 'href="/privacy"'), 1);
    check("honeypot present, hidden from people", manual.includes('aria-hidden="true"') && manual.includes('name="website"') && manual.includes('tabindex="-1"'), true);
    check("manual link: the number is typed (no disabled field)", countOf(manual, 'disabled=""'), 0);
    check("the token is not printed in the page", manual.includes(TOKEN), false);
    check("'add a second number' offered", countOf(manual, "הוספת מספר שני"), 1);

    const bot = renderToString(<JoinForm token={TOKEN} lockedNumber="050-123-4567" whatsappNumber={null} />);
    check("bot link: the number is shown, locked", bot.includes('value="050-123-4567"') && countOf(bot, 'disabled=""') === 1, true);
  }

  console.log("\n── 2. the fixed screens");
  {
    const dead = renderToString(<JoinDeadLink whatsappNumber="972500000000" />);
    check("dead: the one sentence", countOf(dead, JOIN_DEAD), 1);
    check("dead: a WhatsApp button when the number is configured", countOf(dead, 'href="https://wa.me/972500000000"'), 1);
    check("dead: no button without it", countOf(renderToString(<JoinDeadLink whatsappNumber={null} />), "wa.me"), 0);
    const thanks = renderToString(<JoinThanks />);
    check("thanks: title + body, once each", [countOf(thanks, JOIN_THANKS_TITLE), countOf(thanks, JOIN_THANKS_BODY)], [1, 1]);
    check("thanks: says nothing about a match", /קיים|כרטיס|התאמה/.test(thanks), false);
    check("metadata: noindex + no-referrer + generic title", [metadata.robots, metadata.referrer, metadata.title], [
      { index: false, follow: false },
      "no-referrer",
      "Bizi Podclub — פתיחת לקוח",
    ]);
  }

  console.log("\n── 3. switch OFF = 404, before any read");
  {
    delete process.env.REGISTRATION_ENABLED;
    let digest: string | null = null;
    try {
      await JoinPage({ params: { token: TOKEN } });
    } catch (e) {
      digest = (e as { digest?: string }).digest ?? (e as Error).message;
    }
    check("the page calls notFound()", digest, "NEXT_NOT_FOUND");
    const res = await submitPOST(new Request("https://x/api/join/submit", { method: "POST", body: JSON.stringify({ token: TOKEN }) }));
    check("the submit route answers 404", res.status, 404);
  }

  console.log("\n── 4. /clients: 'קישור הרשמה חדש'");
  {
    const noop = () => {};
    const router = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop } as unknown as React.ContextType<typeof AppRouterContext>;
    const data = (over: Partial<ClientsScreenData>): ClientsScreenData => ({
      rows: [], card: null, canEditMoney: true, canSeePending: true, canManageBookingContacts: true,
      canCreateRegistrationLink: false, matchedRegistrations: [], today: "2026-10-11", ...over,
    });
    const r = (d: ClientsScreenData) => renderToString(<AppRouterContext.Provider value={router}><ClientsScreen data={d} /></AppRouterContext.Provider>);
    check("not allowed (or switch off): the button is drawn ZERO times", countOf(r(data({})), NEW_LINK_LABEL), 0);
    check("studio_admin + switch on: once", countOf(r(data({ canCreateRegistrationLink: true })), NEW_LINK_LABEL), 1);
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"}  ${passed}/${passed + failed} assertions passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
