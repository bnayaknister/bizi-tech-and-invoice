/**
 * Renders AccruedClient and asserts what the bookkeeper actually SEES — then
 * renders it against deliberately broken payloads and asserts it does not
 * throw.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_accrued_render.tsx
 * Reads nothing, writes nothing, needs no dev server.
 *
 * ═══ WHY ═══
 * Two different failures, one file.
 *
 * (1) The split is only real if the HEADINGS distinguish the cards. Two cards
 * of the same client reading "מצנע" twice would be worse than the single card
 * they replaced — the bookkeeper would have two identical "פדה" buttons
 * folding different months and no way to tell which. buildAccruedCards can
 * prove the rows are partitioned; only a render can prove she can see it.
 *
 * ⚠️ COUNTING assertions, not `includes` (rule 56). `html.includes("אוקטובר
 * 2026")` passes when the month is printed three times, which is precisely the
 * regression this screen was prone to: the month used to appear in a strip
 * INSIDE the card as well, so a card whose heading never gained the month
 * would still match. Every assertion below counts occurrences.
 *
 * (2) The class of bug test_projects_render.tsx was written for: a tab holding
 * the previous JS chunk runs the old expression against the new payload. On
 * 2026-08-27 that crashed /projects with "Cannot read properties of undefined
 * (reading 'length')" while 80 HTTP assertions passed, because they fetched
 * HTML and matched strings. This commit changes the payload of this screen —
 * `months` becomes one entry per card and three fields are added — so the
 * missing-field cases are rendered explicitly.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import AccruedClient, { type AccruedGroup, type AccruedRow } from "../src/app/documents/accrued/AccruedClient";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (!ok && detail ? `   [${detail}]` : ""));
  if (!ok) failures++;
};
const survives = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
    failures++;
  }
};

/** How many times `needle` occurs in `hay`. The only form of assertion here. */
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const occurs = (html: string, needle: string, want: number) =>
  check(`"${needle}" appears ${want}×`, count(html, needle) === want, `found ${count(html, needle)}`);

// AccruedClient calls useRouter, so it cannot be rendered bare — it needs the
// App Router context. Providing that context is the whole mock, exactly as
// test_documents_edit_render.tsx does it: no module interception, just the
// provider Next itself uses. The stub's methods are never called by a render;
// they exist so the shape is honest.
const noop = () => {};
const stubRouter = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} as unknown as React.ContextType<typeof AppRouterContext>;

const render = (groups: AccruedGroup[]) =>
  renderToString(
    <AppRouterContext.Provider value={stubRouter}>
      <AccruedClient groups={groups} issuedOrders={[]} canRedeem={true} />
    </AppRouterContext.Provider>
  );

// The show name is deliberately NOT the client name: every assertion here
// counts occurrences, and a row printing "מצנע" beneath a heading that also
// says "מצנע" would make a count of 1 impossible to attribute to the
// heading. (Real data often has them equal; a test fixture must not.)
const aRow = (id: string, date: string | null): AccruedRow => ({
  id,
  amount: 900,
  show_name: "פודקאסט הבדיקה",
  record_date: date,
  guest: null,
  guest_missing: false,
  age_days: 5,
});

const monthlyCard = (monthKey: string, monthLabel: string, closed: boolean, rows: AccruedRow[]): AccruedGroup => ({
  card_key: `c1:${monthKey}`,
  client_id: "c1",
  client_name: "מצנע",
  cadence: "monthly",
  every_n: null,
  month_key: monthKey,
  month_label: monthLabel,
  month_closed: closed,
  total: rows.length * 900,
  oldest_age_days: 5,
  rows,
  months: [{ key: monthKey, label: monthLabel, count: rows.length, total: rows.length * 900, closed }],
  has_closed_month: closed,
  days_to_month_end: 27,
  ready: closed,
});

// ===========================================================================
console.log("\n1. a monthly client's two cards name their months, once each\n");
{
  const html = render([
    monthlyCard("2026-09", "ספטמבר 2026", true, [aRow("r1", "2026-09-03"), aRow("r2", "2026-09-24")]),
    monthlyCard("2026-10", "אוקטובר 2026", false, [aRow("r3", "2026-10-01")]),
  ]);

  // the owner-approved heading, exactly once per card
  occurs(html, "מצנע · ספטמבר 2026", 1);
  occurs(html, "מצנע · אוקטובר 2026", 1);

  // and the month is not ALSO printed on its own inside the card — the strip
  // that used to list months was removed because the heading carries it now.
  // One occurrence each means heading only.
  occurs(html, "ספטמבר 2026", 1);
  occurs(html, "אוקטובר 2026", 1);

  // two separate cards means two separate redeem buttons, each scoped to its
  // own row count
  occurs(html, "פדה · 2 פרקים", 1);
  occurs(html, "פדה · 1 פרקים", 1);

  // the cadence line the owner asked to keep, under each heading
  occurs(html, "מרוכז חודשי", 2);

  // the status sentence each card reports about ITSELF: September missed its
  // month, October is still open
  occurs(html, "חודש שנסגר ולא נפדה", 1);
  occurs(html, "החודש נסגר בעוד 27 ימים", 1);

  // the amber "ready" chip belongs to the closed month alone
  occurs(html, "מוכן לפדיון", 1);
}

