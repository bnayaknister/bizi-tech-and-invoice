/**
 * ═══════════════════════════════════════════════════════════════════════════
 * מונה הצבירה של /projects — והבאג שה-SELECT הסתיר.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Run:  npx tsx scripts/test_accrual_counter.ts
 *
 * ⛔ NO DATABASE, NO SERVER, NO NETWORK — no Supabase client, no fetch, no
 * clock. F19: the live data holds real every_n clients (חתונמיות bills every 6)
 * and this suite must not go near them.
 *
 * ═══ 🔴 WHAT WAS WRONG, AND WHY NO TEST COULD HAVE CAUGHT IT BEFORE ═══
 * projects/page.tsx built the "last billing document per client" map inline,
 * reading `d.client_id` from rows fetched with a `DOC_SELECT` that did not name
 * `client_id`. PostgREST returns the columns it is asked for and nothing else,
 * so the field was `undefined` on every row, the `if (!cid) continue` guard
 * fired every time, and the map was ALWAYS EMPTY.
 *
 * `lastBilled` was therefore always "", and `(record_date ?? "") > ""` is true
 * of every dated episode — so the counter counted every undocumented episode
 * the client had in range, from the beginning of the range, rather than only
 * those since the last bill. The loop, the guard and the max-by-date comparison
 * were all individually correct. The bug lived in the gap between the query and
 * the reader, which is exactly where an inline loop cannot be tested.
 *
 * So the rule moved to lib/projects/stuck.ts and the column moved into the
 * select, and both halves are pinned here: the first section proves the rule,
 * the last proves the column is in the query.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCRUAL_CLOSING_TYPES,
  accruedSince,
  emptyReasonFor,
  lastBillingDateByClient,
  type AccrualEpisode,
} from "../src/lib/projects/stuck";

let failures = 0;
let checks = 0;
const check = (label: string, ok: boolean, detail = "") => {
  checks++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};
const eq = (label: string, got: unknown, want: unknown) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const C = "client-a";
const ep = (record_date: string | null, over: Partial<AccrualEpisode> = {}): AccrualEpisode => ({
  client_id: C,
  record_date,
  cancelled: false,
  hasDocs: false,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 1. 🔴 המקרה שהבעלים נקב: every_n=4, חיוב אחרון 1.9 ─────────");
// ═══════════════════════════════════════════════════════════════════════════
// Three episodes before the bill, two after. The counter must say 2.
{
  const episodes = [
    ep("2026-08-04"),
    ep("2026-08-11"),
    ep("2026-08-25"),
    ep("2026-09-08"),
    ep("2026-09-22"),
  ];
  const docs = [{ client_id: C, type: 300, document_date: "2026-09-01", cancelled_at: null }];
  const lastBilled = lastBillingDateByClient(docs).get(C) ?? "";
  eq("המפה אינה ריקה", lastBilled, "2026-09-01");

  const r = accruedSince({ clientId: C, lastBilled, everyN: 4, episodes });
  eq("🔴 המונה סופר 2", r.count, 2);
  eq("האגד לא התמלא", r.bundleCompletedOn, null);

  // ---- and the bug itself, as a regression: the empty map gave 5 ----------
  const broken = accruedSince({ clientId: C, lastBilled: "", everyN: 4, episodes });
  eq("🔴 עם מפה ריקה — 5, וזה מה שהיה", broken.count, 5);
  check("כלומר הבאג היה 5 במקום 2", broken.count === 5 && r.count === 2);
  // and it overflowed a bundle of 4 that had only 2 in it
  eq("ואף הצהיר שהאגד התמלא", broken.bundleCompletedOn, "2026-09-08");
  eq("בעוד שבאמת הוא לא", r.bundleCompletedOn, null);

  // ---- the label the bookkeeper reads, from the same number --------------
  const label = emptyReasonFor({
    billing: "priced",
    internal: false,
    cadence: "every_n",
    everyN: 4,
    accruedCount: r.count,
    recordMonth: "2026-09",
    currentMonth: "2026-10",
    hasDocs: false,
  });
  eq("הכיתוב אומר 2 מתוך 4", label?.text, "מצטבר · 2 מתוך 4");
  const brokenLabel = emptyReasonFor({
    billing: "priced",
    internal: false,
    cadence: "every_n",
    everyN: 4,
    accruedCount: broken.count,
    recordMonth: "2026-09",
    currentMonth: "2026-10",
    hasDocs: false,
  });
  eq("🔴 ולפני התיקון הוא אמר 5 מתוך 4", brokenLabel?.text, "מצטבר · 5 מתוך 4");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 2. בלי מסמך חיוב בכלל → סופר הכול (כמו היום) ──────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const episodes = [ep("2026-08-04"), ep("2026-08-11"), ep("2026-08-25"), ep("2026-09-08"), ep("2026-09-22")];
  const lastBilled = lastBillingDateByClient([]).get(C) ?? "";
  eq("אין חיוב אחרון", lastBilled, "");
  const r = accruedSince({ clientId: C, lastBilled, everyN: 4, episodes });
  eq("סופר את כל החמש — התשובה הנכונה ללקוח שטרם חויב", r.count, 5);
  eq("והאגד אכן התמלא בפרק הרביעי", r.bundleCompletedOn, "2026-09-08");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 3. גבול התאריך: פרק שהוקלט ביום החיוב נמצא עליו ───────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const docs = [{ client_id: C, type: 300, document_date: "2026-09-01", cancelled_at: null }];
  const lastBilled = lastBillingDateByClient(docs).get(C) ?? "";
  // `>` and not `>=`: an episode recorded ON the day the bill went out is on it
  eq("1.9 עצמו אינו נספר", accruedSince({ clientId: C, lastBilled, everyN: 4, episodes: [ep("2026-09-01")] }).count, 0);
  eq("2.9 נספר", accruedSince({ clientId: C, lastBilled, everyN: 4, episodes: [ep("2026-09-02")] }).count, 1);
  eq("31.8 אינו נספר", accruedSince({ clientId: C, lastBilled, everyN: 4, episodes: [ep("2026-08-31")] }).count, 0);
  // a dateless episode can never be after any bill
  eq("פרק בלי תאריך אינו נספר", accruedSince({ clientId: C, lastBilled, everyN: 4, episodes: [ep(null)] }).count, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 4. מה יוצא מהמונה: מבוטל, מחויב, ולקוח אחר ─────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  const episodes = [
    ep("2026-09-02"),
    ep("2026-09-03", { cancelled: true }), // revenue that is not coming
    ep("2026-09-04", { hasDocs: true }), // already billed
    ep("2026-09-05", { client_id: "client-b" }), // somebody else's bundle
  ];
  const r = accruedSince({ clientId: C, lastBilled: "2026-09-01", everyN: 4, episodes });
  eq("רק אחד נספר", r.count, 1);
  // and the other client's bundle is counted on its own
  eq("ולקוח ב סופר את שלו", accruedSince({ clientId: "client-b", lastBilled: "", everyN: 4, episodes }).count, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 5. איזה מסמך סוגר צבירה, ואיזה לא ──────────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  eq("שלושה טיפוסים סוגרים: 300 · 305 · 320", ACCRUAL_CLOSING_TYPES, [300, 305, 320]);
  const one = (type: number) =>
    lastBillingDateByClient([{ client_id: C, type, document_date: "2026-09-01", cancelled_at: null }]).get(C) ?? "";
  for (const t of [300, 305, 320]) eq(`${t} סוגר`, one(t), "2026-09-01");
  // 100 is the START of the chain and closes nothing; 400 is raised on a 305
  // that is already counted, and counting it would move the boundary forward on
  // a document that opened no new bill.
  eq("100 אינו סוגר", one(100), "");
  eq("400 אינו סוגר", one(400), "");
  // a cancelled bill is a bill that was withdrawn
  eq(
    "מסמך מבוטל אינו סוגר",
    lastBillingDateByClient([
      { client_id: C, type: 300, document_date: "2026-09-01", cancelled_at: "2026-09-05T00:00:00Z" },
    ]).get(C) ?? "",
    ""
  );
  // the MAX per client, whichever set it arrived from
  eq(
    "לוקח את המאוחר מבין כמה",
    lastBillingDateByClient([
      { client_id: C, type: 300, document_date: "2026-07-01", cancelled_at: null },
      { client_id: C, type: 320, document_date: "2026-09-01", cancelled_at: null },
      { client_id: C, type: 305, document_date: "2026-08-01", cancelled_at: null },
    ]).get(C) ?? "",
    "2026-09-01"
  );
  // the guards that were firing on every row while the column was missing
  eq("client_id חסר — מדולג", lastBillingDateByClient([{ type: 300, document_date: "2026-09-01" }]).size, 0);
  eq("client_id null — מדולג", lastBillingDateByClient([{ client_id: null, type: 300, document_date: "2026-09-01" }]).size, 0);
  eq("תאריך חסר — מדולג", lastBillingDateByClient([{ client_id: C, type: 300, document_date: null }]).size, 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 6. סדר: bundleCompletedOn הוא הפרק ה-N כרונולוגית ──────────");
// ═══════════════════════════════════════════════════════════════════════════
{
  // handed in reverse — the rule sorts, so the answer cannot depend on the order
  // PostgREST happened to return
  const episodes = [ep("2026-09-20"), ep("2026-09-05"), ep("2026-09-12")];
  const r = accruedSince({ clientId: C, lastBilled: "", everyN: 2, episodes });
  eq("שלושה נספרו", r.count, 3);
  eq("האגד של 2 התמלא ב-12.9", r.bundleCompletedOn, "2026-09-12");
  eq("אגד של 3 התמלא ב-20.9", accruedSince({ clientId: C, lastBilled: "", everyN: 3, episodes }).bundleCompletedOn, "2026-09-20");
  eq("אגד של 4 לא התמלא", accruedSince({ clientId: C, lastBilled: "", everyN: 4, episodes }).bundleCompletedOn, null);
  eq("everyN null — אין תאריך מילוי", accruedSince({ clientId: C, lastBilled: "", everyN: null, episodes }).bundleCompletedOn, null);
  eq("everyN 0 — אין תאריך מילוי", accruedSince({ clientId: C, lastBilled: "", everyN: 0, episodes }).bundleCompletedOn, null);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── 7. 🔴 אכיפה: client_id נמצא בשאילתות ───────────────────────");
// ═══════════════════════════════════════════════════════════════════════════
// The rule above can be perfect and the screen still wrong, because the bug was
// never in the rule — it was in the column the query did not ask for. THIS is
// the half that regressed, so this is the half that gets a guard.
{
  const page = readFileSync(join(__dirname, "../src/app/projects/page.tsx"), "utf8");

  const docSelect = /const DOC_SELECT =\s*\n?\s*"([^"]+)"/.exec(page)?.[1] ?? "";
  check("DOC_SELECT קיים", docSelect.length > 0, docSelect.slice(0, 40));
  check("🔴 DOC_SELECT נוקב ב-client_id", docSelect.split(",").includes("client_id"));
  // the columns the document resolver and the milestone walk rely on, so the
  // fix cannot have quietly dropped one while adding client_id
  for (const col of [
    "id",
    "morning_doc_id",
    "morning_doc_number",
    "type",
    "amount",
    "document_date",
    "production_id",
    "job_id",
    "bundle_job_ids",
    "cancelled_at",
    "archived_at",
    "status",
  ]) {
    check(`DOC_SELECT עדיין נוקב ב-${col}`, docSelect.split(",").includes(col));
  }

  // and the month-document read, which is the set that makes the counter
  // COMPLETE — a bundle raised by hand in Morning reaches no episode and no job,
  // so docsById cannot see it and only this read can
  const monthSelect = /\.select\("(id,type,amount,document_date[^"]*)"\)/.exec(page)?.[1] ?? "";
  check("שאילתת מסמכי החודש קיימת", monthSelect.length > 0, monthSelect);
  check("🔴 והיא נוקבת ב-client_id", monthSelect.split(",").includes("client_id"));

  // the inline loop is gone — the rule has one home
  check("אין לוּפ inline של 300/305/320 ב-page.tsx", !page.includes("[300, 305, 320].includes"));
  check("page.tsx מייבא את הכלל", page.includes("lastBillingDateByClient") && page.includes("accruedSince"));

  // 🔵 AND THE RADAR, which the owner asked about: it does NOT share this rule,
  // and that is correct rather than a second bug. alerts.ts counts
  // pending_documents rows still at status 'accrued' — the QUEUE — where
  // redemption removes a row from the population and no "since when" question
  // arises. So it has no lastBilling concept to get wrong.
  const alerts = readFileSync(join(__dirname, "../src/modules/radar/alerts.ts"), "utf8");
  check("הראדאר אינו משתמש בכלל הזה", !alerts.includes("lastBillingDateByClient") && !alerts.includes("accruedSince"));
  check("הראדאר סופר מהתור עצמו", alerts.includes('d.status !== "accrued"'));
  check("ואינו קורא documents.client_id לצורך צבירה", !alerts.includes("lastBilling"));

  // the rule module stays pure
  const stuck = readFileSync(join(__dirname, "../src/lib/projects/stuck.ts"), "utf8");
  const imports = stuck.split("\n").filter((l) => /^\s*import\b/.test(l)).join("\n");
  check("stuck.ts אינו מייבא דבר", imports.trim() === "");
  check("stuck.ts אפס fetch(", !stuck.includes("fetch("));
  for (const w of [".insert(", ".upsert(", ".delete(", ".update("]) {
    check(`stuck.ts אפס ${w}`, !stuck.includes(w));
  }
}

console.log(`\n${failures === 0 ? "✅" : "❌"}  ${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);
