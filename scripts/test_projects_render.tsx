/**
 * Renders ProjectsClient against DELIBERATELY BROKEN payloads and asserts it
 * does not throw.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_projects_render.tsx
 * Reads nothing, writes nothing, needs no dev server.
 *
 * ═══ WHY ═══
 * On 2026-08-27 the page crashed in the browser with
 *   TypeError: Cannot read properties of undefined (reading 'length')
 * inside buckets.map in ProjectsClient — while 80 assertions across four HTTP
 * suites were passing. They were all fetching HTML and matching strings, which
 * proves the SERVER rendered and says nothing about whether React can mount the
 * component. The trigger was a payload/chunk version skew: the option label
 * read `b.rows.length + b.undated.length`, `undated` was removed from the
 * server payload, and any tab still holding the previous JS chunk ran the old
 * expression against the new data.
 *
 * The browser check (test_projects_browser.py) catches the real page. This
 * catches the CLASS: it feeds the component payloads with fields missing,
 * which is what a version skew looks like from inside the component, and which
 * no amount of loading the current page will ever produce.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import ProjectsClient, { type MonthBucket } from "../src/app/projects/ProjectsClient";
import type { UnifiedRow } from "../src/lib/projects/unified";

let failures = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
    failures++;
  }
};

const fullRow = {
  id: "p1",
  billing: "priced" as const,
  contract_name: null,
  record_date: "2026-08-12",
  podcast_name: "בדיקה",
  show_name: "בדיקה",
  client_name: "לקוח",
  guest: "אורח",
  status: "הופץ",
  episode_no: 3,
  internal: false,
  cancelled: false,
  price: 700,
  docs: [{ type: 100, number: "10301", date: "2026-08-12", shared: false, cancelled: false, path: "production" }],
  // the stuck fields (2026-09-17). An empty array and a null are the ordinary
  // case — this row is not stuck — and they are spelled out rather than left
  // off so the suite keeps proving the payload shape the screen is handed.
  stuck: [],
  empty_reason: null,
};

// A contract milestone — a second ROW SHAPE in the same table since 2026-09-15,
// and therefore a second thing a stale chunk can be wrong about. Included in the
// healthy payload so the renderer is exercised, and knocked out below.
const fullMilestone = {
  id: "m1",
  name: "פרק 1 ו-2",
  contract_name: "בלי יריה אחת",
  client_name: "עופר גולן",
  state: "paid" as const,
  amount: 5900,
  anchor_date: "2026-08-14",
  counted_in: "incoming" as const,
  docs: [{ type: 320, number: "60197", date: "2026-08-14", shared: false, cancelled: false, path: "job" }],
};

/**
 * THE UNIFIED ROWS — the table's data since 5.10, and therefore the newest and
 * likeliest thing a stale chunk is missing. Five sources, because each one
 * renders a different combination of present and absent cells and a renderer
 * that handles four of them proves nothing about the fifth.
 */
const workRow = (over: Partial<UnifiedRow> = {}): UnifiedRow => ({
  key: "production:p1",
  source: "production",
  month: "2026-08",
  date: "2026-08-12",
  dateMeaning: "record",
  client: "לקוח",
  show: "בדיקה",
  description: "אורח",
  amount: 700,
  billing: "priced",
  contractName: null,
  emptyReasonText: null,
  prodStatus: { label: "הופץ", color: "var(--dim)" },
  billStatus: { state: "blue", label: "ממתין לתשלום", color: "var(--cyan)" },
  docs: [{ type: 100, number: "10301", date: "2026-08-12", shared: false, cancelled: false, path: "production" }],
  open: { kind: "entity", type: "production", id: "p1" },
  jobIds: ["j1"],
  excludedFromMoney: false,
  cancelled: false,
  stuckSentences: [],
  ...over,
});

