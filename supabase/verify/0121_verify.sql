-- ============================================================================
-- 0121 — אימות. להריץ **אחרי** קובץ המיגרציה. קריאה בלבד.
-- כל שורה צריכה לצאת ok = true.
-- ============================================================================
select '1. הפנקס: 0121 רשומה' as check_name,
       exists (select 1 from public.schema_ledger where version = '0121') as ok
union all
select '2. on_production_approved — הגוף החדש (v_new_done)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'on_production_approved'
                  and p.prosrc like '%v_new_done%' and p.prosrc like '%v_old_done%')
union all
select '3. …נקודות הכניסה הישנות נשמרו (הוקלט / אושר_ע"י_לקוח)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'on_production_approved'
                  and p.prosrc like '%''הוקלט''%' and p.prosrc like '%client_approved%' and p.prosrc like '%''recorded''%')
union all
select '4. …SECURITY DEFINER + search_path=public',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'on_production_approved'
                  and p.prosecdef and coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=public%')
union all
select '5. trg_on_production_approved — במקומו, AFTER UPDATE OF status',
       exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
                where c.relname = 'productions' and t.tgname = 'trg_on_production_approved' and not t.tgisinternal
                  and pg_get_triggerdef(t.oid) like '%AFTER UPDATE OF status%')
union all
select '6. ensure_job_for_production לא נגעה (גארד הכפילות של 0060 עדיין בגוף)',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'ensure_job_for_production'
                  and p.prosrc like '%job_productions where production_id = p_id%'
                  and p.prosrc like '%job_skipped_not_recorded%')
union all
select '7. אירוע האודיט job_entry_widened נכתב פעם אחת',
       (select count(*) from public.events where event_type = 'job_entry_widened' and payload->>'migration' = '0121') = 1;
