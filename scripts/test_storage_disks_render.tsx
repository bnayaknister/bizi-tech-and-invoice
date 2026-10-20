/**
 * B35 — the disk management screen renders what it is given. Pure.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_storage_disks_render.tsx
 * renderToString of the real client component with hand-built rows: no dev
 * server, no database, no network.
 */
import React from "react";
import { renderToString } from "react-dom/server";
import DisksClient from "../src/app/settings/disks/DisksClient";
import type { DiskRow } from "../src/lib/disks.server";

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

const rows: DiskRow[] = [
  { id: "a", name: "kong", hidden: false, created_at: "2026-07-30", productions: 26 },
  { id: "b", name: "SSD-99", hidden: false, created_at: "2026-10-20", productions: 0 },
  { id: "c", name: "old-disk", hidden: true, created_at: "2026-07-01", productions: 3 },
];
const html = renderToString(<DisksClient initialDisks={rows} />);
const count = (s: string) => html.split(s).length - 1;

check("title", html.includes("כונני אחסון"), true);
check("every disk is listed", ["kong", "SSD-99", "old-disk"].every((n) => html.includes(n)), true);
check("production counts shown", html.includes("26<!-- --> הפקות") || html.includes("26 הפקות"), true);
check("the hidden disk is marked", count("מוסתר") >= 1, true);
check("hidden sorts last", html.indexOf("old-disk") > html.indexOf("SSD-99") && html.indexOf("old-disk") > html.indexOf("kong"), true);
check("'מחיקה' only for the disk with no productions (1)", count(">מחיקה<"), 1);
check("rename on every row (3)", count("✎ שינוי שם"), 3);
check("hide on visible rows (2), show on the hidden one (1)", [count(">הסתרה<"), count(">הצגה<")], [2, 1]);
check("the add field and button", html.includes("שם כונן חדש") && html.includes(">הוספה<"), true);
check("empty list renders a sentence", renderToString(<DisksClient initialDisks={[]} />).includes("אין כוננים ברשימה"), true);

console.log(`\n${failed === 0 ? "✅ ALL PASSED" : "❌ FAILED"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
