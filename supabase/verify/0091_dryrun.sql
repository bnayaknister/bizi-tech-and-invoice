-- ============================================================================
-- 0091 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה זה עושה: מתקין את הפונקציה ואת הטריגר בתוך טרנזקציה, בונה לקוח מדומה עם
-- חמש עבודות שמכסות את כל המקרים שההיקף מכריע בהם, משנה לו את תנאי התשלום,
-- ומוכיח:
--   (1) עבודה פתוחה עם תאריך  — מתרעננת
--   (2) עבודה ששולמה (paid='כן') — **אינה** זזה, גם כשהיא מיושנת
--   (3) עבודה עם date ריק      — **אינה** זזה
--   (4) עבודה מוסתרת פתוחה     — כן מתרעננת (הכרעת היקף, ראה המיגרציה)
--   (5) אף עבודה של אף לקוח אחר לא זזה — נבדק בטביעת אצבע md5 על כל הטבלה
--   (6) האירוע נכתב פעם אחת, עם המספר האמיתי של השורות שזזו
--   (7) שמירה חוזרת של אותו ערך אינה כותבת אירוע (שער ה-WHEN)
--   (8) ההשלמה למפרע נוגעת ב-07faca02 ובו בלבד, ונותנת לו 2026-11-01
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API, ולכן
-- שום דבר כאן אינו נשאר על המסד: לא הלקוח המדומה, לא חמש העבודות, לא
-- האירועים, ולא ההשלמה למפרע.
--
-- Management API אינו מחזיר NOTICE, ולכן כל הדוח רוכב על הודעת ה-exception.
-- הצלחה נראית כך:  ✅ 0091 DRY RUN OK — ...   (בתוך הודעת שגיאה)
-- כישלון נראית כך: ❌ ...
--
-- ⚠️ auth.uid() הוא null בהרצה דרך Management API, ולכן guard_client_money_columns
--    ו-guard_job_money_columns מוותרים (can_edit_money() מחזירה NULL ו-`if not NULL`
--    אינו נכנס), ו-actor_id באירוע ייצא null. זה המצב הצפוי כאן ואינו מעיד על באג.
--
-- ⚠️ בניגוד ל-0090, הנבדקים כאן מדומים ולא אמיתיים, במכוון. ההיקף שנבדק הוא
--    הצלב של ארבעה מצבים (paid × date ריק × מוסתר × מיושן), ובנתונים החיים אין
--    ולו לקוח אחד שמחזיק את כל הארבעה — בדיקה על נתון אמיתי הייתה בודקת שניים
--    מהם ומשאירה את השניים החשובים בלי כיסוי. מה שכן נבדק על הנתון החי הוא
--    מבחן 5 (טביעת האצבע על כל הטבלה) ומבחן 8 (07faca02 האמיתי).
-- ============================================================================
do $dry$
declare
  v_client   uuid;
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_e uuid;
  v_due_a date; v_due_b date; v_due_c date; v_due_d date; v_due_e date;
  v_c_at_insert date;
  v_hash_before text;
  v_hash_after  text;
  v_events      int;
  v_events_noop int;
  v_refreshed   int;
  v_payload     jsonb;
  v_pending     jsonb;
  v_backfill_id uuid;
  v_backfill_due date;
  v_fail text := '';
  v_rep  text := '';
  -- השורה היחידה שההשלמה למפרע אמורה לגעת בה. וואי 360, ₪8,000, net_60.
  c_target constant uuid := '07faca02-373c-48ba-af59-084cb9709405';
