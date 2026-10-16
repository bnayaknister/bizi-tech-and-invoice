-- ============================================================================
-- 0116 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- n_bunny_rows ו-n_drive_rows הן עמודות מידע (bunny צפוי 0 עד E13-4;
-- drive = מספר גרסאות ה-v1 של ה-backfill, 0 לפני שהורץ).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0116')                                as ledger_row_present,
  (select count(*) = 32 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_versions')                        as versions_32_cols,
  (select count(*) = 7 from information_schema.columns
     where table_schema = 'public' and table_name = 'client_review_versions'
       and (column_name, data_type) in (('drive_file_id', 'text'), ('drive_sha256', 'text'),
                                        ('drive_size_bytes', 'bigint'), ('drive_mime_type', 'text'),
                                        ('integrity', 'text'), ('integrity_at', 'timestamp with time zone'),
                                        ('fetch_requested_at', 'timestamp with time zone')))           as drive_cols_typed,
  (select count(*) = 2 from pg_constraint
     where conrelid = 'public.client_review_versions'::regclass and contype = 'c' and convalidated
       and conname in ('crv_bunny_fields_chk', 'crv_drive_source_chk'))                              as shape_checks,
  coalesce((select pg_get_constraintdef(oid) like '%bunny_status = ''uploading''%'
              from pg_constraint where conname = 'crv_bunny_fields_chk'
               and conrelid = 'public.client_review_versions'::regclass), false)                     as guidless_only_while_uploading,
  exists (select 1 from pg_indexes
            where schemaname = 'public' and tablename = 'client_review_versions'
              and indexname = 'uq_crv_item_drive_sha' and indexdef like 'CREATE UNIQUE INDEX%')       as q17_unique_index,
  exists (select 1 from pg_constraint where conname = 'crv_ready_needs_original_chk'
            and conrelid = 'public.client_review_versions'::regclass and convalidated)                as ready_gate_kept,
  exists (select 1 from pg_constraint where conname = 'crv_ready_at_chk'
            and conrelid = 'public.client_review_versions'::regclass and convalidated)                as ready_at_check_kept,
  not (has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT')
       or has_column_privilege('authenticated', 'public.client_review_versions', 'drive_sha256', 'SELECT')
       or has_column_privilege('anon', 'public.client_review_versions', 'drive_file_id', 'SELECT'))   as sessions_cannot_read,
  (has_table_privilege('service_role', 'public.client_review_versions', 'SELECT')
   and has_table_privilege('service_role', 'public.client_review_versions', 'INSERT')
   and has_table_privilege('service_role', 'public.client_review_versions', 'UPDATE'))               as service_role_reads_writes,
  (select count(*) = 0 from pg_policies
     where schemaname = 'public' and tablename = 'client_review_versions')                           as zero_policies,
  (select count(*) from public.client_review_versions where source = 'bunny')                         as n_bunny_rows,
  (select count(*) from public.client_review_versions where source = 'drive')                         as n_drive_rows;
