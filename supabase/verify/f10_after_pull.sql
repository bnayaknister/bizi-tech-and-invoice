-- ============================================================================
-- F10 — הבדיקה שמריצים אחרי משיכה. קריאה בלבד.
-- אינה שייכת למיגרציה אחת ולכן אינה נושאת מספר — כלל 50.
--
-- ═══ מה הקובץ הזה למד בהרצה הראשונה שלו, 19.9 ═══
-- הוא נכתב לפני המשיכה הראשונה שרצה עם קוד F10, וציפה ש**שלושה** מסמכים
-- יקבלו `client_id`. בפועל קיבלו **15**, והבדיקה `nothing_else_moved` נפלה —
-- **והיא עשתה בדיוק את עבודתה**: היא לא נועדה לאשר את החיזוי אלא לומר
-- שמשהו מעבר לו זז.
--
-- 🔴 **למה החיזוי היה 3 והמציאות 15 — וזה ההבדל שכדאי לזכור:**
--   · `backfillDocumentClients` מסנן `archived_at is null` — הוא **אינו נוגע
--     במאורכבים**. המדידה שחזתה 3 נעשתה דרך אותה עדשה (מסנן `loadData`),
--     וספרה מסמכים **חיים** בלבד: 10248, 10265, 10260.
--   · **המשיכה עצמה אינה מסננת ארכיון.** `registry.ts` מעדכן `client_id`
--     מהמפה על **כל שורה שהוא מושך**, מאורכבת או לא. והראיה: בהרצה ההיא
--     נכתבו **אפס** אירועי `documents_client_backfilled` — כלומר ה-backfill
--     לא רץ כלל, והחותם היה הפול.
--   · התוצאה: 15 מסמכים קיבלו לקוח, **12 מהם מאורכבים** ו-3 חיים.
--   מדידה דרך עדשת המנוע כשהשאלה היא על עדשת הפול — זה כל הפער.
--
-- ═══ מה נמצא כשבדקו, ולמה זה לא היה נזק ═══
--   24 מסמכים נושאים `client_id` שונה מתשובת המפה שלפני F10.
--   24 מתוך 24 מוסברים ע"י שלושת האליאסים · 0 לא מוסברים ·
--   0 שויכו מלקוח אחד לאחר · 0 איבדו לקוח.
--   כל שינוי היה `null → הלקוח הנכון`. 9 מהם כבר נשאו לקוח לפני המשיכה
--   (8 מקושרי-job ו-10307 שנוצר באפליקציה), ו-15 נחתמו במשיכה.
--
-- ═══ קו הבסיס הנוכחי — נלקח 19.9 13:21Z, אחרי המשיכה ההיא ═══
--   fp_existing = 77eb8b2e04abf6c3944e09df390635a3  על 1,113 מסמכים
--
-- ⚠️ **קו הבסיס מוגבל למסמכים שנוצרו לפני 19.9 14:00Z**, ולא לכל הטבלה.
--    זה תיקון לגרסה הראשונה, שהוציאה שלושה מסמכים **לפי מספר מסמך** —
--    ניסוח שנשבר ברגע שמשיכה מביאה שורה חדשה. עכשיו מסמך חדש פשוט אינו
--    בקבוצה, והבדיקה ממשיכה לענות על השאלה שהיא באמת שואלת:
--    **האם `client_id` של מסמך קיים זז בלי שהתכוונו.**
--
-- הרצה: להדביק ולקרוא את השורה. כל העמודות חייבות `true`.
-- ============================================================================
select
  -- 1. 24 המסמכים של שלושת האליאסים נושאים את הלקוח הנכון:
  --    90b369a5 טל מדיקל 17 + 3236ef61 Nikson 3 = 20 לסבטלנה, ו-4 לדה פקטו.
  (select count(*) = 20 from public.documents
    where morning_client_id in ('90b369a5-b071-4a83-8c32-880671625eaf',
                                '3236ef61-db85-491e-a407-e81b493e79ea')
      and client_id = 'b42808ad-4e91-4951-bcff-23111644a88b')            as alias_docs_to_svetlana,

  (select count(*) = 4 from public.documents
    where morning_client_id = 'fcf1e261-214c-4195-a372-4380e7bb9b5f'
      and client_id = '261c0445-c013-4f87-9dc6-e82f8c7e9c30')            as alias_docs_to_defacto,

  -- ואף אחד מהם לא נותר בלי לקוח
  (select count(*) = 0 from public.documents
    where morning_client_id in ('90b369a5-b071-4a83-8c32-880671625eaf',
                                '3236ef61-db85-491e-a407-e81b493e79ea',
                                'fcf1e261-214c-4195-a372-4380e7bb9b5f')
      and client_id is null)                                             as no_alias_doc_left_behind,

  -- 2. התג והטבלה
  (select count(*) = 22 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null)
                                                                          as unmatched_badge_22,
  (select count(*) = 4 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null
      and type in (300,305,320,400))                                      as billing_rows_still_4,

  -- 3. 🔴 העיקר: `client_id` של מסמך שכבר היה קיים לא זז.
  --    קל לראות שמה שציפינו לו קרה; מה שקשה לראות הוא שמשהו אחר זז בשקט.
  (select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-'), ',' order by d.id),''))
          = '77eb8b2e04abf6c3944e09df390635a3'
     from public.documents d
    where d.created_at < timestamptz '2026-09-19 14:00:00+00')            as nothing_else_moved,

  -- ושורות קו הבסיס עדיין שם — מסמך שנמחק היה מזיז את ה-md5 בלי שינוי client_id
  (select count(*) = 1113 from public.documents
    where created_at < timestamptz '2026-09-19 14:00:00+00')              as baseline_rows_intact,

  -- 4. והאוטו-לינק לא קישר דבר. `certain` נמדד 0 שלוש פעמים — זו העדות.
  (select count(*) = 0 from public.events
    where event_type = 'document_reconciled'
      and created_at > timestamptz '2026-09-19 14:00:00+00'
      and coalesce(payload->>'auto', 'false') = 'true')                   as no_auto_links,

  -- 5. ⚠️ ו-F17 לא זז: 56 מזהים יתומים על 251 מסמכים, כולם בלי לקוח.
  --    אם המספר גדל — משיכה הביאה מסמך תחת מזהה שאיש אינו תובע, וזה
  --    ממצא חדש ולא הארכיון שהוכרע.
  (select count(*) = 251 from public.documents d
    where d.morning_client_id is not null
      and not exists (select 1 from public.clients c where c.morning_client_id = d.morning_client_id)
      and not exists (select 1 from public.client_morning_ids m where m.morning_client_id = d.morning_client_id))
                                                                          as f17_still_251;


