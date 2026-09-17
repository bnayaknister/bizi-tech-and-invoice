-- ============================================================================
-- 0089 — due_date_for(base, terms): מועד הפירעון הופך לפונקציה שאפשר לקרוא לה
--
-- ⚠️ להריץ את supabase/verify/0089_dryrun.sql לפני. שם, ולא כאן, נמצאת
--    ההשוואה המלאה מול הלוגיקה של 0002. כלל 50: קובץ אימות אינו יושב בתיקיית
--    המיגרציות.
--
-- למה בכלל: compute_due_date (0002:258) היא `returns trigger`. הלוגיקה של
-- תנאי התשלום קבורה בתוכה ואי אפשר לשאול אותה שאלה — היא רק כותבת
-- jobs.due_date מתוך jobs.date. מסך מעקב הפרויקטים צריך את אותה אריתמטיקה על
-- **תאריך המסמך**, וההכרעה שהמספר הזה חי במקום אחד (הכרעה יב) משאירה בדיוק
-- שתי אפשרויות: לשכפל אותה ב-TypeScript, או להוציא אותה החוצה כפונקציה.
-- הקובץ הזה מוציא אותה החוצה.
--
-- ⚠️ ההתנהגות של jobs.due_date אינה משתנה. הבסיס נשאר
--    coalesce(new.date, current_date), ה-case זהה תו-בתו, והטריגר יורה על
--    אותם אירועים. שינוי הבסיס (תאריך הנפקה במקום תאריך עבודה) הוא BL-2 והוא
--    אינו כאן. המיגרציה הזו היא **ריפקטור טהור** של 0002 ותו לא.
--
-- אפס שינוי סכימה · אפס DELETE · אפס UPDATE על נתונים · אפס שורה חדשה מלבד
-- שורת הפנקס והאירוע.
--
-- כלל 49 — השפעת ACL, מוצהרת: נוצר אובייקט אחד נושא-ACL, הפונקציה
-- due_date_for. ברירת המחדל של PostgreSQL היא EXECUTE ל-PUBLIC, ולכן היא
-- נשללת במפורש ומוענקת ל-service_role בלבד — הקריאה היחידה מהאפליקציה תהיה
-- בקריאת service-role מאחורי שער כספים, כמו כל שאר מסך /projects.
-- compute_due_date היא SECURITY DEFINER בבעלות postgres ולכן קוראת לה
-- ללא קשר לגרנט. אם ייפתח אי-פעם RPC ללקוח מחובר — זה גרנט נפרד ומודע.
-- ============================================================================

-- ── הפונקציה ───────────────────────────────────────────────────────────────
-- IMMUTABLE ולא STABLE: התוצאה נגזרת מהארגומנטים בלבד, בלי קריאה לטבלה ובלי
-- current_date. חיפוש הלקוח נשאר אצל הקורא, וזה מה שהופך אותה לניתנת לבדיקה.
--
-- לא STRICT, במכוון ובניגוד לאינסטינקט: ה-else של 0002 מחזיר את הבסיס גם
-- כשה-terms ריק (לקוח שלא נמצא, או client_id ריק על ה-job). STRICT היה מחזיר
-- NULL ומוחק due_date על כל שורה כזו בעדכון הבא שלה. מבחן 2 בהרצה המדומה נכתב
-- בדיוק על זה.
create or replace function public.due_date_for(base date, terms public.payment_terms)
returns date
language sql
immutable
as $$
  -- מועתק תו-בתו מ-compute_due_date (0002:265-272). ⚠️ eom הוא סוף החודש
  -- ואז +N ימים — ל-13.08 עם eom_30 זה 30.09, לא 12.09.
  select case terms
    when 'net_30' then base + 30
    when 'net_60' then base + 60
    when 'eom_30' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 30
    when 'eom_60' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 60
    when 'eom_90' then (date_trunc('month', base) + interval '1 month - 1 day')::date + 90
    else base   -- immediate, או terms ריק
  end
$$;

comment on function public.due_date_for(date, public.payment_terms) is
  'מועד הפירעון לפי תנאי התשלום. מקור האמת היחיד (הכרעה יב) — compute_due_date קוראת לה, וכך גם כל קורא אחר. אין לשכפל את הלוגיקה הזו ב-TypeScript.';

revoke all on function public.due_date_for(date, public.payment_terms) from public;
grant execute on function public.due_date_for(date, public.payment_terms) to service_role;

