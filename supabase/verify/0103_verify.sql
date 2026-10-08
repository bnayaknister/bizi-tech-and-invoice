-- ============================================================================
-- 0103 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. אחת עשרה עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- שתי עמודות מידע.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה. אם היא לא חזרה בכלל, הטבלה אינה קיימת והמיגרציה לא רצה.
--
-- ⚠️ `nrows` אינו חייב להיות 0. הטבלה נולדת ריקה, אבל ברגע שהבעלים מזין את
--    איש הקשר הראשון בכרטיסייה היא מתמלאת, ומספר גדול מאפס הוא בדיוק מה
--    שרוצים לראות. הוא עמודת מידע ולא בדיקה.
-- ============================================================================

with
cols as (
  select
    count(*) filter (where column_name = 'show_id')    as show_id,
    count(*) filter (where column_name = 'name')       as nm,
    count(*) filter (where column_name = 'wa_id')      as wa_id,
    count(*) filter (where column_name = 'created_by') as created_by,
    count(*)                                          as n_all
  from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_contacts'
),
checks as (
  select
    count(*) filter (where conname = 'booking_contacts_name_len_chk') as name_chk,
    count(*) filter (where conname = 'booking_contacts_wa_id_chk')    as wa_chk,
    count(*) filter (where contype = 'f')                             as fks
  from pg_constraint
  where conrelid = 'public.booking_contacts'::regclass
),
idx as (
  select
    count(*) filter (where indexname = 'booking_contacts_show_wa_key') as show_wa,
    count(*) filter (where indexname = 'booking_contacts_wa_id_idx')   as wa_only,
    count(*) filter (where indexname = 'booking_contacts_show_idx')    as show_only
  from pg_indexes
  where schemaname = 'public' and tablename = 'booking_contacts'
)
select
  -- 0. הפנקס. בלעדיו המיגרציה רצה ולא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0103'))        as ledger_row_present,

  -- 1. המבנה: שש עמודות, והארבע שנושאות משמעות
  (select n_all from cols) = 6                                                as ncols_is_6,
  ((select show_id from cols) = 1
    and (select nm from cols) = 1
    and (select wa_id from cols) = 1
    and (select created_by from cols) = 1)                                    as named_columns_present,

  -- 2. שני ה-CHECKים, בשמם
  (select name_chk from checks) = 1                                           as name_len_chk_present,
  (select wa_chk from checks) = 1                                             as wa_id_chk_present,

  -- 3. שני מפתחות זרים: show_id ו-created_by
  (select fks from checks) = 2                                                as two_foreign_keys,

  -- 🔴 4. האינדקס הייחודי על הצמד. **הבדיקה שאין לה תחליף כאן.** הוא מה
  --    שמבטיח "אותו אדם פעם אחת לכל תוכנית": בלעדיו אותו מספר יכול לשבת
  --    פעמיים לאותה תוכנית, והבוט ישלח לאותו אדם שתי הודעות או יציג את אותו
  --    פודקאסט פעמיים ברשימת הבחירה.
  (select show_wa from idx) = 1                                               as show_wa_unique_idx,
  (select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'booking_contacts'
      and indexname = 'booking_contacts_show_wa_key') like '%UNIQUE%'          as show_wa_is_unique,

  -- ⚠️ ובמפורש: **אין** ייחודיות על wa_id לבדו. הכרעת בעלים — אותו מספר כן
  --    יכול להיות משויך לכמה פודקאסטים, וזה בדיוק המקרה שמייצר את הודעת
  --    הרשימה. אינדקס ייחודי שם היה שובר את התכונה הזאת בשקט.
  (select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'booking_contacts'
      and indexname = 'booking_contacts_wa_id_idx') not like '%UNIQUE%'        as wa_id_idx_is_NOT_unique,

  (select wa_only from idx) = 1 and (select show_only from idx) = 1            as lookup_indexes_present,

  -- 5. ההרשאות: אפס קריאה מכל תפקיד של סשן, RLS דלוק, אפס policy
  (select relrowsecurity from pg_class where oid = 'public.booking_contacts'::regclass)
    and not has_table_privilege('anon', 'public.booking_contacts', 'select')
    and not has_table_privilege('authenticated', 'public.booking_contacts', 'select')
    and not has_table_privilege('authenticated', 'public.booking_contacts', 'insert')
    and not has_table_privilege('authenticated', 'public.booking_contacts', 'update')
    and not has_table_privilege('authenticated', 'public.booking_contacts', 'delete')
    and (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'booking_contacts') = 0  as locked_down,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select count(*) from public.booking_contacts)                      as nrows,
  (select count(distinct wa_id) from public.booking_contacts)          as ndistinct_numbers;