// ===========================================================================
console.log("\n2. a non-monthly card keeps the bare client name — no month\n");
{
  const everyN: AccruedGroup = {
    card_key: "c2",
    client_id: "c2",
    client_name: "חתונמיות",
    cadence: "every_n",
    every_n: 6,
    month_key: null,
    month_label: null,
    month_closed: false,
    total: 2800,
    oldest_age_days: 12,
    rows: [aRow("e1", "2026-09-10"), aRow("e2", "2026-09-20"), aRow("e3", "2026-10-01"), aRow("e4", "2026-10-02")],
    months: [],
    has_closed_month: true,
    days_to_month_end: 27,
    ready: false,
  };
  const html = render([everyN]);
  occurs(html, "חתונמיות", 1);
  check("no month name in the heading", !/חתונמיות\s*·\s*\S+\s+20\d\d/.test(html));
  occurs(html, "ספטמבר", 0);
  occurs(html, "אוקטובר", 0);
  // the every_n progress bar and its own wording survive untouched
  occurs(html, "מרוכז כל 6 פרקים", 1);
  occurs(html, "עוד 2 פרקים לאגד מלא", 1);
  // and NOT the monthly status line
  occurs(html, "חודש שנסגר ולא נפדה", 0);
  occurs(html, "החודש נסגר בעוד", 0);

  const perEpisode: AccruedGroup = { ...everyN, card_key: "c3", client_id: "c3", client_name: "מלי אלקובי", cadence: "per_episode", every_n: null };
  const html2 = render([perEpisode]);
  occurs(html2, "מלי אלקובי", 1);
  occurs(html2, "פר-פרק", 1);
  occurs(html2, "חודש שנסגר ולא נפדה", 0);
}

// ===========================================================================
console.log("\n3. two clients, same month — the client name still separates them\n");
{
  const html = render([
    monthlyCard("2026-09", "ספטמבר 2026", true, [aRow("r1", "2026-09-03")]),
    { ...monthlyCard("2026-09", "ספטמבר 2026", true, [aRow("r9", "2026-09-05")]), card_key: "c9:2026-09", client_id: "c9", client_name: "ברק" },
  ]);
  occurs(html, "מצנע · ספטמבר 2026", 1);
  occurs(html, "ברק · ספטמבר 2026", 1);
}

// ===========================================================================
console.log("\n4. broken payloads must not throw (chunk/payload skew)\n");
{
  const full = monthlyCard("2026-09", "ספטמבר 2026", true, [aRow("r1", "2026-09-03")]);

  // `months` is still sent by the server for exactly this reason, but the new
  // chunk must not depend on it either way.
  survives("months missing", () => render([{ ...full, months: undefined }]));
  survives("months empty", () => render([{ ...full, months: [] }]));

  // the three fields this commit ADDED. A tab that somehow renders new JS
  // against an older payload sees these as undefined.
  survives("month_label missing", () => render([{ ...full, month_label: undefined }]));
  survives("month_key missing", () => render([{ ...full, month_key: undefined }]));
  survives("month_closed missing", () => render([{ ...full, month_closed: undefined }]));
  survives("all three missing at once", () =>
    render([{ ...full, month_key: undefined, month_label: undefined, month_closed: undefined }])
  );
  survives("days_to_month_end missing", () => render([{ ...full, days_to_month_end: undefined }]));

  // and the shapes the old suite already guarded
  survives("rows empty", () => render([{ ...full, rows: [] }]));
  survives("record_date null on a row", () => render([{ ...full, rows: [aRow("r1", null)] }]));
  survives("amount null", () => render([{ ...full, total: 0, rows: [{ ...aRow("r1", null), amount: null }] }]));
  survives("every_n null on an every_n card", () =>
    render([{ ...full, cadence: "every_n", every_n: null, month_key: null, month_label: null }])
  );
  survives("no groups at all", () => render([]));

  // a month_label missing must degrade to the bare client name, not to
  // "מצנע · undefined" on a screen that issues documents
  const degraded = render([{ ...full, month_label: undefined }]);
  occurs(degraded, "undefined", 0);
  occurs(degraded, "מצנע", 1);
}

console.log(failures === 0 ? "\nOK\n" : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
