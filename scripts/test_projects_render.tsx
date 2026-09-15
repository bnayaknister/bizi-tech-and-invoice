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

const fullBucket: MonthBucket = {
  key: "2026-08",
  label: "אוגוסט 2026",
  rows: [fullRow],
  milestones: [fullMilestone],
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

const render = (buckets: unknown, initialMonth = "2026-08") =>
  renderToString(
    React.createElement(ProjectsClient, {
      buckets: buckets as MonthBucket[],
      initialMonth,
    })
  );

console.log("\n=== the healthy payload still renders ===");
check("full payload", () => {
  const html = render([fullBucket]);
  if (!html.includes("מעקב פרויקטים")) throw new Error("title missing");
  if (!html.includes("10301")) throw new Error("document number missing");
  if (!html.includes("עבודת חוזה")) throw new Error("contract line missing");
  // the milestone group: its separator, its document, and the line that says
  // the money is not being counted twice
  if (!html.includes("אבני דרך של חוזים")) throw new Error("milestone separator missing");
  if (!html.includes("60197")) throw new Error("milestone document missing");
  if (!html.includes("אינם נספרים פעמיים")) throw new Error("double-count note missing");
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
// the milestone array is the newest field on the payload, so it is the one a
// stale chunk is most likely to be missing
check("milestones undefined", () => render([{ ...fullBucket, milestones: undefined }]));
check("milestone.docs undefined", () =>
  render([{ ...fullBucket, milestones: [{ ...fullMilestone, docs: undefined }] }]));
check("milestone.state unknown", () =>
  render([{ ...fullBucket, milestones: [{ ...fullMilestone, state: "אחר" }] }]));

console.log("\n=== whole objects missing ===");
check("summary undefined", () => render([{ key: "2026-08", label: "אוגוסט 2026", rows: [] }]));
check("buckets undefined", () => render(undefined, "2026-08"));
check("buckets empty", () => render([]));
check("initialMonth names a month that is not there", () => render([fullBucket], "2026-12"));

console.log("\n=== every numeric field missing at once ===");
check("summary is an empty object", () => {
  render([{ key: "2026-08", label: "אוגוסט 2026", rows: [fullRow], summary: {} }]);
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
