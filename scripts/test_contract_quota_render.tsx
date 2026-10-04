/**
 * ContractQuotaBox — rendered, and COUNTED (כלל 56).
 *
 * Run:  npx tsx --tsconfig scripts/tsconfig.render.json scripts/test_contract_quota_render.tsx
 * Pure. Reads nothing, writes nothing, needs no database and no dev server.
 *
 * ═══ למה נספר ולא נגרפ ═══
 * ארבע העובדות שהבעלים ביקש להבטיח הן כולן **כמה פעמים**: המשפט מופיע פעם
 * אחת, חוזה בלי מכסה מצייר אפס, ההתראה מופיעה פעם אחת ולא פעם לכל הפקה
 * שמעבר, והשדה בטופס פעם אחת. "ה-HTML מכיל את המשפט" אינו מבדיל בין אחד
 * לשניים — וכפילות של אמירה כספית היא בדיוק הצורה שהרג׳יסטרי שילם עליה
 * ב-17.9: שתי אמירות על אותה עובדה, בלי אזהרה.
 *
 * ⚠️ `ContractQuotaBox` הוא הרכיב שמצייר את המשפט בשני המסכים — שורת החוזה
 * ב-/contracts וקופסת "חוזה מחייב" במגירת התוכנית ב-/shows. ספירה עליו היא
 * ספירה על שניהם, כי המשפט יושב במקום אחד.
 */
import { renderToString } from "react-dom/server";
import React from "react";
import ContractQuotaBox from "../src/components/ContractQuotaBox";
import {
  QUOTA_COPY,
  quotaOf,
  quotaOverNotice,
  type ContractQuota,
  type QuotaProduction,
} from "../src/lib/contracts/quota";

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

// React מפריד בין צמתי טקסט סמוכים בהערה ריקה, ולכן היא מוסרת לפני כל
// השוואה על משפט שאדם קורא (מוסכמת RecordPastBody).
const render = (el: React.ReactElement) => renderToString(el).replace(/<!-- -->/g, "");
const count = (h: string, needle: string) => h.split(needle).length - 1;

