-- 0064: jobs.date is the date the WORK happened, not the date the row was written.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHERE current_date CAME FROM. 0033 wrote `current_date` into jobs.date when
-- the client-approval trigger minted a job, and 0060 carried that line over
-- verbatim when it extracted the body into ensure_job_for_production. Neither
-- was wrong on the day it shipped: the trigger fires on approval, approval
-- usually follows the recording closely, and the two dates were near enough
-- that nobody looked. The 24.8 backfill is what made the gap visible — it gave
-- an episode recorded on 22.7 a job dated 24.8, a month out.
--
-- WHY record_date IS THE RIGHT ONE. jobs.date is not an audit column; created_at
-- already is. It is the business date of the work, and two live consumers
-- measure from it: compute_due_date (0002) derives due_date from it through the
-- client's payment_terms, and the radar plus /finance derive ageing and
-- "overdue N days" from that due_date. Dating a job to the day someone happened
-- to run a script makes an old debt look new. Today every affected client is
-- payment_terms='immediate', so due_date = date and the only visible damage is
-- ageing — but the table holds one net_30 and one eom_60 client, and for either
-- of them a job on a 22.7 episode would have fallen due 23.9 instead of 21.8.
--
-- coalesce, not a bare column: a production with no record_date (hand-made,
-- date to be filled in) must still get a job, and current_date is the honest
-- fallback there — it is what we know.
--
-- ALSO HERE, and only because it is the same defect surfacing twice: the
-- אולמדיה duplicate. Three productions carry "שניידר AI - עריכות פרק ו 2 רילז"
-- on 29.7. One (1beacaa2) is real and billed — job 9a2a3360, deal invoice 40293.
-- 44063455 is a duplicate RECORD of the same session, and the backfill gave it a
-- job because it correctly saw no job attached. It is merged, not cancelled:
-- 0019 names merged_into "the one soft-delete mechanism ... merge a calendar
-- duplicate away", and בוטל would assert the recording never happened, which is
-- false. Its work order was already rejected on 29.7 by whoever noticed.
--
-- WHY dismissed AND NOT move_jobs_to_archive. The archive was the first choice
-- and it is not available: archive.jobs DOES NOT EXIST. 0002 carries the
-- `create table archive.jobs (like public.jobs including all)` statement, but
-- 0002 and 0005 are both recorded in schema_ledger with note='backfill' at one
-- identical timestamp — registered after the fact to describe an existing
-- database, never run as files — so that section never executed. Both
-- move_*_to_archive functions raise 42P01 today and always have. Verified
-- before writing this by calling move_jobs_to_archive with an EMPTY array: the
-- INSERT is still planned, so a missing table raises, while zero rows move.
-- Filed as its own ticket; it is a real bug and not this one.
--
-- dismissed is not a downgrade. 0041 was written for exactly this case — "a
-- wrong/DUPLICATE/irrelevant job must NEVER hard-delete" — it drops the row
-- from every money surface (radar reads jobs with dismissed=false, /finance
-- filters it, mark-paid and jobs-search exclude it), the reason and timestamp
-- are recorded, and it is reversible from the "מוסתרים" tab. dismissed_by stays
-- null on purpose: no human clicked this, a migration did, and inventing an
-- actor id would put a person's name on a decision they did not make.

do $mig$
declare
  v_dup   uuid := '44063455-8cf3-4521-9e93-61b95a3499f3';
  v_real  uuid := '1beacaa2-1aef-4db5-805e-cb76090ee1b6';
  v_job   uuid := '9e3982fe-9e27-47fc-b0d6-cce2a565da78';
  v_reason text := 'כפילות רישום של הקלטה אחת ב-29.7; החיוב האמיתי הוא 40293 על job 9a2a3360';
  v_fixed integer;
  v_guard integer;
  -- the 18 backfill jobs, named one by one. NOT `notes like '%backfill%'` and
  -- NOT created_at >= 24.8: the 17 historical orphan jobs must be impossible to
  -- touch by accident, and an explicit list is the only version of that promise
  -- a later reader can check.
  v_ids uuid[] := array[
    '01e7d5d4-bce7-4317-bb7c-2d3a82c07565','06d03050-7256-4a2c-8a35-680a6e504b12',
    '3a8ba213-26e1-42af-844a-34892263f916','554dd7fe-9b4c-4b24-bb3e-e2b7eb11f81c',
    '5bd93d87-e89b-44e2-8754-9b36836d29a4','608dac49-c914-45ae-890f-6d2d8e46aa0e',
    '73e3ecee-2464-43ac-8acc-5ce3348481c8','8a1bcf1c-ba2a-4dd5-9edd-7ed22e15bdf4',
    '97ab62f5-7610-472a-a85d-bd3416e0c7bf','98244936-6416-41f4-b037-88575fd07be3',
    '9e3982fe-9e27-47fc-b0d6-cce2a565da78','abb26af7-91a1-412f-a2aa-a94a50442f85',
    'c55c5ad3-19a0-43ff-ab4b-1ec29548a0f6','d8609f74-158a-4bad-929f-ee996eb725d6',
    'e348c985-2873-4165-96cd-e3cd53d958f6','ed4e3268-1adb-47c6-aa4c-120a4502ac32',
    'f72eb276-4bd6-4888-8d25-7445cdad0814','fff94d14-dcfd-44c8-9fc9-8a016f22568e'
  ]::uuid[];
