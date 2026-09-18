-- ============================================================================
-- 0090 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה זה עושה: מתקין את שתי הפונקציות החדשות בתוך טרנזקציה, ואז **מניע הפקות
-- אמיתיות** דרך שתי נקודות הכניסה של 0060 — מעבר ל-הוקלט ומעבר לאישור לקוח —
-- ומוכיח שלושה דברים:
--   (א) אותן הפקות נחסמות בדיוק כמו קודם, ואף job חדש לא נוצר עליהן
--   (ב) המסלול החיובי לא נשבר — הפקת client בלי job עדיין מקבלת job
--   (ג) האירוע job_skipped_not_client נכתב, ו**רק** בשתי נקודות הכניסה,
--       כך שעדכון סטטוס אחר על הפקה internal אינו מציף את טבלת האירועים
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL, לא ע"י ה-API, ולכן
-- שום דבר כאן אינו נשאר על המסד: לא ה-jobs שנוצרו במבחן החיובי, לא האירועים,
-- ולא שינויי הסטטוס על ההפקות האמיתיות.
--
-- Management API אינו מחזיר NOTICE, ולכן כל הדוח רוכב על הודעת ה-exception.
-- הצלחה נראית כך:  ✅ 0090 DRY RUN OK — ...   (בתוך הודעת שגיאה)
-- כישלון נראית כך: ❌ ...
--
-- ⚠️ auth.uid() הוא null בהרצה דרך Management API, ולכן
--    guard_client_approval_transition מוותר (הוא בודק `auth.uid() is not null`)
--    ו-actor_id באירועים ייצא null. זה המצב הצפוי כאן ואינו מעיד על באג.
--
-- ⚠️ מגבלה מוצהרת אחת, ובמכוון. on_production_approved מותקן כאן עם הגוף
--    הסופי המלא שלו, כי הוא קצר והוא עיקר השינוי. ensure_job_for_production
--    לעומת זאת **אינה משוכפלת** לקובץ הזה: הגוף החי שלה משוכפל אוטומטית
--    תחת השם __dry_real_ensure דרך pg_get_functiondef, ומעליו נבנה שער ה-kind
--    שיישלח במיגרציה. הסיבה — הגוף אורכו 120 שורות, והעתקה ידנית שנייה שלו
--    לקובץ בדיקה הייתה יכולה להיסחף מהמקור, כלומר הבדיקה הייתה בודקת את
--    ההעתק ולא את הנשלח. מה שכן נבדק כאן על הגוף המלא והאמיתי הוא מבחן 3
--    (המסלול החיובי) ומבחן 4 (גארד הכפילות), ושניהם רצים דרך הקוד החי.
-- ============================================================================
do $dry$
declare
  v_internal   uuid;   -- הפקה kind='internal' על תוכנית per_episode עם לקוח
  v_contract   uuid;   -- הפקה kind='contract'
  v_positive   uuid;   -- הפקה kind='client' בלי job — הבקרה החיובית
  v_billed     uuid;   -- הפקה kind='client' שכבר יש לה job
  v_jobs_before   int;
  v_jobs_after    int;
  v_links_before  int;
  v_links_after   int;
  v_skipped       int;
  v_created       int;
  v_already       int;
  v_noise         int;
  v_new_job       uuid;
  v_ev            jsonb;
  v_txt           text;
  v_fail          text := '';
  v_rep           text := '';
