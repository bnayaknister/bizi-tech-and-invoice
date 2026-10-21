-- ============================================================================
-- 0121 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- הפונקציה החדשה הועתקה לכאן **מילה במילה** מקובץ המיגרציה בסקריפט (לא ביד),
-- והיא מותקנת בתוך הטרנזקציה. אחר כך **מונעות הפקות אמיתיות** דרך המעברים
-- (בתוך אותה טרנזקציה), ומוכחים שבעה דברים:
--   1. קפיצה עתיד_להתחיל → נשלח_ללקוח יוצרת job (החדש)
--   2. בהקלטה אינה יוצרת job; בהקלטה → בעריכה כן (החדש)
--   3. מעבר בין שני מצבים "שבוצעו" (בעריכה → נערך → הופץ) אינו כותב דבר
--   4. עתיד_להתחיל → הוקלט — המסלול הישן עדיין יוצר job
--   5. הפקה שכבר יש לה job: הגארד של 0060 — אין job שני
--   6. internal: job_skipped_not_client פעם אחת, ואין הצפה במעבר הבא
--   7. אישור לקוח אחרי job: client_approved_already_billed, אין job שני
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL: לא הפונקציה, לא
-- ה-jobs, לא האירועים ולא שינויי הסטטוס נשארים על המסד.
-- **גם הצלחה היא exception.** הצלחה:  ✅ 0121 DRY RUN OK — ...
-- Supabase SQL Editor / Management API אינם מציגים NOTICE — כל הדוח בהודעה.
--
-- ⚠️ auth.uid() הוא null בהרצה כזו, ולכן guard_client_approval_transition
--    ו-guard_production_stage_columns מוותרים; actor_id באירועים ייצא null.
-- ============================================================================
do $dry$
declare
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid;
  v_jobs0 bigint; v_jobs bigint;
  v_n bigint; v_m bigint;
  v_fail text := '';
  v_rep  text := '';
begin
  if exists (select 1 from public.schema_ledger where version = '0121') then
    raise exception '❌ 0121 כבר רשומה בפנקס — אין מה להריץ';
  end if;

  -- ── 0. הפונקציה החדשה, מילה במילה מהמיגרציה ──
  execute $mig$
create or replace function public.on_production_approved()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_billing_mode text;
  v_reason       text;
  -- "בוצעה" = כל מצב מלבד שלושת אלה. בשמם, לא לפי סדר ה-enum (ראה הכותרת).
  v_new_done     boolean := new.status not in ('עתיד_להתחיל', 'בהקלטה', 'בוטל');
  v_old_done     boolean := old.status is not null and old.status not in ('עתיד_להתחיל', 'בהקלטה', 'בוטל');
begin
  -- שער ראשון: האם זו נקודת כניסה? (המעבר קודם, ה-kind אחר כך — 0090)
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    v_reason := 'client_approved';                       -- 0033/0060, כמו קודם
  elsif (new.status = 'הוקלט' and old.status is distinct from 'הוקלט')   -- 0060, כמו קודם
     or (v_new_done and not v_old_done) then             -- 0121: כל מעבר אל "בוצעה"
    v_reason := 'recorded';
  else
    return new;
  end if;

  -- שער שני: ה-kind. מדבר, לא שותק (0090).
  if new.kind <> 'client' then
    select s.billing_mode::text into v_billing_mode
    from public.shows s where s.id = new.show_id;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'job_skipped_not_client', auth.uid(),
            jsonb_build_object('production_id', new.id,
                               'client_id',     new.client_id,
                               'kind',          new.kind::text,
                               'billing_mode',  v_billing_mode,
                               'status',        new.status,
                               'fired_by',      'trigger'));
    return new;
  end if;

  perform public.ensure_job_for_production(new.id, v_reason);
  return new;