const fullWork: UnifiedRow[] = [
  workRow(),
  // מרוכזת — no production status at all, and the date means something else
  workRow({
    key: "job:jb",
    source: "bundle",
    date: "2026-08-22",
    dateMeaning: "issued",
    show: "מחנה משותף",
    description: null,
    amount: 3500,
    billing: null,
    prodStatus: null,
    billStatus: { state: "purple", label: "לא חויב", color: "var(--violet-light)" },
    docs: [],
    open: { kind: "entity", type: "job", id: "jb" },
    jobIds: ["jb"],
  }),
  // רדיו ושונות — its own status vocabulary, and an href rather than a drawer
  workRow({
    key: "misc:w1",
    source: "misc",
    date: "2026-08-05",
    dateMeaning: "work",
    show: "עריכת תוכנית רדיו",
    description: "מיקס",
    amount: 900,
    billing: null,
    prodStatus: { label: "הושלם", color: "var(--green)" },
    billStatus: { state: null, label: "טרם חויבה", color: "var(--amber)" },
    docs: [],
    open: { kind: "href", href: "/misc" },
    jobIds: [],
  }),
  // אבן דרך — the money already counted above
  workRow({
    key: "milestone:m1",
    source: "milestone",
    date: "2026-08-14",
    dateMeaning: "document",
    show: "בלי יריה אחת",
    description: "פרק 1 ו-2",
    amount: 5900,
    billing: null,
    contractName: "בלי יריה אחת",
    prodStatus: { label: "שולם", color: "var(--green)" },
    billStatus: { state: "closed", label: "סגור", color: "var(--green)" },
    docs: [{ type: 320, number: "60197", date: "2026-08-14", shared: false, cancelled: false, path: "job" }],
    open: { kind: "entity", type: "contract", id: "c1" },
    jobIds: ["jm"],
    excludedFromMoney: true,
  }),
  // ייבוא — a CSV job, and a stuck one, so STUCK_ROW is exercised too
  workRow({
    key: "job:ji",
    source: "import",
    date: "2026-08-23",
    dateMeaning: "issued",
    show: "ייבוא היסטורי",
    description: null,
    amount: 1200,
    billing: null,
    prodStatus: null,
    billStatus: { state: "red", label: "חסרה חשבונית מס", color: "var(--red)" },
    docs: [],
    open: { kind: "entity", type: "job", id: "ji" },
    jobIds: ["ji"],
    stuckSentences: ["שולם ולא יצאה חשבונית מס"],
  }),
];

const fullBucket: MonthBucket = {
  key: "2026-08",
  label: "אוגוסט 2026",
  rows: [fullRow],
  milestones: [fullMilestone],
  work: fullWork,
  summary: {
    expected: 700,
    expectedPriced: 1,
    expectedPerEpisode: 1,
    expectedTotalRows: 1,
    missingRateCount: 0,
    missingRateShows: [],
    contractCount: 1,
    contractItems: [{ show: "icr spotlight", contract: "icr spotlight" }],
    inactiveCount: 0,
    inactiveShows: [],
    noBillingCount: 0,
    billed: 6962,
    billedCount: 4,
    incoming: 8791,
    incomingCount: 7,
  },
};

/**
 * renderToString inserts `<!-- -->` between adjacent text nodes, so a template
 * literal like `{b.label} ({b.work.length} עבודות)` reaches the HTML as
 * `אוגוסט 2026<!-- --> (<!-- -->5<!-- --> עבודות)`. Those comments are a React
 * hydration marker and not content, and an assertion that trips over them is
 * testing the serialiser rather than the screen — so they are stripped here,
 * once, at the boundary.
 */
const render = (buckets: unknown, initialMonth = "2026-08") =>
  renderToString(
    React.createElement(ProjectsClient, {
      buckets: buckets as MonthBucket[],
      initialMonth,
      userId: "ZTEST-user",
      today: "2026-09-17",
    })
  ).replace(/<!-- -->/g, "");

