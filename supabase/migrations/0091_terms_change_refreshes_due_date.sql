-- ============================================================================
-- 0091 — P10: שינוי תנאי תשלום מרענן את מועד הפירעון של עבודות הלקוח
--
-- ⚠️ להריץ את supabase/verify/0091_dryrun.sql לפני. שם, ולא כאן, נמצאת
--    ההוכחה שההיקף הוא מה שהוכרע. כלל 50: קובץ אימות אינו יושב בתיקיית
--    המיגרציות.
--
-- למה בכלל (תחקיר F12, 19.9): trg_compute_due_date הוא
--   BEFORE INSERT OR UPDATE OF date, client_id ON public.jobs
-- כלומר הוא יורה על שינוי של שדות ה-job, ואילו מועד הפירעון תלוי גם בעמודה
-- שאינה יושבת על ה-job בכלל — clients.payment_terms. שינוי התנאים של לקוח
-- אינו נוגע באף שורת jobs, ולכן עבודותיו הקיימות נושאות פירעון שחושב לפי
-- תנאים שכבר אינם קיימים, לצמיתות, עד שמישהו יגע ב-date או ב-client_id של
-- השורה עצמה.
--
-- זה לא תיאורטי: 07faca02 (וואי 360 בע״מ, ₪8,000, 02.09) נושא due_date
-- 2026-09-02 בעוד הלקוח שלו הוא net_60 ולכן הפירעון הנכון הוא 2026-11-01 —
-- סטייה של 60 יום. הוא מתועד כבר בהערת השער של 0089 כאחת מארבע השורות
-- שההרצה המדומה שם נתקלה בהן, ו-0089 במכוון לא תיקן אותו: הוא היה ריפקטור
-- טהור. הקובץ הזה סוגר את הסיבה, ואז משלים אותו למפרע.
--
-- 🔴 מקור אמת אחד. אין כאן שום אריתמטיקה חדשה — הפונקציה קוראת
--    public.due_date_for(base, terms) של 0089, בדיוק כמו compute_due_date.
--    הכרעה יב אוסרת מימוש שני, וזה כולל מימוש שני בתוך המסד.
--
-- ── ההיקף, ולמה דווקא הוא ──────────────────────────────────────────────────
--
--   and j.date is not null
--   and j.paid <> 'כן'
--   and j.due_date is distinct from public.due_date_for(j.date, new.payment_terms)
--
-- (א) date ריק — לא נוגעים. compute_due_date משתמש ב-coalesce(date, current_date),
--     כלומר הבסיס לשורה כזו הוא היום שבו הטריגר במקרה ירה. ריענון שלה היה
--     כותב ערך שמשמעותו "מתי עדכנו את הלקוח", לא "מתי צריך לשלם". שלוש מתוך
--     ארבע השורות המיושנות היום הן בדיוק הרעש הזה, והן נשארות כפי שהן.
--
-- (ב) paid <> 'כן' — היסטוריה סגורה אינה משתנה. ⚠️ ולא paid = 'לא': התווית
--     'כן' היא היחידה שאומרת "נגבה". 'ללא חיוב' אומר שאין מה לגבות ו-'לא ידוע'
--     אומר שלא נבדק (0082 מילא אותו למפרע) — שתיהן אינן סגירה, ולהקפיא בהן
--     מספר שגוי בשם הזהירות זה להעדיף שקט על נכונות. החלוקה החיה: 66 'כן',
--     31 'לא', 5 'לא ידוע', 2 'ללא חיוב'.
--
-- (ג) עבודות מוסתרות (dismissed) **כן** בהיקף, במכוון וכנגד האינסטינקט.
--     ההיגיון "הן אינן מוצגות ולכן אינן משנות" מייצר בדיוק את הבאג שהקובץ
--     הזה סוגר, רק בדלת האחורית: עבודה שתשוחזר מחר הייתה חוזרת עם פירעון
--     שחושב לפי תנאים שאינם קיימים. נכונות הנתון אינה תלויה בנראותו.
--
-- (ד) והשורה השלישית — מדלגים על מה שלא ישתנה. בלעדיה כל שינוי תנאים היה
--     כותב מחדש את כל עבודות הלקוח ומדווח באירוע מספר ששווה למספר העבודות
--     ולא למספר התנועות. jobs_refreshed חייב לספור תנועה אמיתית, אחרת הוא
--     מדד חסר ערך בדיוק ברגע שבו יסתכלו עליו.
--
-- ⚠️ שער ה-WHEN אינו קישוט. `UPDATE OF payment_terms` יורה כשהעמודה **נזכרת**
--    בפקודת ה-UPDATE, גם כששני הערכים זהים, וה-EntityDrawer שולח את העמודה
--    בכל שמירה של כרטיס לקוח. בלי `when (old.payment_terms is distinct from
--    new.payment_terms)` כל שמירה של שם איש קשר הייתה כותבת אירוע
--    payment_terms_changed שקרי.
--
-- ⚠️ אין רקורסיה, ולא במקרה: ה-UPDATE כאן נוגע ב-due_date בלבד, ו-
--    trg_compute_due_date מוגדר UPDATE OF date, client_id — הוא אינו יורה.
--    שני הטריגרים האחרים על jobs (guard_job_money_columns,
--    guard_job_dismissal) שומרים על עמודות שאינן due_date ולכן עוברים בשתיקה.
--
-- SECURITY DEFINER מפני ש-jobs היא relrowsecurity=true: בלי זה הטריגר היה
-- מרענן רק את השורות שה-RLS של המשתמש המעדכן מראה לו, ושורה שאינה נראית
-- הייתה נשארת מיושנת בשקט — כישלון חלקי שאינו מדווח, הגרוע מכולם.
--
-- ── מה הקובץ נוגע בו ───────────────────────────────────────────────────────
-- אפס שינוי סכימה · אפס DELETE · שורת UPDATE אחת על נתונים (07faca02,
-- ההשלמה למפרע, מאחורי שער שעוצר אם אינה היחידה) · אפס שורה חדשה מלבד
-- שורת הפנקס והאירוע.
--
-- כלל 49 — השפעת ACL, מוצהרת: נוצר אובייקט אחד נושא-ACL, פונקציית הטריגר
-- refresh_jobs_due_date_on_terms_change. ברירת המחדל של PostgreSQL (EXECUTE
-- ל-PUBLIC) נשמרת **במכוון**, בהתאמה לכל פונקציות הטריגר האחרות בסכימה
-- (compute_due_date, guard_client_money_columns, on_production_approved —
-- כולן public_exec=true). זה בטוח ולא מרושל: plpgsql מסרב להריץ פונקציית
-- טריגר מחוץ להקשר טריגר ("trigger functions can only be called as triggers"),
-- ולכן ה-SECURITY DEFINER אינו ניתן לניצול דרך קריאה ישירה. due_date_for
-- נשארת מוגבלת ל-service_role כפי שקבע 0089, והטריגר מגיע אליה דרך
-- ה-SECURITY DEFINER בבעלות postgres.
-- ============================================================================