-- ── הטריגר, עכשיו קורא לפונקציה ────────────────────────────────────────────
-- החתימה, ה-security definer, ה-search_path וה-coalesce — כולם כפי שהיו.
-- השורה היחידה שהשתנתה היא ה-case שהפך לקריאה.
create or replace function public.compute_due_date()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  terms payment_terms;
  base date;
begin
  select payment_terms into terms from public.clients where id = new.client_id;
  base := coalesce(new.date, current_date);
  new.due_date := public.due_date_for(base, terms);
  return new;
end;
$$;

-- הטריגר עצמו לא נגע: אותו שם, אותו BEFORE INSERT OR UPDATE OF date, client_id,
-- אותה פונקציה. create or replace על הפונקציה מספיק, ו-drop/create מיותר של
-- הטריגר היה חלון שבו העמודה אינה מחושבת.

-- ── שער: אף שורת jobs קיימת אינה משנה את ה-due_date שלה ───────────────────
do $guard$
declare
  v_bad int;
  v_total int;
begin
  select count(*), count(*) filter (
           where j.due_date is distinct from public.due_date_for(coalesce(j.date, current_date), c.payment_terms))
    into v_total, v_bad
    from public.jobs j
    left join public.clients c on c.id = j.client_id;
  if v_bad > 0 then
    raise exception '0089 עצרה: % מתוך % שורות jobs היו מקבלות due_date שונה. הריצי את supabase/verify/0089_dryrun.sql וקראי את הפירוט.', v_bad, v_total;
  end if;
  raise notice '0089: % שורות jobs, אפס הפרשים.', v_total;
end $guard$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'due_date_logic_extracted', null,
        jsonb_build_object(
          'migration', '0089',
          'function', 'public.due_date_for(date, payment_terms)',
          'source', 'compute_due_date (0002)',
          'behaviour_change', false,
          'jobs_due_date_base', 'coalesce(jobs.date, current_date) — ללא שינוי',
          'acl', 'revoke from public; grant execute to service_role'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0089', now(), 'bnaya',
        'חילוץ אריתמטיקת מועד הפירעון מתוך compute_due_date לפונקציה שאפשר לקרוא לה: public.due_date_for(base date, terms payment_terms) returns date, immutable, לא strict. ריפקטור טהור — ה-case מועתק תו-בתו מ-0002:265-272, compute_due_date שומרת על החתימה ועל security definer ועל search_path ועל coalesce(new.date, current_date), והטריגר trg_compute_due_date לא נגע כלל. jobs.due_date אינו משנה ערך על אף שורה, ושער בתוך הקובץ סופר את כל שורות jobs מול הפונקציה החדשה ועוצר אם ולו אחת מהן זזה. למה זה נדרש: compute_due_date היא returns trigger, כלומר הלוגיקה קבורה בתוכה ואי אפשר לשאול אותה מה הפירעון של תאריך כלשהו; מסך מעקב הפרויקטים צריך בדיוק את אותה אריתמטיקה על תאריך המסמך ולא על תאריך העבודה, והכרעה יב אוסרת מימוש שני ב-TypeScript. לא STRICT במכוון: ה-else של 0002 מחזיר את הבסיס גם כש-terms ריק (לקוח שלא נמצא או client_id ריק), ו-STRICT היה מחזיר NULL ומוחק due_date על כל שורה כזו בעדכון הבא שלה. IMMUTABLE ולא STABLE כי אין קריאה לטבלה ואין current_date בפונקציה — חיפוש הלקוח נשאר אצל הקורא, וזה מה שהופך אותה לבדיקה. מה שאינו כאן ובמכוון: שינוי הבסיס של jobs.due_date מתאריך העבודה לתאריך ההנפקה הוא BL-2, וגם dueDate שנשלח למורנינג ב-issue.ts הוא BL-2; הקובץ הזה אינו נוגע באף אחד מהם ואינו מכריע בהם. כלל 49, ACL מוצהר: נוצר אובייקט אחד נושא-ACL, ו-EXECUTE נשלל מ-PUBLIC ומוענק ל-service_role בלבד — הקריאה היחידה מהאפליקציה היא קריאת service-role מאחורי שער כספים; compute_due_date היא SECURITY DEFINER בבעלות postgres וקוראת לה ללא קשר לגרנט. אפס שינוי סכימה, אפס DELETE, אפס UPDATE על נתונים, אפס שורה חדשה מלבד האירוע ושורת הפנקס. ההרצה המדומה וההשוואה המלאה יושבות ב-supabase/verify/0089_dryrun.sql ושאילתת האימות ב-supabase/verify/0089_verify.sql — כלל 50.');