-- ── ואם `nothing_else_moved` חזר false: מי זז, בדיוק ─────────────────────
-- ⚠️ לא לפי `updated_at` — המשיכה נוגעת בכל השורות ומעדכנת את כולן לאותה
--    חותמת, ולכן `updated_at` מחזיר את כל 1,113 ואינו אומר דבר. זו בדיוק
--    הטעות שהתגלתה בהרצה הראשונה. השאילתה הזו משווה את `client_id` לתשובת
--    המפה שלפני F10, שהיא הדבר היחיד שניתן לשחזר בוודאות.
with legacy as (
  select distinct on (c.morning_client_id) c.morning_client_id as mid, c.id as cid
  from public.clients c
  where c.morning_client_id is not null and c.merged_into is null
  order by c.morning_client_id, c.name
)
select d.morning_doc_number, d.type, d.amount, d.document_date,
       d.morning_client_name, d.morning_client_id,
       dc.name as client_now, lc.name as client_under_pre_f10_map,
       d.archived_at is not null as archived, d.job_id is not null as has_job, d.source
from public.documents d
left join legacy l  on l.mid = d.morning_client_id
left join public.clients dc on dc.id = d.client_id
left join public.clients lc on lc.id = l.cid
where d.client_id is distinct from l.cid
  -- 24 המסמכים של האליאסים הם השינוי המוכר והמוסבר; כל השאר הוא החדשות
  and d.morning_client_id not in ('90b369a5-b071-4a83-8c32-880671625eaf',
                                  '3236ef61-db85-491e-a407-e81b493e79ea',
                                  'fcf1e261-214c-4195-a372-4380e7bb9b5f')
order by d.document_date desc;
