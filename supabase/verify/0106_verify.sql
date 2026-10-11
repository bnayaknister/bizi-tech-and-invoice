-- ============================================================================
-- 0106 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. תשע עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- שלוש עמודות מידע.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה. אם היא לא חזרה בכלל, הטבלה אינה קיימת והמיגרציה לא רצה.
--
-- ⚠️ `nrows` אינו חייב להיות 0: ברגע שהקוד של E19 נפרס ולקוח בוחר שפה,
--    הטבלה מתמלאת. הוא עמודת מידע ולא בדיקה.
-- ============================================================================

with
cols as (
  select
    count(*) filter (where column_name = 'wa_id')       as wa_id,
    count(*) filter (where column_name = 'lang')        as lang,
    count(*) filter (where column_name = 'lang_set_at') as lang_set_at,
    count(*) filter (where column_name = 'created_at')  as created_at,
    count(*) filter (where column_name = 'updated_at')  as updated_at,
    count(*)                                            as n_all
  from information_schema.columns
  where table_schema = 'public' and table_name = 'wa_contact_prefs'
),
checks as (
  select
    count(*) filter (where conname = 'wa_contact_prefs_wa_id_chk')             as wa_chk,
    count(*) filter (where conname = 'wa_contact_prefs_lang_chk')              as lang_chk,
    count(*) filter (where conname = 'wa_contact_prefs_lang_set_together_chk') as together_chk,
    count(*) filter (where contype = 'f')                                      as fks,
    count(*) filter (where contype = 'p')                                      as pks
  from pg_constraint
  where conrelid = 'public.wa_contact_prefs'::regclass
)
select
  -- 0. הפנקס. בלעדיו המיגרציה רצה ולא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0106'))        as ledger_row_present,

  -- 1. המבנה: חמש עמודות, כולן בשמן
  (select n_all from cols) = 5                                                as ncols_is_5,
  ((select wa_id from cols) = 1 and (select lang from cols) = 1
    and (select lang_set_at from cols) = 1 and (select created_at from cols) = 1
    and (select updated_at from cols) = 1)                                    as named_columns_present,

  -- 🔴 2. המפתח הראשי על wa_id — שפה אחת לכל מספר
  (select pks from checks) = 1
    and exists (
      select 1 from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.wa_contact_prefs'::regclass and i.indisprimary
        and a.attname = 'wa_id'
    )                                                                         as wa_id_is_primary_key,

  -- 3. שלושת ה-CHECKים, בשמם
  (select wa_chk from checks) = 1                                             as wa_id_chk_present,
  (select lang_chk from checks) = 1                                           as lang_chk_present,
  (select together_chk from checks) = 1                                       as lang_set_together_chk_present,

  -- 4. אין מפתח זר — השפה חייבת לעבוד גם למספר לא משויך
  (select fks from checks) = 0                                                as no_foreign_keys,

  -- 5. ההרשאות: אפס לכל תפקיד של סשן, RLS דלוק, אפס policy
  (select relrowsecurity from pg_class where oid = 'public.wa_contact_prefs'::regclass)
    and not has_table_privilege('anon', 'public.wa_contact_prefs', 'select')
    and not has_table_privilege('authenticated', 'public.wa_contact_prefs', 'select')
    and not has_table_privilege('authenticated', 'public.wa_contact_prefs', 'insert')
    and not has_table_privilege('authenticated', 'public.wa_contact_prefs', 'update')
    and not has_table_privilege('authenticated', 'public.wa_contact_prefs', 'delete')
    and (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'wa_contact_prefs') = 0  as locked_down,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select count(*) from public.wa_contact_prefs)                              as nrows,
  (select count(*) from public.wa_contact_prefs where lang = 'he')            as n_he,
  (select count(*) from public.wa_contact_prefs where lang = 'en')            as n_en;
