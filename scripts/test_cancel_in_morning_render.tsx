/**
 * ═══════════════════════════════════════════════════════════════════════════
 * שני כפתורי הביטול ברג'יסטרי — מה מופיע על איזו שורה, וכמה פעמים.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_cancel_in_morning_render.tsx
 *
 * ⛔ Reads nothing, writes nothing, no dev server, no database, and NO Morning:
 * the component is rendered to a string and the string is counted. `fetch` is
 * never reached — nothing here clicks.
 *
 * ═══ WHY COUNT STRINGS AT ALL ═══
 * The whole feature is two buttons that must not appear on the wrong row.
 * "בטל במורנינג" on a `source='pull'` row is a button that closes a document
 * somebody else issued; on a 305 it is a button that cannot work, because a tax
 * document is cancelled by a credit note. The pure suite proves
 * `offersMorningCancel` answers correctly — this proves the answer reaches the
 * DOM, which is a different claim (see the "SSR 200 is not a render check" rule
 * and the header of test_projects_render.tsx).
 */
import { renderToString } from "react-dom/server";
import React from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import RegistryClient, { type DocRow } from "../src/app/documents/registry/RegistryClient";
import { BTN_CANCEL_IN_MORNING, BTN_MARK_LOCALLY } from "../src/lib/documents/cancelLocal";

