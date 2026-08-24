-- 0061: a job is never created for an episode that has not been recorded.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHY. 0060 established the rule "a job is work that was done, so it is born
-- at הוקלט". The trigger honours that by construction — it only fires on the
-- transition INTO הוקלט or אושר_ע"י_לקוח. But the function it calls,
-- ensure_job_for_production, checks kind/cancelled/merged and NOT status, and
-- it is also called directly by the backfill scripts. That is how חתונמיות /
-- דנה ספקטור (record_date 2026-08-24, still עתיד_להתחיל) was given a job on
-- 2026-08-24: work that has not happened, carrying a billable record.
--
-- The guard belongs in the function, not in each caller. A rule enforced at
-- the call sites is a rule that the next call site forgets.
--
-- NAMED LITERALLY, NEVER BY ORDER. 'בוטל' is the LAST value of
-- production_status, so any "status < הוקלט" comparison would sweep cancelled
-- episodes into the allowed set — the same trap 0060 documents.
--
-- 'בהקלטה' is included with the owner's agreement: the recording is under way,
-- which is not the same as done. The status is empty across the account today
-- (census 2026-08-24), so this decides the rule rather than changing behaviour.
--
-- NOT SILENT. A skip writes job_skipped_not_recorded, so a backfill that
-- quietly does nothing is still legible afterwards. The existing
-- client_approved_already_billed event keeps its own meaning: "a job exists",
-- which is a different fact from "too early for one".
--
-- The eight historical jobs already sitting on עתיד_להתחיל productions
-- (created 2026-07-12 and 2026-07-30, one of them carrying invoice_biz 40217
-- and paid) are NOT touched by this migration. It changes what happens next;
-- it does not rewrite what happened. They are a separate decision.

do $mig$
begin

create or replace function public.ensure_job_for_production(p_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  prod public.productions%rowtype;
  new_job_id uuid;
  base_amount numeric;
  addon_total numeric;
  job_amount numeric;
begin
  select * into prod from public.productions where id = p_id;
  if not found then return null; end if;

  -- an internal episode is not billable; a cancelled or merged one must never
  -- acquire a job (the trigger cannot reach these, a direct call could)
  if prod.kind <> 'client' then return null; end if;
  if prod.cancelled_at is not null then return null; end if;
  if prod.merged_into is not null then return null; end if;

  -- 0061: the work has not been done yet. Named literally, never by enum
  -- order — 'בוטל' sorts last and would slip through a range test.
  if prod.status in ('עתיד_להתחיל', 'בהקלטה') then
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', p_id, 'job_skipped_not_recorded', auth.uid(),
            jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                               'status', prod.status, 'fired_by', p_reason));
    return null;
  end if;

  -- THE DUPLICATE GUARD. This is what makes הוקלט -> אושר safe: the second
  -- transition finds the job the first one created and does nothing. Also what
  -- makes a backfill safe to re-run, and what has always protected a
  -- production whose status moves backwards and forwards again.
  if exists (select 1 from public.job_productions where production_id = p_id) then
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', p_id, 'client_approved_already_billed', auth.uid(),
            jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                               'fired_by', p_reason));
    return null;
  end if;

  -- effective base: the production's override wins over the show default
  select coalesce(prod.price_override, s.default_rate) into base_amount
  from public.shows s where s.id = prod.show_id;

  -- approved, priced add-ons on this production (at הוקלט there are normally
  -- none yet — the accepted consequence recorded in 0060)
  select coalesce(sum(total), 0) into addon_total
  from public.production_addons
  where production_id = p_id and status = 'approved' and total is not null;

  -- no base price -> the deal invoice is blocked anyway, so leave the amount
  -- null and let the "fill in the amount" note apply
  if base_amount is not null then
    job_amount := base_amount + coalesce(addon_total, 0);
  else
    job_amount := null;
  end if;

  insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
  values (prod.client_id, prod.contract_id, current_date, prod.podcast_name, job_amount,
          case when job_amount is not null
               then 'נוצר אוטומטית (' || p_reason || '). סכום = מחיר אפקטיבי + תוספות מאושרות — לאמת ולהנפיק חשבונית עסקה.'
               else 'נוצר אוטומטית (' || p_reason || '). יש להשלים סכום וחשבונית עסקה.' end)
  returning id into new_job_id;

  insert into public.job_productions (job_id, production_id)
  values (new_job_id, p_id);

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', p_id, 'client_approved_job_created', auth.uid(),
          jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                             'job_id', new_job_id, 'base_amount', base_amount,
                             'addon_total', addon_total, 'job_amount', job_amount,
                             'fired_by', p_reason));
  return new_job_id;
end;
$fn$;

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0061', now(), 'bnaya',
        'ensure_job_for_production מסרב ליצור job להפקה ב-עתיד_להתחיל או בהקלטה — job הוא עבודה שבוצעה, וזה מיישר את הפונקציה עם הכלל ש-0060 קבעה. הטריגר עצמו כבר ירה רק על הוקלט/אושר, כך שהשומר מגן על נתיב ה-RPC שדרכו סקריפט המילוי אחורה נתן job לחתונמיות/דנה ספקטור ב-24.8 על פרק שטרם הוקלט. שני הסטטוסים נקובים בשמן ולא בהשוואת סדר, כי בוטל הוא הערך האחרון ב-production_status. דילוג כותב job_skipped_not_recorded ואינו שקט; client_approved_already_billed שומר על משמעותו הנפרדת (job כבר קיים, להבדיל ממוקדם מדי). שמונת ה-jobs ההיסטוריים שכבר יושבים על הפקות עתידיות (12.7 ו-30.7, אחד מהם עם invoice_biz 40217 ושולם) לא נגעו — הכרעה נפרדת. אפס שינוי סכימה, אפס DELETE.');

  raise notice '0061 הוחלה ונרשמה. job לא נוצר לפרק שטרם הוקלט.';

end $mig$;