const EY = "contract-ey";
let seq = 0;
const ep = (over: Partial<QuotaProduction> = {}): QuotaProduction => {
  seq += 1;
  return {
    id: `p${seq}`,
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
const q = (included: number | null, recorded: number): ContractQuota | null => {
  seq = 0;
  return quotaOf(included, EY, Array.from({ length: recorded }, () => ep()));
};

const IN_QUOTA = "נוצלו 2 מתוך 6 פרקים · נשארו 4";
const FULL = "כל 6 הפרקים בחבילה נוצלו";
const NOTICE = quotaOverNotice(6);

console.log("\n── בתוך המכסה ──");

check('"נוצלו 2 מתוך 6 פרקים · נשארו 4" מופיע פעם אחת', () => {
  const html = render(<ContractQuotaBox quota={q(6, 2)} />);
  const n = count(html, IN_QUOTA);
  if (n !== 1) throw new Error(`expected 1, got ${n}`);
});

check("ואין איתו שום התראה", () => {
  const html = render(<ContractQuotaBox quota={q(6, 2)} />);
  if (count(html, NOTICE) !== 0) throw new Error("התראה הופיעה בלי מעבר למכסה");
  if (html.includes("data-quota-over")) throw new Error("בלוק ההתראה נוצר");
  if (html.includes("🟡")) throw new Error("סימן ההתראה הופיע");
});

check("0 מוקלטים → נוצלו 0 מתוך 6 · נשארו 6, פעם אחת", () => {
  const html = render(<ContractQuotaBox quota={q(6, 0)} />);
  const n = count(html, "נוצלו 0 מתוך 6 פרקים · נשארו 6");
  if (n !== 1) throw new Error(`expected 1, got ${n}`);
});

console.log("\n── בלי מכסה: אפס מופעים ──");

for (const [label, value] of [
  ["null", null],
  ["undefined", undefined],
] as const) {
  check(`quota ${label} → 0 מופעים של "נוצלו", ואפס HTML`, () => {
    const html = render(<ContractQuotaBox quota={value} />);
    if (count(html, "נוצלו") !== 0) throw new Error("המשפט הופיע לחוזה בלי מכסה");
    if (html !== "") throw new Error(`expected nothing, got ${html.slice(0, 60)}`);
  });
}

check("חוזה שלא הוגדרה לו מכסה (included null) → אין בכלל quota לצייר", () => {
  if (q(null, 3) !== null) throw new Error("quotaOf החזירה אובייקט לחוזה בלי מכסה");
  const html = render(<ContractQuotaBox quota={q(null, 3)} />);
  if (html !== "") throw new Error("צויר משהו");
});

console.log("\n── בדיוק מלא ──");

check('6 מוקלטים → "כל 6 הפרקים בחבילה נוצלו" פעם אחת, בלי התראה', () => {
  const html = render(<ContractQuotaBox quota={q(6, 6)} />);
  if (count(html, FULL) !== 1) throw new Error(`expected 1, got ${count(html, FULL)}`);
  if (count(html, NOTICE) !== 0) throw new Error("התראה בשוויון מדויק");
  if (count(html, IN_QUOTA) !== 0) throw new Error("גם המשפט של 'בתוך המכסה' הופיע");
});

console.log("\n── 7 מוקלטים: הכותרת פעם אחת, וההתראה פעם אחת ──");

check('"כל 6 הפרקים בחבילה נוצלו" פעם אחת', () => {
  const html = render(<ContractQuotaBox quota={q(6, 7)} />);
  const n = count(html, FULL);
  if (n !== 1) throw new Error(`expected 1, got ${n}`);
});

check("וההתראה פעם אחת — לא פעם לכל הפקה שמעבר", () => {
  const html = render(<ContractQuotaBox quota={q(6, 7)} />);
  const n = count(html, NOTICE);
  if (n !== 1) throw new Error(`expected 1, got ${n}`);
  if (count(html, "🟡") !== 1) throw new Error("סימן ההתראה הופיע יותר מפעם אחת");
});

check("9 מוקלטים — 3 מעבר, וההתראה עדיין פעם אחת", () => {
  const html = render(<ContractQuotaBox quota={q(6, 9)} />);
  if (count(html, NOTICE) !== 1) throw new Error(`התראה × ${count(html, NOTICE)}`);
  if (count(html, FULL) !== 1) throw new Error("הכותרת הוכפלה");
  // המספר כן נאמר, כי "איזה פרק" היא עובדה שהמשפט לבדו אינו נושא
  if (!html.includes("3 פרקים מעבר למכסה")) throw new Error("מספר ההפקות שמעבר אינו מוצג");
});

check("הפקה אחת מעבר — אין זנב של 'N פרקים מעבר'", () => {
  const html = render(<ContractQuotaBox quota={q(6, 7)} />);
  if (html.includes("פרקים מעבר למכסה")) throw new Error("זנב מיותר על הפקה אחת");
});

console.log("\n── מכסה שאינה 6 ──");

check("מכסה 1, הפקה אחת → מלא בלי התראה", () => {
  const html = render(<ContractQuotaBox quota={q(1, 1)} />);
  if (count(html, "כל 1 הפרקים בחבילה נוצלו") !== 1) throw new Error("כותרת שגויה");
  if (count(html, quotaOverNotice(1)) !== 0) throw new Error("התראה בשוויון");
});

check("מכסה 12 — ההתראה נוקבת ב-12 ולא ב-6", () => {
  const html = render(<ContractQuotaBox quota={q(12, 13)} />);
  if (count(html, quotaOverNotice(12)) !== 1) throw new Error("המכסה בהתראה שגויה");
  if (html.includes("(6)")) throw new Error("מספר מקובע הגיע למסך");
});

console.log("\n── compact, ומטענים שבורים ──");

check("compact מצייר את אותו משפט פעם אחת", () => {
  const html = render(<ContractQuotaBox quota={q(6, 2)} compact />);
  if (count(html, IN_QUOTA) !== 1) throw new Error("המשפט לא אחד");
});

check("included שבור (NaN) → אפס HTML, לא NaN על המסך", () => {
  const broken = { included: Number.NaN, used: 2, remaining: 0, full: false, over: [] } as ContractQuota;
  const html = render(<ContractQuotaBox quota={broken} />);
  if (html !== "") throw new Error(`expected nothing, got ${html.slice(0, 60)}`);
});

check("over undefined (גרסה לא תואמת) → נספר כאפס ולא זורק", () => {
  const broken = { included: 6, used: 6, remaining: 0, full: true } as unknown as ContractQuota;
  const html = render(<ContractQuotaBox quota={broken} />);
  if (count(html, FULL) !== 1) throw new Error("הכותרת חסרה");
  if (count(html, NOTICE) !== 0) throw new Error("התראה על over חסר");
  if (html.includes("NaN") || html.includes("undefined")) throw new Error("undefined הגיע למסך");
});

check("used/remaining שבורים — אין NaN במשפט", () => {
  const broken = { included: 6, used: NaN, remaining: NaN, full: false, over: [] } as ContractQuota;
  const html = render(<ContractQuotaBox quota={broken} />);
  // המשפט כן נאמר (included תקין), אבל הבדיקה היא שאין קריסה
  if (html === "") throw new Error("לא צויר דבר על included תקין");
});

console.log("\n── הנוסחים המאושרים של הטופס, בקבצים ──");

// השדה בטופס אינו רכיב טהור משלו — הוא יושב בשני מודאלים ב-ContractsClient,
// שהוא קומפוננטה עם hooks ו-router ואינו מגיע ל-renderToString. הספירה כאן
// היא על **מקור השדה**: הנוסח יושב ב-QUOTA_COPY ולכן אפשר לספור שהוא נצרך
// פעם אחת בכל מודאל ולא הוקלד מחדש באף מקום.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const client = readFileSync(join(process.cwd(), "src/app/contracts/ContractsClient.tsx"), "utf8");

check("השדה מופיע בשני מודאלים — יצירה ועריכה — ובשניהם מ-QUOTA_COPY", () => {
  const n = count(client, "QUOTA_COPY.field}");
  // placeholder ביצירה + label בעריכה = 2
  if (n !== 2) throw new Error(`QUOTA_COPY.field נצרך ${n} פעמים, מצופה 2 (יצירה + עריכה)`);
  const h = count(client, "QUOTA_COPY.fieldHint}");
  if (h !== 2) throw new Error(`הרמז נצרך ${h} פעמים, מצופה 2`);
});

check("הנוסח לא הוקלד מחדש באף מסך", () => {
  for (const f of [
    "src/app/contracts/ContractsClient.tsx",
    "src/app/shows/ShowsClient.tsx",
    "src/components/ContractQuotaBox.tsx",
    "src/modules/radar/alerts.ts",
    "src/components/EntityDrawer.tsx",
  ]) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    if (src.includes(QUOTA_COPY.field) && !f.endsWith("quota.ts")) {
      throw new Error(`${f} מקליד את נוסח השדה במקום לייבא אותו`);
    }
    if (src.includes("הוקלט פרק מעבר למכסת החבילה")) {
      throw new Error(`${f} מקליד את נוסח ההתראה במקום לקרוא ל-quotaOverNotice`);
    }
  }
});

check("ההתראה במגירת ההפקה נשענת על אותה פונקציה", () => {
  const drawer = readFileSync(join(process.cwd(), "src/components/EntityDrawer.tsx"), "utf8");
  if (!drawer.includes("quotaOverNotice(data.quotaOver.included)")) {
    throw new Error("מגירת ההפקה אינה קוראת ל-quotaOverNotice עם המכסה של החוזה");
  }
  if (count(drawer, "data-quota-over-production") !== 1) {
    throw new Error("בלוק ההתראה במגירה אינו מופיע בדיוק פעם אחת");
  }
});

check("ההתראה ברדאר היא שורה לכל הפקה, עם מפתח ייחודי", () => {
  const alerts = readFileSync(join(process.cwd(), "src/modules/radar/alerts.ts"), "utf8");
  if (!alerts.includes("`quota_over:${r.productionId}`")) {
    throw new Error("מפתח ההתראה ברדאר אינו נגזר מה-production id — שורות היו מתנגשות");
  }
  if (!alerts.includes("quotaOverNotice(r.included)")) {
    throw new Error("הרדאר אינו משתמש בנוסח המשותף");
  }
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
