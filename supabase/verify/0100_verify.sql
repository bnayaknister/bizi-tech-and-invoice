-- ============================================================================
-- 0100 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. ארבע עשרה עמודות, **כולן חייבות להיות true**.
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה.
--
-- ═══ 🐛 תוקן 8.10 — `job_id` על CTE שעמודותיו הן עמודות `jobs` ═══
-- ההרצה הראשונה אחרי החלת המיגרציה נפלה ב-
-- `42703: column "job_id" does not exist`, והכשל היה **בקובץ ולא בנתונים** —
-- המיגרציה הוחלה בהצלחה.
--
-- `dead_job` הוא `select j.* from public.jobs j`, ולכן עמודותיו הן עמודות
-- `jobs` ומפתחו הוא **`id`**. שורה 104 כתבה
-- `(select job_id::text from dead_job)` — `job_id` הוא שם העמודה
-- ב-`contract_milestones` ובמסמכים, ושם הוא נכון; על `jobs` אין עמודה כזו.
-- שגיאת ניתוח, כלומר הקובץ נפל לפני שהחזיר שורה.
--
-- ⚠️ ומה שזה **לא** היה: לא תלות בשורה שנמחקה. `dead_job` נגזר מ-
--    `ev.payload`, לא מ-`contract_milestones`, ולכן הוא שרד את המחיקה
--    מהרגע הראשון. ההנחה הסבירה שהכשל נובע מכך שאבן הדרך איננה אינה נכונה
--    כאן — הסיבה היא שם עמודה אחד.
--
-- אגב התיקון הוקשח גם משהו אמיתי: `dead_job` נקרא עכשיו מהמזהה הקבוע
-- (`k.job`) ולא מ-`ev`, כך שבדיקות ה-job (5-8, 11) אינן תלויות עוד בשורת
-- ה-events. היא ההעתק היחיד של התצלום, כלומר בדיוק הדבר שהקובץ בא לאמת,
-- ולולא זה היעדרה היה מחזיר NULL בשש בדיקות במקום כשל אחד בעל שם.
-- `event_job_matches_constant` (עמודה 0ב) משווה בין השניים ותופס מזהה
-- שהוקלד שגוי.
--
-- 🔴 **בדיקה 9 היא הבדיקה שאין לה תחליף.** אין `archive.contract_milestones`,
-- ולכן התצלום ב-`events.payload->'milestone_snapshot'` הוא ההעתק **היחיד** של
-- השורה שנמחקה. ההרצה המדומה אינה יכולה לאמת אותו — היא מגלגלת את שורת
-- ה-events יחד עם כל השאר. אם בדיקה 9 חוזרת false, השורה אבדה בלי העתק.
--
-- שתי השורות שמתחת לטבלה הן למבט אנושי ולא להשוואה אוטומטית: התצלום עצמו,
-- ואבני הדרך שנשארו על החוזה.
-- ============================================================================