begin
  if exists (select 1 from schema_ledger where version = '0064') then
    raise exception '0064 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---- 1. the function: the work date, with today as the honest fallback ----
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

    -- THE DUPLICATE GUARD (0060). What makes הוקלט -> אושר safe, what makes a
    -- backfill safe to re-run, and what protects a status that moves backwards
    -- and forwards again.
    if exists (select 1 from public.job_productions where production_id = p_id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                 'fired_by', p_reason));
      return null;
    end if;

    select coalesce(prod.price_override, s.default_rate) into base_amount
    from public.shows s where s.id = prod.show_id;

    select coalesce(sum(total), 0) into addon_total
    from public.production_addons
    where production_id = p_id and status = 'approved' and total is not null;

    if base_amount is not null then
      job_amount := base_amount + coalesce(addon_total, 0);
    else
      job_amount := null;
    end if;

    -- 0064: the work date. See the header — due_date and every ageing number
    -- downstream are derived from this column.
    insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
    values (prod.client_id, prod.contract_id,
            coalesce(prod.record_date, current_date),
            prod.podcast_name, job_amount,
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

  -- ---- 2. the אולמדיה duplicate: merged away, its job hidden ---------------
  -- Refuse rather than assume. If any of these stopped being true since the
  -- check on 25.8, the whole migration rolls back and someone looks again.
  -- Still required for dismissal, not only for deletion: hiding a job that has
  -- since acquired an invoice or a payment would hide real money.
  select count(*) into v_guard from public.jobs j
   where j.id = v_job
     and j.invoice_biz is null and j.invoice_tax is null and j.paid <> 'כן'
     and not exists (select 1 from public.documents         d where d.job_id = j.id)
     and not exists (select 1 from public.pending_documents p where p.job_id = j.id)
     and not exists (select 1 from public.documents d where d.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.pending_documents p where p.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.contract_milestones m where m.job_id = j.id);
  if v_guard <> 1 then
    raise exception 'job % אינו עומד בתנאי ההסתרה (invoice/paid/מסמך מקושר) — מבטל', v_job;
  end if;

  update public.productions set merged_into = v_real
   where id = v_dup and merged_into is null;

  -- dismissed_by stays null: a migration did this, not a person.
  update public.jobs
     set dismissed = true, dismiss_reason = v_reason, dismissed_at = now()
   where id = v_job and dismissed = false;

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', v_job, 'job_dismissed', null,
          jsonb_build_object('reason', v_reason, 'via', 'migration_0064',
                             'production_id', v_dup, 'merged_into', v_real));

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', v_dup, 'production_merged_duplicate', null,
          jsonb_build_object('merged_into', v_real, 'dismissed_job_id', v_job,
                             'reason', v_reason));

  -- ---- 3. the backfill jobs: the work date ---------------------------------
  -- All 18 are in scope, including the dismissed one — a hidden row with a
  -- wrong date is still a wrong date if it is ever restored.
  -- trg_compute_due_date fires on update of date and rewrites due_date itself.
  update public.jobs j
     set date = p.record_date
    from public.job_productions jp
    join public.productions p on p.id = jp.production_id
   where jp.job_id = j.id
     and j.id = any(v_ids)
     and p.record_date is not null
     and j.date is distinct from p.record_date;
  get diagnostics v_fixed = row_count;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0064', now(), 'bnaya',
          'jobs.date נכתב מ-record_date של ההפקה במקום current_date. הבאג מקורי ב-0033 ו-0060 העתיקה אותו verbatim; המילוי-אחורה של 24.8 הנכיח אותו כשנתן לפרק מ-22.7 job בתאריך 24.8. jobs.date הוא תאריך העבודה ולא תאריך הרישום — created_at כבר ממלא את התפקיד הזה — ומ-due_date שנגזר ממנו (compute_due_date, 0002) הרדאר ו-/finance גוזרים ותק ו"באיחור N יום". כרגע כל הלקוחות המושפעים הם immediate ולכן הנזק הגלוי הוא ותק בלבד, אבל בטבלה יש net_30 אחד ו-eom_60 אחד ואצלם פרק מ-22.7 היה נופל לפירעון 23.9 במקום 21.8. coalesce ולא עמודה חשופה: הפקה בלי record_date עדיין חייבת לקבל job. תוקנו 18 jobs מהמילוי לפי רשימת מזהים מפורשת ולא לפי notes/created_at, כדי ש-17 ה-jobs ההיסטוריים לא ייגעו; due_date התעדכן מעצמו דרך trg_compute_due_date. בנוסף: כפילות אולמדיה 29.7 — 44063455 מוזגה ל-1beacaa2 דרך merged_into (מנגנון המחיקה הרכה של 0019 לכפילות יומן, ולא בוטל שהיה טוען שההקלטה לא קרתה), וה-job שהמילוי נתן לה סומן dismissed עם סיבה, אחרי אימות שאין לו invoice_biz/invoice_tax/paid ואף מסמך מקושר. dismissed ולא ארכוב כי archive.jobs לא קיימת — 0002 מכילה את ה-create אך נרשמה בפנקס בדיעבד כ-backfill ומעולם לא הורצה, ושתי פונקציות move_*_to_archive מחזירות 42P01 מאז ומתמיד (טיקט נפרד). dismissed_by נשאר null במכוון: מיגרציה עשתה זאת, לא אדם. אפס שינוי סכימה, אפס DELETE.');

  raise notice '0064 הוחלה. % jobs תוקנו לתאריך ההקלטה, כפילות אולמדיה מוזגה וה-job שלה הוסתר.', v_fixed;
end $mig$;