console.log("\n=== the healthy payload still renders ===");
check("full payload", () => {
  const html = render([fullBucket]);
  if (!html.includes("מעקב פרויקטים")) throw new Error("title missing");
  if (!html.includes("10301")) throw new Error("document number missing");
  if (!html.includes("עבודת חוזה")) throw new Error("contract line missing");
  // ALL FIVE SOURCE TAGS, in one table. The separator row is gone — five
  // sources interleaved by date cannot be banded — so the tag IS the
  // announcement and its absence is the screen lying quietly.
  for (const tag of ["הפקה", "מרוכזת", "רדיו ושונות", "אבן דרך", "ייבוא"]) {
    if (!html.includes(tag)) throw new Error(`source tag missing: ${tag}`);
  }
  if (!html.includes("60197")) throw new Error("milestone document missing");
  // the sentence the separator used to carry survives as the footnote
  if (!html.includes("אינם נספרים פעמיים")) throw new Error("double-count note missing");
  // the billing-status column, including the absence
  for (const label of ["ממתין לתשלום", "לא חויב", "טרם חויבה", "סגור", "חסרה חשבונית מס"]) {
    if (!html.includes(label)) throw new Error(`bill status missing: ${label}`);
  }
  // the date-meaning titles — the only thing keeping one column honest
  if (!html.includes("תאריך הנפקת ההזמנה, לא תאריך העבודה")) throw new Error("issued-date title missing");
  if (!html.includes("תאריך העבודה")) throw new Error("work-date title missing");
  // the filter bar, with per-source counts off the unfiltered month
  if (!html.includes("סטטוס חיוב")) throw new Error("bill filter missing");
  if (!html.includes("כל הלקוחות")) throw new Error("client filter missing");
  // the month picker counts WORK, not productions
  if (!html.includes("(5 עבודות)")) throw new Error("month option should count 5 work rows");
});

console.log("\n=== the summary cards' wording (owner 5.10) ===");
// COUNTING, once each. The cards' ARITHMETIC did not change — only their
// captions — and these assertions are what stop a future edit from putting the
// old claim back. `expectedTotalRows` is still `all.length` over the PRODUCTION
// rows, so a caption that called it the month's row total sat above a table
// carrying five sources' worth of rows.
check("the three approved captions, once each", () => {
  const html = render([fullBucket]);
  const once = (needle: string) => {
    const n = html.split(needle).length - 1;
    if (n !== 1) throw new Error(`"${needle.slice(0, 40)}…" appears ${n}x, want 1`);
  };
  once("לא כולל הפקות פנימיות ומבוטלות · 1 הפקות בחודש");
  once("הסכום הזה מכסה הפקות בלבד. הזמנות מרוכזות, רדיו ושונות וייבוא מופיעים בטבלה ואינם בתוכו.");
  // this one legitimately appears on BOTH document cards — 300 and 320+400
  const both = html.split("מסמכים לפי תאריך הנפקה · כל העסק, גם מה שאינו בטבלה שלמטה").length - 1;
  if (both !== 2) throw new Error(`document-card caption appears ${both}x, want 2`);
});
check("the superseded wording is gone", () => {
  const html = render([fullBucket]);
  for (const dead of ["שורות בחודש בסך הכל", "לא רק ההפקות שלמטה"]) {
    if (html.includes(dead)) throw new Error(`old copy still rendered: ${dead}`);
  }
});

console.log("\n=== the empty states, one each ===");
check("אין עבודות בחודש הזה — when work is empty", () => {
  const html = render([{ ...fullBucket, work: [] }]);
  if (!html.includes("אין עבודות בחודש הזה")) throw new Error("empty-month copy missing");
  if (html.includes("<table")) throw new Error("table should not render for an empty month");
});
// The filtered-empty state ("אין עבודות מהמקורות שנבחרו בחודש הזה") is reachable
// only after a click, and renderToString runs no events. Its presence in the
// source is asserted by scripts/test_projects_unified.ts §18 instead — stating
// it here so nobody concludes the state is untested.

