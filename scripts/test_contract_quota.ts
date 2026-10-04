/**
 * מכסת פרקים לחוזה — הלוגיקה כפונקציות טהורות, ואכיפת ההפרדה מנתיבי המסמכים.
 *
 * Run:  npx tsx scripts/test_contract_quota.ts
 *
 * NO DATABASE, NO SERVER, NO NETWORK — אין בקובץ הזה קליינט של Supabase, וזה
 * מה ש-F19 דורש: המקרה שהתכונה נבנתה בשבילו הוא חוזה EY עם 6 פרקים אמיתיים,
 * ואסור לגעת בו. הכל כאן אריתמטיקה, מיון, וקריאה סטטית של קבצים.
 *
 * ═══ 🔴 החלק החשוב: האכיפה ═══
 * הכרעת הבעלים היא "התראה בלבד, לא חסימה ולא מסמך", והדרישה שנגזרת ממנה אינה
 * תכונה של שום ערך מוחזר — היא תכונה של **מה הקבצים שנגעו בהם מייבאים ולמה
 * הם כותבים**. בדיקה שהייתה מדמה את Supabase הייתה בודקת את ה-mock. לכן
 * החלק האחרון קורא את טקסט כל הקבצים ששונו ונכשל אם אחד מהם מייבא
 * enqueue/morning או כותב ל-pending_documents/jobs/productions.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_INCLUDED_EPISODES,
  MIN_INCLUDED_EPISODES,
  QUOTA_COPY,
  compareForQuota,
  contractQuotas,
  countsTowardQuota,
  includedEpisodesError,
  parseIncludedEpisodes,
  quotaLine,
  quotaOf,
  quotaOverNotice,
  type QuotaProduction,
} from "../src/lib/contracts/quota";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── EY: החוזה שהתכונה נבנתה בשבילו, 6 פרקים ───────────────────────────────
const EY = "contract-ey";
const OTHER = "contract-other";

let seq = 0;
const ep = (over: Partial<QuotaProduction> = {}): QuotaProduction => {
  seq += 1;
  return {
    id: `p${String(seq).padStart(2, "0")}`,
    contract_id: EY,
    status: "הוקלט",
    cancelled_at: null,
    merged_into: null,
    record_date: `2026-10-${String(seq).padStart(2, "0")}`,
    created_at: `2026-10-${String(seq).padStart(2, "0")}T09:00:00Z`,
    podcast_name: "EY",
    ...over,
  };
};
const nEpisodes = (n: number) => Array.from({ length: n }, () => ep());

console.log("\n── אין מכסה ──");

check("included null → אין מכסה", quotaOf(null, EY, nEpisodes(3)) === null);
check("included undefined → אין מכסה", quotaOf(undefined, EY, nEpisodes(3)) === null);
check("included 0 → אין מכסה (ולא 'כל 0 הפרקים נוצלו')", quotaOf(0, EY, nEpisodes(3)) === null);
check("included שלילי → אין מכסה", quotaOf(-6, EY, nEpisodes(3)) === null);
check("included NaN → אין מכסה", quotaOf(Number.NaN, EY, nEpisodes(3)) === null);
check(
  "חוזה בלי מכסה אינו במפה בכלל — ולכן אין לו מה להציג ואין לו התראות",
  (() => {
    const m = contractQuotas([{ id: EY, included_episodes: null }], nEpisodes(9));
    return m.size === 0 && m.get(EY) === undefined;
  })()
);

console.log("\n── 6 פרקים: 0 / 2 / 6 מוקלטים ──");

for (const [recorded, used, remaining, full] of [
  [0, 0, 6, false],
  [2, 2, 4, false],
  [6, 6, 0, true],
] as const) {
  const q = quotaOf(6, EY, nEpisodes(recorded));
  check(
    `${recorded} מוקלטים → נוצלו ${used}, נשארו ${remaining}, full=${full}`,
    !!q && q.used === used && q.remaining === remaining && q.full === full && q.over.length === 0,
    q ? `used=${q.used} remaining=${q.remaining} full=${q.full} over=${q.over.length}` : "null"
  );
}

check(
  "הנוסח בתוך המכסה",
  quotaLine(quotaOf(6, EY, nEpisodes(2))!) === "נוצלו 2 מתוך 6 פרקים · נשארו 4"
);
check("הנוסח בדיוק במכסה", quotaLine(quotaOf(6, EY, nEpisodes(6))!) === "כל 6 הפרקים בחבילה נוצלו");

console.log("\n── 7 מוקלטים: בדיוק הפקה אחת מעבר ──");

{
  const eps = nEpisodes(7); // p.. עם תאריכים עולים, האחרון הוא המאוחר
  const latestId = eps[eps.length - 1].id;
  const q = quotaOf(6, EY, eps)!;
  check("over הוא בדיוק הפקה אחת", q.over.length === 1, `over=${q.over.length}`);
  check("וזו ההפקה המאוחרת לפי record_date", q.over[0]?.id === latestId, q.over[0]?.id ?? "—");
  check("used=7, remaining=0 ולא -1", q.used === 7 && q.remaining === 0, `remaining=${q.remaining}`);
  check("full=true", q.full);
  check("הכותרת זהה לכותרת של 'בדיוק מלא'", quotaLine(q) === "כל 6 הפרקים בחבילה נוצלו");
}

check(
  "הסדר אינו תלוי בסדר הקלט — ערבוב מחזיר את אותה הפקה מעבר",
  (() => {
    seq = 0;
    const eps = nEpisodes(7);
    const latest = eps[6].id;
    const shuffled = [eps[3], eps[6], eps[0], eps[5], eps[1], eps[4], eps[2]];
    return quotaOf(6, EY, shuffled)!.over[0].id === latest;
  })()
);

check(
  "9 מוקלטים → 3 מעבר, בסדר עולה",
  (() => {
    seq = 0;
    const eps = nEpisodes(9);
    const q = quotaOf(6, EY, eps)!;
    return (
      q.over.length === 3 &&
      q.over[0].id === eps[6].id &&
      q.over[1].id === eps[7].id &&
      q.over[2].id === eps[8].id
    );
  })()
);

console.log("\n── מה לא נספר ──");

check('status "עתיד_להתחיל" אינו נספר', !countsTowardQuota(ep({ status: "עתיד_להתחיל" })));
check('status "בהקלטה" אינו נספר', !countsTowardQuota(ep({ status: "בהקלטה" })));
check('status "בוטל" אינו נספר', !countsTowardQuota(ep({ status: "בוטל" })));
check("status null אינו נספר", !countsTowardQuota(ep({ status: null })));
check("cancelled_at אינו נספר", !countsTowardQuota(ep({ cancelled_at: "2026-10-01T00:00:00Z" })));
check("merged_into אינו נספר", !countsTowardQuota(ep({ merged_into: "p99" })));
check(
  "מבוטלת שהסטטוס שלה עדיין הוקלט — cancelled_at הוא הקובע",
  !countsTowardQuota(ep({ status: "הוקלט", cancelled_at: "2026-10-01T00:00:00Z" }))
);
check(
  "ממוזגת שאינה מבוטלת — merged_into הוא הקובע, ואינו נגזר מהסטטוס",
  !countsTowardQuota(ep({ status: "הופץ", cancelled_at: null, merged_into: "p99" }))
);

for (const st of ["הוקלט", "בעריכה", "נערך", "נשלח_ללקוח", "ממתין_לתגובת_לקוח", 'אושר_ע"י_לקוח', "הופץ"]) {
  check(`status "${st}" נספר`, countsTowardQuota(ep({ status: st })));
}

check(
  "6 מוקלטים + 3 עתידיים + מבוטלת + ממוזגת → נוצלו 6 בלבד, אפס מעבר",
  (() => {
    seq = 0;
    const eps = [
      ...nEpisodes(6),
      ep({ status: "עתיד_להתחיל" }),
      ep({ status: "בהקלטה" }),
      ep({ status: "עתיד_להתחיל" }),
      ep({ cancelled_at: "2026-11-01T00:00:00Z" }),
      ep({ merged_into: "pX" }),
    ];
    const q = quotaOf(6, EY, eps)!;
    return q.used === 6 && q.over.length === 0 && q.remaining === 0 && q.full;
  })()
);

console.log("\n── חוזה אחר ──");

check(
  "הפקה של חוזה אחר אינה נספרת",
  (() => {
    seq = 0;
    const eps = [...nEpisodes(2), ep({ contract_id: OTHER }), ep({ contract_id: OTHER })];
    return quotaOf(6, EY, eps)!.used === 2;
  })()
);
check(
  "הפקה בלי חוזה (contract_id null) אינה נספרת",
  (() => {
    seq = 0;
    return quotaOf(6, EY, [...nEpisodes(2), ep({ contract_id: null })])!.used === 2;
  })()
);
check(
  "שני חוזים עם מכסה — כל אחד סופר את שלו, ממעבר אחד",
  (() => {
    seq = 0;
    const eps = [...nEpisodes(7), ...Array.from({ length: 2 }, () => ep({ contract_id: OTHER }))];
    const m = contractQuotas(
      [
        { id: EY, included_episodes: 6 },
        { id: OTHER, included_episodes: 6 },
      ],
      eps
    );
    return (
      m.size === 2 &&
      m.get(EY)!.used === 7 &&
      m.get(EY)!.over.length === 1 &&
      m.get(OTHER)!.used === 2 &&
      m.get(OTHER)!.over.length === 0
    );
  })()
);

console.log("\n── שובר השוויון: דטרמיניסטי ──");

check(
  "אותו record_date → created_at מכריע",
  (() => {
    const a: QuotaProduction = { ...ep(), id: "a", record_date: "2026-10-01", created_at: "2026-10-01T12:00:00Z" };
    const b: QuotaProduction = { ...ep(), id: "b", record_date: "2026-10-01", created_at: "2026-10-01T08:00:00Z" };
    const q = quotaOf(1, EY, [a, b])!;
    // b נוצרה קודם, ולכן היא בתוך המכסה ו-a היא שמעבר
    return q.over.length === 1 && q.over[0].id === "a";
  })()
);

check(
  "אותו record_date ואותו created_at → id מכריע, והסדר טוטאלי",
  (() => {
    const base = { ...ep(), record_date: "2026-10-01", created_at: "2026-10-01T09:00:00Z" };
    const a: QuotaProduction = { ...base, id: "aaa" };
    const b: QuotaProduction = { ...base, id: "bbb" };
    const one = quotaOf(1, EY, [a, b])!.over[0].id;
    const two = quotaOf(1, EY, [b, a])!.over[0].id;
    return one === "bbb" && two === "bbb"; // אותה תשובה בשני סדרי הקלט
  })()
);

check(
  "record_date ריק ממוין אחרון — הפקה בלי תאריך אינה 'המוקדמת'",
  (() => {
    const dated: QuotaProduction = { ...ep(), id: "dated", record_date: "2026-12-31" };
    const undated: QuotaProduction = { ...ep(), id: "undated", record_date: null };
    return quotaOf(1, EY, [undated, dated])!.over[0].id === "undated";
  })()
);

check(
  "compareForQuota הוא סדר יציב ועקבי מול עצמו",
  (() => {
    const a: QuotaProduction = { ...ep(), id: "a", record_date: "2026-10-01" };
    const b: QuotaProduction = { ...ep(), id: "b", record_date: "2026-10-02" };
    return (
      compareForQuota(a, b) < 0 &&
      compareForQuota(b, a) > 0 &&
      compareForQuota(a, a) === 0
    );
  })()
);

console.log("\n── גבולות השדה ──");

check("ריק תקין — לא חובה", includedEpisodesError("") === null);
check("רווחים בלבד תקין", includedEpisodesError("   ") === null);
check("null תקין", includedEpisodesError(null) === null);
check("undefined תקין", includedEpisodesError(undefined) === null);
check("6 תקין", includedEpisodesError(6) === null);
check('"6" תקין', includedEpisodesError("6") === null);
check("1 תקין (הגבול התחתון)", includedEpisodesError(MIN_INCLUDED_EPISODES) === null);
check("500 תקין (הגבול העליון)", includedEpisodesError(MAX_INCLUDED_EPISODES) === null);
check("0 נדחה", includedEpisodesError(0) !== null);
check("שלילי נדחה", includedEpisodesError(-6) !== null);
check("501 נדחה", includedEpisodesError(501) !== null);
check("שבר נדחה", includedEpisodesError(6.5) === "מספר הפרקים חייב להיות שלם");
check("אותיות נדחות", includedEpisodesError("שש") === "מספר הפרקים אינו מספר תקין");
check("Infinity נדחה", includedEpisodesError(Infinity) === "מספר הפרקים אינו מספר תקין");
check("ריק → null בפרסור", parseIncludedEpisodes("") === null);
check("רווחים → null בפרסור", parseIncludedEpisodes("  ") === null);
check('"6" → 6 בפרסור', parseIncludedEpisodes("6") === 6);
check(
  "הגבולות זהים ל-CHECK של 0098",
  (() => {
    const mig = readFileSync(
      join(process.cwd(), "supabase/migrations/0098_contract_included_episodes.sql"),
      "utf8"
    );
    return (
      mig.includes(`between ${MIN_INCLUDED_EPISODES} and ${MAX_INCLUDED_EPISODES}`) &&
      mig.includes("included_episodes is null or")
    );
  })(),
  "אחרת הטופס מקבל מה שהמסד דוחה"
);

console.log("\n── הנוסחים המאושרים ──");

check("שדה", QUOTA_COPY.field === "מספר פרקים בחבילה (לא חובה)");
check(
  "רמז",
  QUOTA_COPY.fieldHint === "חוזה שמכסה מספר פרקים קבוע. השאירו ריק לחוזה לפי אבני דרך בלבד."
);
check(
  "התראה",
  quotaOverNotice(6) ===
    "הוקלט פרק מעבר למכסת החבילה (6) — לא יחויב. יש להחליט אם מרחיבים את החבילה או מחייבים בנפרד."
);
check("ההתראה נוקבת במכסה שהוגדרה", quotaOverNotice(12).includes("(12)"));

console.log("\n── 🔴 אכיפה: אפס נגיעה בנתיבי המסמכים ──");

// כל קובץ שהקומיט הזה נגע בו, ומה אסור שיופיע בו.
const TOUCHED = [
  "src/lib/contracts/quota.ts",
  "src/components/ContractQuotaBox.tsx",
  "src/app/contracts/page.tsx",
  "src/app/contracts/ContractsClient.tsx",
  "src/app/shows/page.tsx",
  "src/app/shows/ShowsClient.tsx",
  "src/modules/radar/alerts.ts",
  "src/app/api/entity/[type]/[id]/route.ts",
  "src/components/EntityDrawer.tsx",
  "src/lib/entities.ts",
];

// `lib/documents/enqueue` ו-`lib/morning` הם הגבול: כל נתיב שמייצר מסמך עובר
// באחד מהם. `ensure_job_for_production` נקראת רק דרך RPC, ולכן גם השם שלה
// אסור. ההחרגה היחידה היא ההערות — כמה מהקבצים מסבירים במפורש שהם אינם
// נוגעים בנתיבים האלה, ובדיקה שקוראת את הפרוזה הייתה נכשלת על המשפט
// שמבטיח בדיוק את מה שהיא בודקת (הלקח של test_create_job_for_production).
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

// ⚠️ `lib/morning/client` ולא `lib/morning`. הראשון הוא הקורא היחיד ל-API של
// מורנינג (שלוש קריאות fetch בתוכו); השני, `lib/morning/types`, הוא מודול
// קבועים ואוצר מילים בלבד — אפס supabase, אפס fetch (נמדד) — ושני המסכים
// שבקומיט הזה כבר ייבאו ממנו מלפניו (MORNING_DOC_CODE ב-contracts/page.tsx:6,
// DOC_TYPE_LABEL ו-RECEIPT_NOTICE ב-ContractsClient.tsx:15). כלל שהיה חוסם גם
// אותו היה אוסר על מסך להכיר את השם "חשבון עסקה", וזו אינה הדרישה.
const FORBIDDEN_IMPORTS = /from\s+["'][^"']*(lib\/documents\/enqueue|lib\/documents\/bundle|lib\/documents\/issue|lib\/documents\/taxFromParent|lib\/morning\/client)/;
const FORBIDDEN_CALLS = /\b(enqueueDocument|issuePendingDocument|ensure_job_for_production|createDealInvoice|createTaxFromParents|checkEligibility)\b/;
const FORBIDDEN_WRITES = /\.from\(\s*["'](pending_documents|jobs|job_productions|invoices|productions|documents)["']\s*\)\s*\n?\s*\.(insert|update|upsert|delete)/;

for (const f of TOUCHED) {
  const raw = readFileSync(join(process.cwd(), f), "utf8");
  const code = stripComments(raw);
  check(`${f} — אינו מייבא נתיב מסמכים`, !FORBIDDEN_IMPORTS.test(code),
    (code.match(FORBIDDEN_IMPORTS) ?? [])[0] ?? "");
  check(`${f} — אינו קורא לפונקציה שמייצרת מסמך או job`, !FORBIDDEN_CALLS.test(code),
    (code.match(FORBIDDEN_CALLS) ?? [])[0] ?? "");
  check(`${f} — אינו כותב לטבלת מסמכים/עבודות/הפקות`, !FORBIDDEN_WRITES.test(code),
    (code.match(FORBIDDEN_WRITES) ?? [])[0] ?? "");
}

// הכיוון ההופכי, וזה מה שהופך את הרשימה למשמעותית: הקבצים ששומרים על נתיבי
// הכסף **לא נגעו בהם כלל**. בדיקה שרק סופרת מה אין בקבצים שלי הייתה עוברת
// גם אם הייתי משנה את checkEligibility בקובץ אחר.
const UNTOUCHED_GUARDS = [
  "src/lib/documents/enqueue.ts",
  "src/lib/documents/bundle.ts",
  "src/lib/documents/issue.ts",
];
for (const f of UNTOUCHED_GUARDS) {
  const raw = readFileSync(join(process.cwd(), f), "utf8");
  check(
    `${f} — אינו יודע דבר על מכסות`,
    !/included_episodes|contracts\/quota|quotaOf|contractQuotas/.test(raw)
  );
}

check(
  "המודול הטהור אינו מייבא Supabase",
  // ⚠️ על הקוד ולא על הפרוזה: הכותרת של הקובץ מצהירה "אין בו Supabase", ובדיקה
  // שקראה את ההערות הייתה נכשלת על המשפט שמבטיח בדיוק את מה שהיא בודקת.
  !/supabase/i.test(stripComments(readFileSync(join(process.cwd(), "src/lib/contracts/quota.ts"), "utf8")))
);

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
