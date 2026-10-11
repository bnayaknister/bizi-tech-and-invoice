-- ============================================================================
-- 0107 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. עשרים עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- חמש עמודות מידע.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה. אם היא לא חזרה בכלל, הטבלאות אינן קיימות והמיגרציה לא רצה.
--
-- ⚠️ עמודות המידע אינן בדיקות: `nstudio_admins` הוא 0 מיד אחרי ההחלה ו-2
--    אחרי שהבעלים מסמן את בניה ואלי; `nclients_not_active` מתחיל ב-0 וגדל
--    עם כל הרשמה ממתינה.
-- ============================================================================

with
reg_cols as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'client_registrations'
),
link_cols as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'registration_links'
),
reg_checks as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.client_registrations'::regclass and contype = 'c'
),
link_checks as (
  select count(*) filter (where contype = 'c') as n_chk,
         count(*) filter (where conname = 'registration_links_token_key') as n_token_key
  from pg_constraint where conrelid = 'public.registration_links'::regclass
),
col as (
  select table_name, column_name, is_nullable, column_default
  from information_schema.columns
  where table_schema = 'public'
    and (table_name, column_name) in (
      ('clients', 'status'), ('clients', 'tax_id'),
      ('shows', 'first_booking_needs_approval'),
      ('booking_contacts', 'registration_id'),
      ('profiles', 'studio_admin'))
)
select
  -- 0. הפנקס. בלעדיו המיגרציה רצה ולא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0107'))              as ledger_row_present,

  -- 1. studio_admin: עמודה NOT NULL default false, הפונקציה, והשומר
  exists (select 1 from col where table_name = 'profiles' and column_name = 'studio_admin'
            and is_nullable = 'NO' and column_default = 'false')                    as profiles_studio_admin_col,
  (to_regprocedure('public.is_studio_admin()') is not null)                         as is_studio_admin_fn,
  exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass
            and tgname = 'trg_guard_studio_admin_flag' and not tgisinternal)        as studio_admin_guard_trigger,

  -- 2. clients.status / tax_id
  exists (select 1 from col where table_name = 'clients' and column_name = 'status'
            and is_nullable = 'NO' and column_default like '''active''%')            as clients_status_col,
  exists (select 1 from pg_constraint where conname = 'clients_status_chk')         as clients_status_chk,
  exists (select 1 from col where table_name = 'clients' and column_name = 'tax_id'
            and is_nullable = 'YES')                                                as clients_tax_id_col,
  exists (select 1 from pg_constraint where conname = 'clients_tax_id_chk')         as clients_tax_id_chk,
  exists (select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'clients_tax_id_key' and indexdef like '%UNIQUE%'
            and indexdef like '%WHERE (tax_id IS NOT NULL)%')                        as clients_tax_id_unique_partial,
  exists (select 1 from pg_trigger where tgrelid = 'public.clients'::regclass
            and tgname = 'trg_guard_client_status' and not tgisinternal)            as client_status_guard_trigger,

  -- 3. registration_links: 8 עמודות, טוקן ייחודי, 4 CHECKים
  (select n from link_cols) = 8                                                     as links_ncols_is_8,
  ((select n_token_key from link_checks) = 1 and (select n_chk from link_checks) = 4) as links_constraints,

  -- 4. client_registrations: 27 עמודות, 20 CHECKים, אינדקס קישור חד-פעמי
  (select n from reg_cols) = 27                                                     as registrations_ncols_is_27,
  (select n from reg_checks) = 20                                                   as registrations_nchecks_is_20,
  exists (select 1 from pg_indexes where schemaname = 'public'
            and indexname = 'client_registrations_link_key' and indexdef like '%UNIQUE%') as registrations_one_per_link,

  -- 5–6. shows + booking_contacts
  exists (select 1 from col where table_name = 'shows' and column_name = 'first_booking_needs_approval'
            and is_nullable = 'NO' and column_default = 'false')                    as shows_flag_col,
  (exists (select 1 from pg_trigger where tgrelid = 'public.shows'::regclass
             and tgname = 'trg_guard_first_booking_flag' and not tgisinternal)
   and exists (select 1 from pg_constraint where conrelid = 'public.booking_contacts'::regclass
                 and contype = 'f' and confrelid = 'public.client_registrations'::regclass)) as flag_guard_and_contacts_fk,

  -- 7. 🔴 הרשאות: client_registrations נעולה, token מוחרג
  ((select relrowsecurity from pg_class where oid = 'public.client_registrations'::regclass)
    and not has_table_privilege('anon', 'public.client_registrations', 'SELECT')
    and not has_table_privilege('authenticated', 'public.client_registrations', 'SELECT')
    and not has_table_privilege('authenticated', 'public.client_registrations', 'INSERT')
    and not has_table_privilege('authenticated', 'public.client_registrations', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.client_registrations', 'DELETE')
    and (select count(*) from pg_policies where schemaname = 'public'
           and tablename = 'client_registrations') = 0)                             as registrations_locked_down,
  ((select relrowsecurity from pg_class where oid = 'public.registration_links'::regclass)
    and not has_column_privilege('anon', 'public.registration_links', 'token', 'SELECT')
    and not has_column_privilege('authenticated', 'public.registration_links', 'token', 'SELECT')
    and not has_table_privilege('authenticated', 'public.registration_links', 'INSERT')
    and has_column_privilege('authenticated', 'public.registration_links', 'wa_id', 'SELECT')
    and (select count(*) from pg_policies where schemaname = 'public'
           and tablename = 'registration_links') = 1)                               as links_token_hidden,

  -- 8. והכיוון השני: העמודות החדשות בטבלאות קיימות קריאות (כלל 61)
  (has_column_privilege('authenticated', 'public.clients', 'status', 'SELECT')
    and has_column_privilege('authenticated', 'public.clients', 'tax_id', 'SELECT')
    and has_column_privilege('authenticated', 'public.shows', 'first_booking_needs_approval', 'SELECT')
    and has_column_privilege('authenticated', 'public.profiles', 'studio_admin', 'SELECT')
    and not has_column_privilege('authenticated', 'public.booking_contacts', 'registration_id', 'SELECT')) as new_columns_readable,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select count(*) from public.profiles where studio_admin)                         as nstudio_admins,
  (select count(*) from public.clients where status <> 'active')                    as nclients_not_active,
  (select count(*) from public.shows where first_booking_needs_approval)            as nshows_flagged,
  (select count(*) from public.client_registrations)                                as nregistrations,
  (select count(*) from public.registration_links)                                  as nlinks;