console.log("\n=== a month whose ONLY work is a job-only row ===");
// Before 5.10 this month showed "(0 הפקות)" and an empty state, which made the
// only month holding that work look like a month holding none.
check("bundle-only month renders", () => {
  const b = { ...fullBucket, rows: [], milestones: [], work: [fullWork[1]] };
  const html = render([b]);
  if (!html.includes("מרוכזת")) throw new Error("bundle row missing");
  if (html.includes("אין עבודות בחודש הזה")) throw new Error("should not be the empty state");
  if (!html.includes("(1 עבודות)")) throw new Error("month option should count 1");
});

console.log("\n=== the exact crash: a field the payload no longer carries ===");
// this is what the browser actually had — old chunk expecting `undated`
check("bucket with an extra/removed array field", () => {
  const { rows, ...withoutRows } = fullBucket;
  void rows;
  render([{ ...withoutRows, rows: undefined }]);
});

console.log("\n=== every array field missing, one at a time ===");
const ARRAY_FIELDS = ["missingRateShows", "contractItems", "inactiveShows"] as const;
for (const f of ARRAY_FIELDS) {
  check(`summary.${f} undefined`, () => {
    const b = { ...fullBucket, summary: { ...fullBucket.summary, [f]: undefined } };
    render([b]);
  });
}
check("rows undefined", () => render([{ ...fullBucket, rows: undefined }]));
check("row.docs undefined", () => render([{ ...fullBucket, rows: [{ ...fullRow, docs: undefined }] }]));
// `work` is the NEWEST field on the payload (5.10) and therefore the one a
// stale chunk is most likely to be missing or to carry in the wrong shape. The
// screen must render a smaller truth, never a stack trace.
check("work undefined", () => render([{ ...fullBucket, work: undefined }]));
check("work is null", () => render([{ ...fullBucket, work: null }]));
check("work row .docs undefined", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), docs: undefined }] }]));
check("work row .stuckSentences undefined", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), stuckSentences: undefined }] }]));
check("work row .source unknown", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), source: "מקור_חדש" }] }]));
check("work row .dateMeaning unknown", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), dateMeaning: "משהו" }] }]));
check("work row .billStatus undefined", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), billStatus: undefined }] }]));
check("work row .prodStatus undefined", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), prodStatus: undefined }] }]));
check("work row .billing is an unknown BillingClass", () =>
  render([{ ...fullBucket, work: [{ ...workRow(), amount: null, billing: "מצב_חדש" }] }]));
check("work row everything null", () =>
  render([
    {
      ...fullBucket,
      work: [
        {
          key: "x",
          source: undefined,
          month: "2026-08",
          date: null,
          dateMeaning: undefined,
          client: null,
          show: null,
          description: null,
          amount: null,
          billing: null,
          contractName: null,
          emptyReasonText: null,
          prodStatus: null,
          billStatus: undefined,
          docs: undefined,
          open: undefined,
          jobIds: undefined,
          excludedFromMoney: false,
          cancelled: false,
          stuckSentences: undefined,
        },
      ],
    },
  ]));

// the milestone array is still on the payload for the summary and for a stale
// chunk, so it keeps its own checks
check("milestones undefined", () => render([{ ...fullBucket, milestones: undefined }]));
check("milestone.docs undefined", () =>
  render([{ ...fullBucket, milestones: [{ ...fullMilestone, docs: undefined }] }]));
check("milestone.state unknown", () =>
  render([{ ...fullBucket, milestones: [{ ...fullMilestone, state: "אחר" }] }]));

console.log("\n=== whole objects missing ===");
check("summary undefined", () => render([{ key: "2026-08", label: "אוגוסט 2026", rows: [], work: [workRow()] }]));
check("buckets undefined", () => render(undefined, "2026-08"));
check("buckets empty", () => render([]));
check("initialMonth names a month that is not there", () => render([fullBucket], "2026-12"));

console.log("\n=== every numeric field missing at once ===");
check("summary is an empty object", () => {
  render([{ key: "2026-08", label: "אוגוסט 2026", rows: [fullRow], work: [workRow()], summary: {} }]);
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
