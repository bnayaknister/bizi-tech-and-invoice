-- ============================================================================
-- 0118 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שורה אחת; כל העמודות הבוליאניות חייבות להיות true.
-- n_client_comments / n_live_approvals הן עמודות מידע (צפוי 0 עד E13-8ב).
-- ============================================================================
select
  exists (select 1 from public.schema_ledger where version = '0118')                                  as ledger_row_present,
  (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('review_item_comment', 'review_item_reapprove')
       and p.prosecdef and array_to_string(p.proconfig, ',') like '%search_path=public%')             as two_definer_functions,
  (pg_get_function_identity_arguments('public.review_item_comment(uuid, uuid, uuid, text, int, text)'::regprocedure)
     = 'p_link_id uuid, p_item_id uuid, p_version_id uuid, p_kind text, p_time_ms integer, p_body text') as comment_signature,
  (pg_get_function_identity_arguments('public.review_item_reapprove(uuid, uuid, uuid)'::regprocedure)
     = 'p_link_id uuid, p_item_id uuid, p_version_id uuid')                                            as reapprove_signature,
  not (has_function_privilege('anon', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
       or has_function_privilege('anon', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE'))
                                                                                                        as sessions_cannot_execute,
  (has_function_privilege('service_role', 'public.review_item_comment(uuid, uuid, uuid, text, int, text)', 'EXECUTE')
   and has_function_privilege('service_role', 'public.review_item_reapprove(uuid, uuid, uuid)', 'EXECUTE')) as service_role_executes,
  not (has_function_privilege('anon', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE')
       or has_function_privilege('authenticated', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE'))
                                                                                                        as create_pin_still_closed,
  (select count(*) from public.client_review_comments where not is_backfill)                            as n_client_comments,
  (select count(*) from public.client_review_approvals where not is_backfill)                           as n_live_approvals;
