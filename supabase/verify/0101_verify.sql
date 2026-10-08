-- ============================================================================
-- 0101 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שלוש עשרה עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- שתי עמודות מידע (`ncols`, `nrows`) שהן למבט אנושי.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה. אם היא לא חזרה בכלל, הטבלה אינה קיימת והמיגרציה לא רצה.
--
-- ⚠️ `nrows` אינו חייב להיות 0. הטבלה נולדת ריקה, אבל ברגע שה-webhook מוגדר
--    ב-Meta היא מתמלאת — ואם מריצים את הקובץ הזה אחרי שהגיעה הודעה ראשונה,
--    מספר גדול מאפס הוא בדיוק הדבר שרוצים לראות. הוא עמודת מידע ולא בדיקה.
--
-- ⚠️ מה הקובץ הזה **אינו** בודק: שה-webhook מוגדר ב-Meta, שמשתני הסביבה
--    קיימים ב-Vercel, ושהחתימה מתאמתת בפועל. אלה אינם עובדות על המסד. את
--    השלמות של הצד הזה מוכיחה `scripts/test_wa_webhook.ts` (טהורה, אפס מסד),
--    וההודעה הראשונה שתגיע לטבלה הזאת היא ההוכחה מקצה לקצה.
-- ============================================================================

with
k as (
  select 'public.wa_messages'::text as tbl
),
cols as (
  select count(*)::int as n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'wa_messages'
),
rows_now as (
  select count(*)::int as n from public.wa_messages
),
checks as (
  select
    count(*) filter (where conname = 'wa_messages_direction_chk')        as direction_chk,
    count(*) filter (where conname = 'wa_messages_status_chk')           as status_chk,
    count(*) filter (where conname = 'wa_messages_direction_status_chk') as pair_chk,
    count(*) filter (where conname = 'wa_messages_wa_id_len_chk')        as wa_id_chk,
    count(*) filter (where conname = 'wa_messages_body_len_chk')         as body_chk,
    count(*) filter (where conname = 'wa_messages_template_len_chk')     as template_chk,
    count(*) filter (where conname = 'wa_messages_wamid_key' and contype = 'u') as wamid_unique
  from pg_constraint
  where conrelid = (select tbl from k)::regclass
),
idx as (
  select
    count(*) filter (where indexname = 'wa_messages_wa_id_idx')   as wa_id_idx,
    count(*) filter (where indexname = 'wa_messages_created_idx') as created_idx,
    count(*) filter (where indexname = 'wa_messages_failed_idx')  as failed_idx
  from pg_indexes
  where schemaname = 'public' and tablename = 'wa_messages'
)
select
  -- 0. הפנקס. בלי השורה הזאת המיגרציה רצה אבל לא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0101'))        as ledger_row_present,

  -- 1. המבנה
  (select n from cols) = 10                                                   as ncols_is_10,

  -- 2. כל אילוץ, בשמו. ספירה ולא `exists`, כדי ששינוי שם יראה כ-false
  --    במקום להיעלם.
  (select direction_chk from checks) = 1                                      as direction_chk_present,
  (select status_chk from checks) = 1                                         as status_chk_present,
  (select pair_chk from checks) = 1                                           as direction_status_chk_present,
  (select wa_id_chk from checks) = 1                                          as wa_id_len_chk_present,
  (select body_chk from checks) = 1                                           as body_len_chk_present,
  (select template_chk from checks) = 1                                       as template_len_chk_present,

  -- 🔴 3. ה-unique על wamid. **הבדיקה שאין לה תחליף בקובץ הזה.** זהו מנגנון
  --    ה-de-dup, והראוט נשען עליו פעמיים: upsert עם ignoreDuplicates, וכשל
  --    כתיבה שמחזיר 500 כדי ש-Meta תנסה שוב. בלי האילוץ, אותה מסירה חוזרת
  --    מייצרת שורות כפולות והיומן מפסיק להיות ראיה.
  (select wamid_unique from checks) = 1                                       as wamid_unique_present,

  -- 4. האינדקסים
  (select wa_id_idx from idx) = 1
    and (select created_idx from idx) = 1
    and (select failed_idx from idx) = 1                                      as all_three_indexes_present,

  -- 🔴 5. ההרשאות. הטבלה נושאת מספרי טלפון ותוכן הודעות, והיא אמורה להיות
  --    בלתי קריאה מכל תפקיד של סשן — `revoke all` בלי גרנט, RLS דלוק, אפס
  --    policy. כל אחת מהשלוש לבדה אינה מספיקה.
  (select relrowsecurity from pg_class where oid = (select tbl from k)::regclass) as rls_enabled,
  (not has_table_privilege('anon', (select tbl from k), 'select')
    and not has_table_privilege('authenticated', (select tbl from k), 'select')
    and not has_table_privilege('authenticated', (select tbl from k), 'insert')
    and not has_table_privilege('authenticated', (select tbl from k), 'update')
    and not has_table_privilege('authenticated', (select tbl from k), 'delete')) as no_session_privileges,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'wa_messages') = 0             as no_policies,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select n from cols) as ncols,
  (select n from rows_now) as nrows;
