import { hasBeenPerformed } from "@/lib/productions/status";

// מכסת פרקים לחוזה — החישוב כולו, כפונקציות טהורות (0098, הכרעות הבעלים 4.10).
//
// ═══ 🔴 מה הקובץ הזה אינו עושה, ולמה זו הדרישה ═══
// הוא **קורא בלבד**. אין בו Supabase, אין בו fetch, והוא אינו מייבא שום דבר
// מ-`lib/documents/*`. ההתראה על פרק שמעבר למכסה מחושבת בצד הקריאה ואינה
// נוגעת ב-`checkEligibility`, ב-`enqueueDocument`, ב-`ensure_job_for_production`
// או בכל נתיב שמייצר מסמך או job — הכרעת הבעלים היא **התראה בלבד, לא חסימה
// ולא מסמך**, וההפרדה הזו היא מה שהופך אותה לכזו.
// `scripts/test_contract_quota.ts` קורא את טקסט הקבצים ששונו ונכשל אם אחד מהם
// מייבא enqueue/morning או כותב ל-pending_documents/jobs.
//
// ═══ ספירה, לא מונה ═══
// הניצול נגזר בכל קריאה מ-`productions.contract_id`, שכבר נכתב ביצירת ההפקה
// (calendar/sync/route.ts:325, productions/route.ts:155) — ולכן המונה קיים
// בנתונים מהיום הראשון, גם לחוזים שכבר יש. עמודת מונה הייתה דורשת נתיב כתיבה
// בכל מעבר סטטוס, ביטול, מיזוג ופיצול, וארבעה נתיבים הם ארבע הזדמנויות
// להיפרד מהמציאות. ספירה אינה יכולה להיפרד. פנקס 0098 אומר זאת במילים.
//
// ═══ שאילתה אחת למסך ═══
// `contractQuotas` מקבלת את **כל** ההפקות ואת **כל** החוזים ומחזירה מפה.
// הקוראים טוענים שאילתה אחת (`productions where contract_id in (…)`) ולא אחת
// לכל חוזה — ובוודאי לא אחת לכל הפקה.

/** המינימום שההפקה חייבת לשאת כדי שאפשר יהיה לספור אותה ולמיין אותה. */
export type QuotaProduction = {
  id: string;
  contract_id: string | null;
  status: string | null;
  /** שלושת השדות חובה ולא רשות, בדפוס countsAsEpisode: קורא ששכח לבקש
   *  cancelled_at ב-select נכשל בקומפילציה ולא סופר הכול בשקט. */
  cancelled_at: string | null;
  merged_into: string | null;
  record_date: string | null;
  created_at: string | null;
  /** לשורת ההתראה ברדאר. אופציונלי: קורא שאינו מציג שם אינו חייב לבקש אותו. */
  podcast_name?: string | null;
};

export type ContractQuota = {
  /** המכסה שהוגדרה. תמיד מספר — `quotaOf` מחזירה null כשאין מכסה. */
  included: number;
  used: number;
  /** לעולם לא שלילי: מעבר למכסה פירושו 0 שנותרו, לא מינוס אחד. */
  remaining: number;
  /** `used >= included` — כולל מעבר למכסה, ולא רק שוויון מדויק. */
  full: boolean;
  /** ההפקות שמעבר למכסה, בסדר שבו נספרו. ריק כשאין מעבר. */
  over: QuotaProduction[];
};

/**
 * האם ההפקה נספרת מול המכסה?
 *
 * שלושת התנאים של הבעלים, מילה במילה: `hasBeenPerformed(status)`,
 * `cancelled_at is null`, `merged_into is null`.
 *
 * ⚠️ `hasBeenPerformed` מקבלת גם את `cancelled_at` (status.ts:56-60) ולכן
 * הביטול נבדק פעמיים — וזה מכוון, לא כפילות. `countsAsEpisode` באותו קובץ
 * מנמק בדיוק את זה: `cancelled_at` הוא מה שהטריגרים של 0060/0061/0064
 * בודקים, ו-`status='בוטל'` נבדק לידו כחגורה. `merged_into` הוא מנגנון
 * המחיקה הרכה היחיד של הטבלה (0019), והוא **אינו** נגזר מהסטטוס: מיזוג
 * כפילות אינו ביטול — ההקלטה כן התרחשה, רק הרישום הוכפל. שתי הקבוצות
 * זרות בנתונים, ולכן בדיקה אחת אינה יכולה להחליף את השנייה.
 */
