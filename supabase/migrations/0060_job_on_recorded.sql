-- 0060: the job is created when the episode is RECORDED, in addition to when
-- the client approves it (owner decision 2026-08-24).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHY. A job is the only thing a tax document can stamp invoice_tax on, and
-- until now the only thing in the entire system that created one was the
-- client-approval transition (0033). That made the "client paid immediately"
-- feature contradict itself: it exists to raise a 305/320 straight off a work
-- order — which happens BEFORE the client has approved anything — and it was
-- refused every time with "no linked jobs", because at that moment no job
-- could possibly exist. Census 2026-08-24: 20 live productions had reached
-- הוקלט or later with no job at all. The work was done; the record of it did
-- not exist.
--
-- ADDITIVE, NOT A MOVE (owner instruction). The client-approval branch is
-- untouched and still fires. הוקלט is simply a second, earlier entry point.
-- Whichever comes first creates the job; the guard below makes the second a
-- no-op. Nothing about the deal-invoice path changes: 'אושר_ע"י_לקוח' still
-- enqueues a 300 exactly as before, and enqueueDocument prices it from
-- price_override/default_rate + approved add-ons on its own — it has never
-- read jobs.amount, so its total cannot drift because of this change.
--
-- KNOWN CONSEQUENCE, ACCEPTED. 0033 sums 'approved' add-ons into the job
-- total, and relies on the review path approving add-ons just before flipping
-- the production to client-approved. A job created at הוקלט is created before
-- the client has seen anything, so its amount is the BASE price and any add-on
-- approved later is not folded in. The deal invoice is still correct (it
-- computes its own total); it is jobs.amount that can under-report until
-- someone edits it. Raised with the owner and accepted rather than splitting
-- create/update across the two transitions.
--
-- NO ORDINAL COMPARISON. 'בוטל' is the LAST value of production_status, so any
-- "status >= הוקלט" test would sweep cancelled productions into billing. The
-- two entry points are named literally for exactly that reason.
--
-- Security definer for the same reason 0033 gives: it reads shows.default_rate,
-- price_override and production_addons totals, all money-restricted to
-- authenticated, and must work from the account-less client review response.

do $mig$
begin

-- ---------------------------------------------------------------------------
-- 1. The body, lifted verbatim out of 0033's trigger into a callable function.
--    ONE definition, two callers: the trigger below, and the retroactive
--    backfill for the 20 productions already past הוקלט. The alternative for
--    the backfill — nudging status to make the trigger fire — was rejected: it
--    pollutes the production event log and can wake unrelated side effects
--    (auto-advance, review-link creation).
-- ---------------------------------------------------------------------------
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
  -- acquire a job (the trigger cannot reach these, the backfill could)
  if prod.kind <> 'client' then return null; end if;
  if prod.cancelled_at is not null then return null; end if;
  if prod.merged_into is not null then return null; end if;

  -- THE DUPLICATE GUARD. This is what makes הוקלט -> אושר safe: the second
  -- transition finds the job the first one created and does nothing. Also what
  -- makes the backfill safe to re-run, and what has always protected a
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

  -- approved, priced add-ons on this production (see KNOWN CONSEQUENCE above:
  -- at הוקלט there are normally none yet)
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

-- ---------------------------------------------------------------------------
-- 2. The trigger. Same shape as 0033, now with two named entry points. The
--    trigger binding itself (trg_on_production_approved, AFTER UPDATE OF
--    status) is NOT recreated — only the function body it calls.
-- ---------------------------------------------------------------------------
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.kind <> 'client' then
    return new;
  end if;

  if new.status = 'הוקלט' and old.status is distinct from 'הוקלט' then
    perform public.ensure_job_for_production(new.id, 'recorded');
  elsif new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    perform public.ensure_job_for_production(new.id, 'client_approved');
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. The ledger entry — inside the same atomic DO block, so the change and its
--    record fail or pass together (supabase/migrations/README.md).
-- ---------------------------------------------------------------------------
insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0060', now(), 'bnaya',
        'job נוצר גם במעבר ל-הוקלט, בנוסף לאישור הלקוח (0033) ולא במקומו. גוף הטריגר חולץ ל-ensure_job_for_production(uuid,text) — הגדרה אחת, שני קוראים: הטריגר והתיקון הרטרואקטיבי, כך שהמילוי אחורה עובר באותו מסלול בדיוק ולא ב-INSERT ידני. גארד כפילות על job_productions הוא מה שהופך הוקלט→אושר לבטוח, וגם מגן על סטטוס שחוזר אחורה ומתקדם שוב. שתי נקודות הכניסה נקובות בשמן במפורש ולא בהשוואת סדר, כי בוטל הוא הערך האחרון ב-production_status וכל תנאי מסוג >= הוקלט היה גורף הפקות מבוטלות לחיוב. trg_on_production_approved עצמו לא נוצר מחדש. מסלול חשבון העסקה לא נגע: enqueueDocument מתמחר לבד ומעולם לא קרא jobs.amount. תוצאת לוואי מוצהרת ומאושרת: job שנוצר ב-הוקלט נושא מחיר בסיס בלבד, ותוספת שתאושר אחר כך לא תיכנס ל-jobs.amount (החשבונית כן תכלול אותה). אפס שינוי סכימה, אפס DELETE.');

  raise notice '0060 הוחלה ונרשמה. job נולד כשהפרק מוקלט, לא רק כשהלקוח מאשר.';

end $mig$;