-- ── הפונקציה ───────────────────────────────────────────────────────────────
create or replace function public.refresh_jobs_due_date_on_terms_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  -- האירוע נכתב גם כש-v_rows הוא 0. שינוי תנאי תשלום הוא החלטה כספית נדירה
  -- ומכוונת, ו"שיניתי ולא זז כלום" הוא בדיוק המידע שירצו כשיסתכלו אחורה.
  -- שער ה-WHEN של הטריגר הוא מה שמונע הצפה, לא תנאי כאן.
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

  return null;  -- AFTER trigger: ערך ההחזרה נזנח
end;
$$;

comment on function public.refresh_jobs_due_date_on_terms_change() is
  'P10 (0091): מרענן jobs.due_date לעבודות הפתוחות של לקוח כשתנאי התשלום שלו משתנים, דרך due_date_for בלבד. היקף: date לא ריק, paid <> ''כן'', ורק שורות שהערך שלהן באמת זז. מוסתרות בהיקף במכוון.';

-- ── הטריגר ─────────────────────────────────────────────────────────────────
drop trigger if exists trg_refresh_jobs_due_date on public.clients;
create trigger trg_refresh_jobs_due_date
after update of payment_terms on public.clients
for each row
when (old.payment_terms is distinct from new.payment_terms)
execute function public.refresh_jobs_due_date_on_terms_change();