begin
  -- ── 0. הפונקציות החדשות, בדיוק כפי שהמיגרציה תיצור אותן ──────────────────
  execute $f$
    create or replace function public.on_production_approved()
    returns trigger language plpgsql security definer set search_path to 'public'
    as $body$
    declare
      v_billing_mode text;
    begin
      if not (
           (new.status = 'הוקלט'         and old.status is distinct from 'הוקלט')
        or (new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח')
      ) then
        return new;
      end if;

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

      if new.status = 'הוקלט' and old.status is distinct from 'הוקלט' then
        perform public.ensure_job_for_production(new.id, 'recorded');
      elsif new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
        perform public.ensure_job_for_production(new.id, 'client_approved');
      end if;

      return new;
    end;
    $body$;
  $f$;

  -- שכפול אוטומטי של הגוף החי תחת שם זמני — בלי לכתוב אותו שוב ביד.
  execute replace(
    (select pg_get_functiondef(p.oid)
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'ensure_job_for_production'),
    'FUNCTION public.ensure_job_for_production(',
    'FUNCTION public.__dry_real_ensure('
  );

  -- ועכשיו שער ה-kind שיישלח במיגרציה, מעל הגוף האמיתי.
  execute $f$
    create or replace function public.ensure_job_for_production(p_id uuid, p_reason text)
    returns uuid language plpgsql security definer set search_path to 'public'
    as $body$
    declare
      prod public.productions%rowtype;
      v_billing_mode text;
      v_job uuid;
    begin
      select * into prod from public.productions where id = p_id;
      if not found then return null; end if;

      if prod.kind <> 'client' then
        select s.billing_mode::text into v_billing_mode
        from public.shows s where s.id = prod.show_id;
        insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
        values ('production', p_id, 'job_skipped_not_client', auth.uid(),
                jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                   'kind', prod.kind::text, 'billing_mode', v_billing_mode,
                                   'status', prod.status, 'fired_by', p_reason));
        return null;
      end if;
      -- הגוף האמיתי ממשיך מכאן; בהרצה המדומה קוראים לו דרך המקור החי
      select public.__dry_real_ensure(p_id, p_reason) into v_job;
      return v_job;
    end;
    $body$;
  $f$;

  -- ── 1. בחירת נבדקים אמיתיים ──────────────────────────────────────────────
  select p.id into v_internal
  from public.productions p join public.shows s on s.id = p.show_id
  where p.kind = 'internal' and s.billing_mode = 'per_episode'
    and coalesce(p.client_id, s.client_id) is not null
    and p.cancelled_at is null and p.merged_into is null
  limit 1;

  select p.id into v_contract
  from public.productions p
  where p.kind = 'contract' and p.cancelled_at is null and p.merged_into is null
  limit 1;

  select p.id into v_positive
  from public.productions p
  where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null
    and p.status not in ('עתיד_להתחיל', 'בהקלטה', 'בוטל')
    and not exists (select 1 from public.job_productions jp where jp.production_id = p.id)
  limit 1;

  select jp.production_id into v_billed
  from public.job_productions jp join public.productions p on p.id = jp.production_id
  where p.kind = 'client' and p.cancelled_at is null and p.merged_into is null
  limit 1;

  if v_internal is null or v_contract is null or v_positive is null or v_billed is null then
    raise exception '❌ 0090 DRY RUN: לא נמצאו כל ארבעת הנבדקים (internal=%, contract=%, positive=%, billed=%)',
      v_internal, v_contract, v_positive, v_billed;
  end if;

  select count(*) into v_jobs_before  from public.jobs;
  select count(*) into v_links_before from public.job_productions;

  -- ── 2. השער השקט, שתי נקודות הכניסה ─────────────────────────────────────
  update public.productions set status = 'הוקלט'         where id = v_internal;
  update public.productions set status = 'אושר_ע"י_לקוח' where id = v_contract;

  select count(*) into v_skipped from public.events
   where event_type = 'job_skipped_not_client'
     and entity_id in (v_internal, v_contract);

  if v_skipped <> 2 then
    v_fail := v_fail || format('מבחן 1: ציפיתי ל-2 אירועי job_skipped_not_client, קיבלתי %s. ', v_skipped);
  end if;

  select payload into v_ev from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_internal limit 1;
  if v_ev->>'billing_mode' is null or v_ev->>'kind' is null or v_ev->>'status' is null then
    v_fail := v_fail || format('מבחן 1: מטען חסר שדות — %s. ', v_ev::text);
  end if;
  v_rep := v_rep || format('מבחן 1 — שני השערים דיווחו. מטען לדוגמה: %s | ', v_ev::text);

  -- ── 3. ואף job לא נוצר עליהם ────────────────────────────────────────────
  select count(*) into v_jobs_after  from public.jobs;
  select count(*) into v_links_after from public.job_productions;
  if v_jobs_after <> v_jobs_before or v_links_after <> v_links_before then
    v_fail := v_fail || format('מבחן 2: נוצר job על הפקה חסומה! jobs %s→%s, links %s→%s. ',
                               v_jobs_before, v_jobs_after, v_links_before, v_links_after);
  else
    v_rep := v_rep || format('מבחן 2 — אפס jobs חדשים (%s) ואפס קישורים חדשים (%s). | ',
                             v_jobs_after, v_links_after);
  end if;

  -- ── 4. הבקרה החיובית: המסלול שאמור לעבוד עדיין עובד ─────────────────────
  update public.productions set status = 'אושר_ע"י_לקוח' where id = v_positive;

  select count(*) into v_created from public.events
   where event_type = 'client_approved_job_created' and entity_id = v_positive;
  select count(*) into v_jobs_after from public.jobs;

  if v_created <> 1 or v_jobs_after <> v_jobs_before + 1 then
    v_fail := v_fail || format('מבחן 3: המסלול החיובי נשבר — אירועי יצירה=%s, jobs %s→%s. ',
                               v_created, v_jobs_before, v_jobs_after);
  else
    select payload->>'job_id' into v_txt from public.events
     where event_type = 'client_approved_job_created' and entity_id = v_positive limit 1;
    v_rep := v_rep || format('מבחן 3 — הפקת client בלי job עדיין מקבלת job (%s). | ', v_txt);
  end if;

  -- ── 5. גארד הכפילות של 0060 לא נפגע ─────────────────────────────────────
  update public.productions set status = 'הוקלט'         where id = v_billed;
  update public.productions set status = 'אושר_ע"י_לקוח' where id = v_billed;

  select count(*) into v_already from public.events
   where event_type = 'client_approved_already_billed' and entity_id = v_billed;
  if v_already < 1 then
    v_fail := v_fail || 'מבחן 4: גארד הכפילות לא דיווח. ';
  else
    v_rep := v_rep || format('מבחן 4 — גארד הכפילות ירה %s פעמים, ללא job חדש. | ', v_already);
  end if;

  -- ── 6. אין הצפה: עדכון סטטוס שאינו נקודת כניסה אינו כותב דבר ────────────
  select count(*) into v_noise from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_internal;
  update public.productions set status = 'בעריכה' where id = v_internal;
  update public.productions set status = 'נערך'   where id = v_internal;
  update public.productions set status = 'הופץ'   where id = v_internal;

  select count(*) into v_skipped from public.events
   where event_type = 'job_skipped_not_client' and entity_id = v_internal;
  if v_skipped <> v_noise then
    v_fail := v_fail || format('מבחן 5: הצפה — שלושה עדכוני סטטוס לא-רלוונטיים הוסיפו %s אירועים. ',
                               v_skipped - v_noise);
  else
    v_rep := v_rep || format('מבחן 5 — שלושה עדכוני סטטוס נוספים על אותה הפקה internal הוסיפו אפס אירועים (נשאר %s). | ', v_skipped);
  end if;

  -- ── הדוח ────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0090 DRY RUN FAILED — %', v_fail;
  end if;

  raise exception '✅ 0090 DRY RUN OK — ההתנהגות לא זזה. % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