with
-- שלושת המזהים הקבועים. `job` נוסף 8.10: אחרי המיגרציה אבן הדרך איננה, ולכן
-- אין שום טבלה שממנה אפשר לגזור את ה-job שלה — הוא חייב לבוא או מכאן או
-- מ-`events.payload`. שניהם קיימים כאן, והבדיקה שמשווה ביניהם היא מה שתופס
-- מזהה שהוקלד שגוי במקום להחזיר NULL בשתיקה.
k(dead, live, job) as (values (
  '1b55f005-12f8-4280-a49e-9cd4d33e0b79'::uuid,
  '1b5e4654-b2e2-4f59-8ed3-317ef336df07'::uuid,
  '5f2beb79-f8ec-48dd-8198-ed5123444629'::uuid
)),
ev as (
  select e.payload
  from public.events e, k
  where e.event_type = 'milestone_orphan_cleaned'
    and e.payload->>'via' = '0100'
    and e.payload->>'milestone_id' = k.dead::text
  order by e.created_at desc
  limit 1
),
-- ה-job שאבן הדרך הנמחקת הצביעה עליו.
--
-- 🔴 נקרא מהמזהה הקבוע ולא מ-`ev`, וזה שינוי של 8.10: קודם הוא נגזר מ-
--    `ev.payload->>'job_id'`, כלומר כל בדיקות ה-job (5-8, 11) היו תלויות
--    בשורת ה-events. אם היא חסרה — והיא ההעתק היחיד של התצלום, כלומר בדיוק
--    הדבר שהקובץ הזה בא לאמת — כל אותן בדיקות היו מחזירות NULL ולא false.
--    עכשיו הן עומדות בזכות עצמן, ו-`audit_event_written` לבדה מדווחת על
--    השורה החסרה.
--
-- ⚠️ העמודות כאן הן עמודות `jobs`, ולכן המפתח הוא **`id`** ולא `job_id`.
--    זה היה הבאג: שורה 104 כתבה `select job_id from dead_job` וקיבלה 42703.
--    `job_id` הוא שם העמודה ב-`contract_milestones` ובמסמכים, לא כאן.
dead_job as (
  select j.*
  from public.jobs j, k
  where j.id = k.job
),
live_ms as (
  select m.*
  from public.contract_milestones m, k
  where m.id = k.live
),
live_docs as (
  select count(*) as n
  from public.documents d, live_ms
  where (d.job_id = live_ms.job_id or d.bundle_job_ids @> array[live_ms.job_id])
    and d.cancelled_at is null and d.archived_at is null
),
-- 🔴 ספירת הדפוס (T29) — כמה שורות בצורה הזו נותרו במסד כולו.
-- אבן דרך עם job חי שאינו מוסתר, אפס מסמכים חיים, ולפחות מסמך מבוטל אחד,
-- בתוך טווח המסך (הרצפה 2026-07, projects/page.tsx:61). זו ההגדרה המדויקת
-- של השורה שהוסרה, והיא צריכה לחזור 0.
pattern_left as (
  select count(*) as n
  from public.contract_milestones m
  join public.jobs j on j.id = m.job_id
  where j.dismissed = false
    and coalesce(m.expected_date, j.date) >= '2026-07-01'
    and (select count(*) from public.documents d
          where (d.job_id = m.job_id or d.bundle_job_ids @> array[m.job_id])
            and d.cancelled_at is null and d.archived_at is null) = 0
    and (select count(*) from public.documents d
          where (d.job_id = m.job_id or d.bundle_job_ids @> array[m.job_id])
            and d.cancelled_at is not null) > 0
)
select
  -- 0. שורת האודיט קיימת. **קראו את העמודה הזו קודם:** `ev` נגזרת ממנה, ולכן
  --    אם היא false — בדיקות 3 ו-9 יחזרו NULL ולא false, וזה נראה כמו טבלה
  --    ריקה ולא ככשל. NULL אינו true, כלומר הן נכשלות כנדרש, אבל הסיבה
  --    נראית כאן ולא שם. (בדיקות ה-job, 5-8 ו-11, אינן תלויות בה יותר —
  --    ראה `dead_job` למעלה.)
  exists (select 1 from ev)                                        as audit_event_written,

  -- 0ב. 🔴 שורת האודיט מצביעה על אותו job שהמזהה הקבוע מצביע עליו.
  --     זו הבדיקה שהופכת מזהה שהוקלד שגוי מ-NULL שקט לכשל בעל שם: אם
  --     `k.job` אינו ה-job הנכון, `dead_job` ריק וכל בדיקות ה-job יחזרו
  --     NULL — והעמודה הזו תאמר למה.
  (select ev.payload->>'job_id' = (select job::text from k) from ev)
                                                                   as event_job_matches_constant,

  -- 1. אבן הדרך המתה נעלמה. זה המבחן המרכזי.
  not exists (select 1 from public.contract_milestones m, k where m.id = k.dead)
                                                                  as dead_milestone_gone,

  -- 2. אבן הדרך החיה שרדה. המחיקה הייתה על מזהה בודד, והבדיקה הזו היא מה
  --    שהופך "לא יכלה לגעת בה" לנמדד.
  (select count(*) from live_ms) = 1                              as live_milestone_intact,

  -- 3. היא עדיין תחת אותו חוזה שהתצלום מעיד עליו, ועדיין עם job.
  (select count(*) from live_ms, ev
    where live_ms.contract_id = (ev.payload->>'contract_id')::uuid
      and live_ms.job_id is not null) = 1                         as live_milestone_same_contract,

  -- 4. ולמסמכים שלה לא קרה דבר — ההנפקה מחדש היא כל ההצדקה למחיקת הישנה.
  (select n from live_docs) >= 1                                   as live_milestone_has_docs,

  -- 5+6+7+8. ה-job המת: מוסתר, עם נימוק שמצביע על המחליפה, עם חותמת,
  --          ובלי שחתמו עליו אדם. dismissed_by null = מיגרציה (0041/0095).
  (select dismissed from dead_job)                                 as dead_job_dismissed,
  (select dismiss_reason like '%' || (select live::text from k) || '%'
            and dismiss_reason like '%0100%'
     from dead_job)                                                as reason_points_to_replacement,
  (select dismissed_at is not null from dead_job)                  as dismissed_at_stamped,
  (select dismissed_by is null from dead_job)                      as dismissed_by_is_null,

  -- 9. 🔴 התצלום. אין archive.contract_milestones — זה ההעתק היחיד.
  --    נבדק על **תוכן** ולא על קיום: שורת events שנכתבה בלי התצלום, או עם
  --    תצלום של שורה אחרת, היא בדיוק הכשל שאי אפשר לגלות אחר כך.
  (select ev.payload->'milestone_snapshot'->>'id' = (select dead::text from k)
      and (ev.payload->'milestone_snapshot'->>'amount')::numeric = 9600
      and (ev.payload->'milestone_snapshot'->>'expected_date')::date = '2026-10-04'
      and ev.payload->'milestone_snapshot'->>'status' = 'pending'
      and ev.payload->'job_snapshot_before'->>'id' = (select job::text from k)
     from ev)                                                      as snapshot_is_the_real_row,

  -- 10. הפנקס. בלעדיו אין שום תיעוד שהמיגרציה רצה.
  exists (select 1 from public.schema_ledger where version = '0100')
                                                                   as ledger_row_written,

  -- 11. 🔴 ההסתרה לא נגעה בכסף. trg_guard_job_money נדלק על שש העמודות
  --     האלה, והקובץ לא היה אמור לגעת באף אחת — זו ההוכחה שלא נגע.
  (select coalesce(btrim(invoice_biz), '') = ''
      and coalesce(btrim(invoice_tax), '') = ''
      and paid::text <> 'כן'
     from dead_job)                                                as money_columns_untouched,

  -- 12. הדפוס (T29) — אפס שורות בצורה הזו נותרו. נמדד על כל המסד ולא רק על
  --     החוזה הזה: שורה שנייה בצורה הזו פירושה שהניקוי הנקודתי אינו מספיק
  --     ושהדפוס חזר, וזה בדיוק מה ש-T29 אומר שיקרה בכל הנפקה מחדש.
  (select n from pattern_left) = 0                                 as pattern_count_is_zero;

