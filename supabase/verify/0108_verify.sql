-- ============================================================================
-- 0108 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת, **כל העמודות חייבות להיות true**. אם לא חזרה שורה —
-- משהו לא רץ.
-- ============================================================================

with fns(sig) as (
  values
    ('public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb)'),
    ('public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb)'),
    ('public.reject_client_registration(uuid, uuid, text)'),
    ('public.purge_rejected_registrations(timestamptz)')
)
select
  -- 0. הפנקס
  exists (select 1 from public.schema_ledger where version = '0108')                          as ledger_row_present,
  -- 1. ארבע הפונקציות קיימות
  (select count(*) from fns where to_regprocedure(sig) is not null) = 4                      as four_functions_exist,
  -- 2. אף אחת לא ניתנת להרצה מסשן
  (select count(*) from fns where has_function_privilege('anon', sig, 'EXECUTE')) = 0         as anon_cannot_execute,
  (select count(*) from fns where has_function_privilege('authenticated', sig, 'EXECUTE')) = 0 as authenticated_cannot_execute,
  -- 3. service_role כן
  (select count(*) from fns where has_function_privilege('service_role', sig, 'EXECUTE')) = 4 as service_role_can_execute,
  -- 4. SECURITY INVOKER (לא definer) — הן רצות בהרשאות הקורא, כלומר service_role
  (select count(*) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig) where p.prosecdef) = 0
                                                                                              as all_security_invoker,
  -- 5. search_path קבוע בכל אחת
  (select count(*) from fns f join pg_proc p on p.oid = to_regprocedure(f.sig)
     where p.proconfig @> array['search_path=public']) = 4                                    as search_path_pinned,
  -- 6. שום נתון לא השתנה בהחלה: אין לקוח active שנוצר מהרשמה בלי אישור
  not exists (select 1 from public.client_registrations where status = 'approved' and decided_at is null)
                                                                                              as no_approved_without_decision;
