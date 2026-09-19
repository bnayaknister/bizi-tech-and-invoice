-- ============================================================================
-- 0091 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
-- שני חלקים, ובכוונה — שתי שאלות שונות:
--
--   ── חלק א' (קריאה בלבד) ──────────────────────────────────────────────────
--   "האם המיגרציה הוחלה, והאם המבנה וההשלמה למפרע נכונים?"
--   SELECT אחד שמחזיר שורת בוליאנים. כל אחד מהם חייב להיות true.
--   ⚠️ `Success. No rows returned` אינו הוכחה — רק השורה שחוזרת.
--   אינו נוגע בדבר. זה מה שמריצים תמיד.
--
--   ── חלק ב' (חי, ומגלגל את עצמו) ──────────────────────────────────────────
--   "והאם הטריגר באמת יורה, על נתון אמיתי?"
--   חלק א' מראה שהטריגר מותקן, לא שהוא מתנהג. חלק ב' לוקח לקוח אמיתי עם
--   עבודות פתוחות, משנה לו את תנאי התשלום באמת, ומוכיח את ארבעת ההיגדים
--   שההיקף עומד עליהם — הפתוחות זזו, הסגורות לא, שאר הטבלה לא, והאירוע
--   מדווח את המספר האמיתי — ואז נופל ב-raise exception.
--   הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API: שינוי התנאים, מועדי הפירעון
--   שהתרעננו והאירוע שנכתב **אינם נשארים**.
--   ⚠️ להריץ כבלוק נפרד, ולצפות ל"שגיאה" שמתחילה ב-✅.
--
-- ⚠️ ההבדל מ-0091_dryrun.sql: ההרצה המדומה בדקה נבדקים **מדומים** לפני
--    ההחלה, כי ההיקף הוא צלב של ארבעה מצבים שאין לקוח חי שמחזיק את כולם.
--    הקובץ הזה בודק את מה שבאמת הותקן, על נתון **חי**, אחרי ההחלה. שניהם
--    נחוצים ואף אחד אינו מייתר את השני.
--
-- ⚠️ auth.uid() הוא null בהרצה דרך Management API, ולכן guard_client_money_columns
--    מוותר (can_edit_money() מחזירה NULL ו-`if not NULL` אינו נכנס) ו-actor_id
--    באירוע ייצא null. זה המצב הצפוי כאן ואינו מעיד על באג.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- חלק א' — קריאה בלבד. שתים-עשרה בדיקות, כולן חייבות להחזיר true.
-- ════════════════════════════════════════════════════════════════════════════
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0091')              as ledger_row,

  -- 2. אירוע האודיט של המיגרציה נכתב
  (select count(*) = 1 from public.events
    where event_type = 'due_date_follows_terms'
      and payload->>'migration' = '0091')                                             as audit_event,

  -- 3. הפונקציה קיימת ושמרה על SECURITY DEFINER.
  --    ⚠️ לא קישוט: jobs היא relrowsecurity=true, ובלי זה הטריגר היה מרענן רק
  --    את השורות שה-RLS מראה למעדכן — כישלון חלקי שאינו מדווח.
  (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'refresh_jobs_due_date_on_terms_change') as fn_secdef,

  -- 4. ו-search_path=public, כי SECURITY DEFINER בלי זה הוא חור
  (select array_to_string(p.proconfig, ',') like '%search_path=public%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'refresh_jobs_due_date_on_terms_change') as fn_search_path,

  -- 5. 🔴 מקור אמת אחד (הכרעה יב) — הפונקציה **קוראת** ל-due_date_for
  --    ואינה מחשבת בעצמה. הטוקנים השליליים הם האריתמטיקה עצמה: אם מישהו
  --    יעתיק את ה-case לתוך הפונקציה, date_trunc או 'net_30' יופיעו בגוף.
  (select p.prosrc like '%due_date_for%'
          and p.prosrc not like '%date_trunc%'
          and p.prosrc not like '%net_30%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'refresh_jobs_due_date_on_terms_change') as single_source_of_truth,

  -- 6. הטריגר מותקן ומוגבל לעמודה אחת
  (select pg_get_triggerdef(t.oid) like '%AFTER UPDATE OF payment_terms%'
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'clients' and t.tgname = 'trg_refresh_jobs_due_date'
      and not t.tgisinternal)                                                         as trigger_scoped,

  -- 7. ⚠️ שער ה-WHEN קיים. UPDATE OF payment_terms יורה כשהעמודה **נזכרת**
  --    בפקודה, גם בלי שינוי ערך, וה-EntityDrawer שולח אותה בכל שמירת כרטיס
  --    לקוח — בלי השער הזה כל שמירת שם איש קשר כותבת אירוע שקרי.
  (select pg_get_triggerdef(t.oid) like '%WHEN%'
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'clients' and t.tgname = 'trg_refresh_jobs_due_date'
      and not t.tgisinternal)                                                         as when_gate,

  -- 8. ההשלמה למפרע הוחלה: 07faca02 (וואי 360, ₪8,000, 02.09, net_60)
  (select due_date = date '2026-11-01' from public.jobs
    where id = '07faca02-373c-48ba-af59-084cb9709405')                                as backfill_applied,

  -- 9. ושובל האודיט שלה נכתב, עם המצב המלא שלפני
  (select count(*) = 1 from public.events
    where event_type = 'due_date_backfilled'
      and entity_id = '07faca02-373c-48ba-af59-084cb9709405'
      and payload->>'migration' = '0091'
      and payload->'before'->>'due_old' = '2026-09-02')                               as backfill_event,

  -- 10. 🔴 האינווריאנטה שכל הקובץ קיים בשבילה: אפס עבודות פתוחות עם תאריך
  --     נושאות פירעון שאינו תואם את תנאי הלקוח שלהן. זו הבדיקה היחידה כאן
  --     שתישבר שוב אם הטריגר יפסיק לעבוד — השאר בודקות התקנה.
  (select count(*) = 0
     from public.jobs j join public.clients c on c.id = j.client_id
    where j.date is not null
      and j.paid <> 'כן'
      and j.due_date is distinct from public.due_date_for(j.date, c.payment_terms))   as zero_stale_rows,

  -- 11. ⚠️ ו-0089 שלם: הטריגר המקורי לא נגע, ועדיין על אותן עמודות בדיוק.
  --     אם 0091 היה מחליף אותו, שורה חדשה הייתה נכתבת בלי מועד פירעון כלל.
  (select pg_get_triggerdef(t.oid) like '%BEFORE INSERT OR UPDATE OF date, client_id%'
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'jobs' and t.tgname = 'trg_compute_due_date'
      and not t.tgisinternal)                                                         as trg_0089_intact,

  -- 12. כלל 49 — ה-ACL הוא מה שהוצהר. הפונקציה החדשה נושאת EXECUTE ל-PUBLIC
  --     כמו כל פונקציות הטריגר האחרות בסכימה, ו-due_date_for לא זזה.
  --     ⚠️ due_date_for נבדקת מול המצב **המדוד** (postgres, authenticated,
  --     service_role) ולא מול ההצהרה השגויה של 0089 — ראה הערת התיקון
  --     בראש המיגרציה. הבדיקה כאן היא שהיא לא זזה, לא שהיא "נכונה".
  (select (p.proacl is null or exists (select 1 from unnest(p.proacl::text[]) a where a like '=X%'))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'refresh_jobs_due_date_on_terms_change') as fn_acl_as_declared,

  (select not exists (select 1 from unnest(p.proacl::text[]) a where a like '=X%')
          and exists (select 1 from unnest(p.proacl::text[]) a where a like 'service_role=X%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'due_date_for')                        as due_date_for_acl_unmoved;


-- ════════════════════════════════════════════════════════════════════════════
-- חלק ב' — חי. מוכיח שהטריגר יורה על לקוח אמיתי, ומגלגל את עצמו.
-- להריץ בנפרד. הצלחה = "שגיאה" שמתחילה ב-✅.
-- ════════════════════════════════════════════════════════════════════════════
do $live$
declare
  v_client      uuid;
  v_name        text;
  v_terms_old   public.payment_terms;
  v_terms_new   public.payment_terms;
  v_expect_move int;    -- כמה אמורות לזוז (פתוחות, עם תאריך, שהערך שלהן באמת משתנה)
  v_moved_ok    int;    -- כמה באמת נחתו על הערך הנכון
  v_frozen_bad  int;    -- כמה שהיו אמורות לא לזוז — וזזו
  v_frozen_n    int;
  v_frozen      jsonb;  -- תצלום הקפואות לפני המעשה
  v_hash_before text;
  v_hash_after  text;
  v_others      int;
  v_events      int;
  v_events_noop int;
  v_payload     jsonb;
  v_refreshed   int;
  v_fail        text := '';
  v_rep         text := '';
begin
  -- ── 0. נבדק חי: לקוח עם לפחות עבודה פתוחה אחת עם תאריך ────────────────────
  -- נבחר דינמית ולא מקודד קשה, כדי שהקובץ יישאר נכון גם בעוד חצי שנה.
  -- מועדף מי שיש לו גם עבודות **סגורות** — שם מבחן ההקפאה שווה משהו.
  select c.id, c.name, c.payment_terms
    into v_client, v_name, v_terms_old
  from public.clients c
  join public.jobs j on j.client_id = c.id
  group by c.id, c.name, c.payment_terms
  having count(*) filter (where j.date is not null and j.paid <> 'כן') > 0
  order by count(*) filter (where j.paid = 'כן' or j.date is null) desc,
           count(*) filter (where j.date is not null and j.paid <> 'כן') desc,
           c.id
  limit 1;

  if v_client is null then
    raise exception '❌ 0091 VERIFY: לא נמצא לקוח עם עבודה פתוחה ומתוארכת לבדיקה.';
  end if;

  -- ערך יעד שאינו הערך הנוכחי, אחרת שער ה-WHEN יחסום ולא נבדוק כלום
  v_terms_new := case when v_terms_old = 'net_60' then 'net_30'::public.payment_terms
                      else 'net_60'::public.payment_terms end;

  -- ── 1. מה אמור לזוז, ומה אמור להישאר — נקבע לפני המעשה ───────────────────
  select count(*) into v_expect_move
  from public.jobs j
  where j.client_id = v_client
    and j.date is not null
    and j.paid <> 'כן'
    and j.due_date is distinct from public.due_date_for(j.date, v_terms_new);

  if v_expect_move = 0 then
    raise exception '❌ 0091 VERIFY: הלקוח % כבר עומד על % — אין תנועה לבדוק.', v_name, v_terms_new;
  end if;

  -- הקפואות: ששולמו, או בלי תאריך. מצלמים את הערך שלהן כדי להשוות אחרי.
  -- ⚠️ jsonb ולא טבלה זמנית, במכוון: ON COMMIT DROP תלוי בגבולות הטרנזקציה,
  --    וקובץ הזה אמור לרוץ זהה ב-SQL Editor, ב-psql וב-Management API.
  --    משתנה אינו תלוי בכך כלל.
  select jsonb_agg(jsonb_build_object('id', j.id, 'due', j.due_date) order by j.id),
         count(*)
    into v_frozen, v_frozen_n
  from public.jobs j
  where j.client_id = v_client
    and (j.paid = 'כן' or j.date is null);

  -- ── 2. טביעת אצבע על כל העבודות שאינן של הלקוח הנבדק ─────────────────────
  select md5(coalesce(string_agg(j.id::text || '=' || coalesce(j.due_date::text, '-'), ',' order by j.id), '')),
         count(*)
    into v_hash_before, v_others
  from public.jobs j
  where j.client_id is distinct from v_client;

  -- ── 3. המעשה ─────────────────────────────────────────────────────────────
  update public.clients set payment_terms = v_terms_new where id = v_client;

  -- ── 4. מבחן 1 — הפתוחות עם תאריך נחתו על הערך של due_date_for ────────────
  select count(*) into v_moved_ok
  from public.jobs j
  where j.client_id = v_client
    and j.date is not null
    and j.paid <> 'כן'
    and j.due_date = public.due_date_for(j.date, v_terms_new);

  if v_moved_ok < v_expect_move then
    v_fail := v_fail || format('מבחן 1: ציפיתי ש-%s עבודות פתוחות יתרעננו, רק %s נחתו על הערך הנכון. ',
                               v_expect_move, v_moved_ok);
  else
    v_rep := v_rep || format('מבחן 1 — %s עבודות פתוחות של %s התרעננו ל-%s. | ',
                             v_expect_move, v_name, v_terms_new);
  end if;

  -- ── 5. מבחן 2 — ששולמה / בלי תאריך לא זזה במילימטר ───────────────────────
  select count(*) into v_frozen_bad
  from jsonb_array_elements(coalesce(v_frozen, '[]'::jsonb)) f
  join public.jobs j on j.id = (f->>'id')::uuid
  where j.due_date is distinct from (f->>'due')::date;

  if v_frozen_bad > 0 then
    v_fail := v_fail || format('מבחן 2: %s עבודות סגורות/חסרות-תאריך זזו! ההיסטוריה אינה מוקפאת. ', v_frozen_bad);
  else
    v_rep := v_rep || format('מבחן 2 — %s עבודות ששולמו/בלי תאריך נשארו בדיוק כפי שהיו. | ', v_frozen_n);
  end if;

  -- ── 6. מבחן 3 — הטריגר לא דלף מעבר ללקוח שלו ─────────────────────────────
  select md5(coalesce(string_agg(j.id::text || '=' || coalesce(j.due_date::text, '-'), ',' order by j.id), ''))
    into v_hash_after
  from public.jobs j
  where j.client_id is distinct from v_client;

  if v_hash_after is distinct from v_hash_before then
    v_fail := v_fail || 'מבחן 3: טביעת האצבע של שאר הטבלה השתנתה — הטריגר דלף מעבר ללקוח שלו! ';
  else
    v_rep := v_rep || format('מבחן 3 — טביעת האצבע של שאר %s העבודות זהה (%s). | ',
                             v_others, left(v_hash_after, 8));
  end if;

  -- ── 7. מבחן 4 — האירוע, ובו המספר האמיתי ─────────────────────────────────
  select count(*) into v_events from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed';

  select payload into v_payload from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed'
   order by created_at desc limit 1;

  v_refreshed := (v_payload->>'jobs_refreshed')::int;

  if v_events <> 1 then
    v_fail := v_fail || format('מבחן 4: ציפיתי לאירוע אחד, קיבלתי %s. ', v_events);
  elsif v_refreshed <> v_expect_move then
    v_fail := v_fail || format('מבחן 4: jobs_refreshed=%s, ציפיתי %s — האירוע סופר שורות ולא תנועות. ',
                               v_refreshed, v_expect_move);
  elsif v_payload->>'terms_old' <> v_terms_old::text or v_payload->>'terms_new' <> v_terms_new::text then
    v_fail := v_fail || format('מבחן 4: הערך הישן/החדש שגוי במטען — %s. ', v_payload::text);
  else
    v_rep := v_rep || format('מבחן 4 — אירוע אחד, jobs_refreshed=%s, %s→%s. מטען: %s | ',
                             v_refreshed, v_terms_old, v_terms_new, v_payload::text);
  end if;

  -- ── 8. מבחן 5 — שער ה-WHEN: שמירה חוזרת של אותו ערך שותקת ────────────────
  update public.clients set payment_terms = v_terms_new where id = v_client;

  select count(*) into v_events_noop from public.events
   where entity_type = 'client' and entity_id = v_client and event_type = 'payment_terms_changed';

  if v_events_noop <> v_events then
    v_fail := v_fail || format('מבחן 5: שמירה חוזרת של אותו ערך הוסיפה %s אירועים — שער ה-WHEN אינו עובד. ',
                               v_events_noop - v_events);
  else
    v_rep := v_rep || format('מבחן 5 — שמירה חוזרת של אותו ערך הוסיפה אפס אירועים (נשאר %s). | ', v_events_noop);
  end if;

  -- ── הדוח ─────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0091 VERIFY FAILED — %', v_fail;
  end if;

  raise exception '✅ 0091 VERIFY OK — נבדק על % (%). % הכל מגולגל, אפס שינוי על המסד.',
    v_name, v_client, v_rep;
end $live$;
