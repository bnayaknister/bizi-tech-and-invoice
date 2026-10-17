-- ============================================================================
-- 0117 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- n_guidless_rows היא עמודת מידע: גרסאות bunny בלי guid (צפוי 0).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0117')                                as ledger_row_present,
  (select count(*) = 32 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_versions')                        as versions_still_32_cols,
  coalesce((select pg_get_constraintdef(oid) like '%''uploading''%' and pg_get_constraintdef(oid) like '%''failed''%'
              from pg_constraint where conname = 'crv_bunny_fields_chk' and convalidated
               and conrelid = 'public.client_review_versions'::regclass), false)                     as guidless_uploading_or_failed,
  coalesce((select pg_get_constraintdef(oid) like '%number IS NULL%'
              from pg_constraint where conname = 'crv_bunny_fields_chk'
               and conrelid = 'public.client_review_versions'::regclass), false)                     as guidless_never_numbered,
  (select count(*) = 4 from pg_constraint
     where conrelid = 'public.client_review_versions'::regclass and contype = 'c' and convalidated
       and conname in ('crv_bunny_fields_chk', 'crv_drive_source_chk',
                       'crv_ready_needs_original_chk', 'crv_ready_at_chk'))                          as shape_checks_4,
  exists (select 1 from pg_indexes
            where schemaname = 'public' and tablename = 'client_review_versions'
              and indexname = 'uq_crv_item_drive_sha' and indexdef like 'CREATE UNIQUE INDEX%'
              and indexdef like '%<> ''failed''%')                                                    as q17_skips_failed,
  not (has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT')
       or has_column_privilege('authenticated', 'public.client_review_versions', 'bunny_status', 'SELECT'))
                                                                                                      as sessions_cannot_read,
  (has_table_privilege('service_role', 'public.client_review_versions', 'SELECT')
   and has_table_privilege('service_role', 'public.client_review_versions', 'INSERT')
   and has_table_privilege('service_role', 'public.client_review_versions', 'UPDATE'))               as service_role_reads_writes,
  (select count(*) = 0 from pg_policies
     where schemaname = 'public' and tablename = 'client_review_versions')                           as zero_policies,
  (select count(*) from public.client_review_versions
     where source = 'bunny' and bunny_video_id is null)                                               as n_guidless_rows;