export function countsTowardQuota(p: QuotaProduction): boolean {
  if (p.merged_into) return false;
  return hasBeenPerformed(p.status, p.cancelled_at);
}

/**
 * סדר הספירה — והוא חייב להיות **טוטאלי ודטרמיניסטי**.
 *
 * `record_date` עולה, ואז `created_at`, ואז `id`. ההכרעה היא שתי הראשונות;
 * `id` הוא הקצה שהופך את הסדר לטוטאלי, כי שתי הפקות יכולות לשאת גם אותו
 * `record_date` וגם אותו `created_at` (פיצול הפקה יוצר אותן באותה שנייה —
 * productions/[id]/split). בלי קצה כזה, "איזו הפקה היא השביעית" הייתה שאלה
 * שהתשובה לה משתנה בין טעינה לטעינה, ועל זה נשענת שורת ההתראה.
 *
 * ⚠️ `record_date` ריק ממוין **אחרון** ולא ראשון: הפקה בלי תאריך אינה
 * "המוקדמת ביותר". ברירת המחדל של Postgres ל-ASC היא nulls last, וזה אותו
 * סדר — כך שספירה בשרת וספירה כאן אינן יכולות לחלוק.
 */
export function compareForQuota(a: QuotaProduction, b: QuotaProduction): number {
  const ad = a.record_date ?? "";
  const bd = b.record_date ?? "";
  // "" נחשב גדול מכל תאריך, כדי שריק יישב בסוף
  if (ad !== bd) {
    if (ad === "") return 1;
    if (bd === "") return -1;
    return ad < bd ? -1 : 1;
  }
  const ac = a.created_at ?? "";
  const bc = b.created_at ?? "";
  if (ac !== bc) {
    if (ac === "") return 1;
    if (bc === "") return -1;
    return ac < bc ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * המכסה של חוזה אחד.
 *
 * `null` פירושו **אין מכסה** — חוזה רגיל לפי אבני דרך. זו הכרעת הבעלים
 * ("ריק → חוזה רגיל, אפס שינוי בתצוגה ובהתנהגות"), והחזרת `null` ולא
 * `{included: 0, …}` היא מה שהופך אותה לבלתי ניתנת להצגה בטעות: קורא חייב
 * לבדוק את ה-null לפני שהוא מגיע למספר.
 *
 * `0` ושלילי נדחים כאן ולא רק ב-CHECK של המסד: הקובץ הזה הוא פונקציה טהורה
 * שקוראים לה גם על נתוני בדיקה, ו-0 שהיה חוזר כ-`{included: 0, full: true}`
 * היה מכריז "כל 0 הפרקים נוצלו" על כל חוזה. למצב "אין מכסה" יש ייצוג אחד.
 */
export function quotaOf(
  includedEpisodes: number | null | undefined,
  contractId: string,
  allProductions: readonly QuotaProduction[]
): ContractQuota | null {
  const included = Number(includedEpisodes);
  if (includedEpisodes == null || !Number.isFinite(included) || included < 1) return null;

  const counted = allProductions
    .filter((p) => p.contract_id === contractId && countsTowardQuota(p))
    .sort(compareForQuota);

  const used = counted.length;
  return {
    included,
    used,
    remaining: Math.max(0, included - used),
    full: used >= included,
    // slice מעבר לאורך מחזיר [] — ולכן אין כאן תנאי, וזה גם מה שמבטיח
    // שההפקות ב-`over` הן בדיוק N+1 והלאה בסדר שנספר.
    over: counted.slice(included),
  };
}

/**
 * כל המכסות של מסך, ממעבר אחד על ההפקות.
 *
 * מפה מ-`contract.id` ל-`ContractQuota`. חוזה בלי מכסה **אינו במפה** — כך
 * ש-`quotas.get(id)` מחזירה undefined, שהוא בדיוק "אין מה להציג".
 */
export function contractQuotas(
  contracts: readonly { id: string; included_episodes: number | null }[],
  allProductions: readonly QuotaProduction[]
): Map<string, ContractQuota> {
  const out = new Map<string, ContractQuota>();
  for (const c of contracts) {
    const q = quotaOf(c.included_episodes, c.id, allProductions);
    if (q) out.set(c.id, q);
  }
  return out;
}

/** הנוסחים המאושרים (4.10), במקום אחד — שהמסכים והבדיקות לא יוכלו להיפרד. */
export const QUOTA_COPY = {
  field: "מספר פרקים בחבילה (לא חובה)",
  fieldHint: "חוזה שמכסה מספר פרקים קבוע. השאירו ריק לחוזה לפי אבני דרך בלבד.",
} as const;

/**
 * השורה שמתארת את מצב המכסה.
 *
 * `full` מכסה גם שוויון מדויק וגם מעבר, והנוסח זהה לשניהם לפי הכרעת
 * הבעלים — ההבדל בין "בדיוק מלא" ל"מעבר" הוא **שורת ההתראה שמתחת**, לא
 * הכותרת. שתי כותרות שונות היו אומרות את אותו דבר פעמיים.
 */
export function quotaLine(q: ContractQuota): string {
  if (q.full) return `כל ${q.included} הפרקים בחבילה נוצלו`;
  return `נוצלו ${q.used} מתוך ${q.included} פרקים · נשארו ${q.remaining}`;
}

/** שורת ההתראה. אותו משפט בראדאר, במגירת התוכנית ובמגירת ההפקה. */
export function quotaOverNotice(included: number): string {
  return `הוקלט פרק מעבר למכסת החבילה (${included}) — לא יחויב. יש להחליט אם מרחיבים את החבילה או מחייבים בנפרד.`;
}

/**
 * גבולות השדה, מול ה-CHECK של 0098 (`null or between 1 and 500`).
 *
 * ספלינג אחד, שמשמש את טופס היצירה, את חלון העריכה ואת
 * `POST /api/contracts`. ⚠️ מסלול העריכה עובר ב-`/api/entity/contract/[id]`,
 * שהוא ראוט גנרי בלי ולידציה משלו — ולכן שם **ה-CHECK של המסד הוא הקיר**,
 * והבדיקה כאן היא מה שמונע מהבעלים לפגוש אותו כשגיאת Postgres גולמית.
 * מדווח ולא מוסתר.
 */
export const MIN_INCLUDED_EPISODES = 1;
export const MAX_INCLUDED_EPISODES = 500;

export function includedEpisodesError(raw: unknown): string | null {
  const s = raw == null ? "" : String(raw).trim();
  if (s === "") return null; // ריק תקין — "לא חובה"
  const n = Number(s);
  if (!Number.isFinite(n)) return "מספר הפרקים אינו מספר תקין";
  if (!Number.isInteger(n)) return "מספר הפרקים חייב להיות שלם";
  if (n < MIN_INCLUDED_EPISODES) {
    return `מספר הפרקים חייב להיות ${MIN_INCLUDED_EPISODES} ומעלה — השאירו ריק לחוזה בלי מכסה`;
  }
  if (n > MAX_INCLUDED_EPISODES) return `מספר הפרקים חייב להיות עד ${MAX_INCLUDED_EPISODES}`;
  return null;
}

/** המחרוזת מהטופס אל העמודה: ריק → null, אחרת מספר. לקרוא רק אחרי שהוולידציה עברה. */
export function parseIncludedEpisodes(raw: unknown): number | null {
  const s = raw == null ? "" : String(raw).trim();
  if (s === "") return null;
  return Number(s);
}
