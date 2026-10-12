-- ============================================================================
-- 0111 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- nrows / nwith_email הן עמודות מידע (nwith_email = 0 מיד אחרי ההחלה).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0111')                         as ledger_row_present,
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'booking_contacts'
              and column_name = 'email' and is_nullable = 'YES' and data_type = 'text')       as email_col_nullable_text,
  exists (select 1 from pg_constraint where conname = 'booking_contacts_email_chk'
            and conrelid = 'public.booking_contacts'::regclass and convalidated)            as email_check_present,
  not has_column_privilege('authenticated', 'public.booking_contacts', 'email', 'SELECT')   as email_not_session_readable,
  not has_column_privilege('anon', 'public.booking_contacts', 'email', 'SELECT')            as email_not_anon_readable,
  exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'booking_contacts'
            and indexname = 'booking_contacts_show_wa_key')                                 as show_wa_unique_still_there,
  (select count(*) from public.booking_contacts)                                            as nrows,
  (select count(*) from public.booking_contacts where email is not null)                    as nwith_email;
