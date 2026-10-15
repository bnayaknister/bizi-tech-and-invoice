-- ============================================================================
-- 0114 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- n_versions / n_comments / n_approvals הן עמודות מידע (0 מיד אחרי ההחלה,
-- ועד שה-backfill ירוץ).
-- ⚠️ אחרי 0115 העמודה versions_24_cols תחזיר false (0115 הוסיפה ready_at → 25).
-- זה צפוי; את 0115 בודקים ב-0115_verify.sql.
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0114')                               as ledger_row_present,
  (select count(*) = 24 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_versions')                       as versions_24_cols,
  (select count(*) = 19 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_comments')                       as comments_19_cols,
  (select count(*) = 12 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_approvals')                      as approvals_12_cols,
  exists (select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'client_review_versions'
              and column_name = 'number' and is_nullable = 'YES')                                     as q11_number_nullable,
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_crv_item_number'
            and indexdef ilike '%where (number is not null)%')                                        as q11_partial_unique,
  exists (select 1 from pg_constraint where conname = 'crv_ready_needs_original_chk'
            and conrelid = 'public.client_review_versions'::regclass and convalidated)               as ready_needs_original,
  exists (select 1 from pg_constraint where conname = 'crc_version_item_fk'
            and conrelid = 'public.client_review_comments'::regclass)
    and exists (select 1 from pg_constraint where conname = 'cra_version_item_fk'
            and conrelid = 'public.client_review_approvals'::regclass)                                as composite_fks,
  exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_crc_version_pin')  as pin_unique_per_version,
  (select bool_and(relrowsecurity) from pg_class
     where oid in ('public.client_review_versions'::regclass, 'public.client_review_comments'::regclass,
                   'public.client_review_approvals'::regclass))                                       as rls_on,
  not exists (select 1 from pg_policies where schemaname = 'public'
                and tablename in ('client_review_versions', 'client_review_comments', 'client_review_approvals')) as zero_policies,
  not (has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT')
       or has_table_privilege('anon', 'public.client_review_comments', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_review_comments', 'SELECT')
       or has_table_privilege('anon', 'public.client_review_approvals', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_review_approvals', 'SELECT')
       or has_table_privilege('anon', 'public.v_review_media_purge_due', 'SELECT')
       or has_table_privilege('authenticated', 'public.v_review_media_purge_due', 'SELECT'))         as sessions_cannot_read,
  not (has_table_privilege('authenticated', 'public.client_review_versions', 'INSERT')
       or has_table_privilege('authenticated', 'public.client_review_comments', 'INSERT')
       or has_table_privilege('authenticated', 'public.client_review_approvals', 'INSERT'))           as sessions_cannot_write,
  has_table_privilege('service_role', 'public.client_review_versions', 'SELECT')
    and has_table_privilege('service_role', 'public.client_review_versions', 'UPDATE')
    and has_table_privilege('service_role', 'public.client_review_comments', 'INSERT')
    and has_table_privilege('service_role', 'public.client_review_approvals', 'INSERT')
    and has_table_privilege('service_role', 'public.v_review_media_purge_due', 'SELECT')             as service_role_can_use,
  not (has_function_privilege('authenticated', 'public.assign_review_version_number(uuid)', 'EXECUTE')
       or has_function_privilege('anon', 'public.assign_review_version_number(uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE')
       or has_function_privilege('anon', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE')) as sessions_cannot_execute,
  has_function_privilege('service_role', 'public.assign_review_version_number(uuid)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE') as service_role_can_execute,
  (select count(*) = 2 from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('assign_review_version_number', 'create_review_pin')
     and prosecdef and proconfig @> array['search_path=public'])                                      as functions_definer_pinned,
  exists (select 1 from pg_class where oid = 'public.v_review_media_purge_due'::regclass
            and reloptions @> array['security_invoker=on'])                                           as view_security_invoker,
  (select count(*) from public.client_review_versions)                                                as n_versions,
  (select count(*) from public.client_review_comments)                                                as n_comments,
  (select count(*) from public.client_review_approvals)                                               as n_approvals;
