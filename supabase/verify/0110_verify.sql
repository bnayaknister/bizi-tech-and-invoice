-- ============================================================================
-- 0110 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- העמודות keep_* הן מידע: הספירות של הנשארת אחרי המיזוג (צפוי מיד אחרי
-- ההחלה: jobs 7, invoices 12, pending 1, documents 39 — ויגדלו עם הזמן).
-- ============================================================================
with
k as (select * from public.clients where id = '3f010d05-5859-4a9d-89ad-f79eee55cad5'),
d as (select * from public.clients where id = '94b1949d-9918-470c-9438-dfadf1617880'),
refs as (
  select
    (select count(*) from public.contracts         where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.documents         where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.invoices          where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.jobs              where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.pending_documents where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.productions       where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.shows             where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.misc_productions  where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.client_morning_ids where client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.client_registrations
       where client_id = '94b1949d-9918-470c-9438-dfadf1617880'
          or duplicate_of_client_id = '94b1949d-9918-470c-9438-dfadf1617880')
  + (select count(*) from public.clients where merged_into = '94b1949d-9918-470c-9438-dfadf1617880') as n
)
select
  exists (select 1 from public.schema_ledger where version = '0110')                      as ledger_row_present,
  -- הממוזגת
  (select merged_into = '3f010d05-5859-4a9d-89ad-f79eee55cad5' from d)                   as drop_merged_into_keep,
  (select status = 'merged' from d)                                                       as drop_status_merged,
  (select morning_client_id is null from d)                                               as drop_unmapped,
  (select normalized_name = 'merged:94b1949d-9918-470c-9438-dfadf1617880' from d)         as drop_name_released,
  (select n = 0 from refs)                                                                as zero_refs_to_drop,
  -- הנשארת
  (select name = 'גל אורן לרנר' from k)                                                   as keep_name_applied,
  (select normalized_name = 'גלאורןלרנר' from k)                                          as keep_normalized_applied,
  (select tax_id = '540279502' from k)                                                    as keep_tax_id_set,
  (select status = 'active' and merged_into is null from k)                               as keep_active,
  (select morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394' from k)              as keep_morning_id,
  (select count(*) = 1 from public.client_morning_ids
     where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5'
       and morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394' and is_primary)     as keep_cmi_primary,
  (select count(*) = 1 from public.client_morning_ids
     where morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394')                    as morning_id_one_owner,
  -- ייחודיות השם
  (select count(*) = count(distinct normalized_name) from public.clients)                 as normalized_names_unique,
  (select count(*) = 1 from public.clients where normalized_name = 'גלאורןלרנר')          as one_row_with_new_name,
  exists (select 1 from public.events where event_type = 'client_merged'
            and entity_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5')                       as merge_event_written,
  -- מידע
  (select count(*) from public.jobs              where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5') as keep_jobs,
  (select count(*) from public.invoices          where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5') as keep_invoices,
  (select count(*) from public.pending_documents where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5') as keep_pending,
  (select count(*) from public.documents         where client_id = '3f010d05-5859-4a9d-89ad-f79eee55cad5') as keep_documents;
