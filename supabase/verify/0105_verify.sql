-- ============================================================================
-- 0105 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. אחת עשרה עמודות בוליאניות, **כולן חייבות להיות true**, ועוד שתי
-- עמודות מידע. אם השורה לא חזרה בכלל — המיגרציה לא רצה.
-- ============================================================================

with
cols as (
  select
    count(*) filter (where column_name = 'replaces_request_id')    as replaces,
    count(*) filter (where column_name = 'calendar_delete_status') as del_status,
    count(*) filter (where column_name = 'calendar_delete_error')  as del_error
  from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests'
),
checks as (
  select
    count(*) filter (where conname = 'booking_requests_replaces_not_self_chk')       as not_self,
    count(*) filter (where conname = 'booking_requests_calendar_delete_status_chk')  as del_chk,
    count(*) filter (where conname = 'booking_requests_no_overlap_approved')          as exclude_kept
  from pg_constraint
  where conrelid = 'public.booking_requests'::regclass
)
select
  -- 0. הפנקס
  (exists (select 1 from public.schema_ledger where version = '0105'))                       as ledger_row_present,

  -- 1. שלוש העמודות
  ((select replaces from cols) = 1 and (select del_status from cols) = 1
    and (select del_error from cols) = 1)                                                     as three_columns_present,

  -- 2. שני ה-CHECKים
  (select not_self from checks) = 1                                                           as replaces_not_self_chk_present,
  (select del_chk from checks) = 1                                                            as delete_status_chk_present,

  -- 🔴 3. ה-EXCLUDE של 0096 עדיין קיים — ההחלפה האטומית נשענת עליו
  (select exclude_kept from checks) = 1                                                       as exclude_constraint_kept,

  -- 4. שתי הפונקציות
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'booking_approve_replacing')             as approve_replacing_present,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'booking_revert_replacing')              as revert_replacing_present,

  -- 5. execute רק ל-service_role
  (has_function_privilege('service_role', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.booking_revert_replacing(uuid, uuid)', 'execute'))
                                                                                              as service_role_can_execute,
  (not has_function_privilege('anon', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.booking_revert_replacing(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.booking_revert_replacing(uuid, uuid)', 'execute'))
                                                                                              as session_roles_cannot_execute,

  -- 6. העמודות החדשות אינן קריאות מסשן
  (not has_column_privilege('authenticated', 'public.booking_requests', 'replaces_request_id', 'select')
    and not has_column_privilege('authenticated', 'public.booking_requests', 'calendar_delete_status', 'select')
    and not has_column_privilege('authenticated', 'public.booking_requests', 'calendar_delete_error', 'select')
    and not has_column_privilege('anon', 'public.booking_requests', 'replaces_request_id', 'select'))
                                                                                              as new_columns_not_session_readable,

  -- 7. שלבי השיחה: ה-CHECK של wa_conversations כולל את שלושת השלבים החדשים
  (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'wa_conversations_step_chk'
      and conrelid = 'public.wa_conversations'::regclass) like '%cancel-confirm%'
    and (select pg_get_constraintdef(oid) from pg_constraint
    where conname = 'wa_conversations_step_chk'
      and conrelid = 'public.wa_conversations'::regclass) like '%manage%'      as conversation_steps_extended,

  -- ── עמודות מידע ─────────────────────────────────────────────────────────
  (select count(*) from public.booking_requests where replaces_request_id is not null)      as nmoves,
  (select count(*) from public.booking_requests where calendar_delete_status = 'failed')     as ndelete_failed;
