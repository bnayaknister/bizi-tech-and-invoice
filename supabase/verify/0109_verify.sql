-- ============================================================================
-- 0109 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- nmerged היא עמודת מידע (מספר השורות הממוזגות).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0109')                    as ledger_row_present,
  exists (select 1 from pg_constraint where conname = 'clients_status_chk'
            and conrelid = 'public.clients'::regclass
            and pg_get_constraintdef(oid) like '%merged%')                              as status_chk_has_merged,
  exists (select 1 from pg_constraint where conname = 'clients_merged_status_chk'
            and conrelid = 'public.clients'::regclass and convalidated)                 as merged_status_chk_present,
  exists (select 1 from pg_constraint where conname = 'clients_merged_row_unmapped')    as merged_row_unmapped_still_there,
  not exists (select 1 from public.clients where status = 'active' and merged_into is not null) as no_active_merged,
  not exists (select 1 from public.clients where status = 'merged' and merged_into is null)     as no_merged_without_target,
  (select count(*) from public.clients where status = 'merged')
    = (select count(*) from public.clients where merged_into is not null)               as merged_counts_agree,
  (select count(*) from public.clients where status = 'merged')                         as nmerged;
