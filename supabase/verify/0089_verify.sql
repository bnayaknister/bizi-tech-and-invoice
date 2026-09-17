-- ============================================================================
-- 0089 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
-- קריאה בלבד. עשר בדיקות, כל אחת חייבת להחזיר true.
-- `Success. No rows returned` אינו הוכחה — רק השורות שלמטה.
-- ============================================================================
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0089')            as ledger_row,

  -- 2. אירוע האודיט נכתב
  (select count(*) = 1 from public.events
    where event_type = 'due_date_logic_extracted'
      and payload->>'migration' = '0089')                                            as audit_event,

  -- 3. הפונקציה קיימת, מחזירה date, ו-IMMUTABLE (provolatile = 'i')
  (select p.provolatile = 'i' and pg_get_function_result(p.oid) = 'date'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_date_for')                        as fn_immutable_date,

  -- 4. ⚠️ אינה STRICT — proisstrict חייב להיות false, אחרת terms ריק מוחק due_date
  (select p.proisstrict = false
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_date_for')                        as fn_not_strict,

  -- 5. ACL — EXECUTE נשלל מ-PUBLIC (כלל 49)
  (select not has_function_privilege('public', p.oid, 'execute')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_date_for')                        as acl_public_revoked,

  -- 6. ACL — service_role כן יכול
  (select has_function_privilege('service_role', p.oid, 'execute')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_date_for')                        as acl_service_role,

  -- 7. ⚠️ eom הוא סוף החודש ואז +N. 13.08 + eom_30 = 30.09, לא 12.09
  (public.due_date_for('2026-08-13', 'eom_30') = '2026-09-30'
   and public.due_date_for('2026-09-09', 'eom_60') = '2026-11-29'
   and public.due_date_for('2026-08-13', 'net_30') = '2026-09-12'
   and public.due_date_for('2026-08-13', 'immediate') = '2026-08-13'
   and public.due_date_for('2026-02-01', 'eom_30') = '2026-03-30'
   and public.due_date_for('2024-02-29', 'eom_60') = '2024-04-29'
   and public.due_date_for('2026-12-31', 'eom_90') = '2027-03-31')                    as arithmetic,

  -- 8. terms ריק מחזיר את הבסיס, כמו ה-else של 0002
  (public.due_date_for('2026-08-13', null) = '2026-08-13')                            as null_terms_is_base,

  -- 9. הפונקציה מחזירה על כל שורת jobs בדיוק את מה שה-case של 0002 החזיר.
  --    ⚠️ ישן מול חדש על אותו בסיס — לא מול העמודה השמורה. ראה את ההערה
  --    בשער שבמיגרציה: 4 שורות נושאות due_date מיושן מסיבות שקדמו ל-0089.
  (select count(*) = 0 from public.jobs j
     left join public.clients c on c.id = j.client_id
    where case c.payment_terms
            when 'net_30' then coalesce(j.date, current_date) + 30
            when 'net_60' then coalesce(j.date, current_date) + 60
            when 'eom_30' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 30
            when 'eom_60' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 60
            when 'eom_90' then (date_trunc('month', coalesce(j.date, current_date)) + interval '1 month - 1 day')::date + 90
            else coalesce(j.date, current_date)
          end
          is distinct from public.due_date_for(coalesce(j.date, current_date), c.payment_terms))
                                                                                      as jobs_old_equals_new,

  -- 10. הטריגר עדיין במקומו, על אותם אירועים ועל אותה פונקציה
  (select count(*) = 1 from pg_trigger t
     join pg_class  cl on cl.oid = t.tgrelid
     join pg_proc   pr on pr.oid = t.tgfoid
    where cl.relname = 'jobs' and t.tgname = 'trg_compute_due_date'
      and pr.proname = 'compute_due_date' and t.tgenabled = 'O')                      as trigger_intact,

  -- 11. ℹ️ מידע בלבד, לא בדיקה: כמה שורות נושאות due_date מיושן. קדם ל-0089.
  --     צפוי 4 (שלוש עם date ריק שקפאו על current_date של 12.7, ואחת —
  --     07faca02, וואי 360, ₪8,000 — שתנאי התשלום שלה שונו אחרי הכתיבה).
  (select count(*) from public.jobs j
     left join public.clients c on c.id = j.client_id
    where j.due_date is distinct from public.due_date_for(coalesce(j.date, current_date), c.payment_terms))
                                                                                      as stale_due_dates_preexisting;

-- ── בדיקה חיה: הטריגר באמת עובר דרך הפונקציה החדשה ────────────────────────
-- כותב ומגלגל. אפס שורות נשארות.
do $live$
declare
  v_client uuid;
  v_job    uuid;
  v_got    date;
  v_want   date;
begin
  select id into v_client from public.clients where payment_terms = 'eom_60' limit 1;
  if v_client is null then
    raise exception '⏭️ אין לקוח eom_60 — הבדיקה החיה דולגה (שאר הבדיקות תקפות)';
  end if;
  insert into public.jobs (client_id, date, amount, campaign)
  values (v_client, '2026-09-09', 1, 'ZZ-0089-verify')
  returning id, due_date into v_job, v_got;
  v_want := public.due_date_for('2026-09-09', 'eom_60');
  if v_got is distinct from v_want then
    raise exception '❌ הטריגר כתב % במקום %', v_got, v_want;
  end if;
  raise exception '✅ 0089 הטריגר חי ועובר דרך due_date_for: 2026-09-09 + eom_60 = %. השורה גולגלה.', v_got;
end $live$;
