/**
 * Renders the /documents EDIT FORM for a bundled work order and asserts the
 * guest and the suggested line are VISIBLE TEXT, not a tooltip.
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_documents_edit_render.tsx
 * Reads nothing, writes nothing, needs no dev server.
 *
 * ═══ WHY THIS EXISTS ═══
 * Two things forced it:
 *
 *   1. The screen crashed twice in this project right after "all checks
 *      passed" — both times because every suite fetched HTML and matched
 *      strings, which proves the server rendered and says nothing about
 *      whether React can mount the component.
 *   2. The case this change is ABOUT cannot be reached in a browser today:
 *      a flagged bundled work order only exists between a redemption and its
 *      issuance, and there is none in the queue. Waiting for one, or writing a
 *      fake row into a live money queue, are both worse than building the row
 *      in memory.
 *
 * DocumentsClient calls useRouter, so it cannot be rendered bare — it needs the
 * App Router context. Providing that context is the whole mock: no module
 * interception, no path remapping, just the provider Next itself uses. The
 * stub router's methods are never called during a render; they exist so the
 * shape is honest.
 *
 * This is also the first coverage the edit form has ever had.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import DocumentsClient, { GuestHint, type PendingDocRow } from "../src/app/documents/DocumentsClient";
import { missingGuestLines } from "../src/lib/documents/guestFlag";
import { STUDIOS } from "../src/lib/calendar/studios";
import { buildLineItemText } from "../src/lib/documents/enqueue";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

const noop = () => {};
const stubRouter = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} as unknown as React.ContextType<typeof AppRouterContext>;

// ── the ברק bundle exactly as it existed between redemption and issuance ────
// Three lines predate the 2026-08-20 change that started writing the guest onto
// the line; two postdate it. That is the real 10317, and the real 3-of-5 split.
const EPISODES = [
  { date: "2026-08-02", guest: "עידן טנדלר", line: "הזמנת עבודה — דעה לא פופולרית 2026-08-02", flagged: true },
  { date: "2026-08-06", guest: "קרן טרנר", line: "הזמנת עבודה — דעה לא פופולרית 2026-08-06", flagged: true },
  { date: "2026-08-13", guest: "אלכס קושניר", line: "הזמנת עבודה — דעה לא פופולרית 2026-08-13", flagged: true },
  { date: "2026-08-23", guest: "רות קבסה אברמזון", line: "הזמנת עבודה — דעה לא פופולרית · רות קבסה אברמזון · 23.08.26", flagged: false },
  { date: "2026-08-26", guest: "שי פירון", line: "הזמנת עבודה — דעה לא פופולרית · שי פירון · 26.08.26", flagged: false },
];
const SHOW = "דעה לא פופולרית";

const bundleRow: PendingDocRow = {
  id: "row-bundle",
  doc_type: "work_order",
  status: "pending",
  amount: 3000,
  created_at: "2026-08-30T09:23:47.000Z",
  age_hours: 1,
  aging: null,
  client_name: "ברק הרשקוביץ",
  show_name: "—",
  record_date: null,
  guest: null,
  guests_by_line: EPISODES.map((e) => e.guest),
  suggested_by_line: EPISODES.map((e) =>
    buildLineItemText({ podcast_name: SHOW, guest: e.guest, record_date: e.date })
  ),
  payload: {
    description: "הזמנת עבודה מאוגדת — ברק הרשקוביץ (5 פרקים)",
    income: EPISODES.map((e) => ({ description: e.line, quantity: 1, price: 600 })),
  },
  last_error: null,
  attempts: 0,
  parent_gross: null,
  parent_gross_error: null,
};

const render = (rows: PendingDocRow[]) =>
  renderToString(
    React.createElement(
      AppRouterContext.Provider,
      { value: stubRouter },
      React.createElement(DocumentsClient, { rows, canApprove: true, dryRun: false, env: "test" })
    )
  );

console.log("\n=== the screen renders at all ===");
let html = "";
check("renders without throwing", (() => {
  try {
    html = render([bundleRow]);
    return html.length > 0;
  } catch (e) {
    console.log("      threw:", (e as Error).message);
    return false;
  }
})());
check("the bundle's client name is on the page", html.includes("ברק הרשקוביץ"));
// NOT asserting the line texts here: the collapsed row does not render them,
// only the document's own description. The lines live behind the "ערוך" click,
// which is exactly why GuestHint is exercised directly below.
check("the collapsed row raises the guest-missing banner", html.includes("אורח חסר בפירוט"));
check("the collapsed row shows the bundle amount", html.includes("3,000"));
// The collapsed row warns but does not name — that is its job, and it is why
// the edit form has to name. This asserts the division of labour, so a future
// change that moves the name up here does not silently make the hint dead code.
check("the collapsed row does NOT leak the guest into a title attribute",
  !/title="[^"]*עידן טנדלר/.test(html));

// The edit form only enters the DOM after a click, which renderToString cannot
// perform. GuestHint is therefore rendered directly — it is the same component
// both call sites use, so this exercises the real thing, not a copy.
const hint = (guest: string | null, suggestion: string | null) =>
  renderToString(React.createElement(GuestHint, { guest, suggestion }));
const strip = (h: string) => h.replace(/<[^>]+>/g, " ");

console.log("\n=== which lines flag — decided by the REAL missingGuestLines ===");
const flaggedIdx = missingGuestLines(
  EPISODES.map((e) => e.guest),
  EPISODES.map((e) => e.line),
  STUDIOS
);
check("exactly three lines flag", flaggedIdx.length === 3, `[${flaggedIdx.join(",")}]`);
check("they are the first three", JSON.stringify(flaggedIdx) === "[0,1,2]", `[${flaggedIdx.join(",")}]`);
check(
  "the two lines that already name their guest do NOT flag",
  !flaggedIdx.includes(3) && !flaggedIdx.includes(4)
);

console.log("\n=== the guest is VISIBLE TEXT, not a title attribute ===");
for (const i of flaggedIdx) {
  const e = EPISODES[i];
  const h = hint(e.guest, bundleRow.suggested_by_line[i]);
  check(`${e.guest}: the label renders`, h.includes("אורח ההפקה"));
  // the regression that started this: strip every tag and attribute, and the
  // name must still be readable
  check(`${e.guest}: survives stripping all tags/attributes`, strip(h).includes(e.guest));
  check(`${e.guest}: is NOT inside a title=""`, !/title="/.test(h));
}

console.log("\n=== the suggested full format matches buildLineItemText ===");
for (const i of flaggedIdx) {
  const e = EPISODES[i];
  const want = buildLineItemText({ podcast_name: SHOW, guest: e.guest, record_date: e.date });
  const h = hint(e.guest, bundleRow.suggested_by_line[i]);
  check(`${e.date}: label renders`, h.includes("הפורמט המלא"));
  check(`${e.date}: suggestion is ${want}`, strip(h).includes(want));
}

console.log("\n=== GuestHint degrades quietly ===");
check("both null renders nothing", hint(null, null) === "");
check("guest only", strip(hint("עידן טנדלר", null)).includes("עידן טנדלר") && !hint("עידן טנדלר", null).includes("הפורמט המלא"));
check("suggestion only", hint(null, "x · y · z").includes("הפורמט המלא") && !hint(null, "x · y · z").includes("אורח ההפקה"));

console.log("\n=== payload shapes that must not crash it ===");
const cases: [string, PendingDocRow][] = [
  ["suggested_by_line missing entirely", { ...bundleRow, suggested_by_line: undefined as never }],
  ["guests_by_line missing entirely", { ...bundleRow, guests_by_line: undefined as never }],
  ["both arrays shorter than the lines", { ...bundleRow, guests_by_line: ["עידן טנדלר"], suggested_by_line: ["x"] }],
  ["no income lines at all", { ...bundleRow, payload: { description: "ריק", income: [] } }],
  ["payload with no income key", { ...bundleRow, payload: { description: "ריק" } }],
  ["a single-line production row", {
    ...bundleRow,
    id: "row-single",
    amount: 600,
    show_name: SHOW,
    record_date: "2026-08-02",
    guest: "עידן טנדלר",
    guests_by_line: ["עידן טנדלר"],
    suggested_by_line: [buildLineItemText({ podcast_name: SHOW, guest: "עידן טנדלר", record_date: "2026-08-02" })],
    payload: { description: "הזמנת עבודה — דעה לא פופולרית 2026-08-02", income: [] },
  }],
];
for (const [label, row] of cases) {
  check(label, (() => {
    try {
      render([row]);
      return true;
    } catch (e) {
      console.log("      threw:", (e as Error).message);
      return false;
    }
  })());
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
