-- ============================================================================
-- 0104 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. אחת עשרה עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- שתי עמודות מידע.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה. אם היא לא חזרה בכלל, הטבלה אינה קיימת והמיגרציה לא רצה.
--
-- ⚠️ `nrows` אינו חייב להיות 0: ברגע שהמתג WHATSAPP_BOOKING_FLOW דלוק ולקוח
--    כותב לבוט, הטבלה מתמלאת. הוא עמודת מידע ולא בדיקה.
-- ============================================================================

with
cols as (
  select
    count(*) filter (where column_name = 'wa_id')      as wa_id,
    count(*) filter (where column_name = 'show_id')    as show_id,
    count(*) filter (where column_name = 'step')       as step,
    count(*) filter (where column_name = 'state')      as state,
    count(*) filter (where column_name = 'version')    as version,
    count(*) filter (where column_name = 'expires_at') as expires_at,
    count(*)                                          as n_all
  from information_schema.columns
  where table_schema = 'public' and table_name = 'wa_conversations'
),
checks as (
  select
    count(*) filter (where conname = 'wa_conversations_wa_id_chk')        as wa_chk,
    count(*) filter (where conname = 'wa_conversations_step_chk')         as step_chk,
    count(*) filter (where conname = 'wa_conversations_state_object_chk') as state_chk,
    count(*) filter (where conname = 'wa_conversations_version_chk')      as version_chk,
    count(*) filter (where contype = 'f')                                 as fks,
    count(*) filter (where contype = 'p')                                 as pks
  from pg_constraint
  where conrelid = 'public.wa_conversations'::regclass
)
select
  -- 0. הפנקס. בלעדיו המיגרציה רצה ולא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0104'))        as ledger_row_present,

  -- 1. המבנה: שמונה עמודות, והשש שנושאות משמעות
  (select n_all from cols) = 8                                                as ncols_is_8,
  ((select wa_id from cols) = 1 and (select show_id from cols) = 1
    and (select step from cols) = 1 and (select state from cols) = 1
    and (select version from cols) = 1 and (select expires_at from cols) = 1)  as named_columns_present,

  -- 🔴 2. המפתח הראשי על wa_id — שיחה אחת לכל מספר. בלעדיו שתי הודעות
  --    ראשונות במקביל היו פותחות שתי שיחות לאותו אדם.
  (select pks from checks) = 1
    and exists (
      select 1 from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.wa_conversations'::regclass and i.indisprimary
        and a.attname = 'wa_id'
    )                                                                         as wa_id_is_primary_key,

  -- 3. ארבעת ה-CHECKים, בשמם
  (select wa_chk from checks) = 1                                             as wa_id_chk_present,
  (select step_chk from checks) = 1                                           as step_chk_present,
  (select state_chk from checks) = 1                                          as state_object_chk_present,
  (select version_chk from checks) = 1                                        as version_chk_present,

  -- 4. מפתח זר אחד: show_id
  (select fks from checks) = 1                                                as one_foreign_key,

  exists (select 1 from pg_indexes where schemaname = 'public'
            and tablename = 'wa_conversations'
            and indexname = 'wa_conversations_show_idx')                      as show_idx_present,

  -- 5. ההרשאות: אפס לכל תפקיד של סשן, RLS דלוק, אפס policy
  (select relrowsecurity from pg_class where oid = 'public.wa_conversations'::regclass)
    and not has_table_privilege('anon', 'public.wa_conversations', 'select')
    and not has_table_privilege('authenticated', 'public.wa_conversations', 'select')
    and not has_table_privilege('authenticated', 'public.wa_conversations', 'insert')
    and not has_table_privilege('authenticated', 'public.wa_conversations', 'update')
    and not has_table_privilege('authenticated', 'public.wa_conversations', 'delete')
    and (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'wa_conversations') = 0  as locked_down,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select count(*) from public.wa_conversations)                              as nrows,
  (select count(*) from public.wa_conversations where expires_at > now())     as nlive;
