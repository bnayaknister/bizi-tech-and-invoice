-- ============================================================================
-- 0115 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- n_ready_without_ready_at חייב להיות 0; n_purge_rows היא עמודת מידע.
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0115')                                as ledger_row_present,
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'client_review_versions'
              and column_name = 'ready_at' and data_type = 'timestamp with time zone')                 as ready_at_col,
  (select count(*) = 25 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_versions')                        as versions_25_cols,
  exists (select 1 from pg_trigger where tgname = 'trg_review_version_ready_at'
            and tgrelid = 'public.client_review_versions'::regclass and not tgisinternal and tgenabled = 'O') as trigger_enabled,
  exists (select 1 from pg_constraint where conname = 'crv_ready_at_chk'
            and conrelid = 'public.client_review_versions'::regclass and convalidated)                as ready_at_check,
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
     where table_schema = 'public' and table_name = 'v_review_media_purge_due')
    = 'item_id,approval_id,approved_at,purge_after,latest_version_id,latest_ready_at,upload_pending'   as view_columns,
  exists (select 1 from pg_class where oid = 'public.v_review_media_purge_due'::regclass
            and reloptions @> array['security_invoker=on'])                                            as view_security_invoker,
  not (has_table_privilege('anon', 'public.v_review_media_purge_due', 'SELECT')
       or has_table_privilege('authenticated', 'public.v_review_media_purge_due', 'SELECT'))          as sessions_cannot_read_view,
  has_table_privilege('service_role', 'public.v_review_media_purge_due', 'SELECT')                     as service_role_reads_view,
  not (has_function_privilege('anon', 'public.review_version_ready_at()', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.review_version_ready_at()', 'EXECUTE'))     as trigger_fn_not_callable,
  (select count(*) from public.client_review_versions where bunny_status = 'ready' and ready_at is null) as n_ready_without_ready_at,
  (select count(*) from public.v_review_media_purge_due)                                               as n_purge_rows;