end;
$function$;
$mig$;

  -- ── 1. הנבדקים: הפקות אמיתיות, בתוך הטרנזקציה בלבד ──
  select p.id into p1 from public.productions p
   where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null
     and not exists (select 1 from public.job_productions jp where jp.production_id = p.id)
   order by p.created_at desc limit 1;
  select p.id into p2 from public.productions p
   where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null and p.id <> p1
     and not exists (select 1 from public.job_productions jp where jp.production_id = p.id)
   order by p.created_at desc limit 1;
  select p.id into p3 from public.productions p
   where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null and p.id not in (p1, p2)
     and not exists (select 1 from public.job_productions jp where jp.production_id = p.id)
   order by p.created_at desc limit 1;
  select p.id into p4 from public.productions p
   where p.kind = 'internal' and p.cancelled_at is null and p.merged_into is null
   order by p.created_at desc limit 1;
  select jp.production_id into p5 from public.job_productions jp join public.productions p on p.id = jp.production_id
   where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null
   order by p.created_at desc limit 1;
  if p1 is null or p2 is null or p3 is null or p4 is null or p5 is null then
    raise exception '❌ 0121 DRY RUN: לא נמצאו כל הנבדקים (p1=% p2=% p3=% p4=% p5=%)', p1, p2, p3, p4, p5;
  end if;

  -- כולם מתחילים ב-עתיד_להתחיל (מעבר אל "לא בוצע" אינו נקודת כניסה)
  update public.productions set status = 'עתיד_להתחיל' where id in (p1, p2, p3, p4, p5);
  select count(*) into v_jobs0 from public.jobs;

  -- ── מבחן 1: קפיצה עתיד_להתחיל → נשלח_ללקוח ──
  update public.productions set status = 'נשלח_ללקוח' where id = p1;
  select count(*) into v_n from public.job_productions where production_id = p1;
  if v_n <> 1 then v_fail := v_fail || format('מבחן 1: ציפיתי ל-job אחד, יש %s. ', v_n);
  else v_rep := v_rep || 'מבחן 1 — קפיצה ל-נשלח_ללקוח יצרה job. | '; end if;

  -- ── מבחן 2: בהקלטה בלי job; בהקלטה → בעריכה עם job ──
  update public.productions set status = 'בהקלטה' where id = p2;
  select count(*) into v_n from public.job_productions where production_id = p2;
  update public.productions set status = 'בעריכה' where id = p2;
  select count(*) into v_m from public.job_productions where production_id = p2;
  if v_n <> 0 or v_m <> 1 then v_fail := v_fail || format('מבחן 2: בהקלטה=%s (צ"ל 0), בעריכה=%s (צ"ל 1). ', v_n, v_m);
  else v_rep := v_rep || 'מבחן 2 — בהקלטה בלי job, בעריכה עם job. | '; end if;

  -- ── מבחן 3: בין שני מצבים שבוצעו — אפס כתיבה ──
  select count(*) into v_n from public.events where entity_id = p2;
  select count(*) into v_jobs from public.jobs;
  update public.productions set status = 'נערך' where id = p2;
  update public.productions set status = 'הופץ' where id = p2;
  select count(*) into v_m from public.events where entity_id = p2;
  if v_m <> v_n or (select count(*) from public.jobs) <> v_jobs then
    v_fail := v_fail || format('מבחן 3: עדכונים בין מצבים שבוצעו כתבו %s אירועים. ', v_m - v_n);
  else v_rep := v_rep || 'מבחן 3 — בעריכה → נערך → הופץ: אפס אירועים, אפס jobs. | '; end if;

  -- ── מבחן 4: המסלול הישן ──
  update public.productions set status = 'הוקלט' where id = p3;
  select count(*) into v_n from public.job_productions where production_id = p3;
  if v_n <> 1 then v_fail := v_fail || format('מבחן 4: עתיד_להתחיל → הוקלט, jobs=%s. ', v_n);
  else v_rep := v_rep || 'מבחן 4 — הוקלט עדיין יוצר job. | '; end if;

  -- ── מבחן 5: כבר יש job ──
  select count(*) into v_n from public.job_productions where production_id = p5;
  update public.productions set status = 'נשלח_ללקוח' where id = p5;
  select count(*) into v_m from public.job_productions where production_id = p5;
  if v_m <> v_n then v_fail := v_fail || format('מבחן 5: נוצר job שני (%s → %s). ', v_n, v_m);
  elsif not exists (select 1 from public.events where entity_id = p5 and event_type = 'client_approved_already_billed'
                     and created_at = now()) then
    v_fail := v_fail || 'מבחן 5: הגארד לא דיווח. ';
  else v_rep := v_rep || 'מבחן 5 — הפקה עם job: הגארד של 0060, אין job שני. | '; end if;

  -- ── מבחן 6: internal ──
  update public.productions set status = 'נשלח_ללקוח' where id = p4;
  select count(*) into v_n from public.events where entity_id = p4 and event_type = 'job_skipped_not_client' and created_at = now();
  update public.productions set status = 'נערך' where id = p4;
  select count(*) into v_m from public.events where entity_id = p4 and event_type = 'job_skipped_not_client' and created_at = now();
  if v_n <> 1 or v_m <> 1 or exists (select 1 from public.job_productions where production_id = p4) then
    v_fail := v_fail || format('מבחן 6: internal — אירועים %s ואז %s (צ"ל 1 ו-1). ', v_n, v_m);
  else v_rep := v_rep || 'מבחן 6 — internal: אירוע אחד, אין job, אין הצפה. | '; end if;

  -- ── מבחן 7: אישור לקוח אחרי job ──
  update public.productions set status = 'אושר_ע"י_לקוח' where id = p1;
  select count(*) into v_n from public.job_productions where production_id = p1;
  if v_n <> 1 then v_fail := v_fail || format('מבחן 7: אחרי אישור יש %s jobs. ', v_n);
  else v_rep := v_rep || 'מבחן 7 — אישור לקוח: עדיין job אחד. | '; end if;

  select count(*) into v_jobs from public.jobs;
  v_rep := v_rep || format('jobs בטרנזקציה: %s → %s (צ"ל +3). ', v_jobs0, v_jobs);
  if v_jobs <> v_jobs0 + 3 then v_fail := v_fail || format('סה"כ: ציפיתי ל-3 jobs חדשים, נוצרו %s. ', v_jobs - v_jobs0); end if;

  if v_fail <> '' then
    raise exception '❌ 0121 DRY RUN FAILED — %', v_fail;
  end if;
  raise exception '✅ 0121 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