-- ── ההשלמה למפרע, מאחורי שער ──────────────────────────────────────────────
-- קודם קוראים מה עומד לזוז, ורק אם זו בדיוק שורה אחת והיא 07faca02 — כותבים.
-- אם התמונה השתנתה מאז התחקיר, הקובץ עוצר ומדפיס את הפירוט המלא, ואז זו
-- החלטה של אדם ולא של מיגרציה.
do $backfill$
declare
  v_pending jsonb;
  v_n       int;
  v_id      uuid;
  v_due     date;
  c_target  constant uuid := '07faca02-373c-48ba-af59-084cb9709405';
begin
  select jsonb_agg(jsonb_build_object(
           'job_id',  j.id,
           'client',  c.name,
           'date',    j.date,
           'paid',    j.paid::text,
           'terms',   c.payment_terms::text,
           'due_old', j.due_date,
           'due_new', public.due_date_for(j.date, c.payment_terms))
         order by j.id)
    into v_pending
  from public.jobs j
  join public.clients c on c.id = j.client_id
  where j.date is not null
    and j.paid <> 'כן'
    and j.due_date is distinct from public.due_date_for(j.date, c.payment_terms);

  v_n := coalesce(jsonb_array_length(v_pending), 0);

  if v_n <> 1 then
    raise exception '0091 עצרה: ההשלמה למפרע נוגעת ב-% שורות ולא באחת. התחקיר מ-19.9 מצא בדיוק את 07faca02. הפירוט: %',
      v_n, coalesce(v_pending::text, 'אין שורות');
  end if;

  v_id := (v_pending->0->>'job_id')::uuid;
  if v_id <> c_target then
    raise exception '0091 עצרה: השורה היחידה היא % ולא 07faca02. הפירוט: %', v_id, v_pending::text;
  end if;

  update public.jobs j
     set due_date = public.due_date_for(j.date, c.payment_terms)
    from public.clients c
   where c.id = j.client_id
     and j.date is not null
     and j.paid <> 'כן'
     and j.due_date is distinct from public.due_date_for(j.date, c.payment_terms);

  select due_date into v_due from public.jobs where id = c_target;
  if v_due is distinct from date '2026-11-01' then
    raise exception '0091 עצרה: 07faca02 קיבל % ולא 2026-11-01 (02.09 + net_60).', v_due;
  end if;

  raise notice '0091: ההשלמה למפרע רועננה שורה אחת — 07faca02, % → 2026-11-01.',
    v_pending->0->>'due_old';

  -- שובל האודיט של ההשלמה, עם המצב המדויק לפני השינוי
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', c_target, 'due_date_backfilled', null,
          jsonb_build_object(
            'migration', '0091',
            'reason',    'P10 — תנאי התשלום של הלקוח שונו אחרי שהשורה נכתבה, והטריגר לא ירה',
            'before',    v_pending->0,
            'due_new',   v_due));
end $backfill$;

-- ── שער: הטריגר הותקן כפי שהוכרע ──────────────────────────────────────────
do $guard$
declare
  v_def text;