begin
  -- ── 0. הפונקציה והטריגר, בדיוק כפי שהמיגרציה תיצור אותם ──────────────────
  execute $f$
    create or replace function public.refresh_jobs_due_date_on_terms_change()
    returns trigger
    language plpgsql
    security definer
    set search_path = public
    as $body$
    declare
      v_rows int;
    begin
      with refreshed as (
        update public.jobs j
           set due_date = public.due_date_for(j.date, new.payment_terms)
         where j.client_id = new.id
           and j.date is not null
           and j.paid <> 'כן'
           and j.due_date is distinct from public.due_date_for(j.date, new.payment_terms)
        returning 1
      )
      select count(*) into v_rows from refreshed;

      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('client', new.id, 'payment_terms_changed', auth.uid(),
              jsonb_build_object(
                'client_id',      new.id,
                'client_name',    new.name,
                'terms_old',      old.payment_terms::text,
                'terms_new',      new.payment_terms::text,
                'jobs_refreshed', v_rows,
                'scope',          'date is not null and paid <> ''כן''',
                'source',         'trg_refresh_jobs_due_date'));

      return null;
    end;
    $body$;
  $f$;

  execute $f$ drop trigger if exists trg_refresh_jobs_due_date on public.clients $f$;
  execute $f$
    create trigger trg_refresh_jobs_due_date
    after update of payment_terms on public.clients
    for each row
    when (old.payment_terms is distinct from new.payment_terms)
    execute function public.refresh_jobs_due_date_on_terms_change();
  $f$;

  -- ── 1. הלקוח המדומה וחמש העבודות ─────────────────────────────────────────
  -- normalized_name הוא not null בלי default ובלי טריגר — חייב להימסר.
  insert into public.clients (name, normalized_name, payment_terms)
  values ('ZZ-0091-dryrun', 'zz-0091-dryrun', 'immediate')
  returning id into v_client;

  -- trg_compute_due_date יורה על ה-INSERT ולכן due_date נכתב מהתנאים הנוכחיים
  -- ('immediate'), כלומר שווה ל-date. paid נמסר ב-INSERT ולא ב-UPDATE, כי
  -- guard_job_money_columns הוא BEFORE UPDATE בלבד.
  insert into public.jobs (client_id, date, amount, campaign, paid)
  values (v_client, '2026-03-10', 100, 'ZZ-0091-A-open', 'לא') returning id into v_a;

  insert into public.jobs (client_id, date, amount, campaign, paid)
  values (v_client, '2026-03-10', 100, 'ZZ-0091-B-paid', 'כן') returning id into v_b;

  insert into public.jobs (client_id, date, amount, campaign, paid)
  values (v_client, null, 100, 'ZZ-0091-C-nodate', 'לא') returning id into v_c;

  insert into public.jobs (client_id, date, amount, campaign, paid, dismissed)
  values (v_client, '2026-03-10', 100, 'ZZ-0091-D-dismissed', 'לא', true) returning id into v_d;

  insert into public.jobs (client_id, date, amount, campaign, paid)
  values (v_client, '2026-03-10', 100, 'ZZ-0091-E-nocharge', 'ללא חיוב') returning id into v_e;

  -- מצב הפתיחה חייב להיות מה שאנחנו חושבים, אחרת כל שאר המבחנים חסרי ערך
  select due_date into v_c_at_insert from public.jobs where id = v_c;
  if (select due_date from public.jobs where id = v_a) <> '2026-03-10' then
    raise exception '❌ 0091 DRY RUN: מצב הפתיחה שגוי — A נפתח על % במקום 2026-03-10',
      (select due_date from public.jobs where id = v_a);
  end if;
  if v_c_at_insert is distinct from current_date then
    raise exception '❌ 0091 DRY RUN: מצב הפתיחה שגוי — C (date ריק) נפתח על % במקום current_date', v_c_at_insert;
  end if;

  -- ── 2. טביעת אצבע על כל העבודות שאינן של הלקוח המדומה ───────────────────
  select md5(coalesce(string_agg(j.id::text || '=' || coalesce(j.due_date::text, '-'), ',' order by j.id), ''))
    into v_hash_before
  from public.jobs j
  where j.client_id is distinct from v_client;

  -- ── 3. המעשה: שינוי תנאי התשלום ──────────────────────────────────────────
  update public.clients set payment_terms = 'net_60' where id = v_client;

  select due_date into v_due_a from public.jobs where id = v_a;
  select due_date into v_due_b from public.jobs where id = v_b;
  select due_date into v_due_c from public.jobs where id = v_c;
  select due_date into v_due_d from public.jobs where id = v_d;
  select due_date into v_due_e from public.jobs where id = v_e;

  -- מבחן 1 — עבודה פתוחה עם תאריך מתרעננת. 2026-03-10 + net_60 = 2026-05-09.
  if v_due_a is distinct from date '2026-05-09' then
    v_fail := v_fail || format('מבחן 1: עבודה פתוחה לא התרעננה — A=%s, ציפיתי 2026-05-09. ', v_due_a);
  else
    v_rep := v_rep || 'מבחן 1 — עבודה פתוחה התרעננה ל-2026-05-09. | ';
  end if;

  -- מבחן 2 — עבודה ששולמה אינה זזה. היא מיושנת עכשיו, ובמכוון.
  if v_due_b is distinct from date '2026-03-10' then
    v_fail := v_fail || format('מבחן 2: היסטוריה סגורה זזה! B=%s, ציפיתי 2026-03-10. ', v_due_b);
  else
    v_rep := v_rep || 'מבחן 2 — עבודה ששולמה נשארה על 2026-03-10 (מיושנת במכוון). | ';
  end if;

  -- מבחן 3 — date ריק אינו נוגע
  if v_due_c is distinct from v_c_at_insert then
    v_fail := v_fail || format('מבחן 3: עבודה עם date ריק זזה — %s → %s. ', v_c_at_insert, v_due_c);
  else
    v_rep := v_rep || format('מבחן 3 — עבודה עם date ריק נשארה על %s. | ', v_due_c);
  end if;

  -- מבחן 4 — מוסתרת פתוחה כן מתרעננת (הכרעת היקף)
  if v_due_d is distinct from date '2026-05-09' then
    v_fail := v_fail || format('מבחן 4: עבודה מוסתרת פתוחה לא התרעננה — D=%s. ', v_due_d);
  else
    v_rep := v_rep || 'מבחן 4 — עבודה מוסתרת פתוחה התרעננה. | ';
  end if;

  -- ו-'ללא חיוב' בהיקף, כי הוא אינו 'כן'
  if v_due_e is distinct from date '2026-05-09' then
    v_fail := v_fail || format('מבחן 4ב: עבודת ''ללא חיוב'' לא התרעננה — E=%s. ', v_due_e);
  else
    v_rep := v_rep || 'מבחן 4ב — ''ללא חיוב'' בהיקף והתרעננה. | ';
  end if;

  -- ── 4. מבחן 5: אף עבודה של אף לקוח אחר לא זזה ───────────────────────────
  select md5(coalesce(string_agg(j.id::text || '=' || coalesce(j.due_date::text, '-'), ',' order by j.id), ''))
    into v_hash_after
  from public.jobs j
  where j.client_id is distinct from v_client;

  if v_hash_after is distinct from v_hash_before then
    v_fail := v_fail || 'מבחן 5: טביעת האצבע של שאר הטבלה השתנתה — הטריגר דלף מעבר ללקוח שלו! ';
  else
    v_rep := v_rep || format('מבחן 5 — טביעת האצבע של שאר %s העבודות זהה (%s). | ',
                             (select count(*) from public.jobs where client_id is distinct from v_client),
                             left(v_hash_after, 8));
  end if;

  -- ── 5. מבחן 6: האירוע, ובו המספר האמיתי ─────────────────────────────────
  select count(*) into v_events from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed';
  select payload into v_payload from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed'
   limit 1;
  v_refreshed := (v_payload->>'jobs_refreshed')::int;

  if v_events <> 1 then
    v_fail := v_fail || format('מבחן 6: ציפיתי לאירוע אחד, קיבלתי %s. ', v_events);
  elsif v_refreshed <> 3 then
    v_fail := v_fail || format('מבחן 6: jobs_refreshed=%s, ציפיתי 3 (A, D, E). ', v_refreshed);
  elsif v_payload->>'terms_old' <> 'immediate' or v_payload->>'terms_new' <> 'net_60' then
    v_fail := v_fail || format('מבחן 6: הערך הישן/החדש שגוי במטען — %s. ', v_payload::text);
  else
    v_rep := v_rep || format('מבחן 6 — אירוע אחד, jobs_refreshed=3, immediate→net_60. מטען: %s | ', v_payload::text);
  end if;

  -- ── 6. מבחן 7: שער ה-WHEN — שמירה חוזרת של אותו ערך שותקת ───────────────
  update public.clients set payment_terms = 'net_60' where id = v_client;

  select count(*) into v_events_noop from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed';

  if v_events_noop <> v_events then
    v_fail := v_fail || format('מבחן 7: שמירה חוזרת של אותו ערך הוסיפה %s אירועים — שער ה-WHEN אינו עובד. ',
                               v_events_noop - v_events);
  else
    v_rep := v_rep || format('מבחן 7 — שמירה חוזרת של אותו ערך הוסיפה אפס אירועים (נשאר %s). | ', v_events_noop);
  end if;

  -- ── 7. מבחן 8: ההשלמה למפרע, בדיוק כפי שהמיגרציה תריץ אותה ──────────────
  -- אותה שאילתה בדיוק שיושבת במיגרציה. תחילה קוראים מה עומד לזוז.
  select jsonb_agg(jsonb_build_object(
           'job_id', j.id, 'client', c.name, 'date', j.date, 'paid', j.paid::text,
           'terms', c.payment_terms::text,
           'due_old', j.due_date,
           'due_new', public.due_date_for(j.date, c.payment_terms))
         order by j.id)
    into v_pending
  from public.jobs j
  join public.clients c on c.id = j.client_id
  where j.date is not null
    and j.paid <> 'כן'
    and j.due_date is distinct from public.due_date_for(j.date, c.payment_terms);

  if v_pending is null or jsonb_array_length(v_pending) <> 1 then
    v_fail := v_fail || format('מבחן 8: ההשלמה למפרע נוגעת ב-%s שורות ולא באחת. הפירוט: %s. ',
                               coalesce(jsonb_array_length(v_pending), 0), coalesce(v_pending::text, 'אין'));
  else
    v_backfill_id := (v_pending->0->>'job_id')::uuid;
    if v_backfill_id <> c_target then
      v_fail := v_fail || format('מבחן 8: השורה היא %s ולא 07faca02. הפירוט: %s. ', v_backfill_id, v_pending::text);
    else
      update public.jobs j
         set due_date = public.due_date_for(j.date, c.payment_terms)
        from public.clients c
       where c.id = j.client_id
         and j.date is not null
         and j.paid <> 'כן'
         and j.due_date is distinct from public.due_date_for(j.date, c.payment_terms);

      select due_date into v_backfill_due from public.jobs where id = c_target;
      if v_backfill_due is distinct from date '2026-11-01' then
        v_fail := v_fail || format('מבחן 8: 07faca02 קיבל %s ולא 2026-11-01. ', v_backfill_due);
      else
        v_rep := v_rep || format('מבחן 8 — ההשלמה למפרע נגעה בשורה אחת בלבד, 07faca02: %s → 2026-11-01. | ',
                                 v_pending->0->>'due_old');
      end if;
    end if;
  end if;

  -- ── הדוח ────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0091 DRY RUN FAILED — %', v_fail;
  end if;

  raise exception '✅ 0091 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
