"use client";

import { quotaLine, quotaOverNotice, type ContractQuota } from "@/lib/contracts/quota";

/**
 * מצב מכסת הפרקים של חוזה — שורה אחת, ועוד שורת התראה כשיש מעבר.
 *
 * ═══ רכיב אחד, שני מסכים ═══
 * שורת החוזה ב-/contracts וקופסת "חוזה מחייב" במגירת התוכנית ב-/shows מציגות
 * את אותה עובדה. שני עותקים של המשפט היו שני מקומות שבהם "נוצלו 2 מתוך 6"
 * יכול להיאמר אחרת, על מסך כספים — ולכן המשפט עצמו יושב ב-`quotaLine`
 * והרכיב הזה רק מצייר אותו.
 *
 * ═══ טהור, ונספר ═══
 * שום fetch, שום state, שום router. זה מה שמאפשר ל-renderToString לספור את
 * שלוש העובדות שהבעלים ביקש להבטיח: המשפט מופיע **פעם אחת**, חוזה בלי מכסה
 * מצייר **אפס**, ושורת ההתראה מופיעה **פעם אחת** ולא פעם לכל הפקה שמעבר.
 *
 * ⚠️ ההתראה היא **מידע, לא פעולה** — הכרעת הבעלים: "התראה בלבד, לא חסימה
 * ולא מסמך". ולכן, בשונה מדגל השעות החסרות ב-EntityDrawer, היא **אינה
 * נושאת כפתור**: אין כאן פעולה אחת נכונה — להרחיב את החבילה או לחייב בנפרד
 * הן שתי החלטות עסקיות, והמשפט אומר זאת במילים.
 */
export default function ContractQuotaBox({
  quota,
  compact = false,
}: {
  /** null / undefined = אין מכסה. חוזה רגיל לפי אבני דרך — ואין מה לצייר. */
  quota: ContractQuota | null | undefined;
  /** במגירת התוכנית הקופסה צרה; בשורת החוזה יש מקום. שינוי מידות בלבד. */
  compact?: boolean;
}) {
  if (!quota) return null;
  // included חייב להיות מספר ב-ContractQuota (quotaOf מחזירה null אחרת), אבל
  // האובייקט מגיע מהשרת ולכן יכול להגיע שבור בגרסה לא תואמת — אותה מחלקת
  // כשל שהפילה את מסך הפרויקטים ב-15.9 בעוד tsc מרוצה.
  if (!Number.isFinite(Number(quota.included))) return null;

  const over = quota.over?.length ?? 0;

  return (
    <div data-quota-box className={compact ? "text-[10px]" : "text-[11px]"}>
      <div className={over > 0 ? "text-[var(--warn)]" : "text-[var(--dim)]"}>
        {quotaLine(quota)}
      </div>
      {over > 0 && (
        <div data-quota-over className="text-[var(--warn)] mt-0.5 leading-relaxed">
          🟡 {quotaOverNotice(quota.included)}
          {/* איזה פרק — אחת העובדות שהמשפט לבדו אינו נושא, וללא שמות
              הבעלים היה צריך לפתוח את הלוח ולספור. מוצג כאן ולא כשורה
              לכל הפקה, כדי שההתראה תישאר אחת. */}
          {over > 1 && <span className="text-[var(--faint)]"> · {over} פרקים מעבר למכסה</span>}
        </div>
      )}
    </div>
  );
}