begin
  select pg_get_triggerdef(t.oid) into v_def
  from pg_trigger t
  join pg_class cl on cl.oid = t.tgrelid
  where cl.relname = 'clients' and t.tgname = 'trg_refresh_jobs_due_date'
    and not t.tgisinternal;

  if v_def is null then
    raise exception '0091 עצרה: trg_refresh_jobs_due_date אינו קיים על clients.';
  end if;
  if v_def not like '%UPDATE OF payment_terms%' then
    raise exception '0091 עצרה: הטריגר אינו מוגבל ל-UPDATE OF payment_terms. ההגדרה: %', v_def;
  end if;
  if v_def not like '%WHEN%' then
    raise exception '0091 עצרה: שער ה-WHEN חסר — כל שמירת כרטיס לקוח תכתוב אירוע שקרי. ההגדרה: %', v_def;
  end if;
  if not (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'refresh_jobs_due_date_on_terms_change') then
    raise exception '0091 עצרה: הפונקציה אינה SECURITY DEFINER, ו-RLS על jobs יגרום לריענון חלקי שקט.';
  end if;

  -- ו-0089 לא נפגע: הטריגר המקורי עדיין במקומו על אותם אירועים
  if not exists (
    select 1 from pg_trigger t
    join pg_class cl on cl.oid = t.tgrelid
    join pg_proc pr on pr.oid = t.tgfoid
    where cl.relname = 'jobs' and t.tgname = 'trg_compute_due_date'
      and pr.proname = 'compute_due_date' and t.tgenabled = 'O'
  ) then
    raise exception '0091 עצרה: trg_compute_due_date על jobs אינו במקומו.';
  end if;

  raise notice '0091: הטריגר הותקן — AFTER UPDATE OF payment_terms עם שער WHEN, SECURITY DEFINER, ו-0089 שלם.';