-- ── התצלום, למבט אנושי ─────────────────────────────────────────────────────
-- 🔴 ההעתק היחיד של השורה שנמחקה. שמור את הפלט הזה.
select
  e.created_at,
  e.payload->>'milestone_name'       as milestone_name,
  e.payload->>'cancelled_docs'       as cancelled_docs,
  e.payload->>'orphaned_event_refs'  as orphaned_event_refs,
  jsonb_pretty(e.payload->'milestone_snapshot') as milestone_snapshot,
  e.payload->>'job_dismiss_reason'   as dismiss_reason
from public.events e
where e.event_type = 'milestone_orphan_cleaned' and e.payload->>'via' = '0100'
order by e.created_at desc;

-- ── מה נשאר על החוזה ───────────────────────────────────────────────────────
-- הצפוי: אבן הדרך החיה 1b5e4654 ומסמכיה, בלי 1b55f005 לצידה.
select
  m.id,
  m.name,
  m.amount,
  m.expected_date,
  m.status,
  m.job_id,
  j.invoice_biz,
  j.invoice_tax,
  j.paid,
  j.dismissed,
  (select count(*) from public.documents d
    where (d.job_id = m.job_id or d.bundle_job_ids @> array[m.job_id])
      and d.cancelled_at is null and d.archived_at is null)  as live_docs,
  (select count(*) from public.documents d
    where (d.job_id = m.job_id or d.bundle_job_ids @> array[m.job_id])
      and d.cancelled_at is not null)                        as cancelled_docs
from public.contract_milestones m
left join public.jobs j on j.id = m.job_id
where m.contract_id = (
  select (e.payload->>'contract_id')::uuid
  from public.events e
  where e.event_type = 'milestone_orphan_cleaned' and e.payload->>'via' = '0100'
  order by e.created_at desc limit 1
)
order by m.expected_date nulls last;