let failures = 0;
let checks = 0;
function check(label: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const noThrow = (label: string, fn: () => void) => {
  checks++;
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${label} — ${(e as Error).message}`);
  }
};

const count = (h: string, n: string) => h.split(n).length - 1;

/**
 * ⚠️ EVERY FIXTURE SITS IN THE `work_order` TAB, AND THAT IS A CONSTRAINT OF SSR
 * RATHER THAN A CHOICE.
 *
 * The selected tab is internal state (`useState("work_order")`,
 * RegistryClient.tsx:276) with no prop, and `shown` renders only rows whose
 * `tab` matches it (:499). A server render therefore sees the work-order tab and
 * nothing else, and a row placed in any other tab produces no DOM at all —
 * which is why the first draft of this suite counted zero buttons on a perfectly
 * correct screen.
 *
 * So the row's `tab` field is pinned to "work_order" while its `type` varies.
 * For a 305 that combination does not occur in production — `registryTabForType`
 * would file it under `tax_invoice` — and it is used deliberately: it is the
 * only way to make the component RENDER a 305 row and prove the button is
 * withheld by `offersMorningCancel(r)` reading `r.type`, rather than by the row
 * being filtered out of the tab for an unrelated reason. A test that cannot tell
 * those two apart proves nothing about the gate.
 */

const row = (over: Partial<DocRow> = {}): DocRow =>
  ({
    id: "d1",
    morning_doc_id: "m1",
    number: "40339",
    type: 300,
    tab: "work_order",
    status: 0,
    client_id: "c1",
    client_name: "EY",
    morning_client_name: "EY",
    amount: 1180,
    currency: "ILS",
    document_date: "2026-10-01",
    pdf_url: null,
    source: "app",
    production_id: null,
    job_id: "j1",
    bundle_job_ids: null,
    parent_doc_numbers: ["10339"],
    parent_relation: "derived",
    show_name: "ey",
    cancelled_at: null,
    cancel_reason: null,
    archived_at: null,
    archive_reason: null,
    pending_id: null,
    // the rest of DocRow. Spelled out rather than left off: RegistryClient reads
    // `r.child_actions.length` with no guard (:1122), so an absent field is a
    // crash and not a missing button — the suite has to hand it a complete row
    // to be testing the buttons at all.
    pending_amount: null,
    child_actions: [],
    has_live_deal_child: false,
    buildable: false,
    build_block: null,
    net_amount: null,
    over_ceiling: false,
    ...over,
  }) as unknown as DocRow;

/**
 * RegistryClient calls `useRouter`, so it needs the App Router context — the
 * same stub test_registry_header_render.tsx and test_documents_edit_render.tsx
 * already use. `useDrawer` needs nothing.
 */
const noop = () => {};
const stubRouter = {
  back: noop,
  forward: noop,
  refresh: noop,
  push: noop,
  replace: noop,
  prefetch: noop,
} as unknown as React.ContextType<typeof AppRouterContext>;

/**
 * `canPull` is the money permission that gates BOTH buttons — the screen's own
 * prop name. Rendered true by default, because with it false the screen shows
 * neither button and every count below would be trivially zero.
 *
 * The `<!-- -->` hydration markers are stripped for the same reason the sibling
 * suite strips them: they are not content, and an assertion that trips over them
 * is testing the serialiser rather than the screen.
 */
function html(rows: DocRow[], props: Record<string, unknown> = {}) {
  return renderToString(
    React.createElement(
      AppRouterContext.Provider,
      { value: stubRouter },
      React.createElement(RegistryClient as unknown as React.FC<Record<string, unknown>>, {
        rows,
        canPull: true,
        lastPull: null,
        ...props,
      })
    )
  ).replace(/<!-- -->/g, "");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 🔵 שורה של 300 מהמערכת — שני הכפתורים ===");
{
  const out = html([row()]);
  check(`"${BTN_CANCEL_IN_MORNING}" מופיע`, count(out, BTN_CANCEL_IN_MORNING) === 1, String(count(out, BTN_CANCEL_IN_MORNING)));
  check(`"${BTN_MARK_LOCALLY}" מופיע לידו`, count(out, BTN_MARK_LOCALLY) === 1, String(count(out, BTN_MARK_LOCALLY)));
}
{
  const out = html([row({ type: 100, number: "10339", parent_doc_numbers: null, parent_relation: null })]);
  check("100 מהמערכת — שני הכפתורים", count(out, BTN_CANCEL_IN_MORNING) === 1 && count(out, BTN_MARK_LOCALLY) === 1);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 🔴 השורות שאסור שיקבלו את הכפתור החדש ===");
{
  // 560 of the 300/305/320 rows are source='pull' (0087) — issued by somebody
  // else, possibly already closed there
  const out = html([row({ source: "pull" })]);
  check("source='pull' → אין \"בטל במורנינג\"", count(out, BTN_CANCEL_IN_MORNING) === 0, String(count(out, BTN_CANCEL_IN_MORNING)));
  check("  ...אבל \"סמן כמבוטל אצלנו\" כן — זה בדיוק המקרה שלו", count(out, BTN_MARK_LOCALLY) === 1);
}
{
  const out = html([row({ source: "manual" })]);
  check("source='manual' → אין \"בטל במורנינג\"", count(out, BTN_CANCEL_IN_MORNING) === 0);
}
for (const t of [305, 320, 400]) {
  const out = html([row({ type: t })]);
  check(`type ${t} → אין "בטל במורנינג" (מתבטל רק בזיכוי 330)`, count(out, BTN_CANCEL_IN_MORNING) === 0, String(count(out, BTN_CANCEL_IN_MORNING)));
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== הנוסח הישן נעלם ===");
{
  const out = html([row()]);
  // "סמן כמבוטל" is a PREFIX of "סמן כמבוטל אצלנו", so a bare substring count
  // cannot tell them apart — the question is whether the string ever appears
  // WITHOUT the suffix, which is what this regex asks.
  check(
    '🔴 אפס מופעים של "סמן כמבוטל" בלי "אצלנו"',
    !/סמן כמבוטל(?! אצלנו)/.test(out),
    (out.match(/סמן כמבוטל.{0,8}/g) ?? []).join(" | ")
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== חודש מעורב: בדיוק המספר הנכון של כפתורים ===");
{
  // four rows in one tab: two that earn the new button, one pulled, one tax
  const out = html([
    row({ id: "a", type: 300, source: "app" }),
    row({ id: "b", type: 100, source: "app", number: "10340" }),
    row({ id: "c", type: 305, source: "app", number: "50070" }),
    row({ id: "d", type: 300, source: "pull", number: "40200" }),
  ]);
  check('"בטל במורנינג" מופיע בדיוק פעמיים', count(out, BTN_CANCEL_IN_MORNING) === 2, String(count(out, BTN_CANCEL_IN_MORNING)));
  // THREE and not four: the LOCAL button is itself limited to 100/300
  // (`CANCELLABLE_TYPES`, RegistryClient.tsx:35 — the types the old route
  // accepts), so the 305 row gets neither button. "every relevant row" means
  // every row the mirror route would accept, which has never included a tax
  // document.
  check('"סמן כמבוטל אצלנו" מופיע בדיוק שלוש פעמים — 300/100/300-pull, ולא על ה-305', count(out, BTN_MARK_LOCALLY) === 3, String(count(out, BTN_MARK_LOCALLY)));
  check('  ...ולכן ל-305 אין אף אחד מהשניים', count(out, BTN_CANCEL_IN_MORNING) === 2 && count(out, BTN_MARK_LOCALLY) === 3);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== בלי הרשאת כספים — אף אחד מהשניים ===");
{
  const out = html([row()], { canPull: false });
  check("canPull=false → אין \"בטל במורנינג\"", count(out, BTN_CANCEL_IN_MORNING) === 0);
  check("  ...וגם אין \"סמן כמבוטל אצלנו\"", count(out, BTN_MARK_LOCALLY) === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== לא קורס על payload חסר (version skew) ===");
noThrow("parent_doc_numbers undefined", () =>
  html([row({ parent_doc_numbers: undefined as unknown as string[] })]));
noThrow("parent_relation undefined", () =>
  html([row({ parent_relation: undefined as unknown as "derived" })]));
noThrow("number null על שורה שמקבלת את הכפתור", () => html([row({ number: null })]));
noThrow("source לא מוכר", () => html([row({ source: "something" as unknown as "app" })]));
noThrow("rows ריק", () => html([]));

console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