end $guard$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'due_date_follows_terms', null,
        jsonb_build_object(
          'migration',       '0091',
          'ticket',          'P10',
          'function',        'public.refresh_jobs_due_date_on_terms_change()',
          'trigger',         'trg_refresh_jobs_due_date on public.clients',
          'new_event_type',  'payment_terms_changed',
          'scope',           'date is not null and paid <> ''כן''; dismissed included',
          'jobs_backfilled', 1,
          'backfilled_id',   '07faca02-373c-48ba-af59-084cb9709405',
          'source',          'F12 investigation 2026-09-19'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0091', now(), 'bnaya',
        'P10 נסגר: שינוי clients.payment_terms מרענן את jobs.due_date של אותו לקוח. נוצרה public.refresh_jobs_due_date_on_terms_change() ועליה trg_refresh_jobs_due_date, AFTER UPDATE OF payment_terms ON public.clients FOR EACH ROW WHEN (old.payment_terms is distinct from new.payment_terms). הרקע — trg_compute_due_date הוא BEFORE INSERT OR UPDATE OF date, client_id על jobs, כלומר מועד הפירעון תלוי בעמודה שאינה יושבת על ה-job (clients.payment_terms) ואף טריגר לא ירה כששינו אותה; התוצאה היא עבודות שנושאות פירעון לפי תנאים שכבר אינם קיימים, לצמיתות. הפונקציה אינה מחשבת דבר בעצמה אלא קוראת ל-public.due_date_for של 0089, כי הכרעה יב אוסרת מימוש שני של האריתמטיקה הזו וזה כולל מימוש שני בתוך המסד. ההיקף, שהוכרע בתחקיר F12 מ-19.9: (א) date ריק אינו בהיקף, כי הבסיס שם הוא coalesce(date, current_date) וריענון היה כותב את תאריך העדכון במקום את מועד התשלום — שלוש מארבע השורות המיושנות היום הן בדיוק הרעש הזה ונשארות כפי שהן; (ב) paid <> כן ולא paid = לא, כי כן היא התווית היחידה שאומרת נגבה, בעוד ללא חיוב אומר שאין מה לגבות ו-לא ידוע אומר שלא נבדק (0082 מילא אותו למפרע), ושתיהן אינן סגירה; (ג) עבודות מוסתרות כן בהיקף במכוון, כי ההיגיון שהן אינן מוצגות ולכן אינן משנות מייצר את אותו באג בדלת האחורית ברגע שעבודה משוחזרת; (ד) רק שורות שהערך שלהן באמת זז מתעדכנות, אחרת jobs_refreshed באירוע היה שווה למספר העבודות ולא למספר התנועות. שער ה-WHEN הוא תנאי ולא קישוט: UPDATE OF payment_terms יורה כשהעמודה נזכרת בפקודה גם בלי שינוי ערך, וה-EntityDrawer שולח אותה בכל שמירת כרטיס, ולכן בלעדיו כל שמירת שם איש קשר הייתה כותבת אירוע payment_terms_changed שקרי. SECURITY DEFINER מפני ש-jobs היא relrowsecurity=true ובלעדיו הטריגר היה מרענן רק את השורות שה-RLS מראה למעדכן, כלומר כישלון חלקי שאינו מדווח. אין רקורסיה: ה-UPDATE נוגע ב-due_date בלבד ו-trg_compute_due_date מוגבל ל-UPDATE OF date, client_id, ושני הגארדים האחרים על jobs שומרים על עמודות אחרות. כל שינוי תנאים כותב אירוע payment_terms_changed על entity_type=client עם client_id, client_name, terms_old, terms_new ו-jobs_refreshed, גם כשהמספר אפס. ההשלמה למפרע: שורה אחת רועננה, 07faca02 (וואי 360 בע״מ, 8,000 ש״ח, 02.09.2026, net_60) מ-2026-09-02 ל-2026-11-01, סטייה של 60 יום; היא מתועדת כבר בהערת השער של 0089 ש-0089 במכוון לא תיקן כי הוא היה ריפקטור טהור. ההשלמה יושבת מאחורי שער שקורא את רשימת השורות לפני הכתיבה ועוצר אם אינה בדיוק 07faca02, ואירוע due_date_backfilled על entity_type=job שומר את המצב המלא שלפני. כלל 49, ACL מוצהר: נוצר אובייקט אחד נושא-ACL, פונקציית הטריגר, וברירת המחדל EXECUTE ל-PUBLIC נשמרת במכוון בהתאמה לשאר פונקציות הטריגר בסכימה; זה בטוח כי plpgsql מסרב להריץ פונקציית טריגר מחוץ להקשר טריגר. הקובץ אינו נוגע ב-ACL של due_date_for, והטריגר מגיע אליה דרך ה-SECURITY DEFINER בבעלות postgres ולכן אינו תלוי בגרנט שלה. ⚠️ תיקון עובדתי ל-0089: 0089 מצהיר ש-due_date_for מוגבלת ל-service_role בלבד, והמדידה על המסד החי ב-19.9 מראה postgres, authenticated ו-service_role. ה-revoke from public של 0089 הסיר את רשומת PUBLIC ורק אותה, בעוד הגרנט ל-authenticated הגיע מ-ALTER DEFAULT PRIVILEGES של Supabase ברגע יצירת הפונקציה ואינו מושפע מ-revoke from public. ההשלכה אפסית כי due_date_for היא IMMUTABLE, אינה SECURITY DEFINER, אינה נוגעת בטבלה ואינה קוראת auth.uid() — אריתמטיקה טהורה על date ו-enum; ההצהרה מתוקנת כאן, 0089 עצמו לא נגע כי הוא כבר הוחל. אפס שינוי סכימה, אפס DELETE, שורת UPDATE אחת על נתונים, אפס שורה חדשה מלבד האירועים ושורת הפנקס. ההרצה המדומה ב-supabase/verify/0091_dryrun.sql ושאילתת האימות ב-supabase/verify/0091_verify.sql — כלל 50.');
