-- ============================================================================
-- 0112 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- nrows / narchived / nhofatz הן עמודות מידע (narchived = 0 מיד אחרי ההחלה).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0112')                          as ledger_row_present,
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'productions'
              and column_name = 'board_archived_at' and is_nullable = 'YES'
              and data_type = 'timestamp with time zone')                                      as archived_at_col,
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'productions'
              and column_name = 'board_archived_by' and is_nullable = 'YES' and data_type = 'uuid') as archived_by_col,
  exists (select 1 from pg_constraint where conname = 'productions_board_archive_status_chk'
            and conrelid = 'public.productions'::regclass and convalidated)                    as status_check_present,
  exists (select 1 from pg_constraint where conname = 'productions_board_archive_by_chk'
            and conrelid = 'public.productions'::regclass and convalidated)                    as by_check_present,
  exists (select 1 from pg_trigger where tgname = 'trg_board_archive'
            and tgrelid = 'public.productions'::regclass and not tgisinternal and tgenabled = 'O') as trigger_enabled,
  exists (select 1 from pg_proc where proname = 'board_archive_guard'
            and pronamespace = 'public'::regnamespace and prosecdef)                           as guard_is_security_definer,
  has_column_privilege('authenticated', 'public.productions', 'board_archived_at', 'SELECT')
    and has_column_privilege('authenticated', 'public.productions', 'board_archived_by', 'SELECT') as board_can_read,
  not has_column_privilege('anon', 'public.productions', 'board_archived_at', 'SELECT')       as anon_cannot_read,
  not has_table_privilege('authenticated', 'public.productions', 'SELECT')                    as table_select_still_closed,
  not has_column_privilege('authenticated', 'public.productions', 'price_override', 'SELECT') as price_override_still_hidden,
  (select count(*) from public.productions)                                                    as nrows,
  (select count(*) from public.productions where board_archived_at is not null)                as narchived,
  (select count(*) from public.productions where status = 'הופץ')                              as nhofatz;
