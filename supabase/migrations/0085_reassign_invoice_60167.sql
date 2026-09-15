-- 0085 — שורת invoices של 60167 עוברת לעבודה הנכונה
--
-- מה זה ולמה. שורה אחת, עמודה אחת, ושני אירועים. שורת invoices b495cdf2
-- מתארת את קבלה 60167 של מכון דווידסון ונושאת job_id שמצביע על b3eaafd3 —
-- עבודה שאין לה שום קשר למסמך הזה. המסמך עצמו כבר מצביע על העבודה הנכונה
-- מאז 30.7.26, והשורה נשארה מאחור. הקובץ מיישר אותה.
--
-- ═══ איך זה נוצר, בשלושה תאריכים ═══
-- 26.7.26 21:49:05 UTC — מנהל החשבונות שייך את 60167 ל-b3eaafd3 ביד. זו
--   הייתה טעות: 60167 הוא בן של חשבונית 40226, ו-b3eaafd3 נושאת 40240.
--   linkDocumentToJob עשתה את מה שנתבקשה — חתמה את documents.job_id, כתבה
--   שורת invoices חדשה עם אותו job_id (reconcile.ts:596), וסימנה את העבודה
--   כשולמה על סמך קבלה שאינה שלה.
-- 30.7.26 21:14 ו-21:17 UTC — התיקון הידני, שרשום בפנקס כ-fix-2026-07-31-a
--   ו-fix-2026-07-31-b. הוא עשה את הדבר הנכון: יצר את 2c005a1f להקלטת 28.4,
--   הזיז אליה את documents.job_id של 40226 ושל 60167, והחזיר את b3eaafd3
--   ל-paid=לא עם invoice_biz=40240. שני בלוקים, שניהם מתועדים באירועים
--   job_created_manual_sql, job_receipt_detached_manual_sql ו-
--   job_payment_corrected_manual_sql.
-- ⚠️ ומה שהוא פספס: טבלת invoices. הוא נגע ב-documents וב-jobs, ושורת
--   b495cdf2 נשארה על b3eaafd3 עד היום. זו כל השארית, והקובץ הזה כולו.
--
-- ═══ למה 2c005a1f היא הכתובת הנכונה, ולא שיפוט ═══
-- 60167 נושא parent_doc_numbers=["40226"], ו-40226 היא invoice_biz של
-- 2c005a1f. השרשרת במורנינג שלמה ומצביעה על עבודה אחת בלבד:
--     10227 (100)  →  40226 (300)  →  60167 (320)
-- ולעבודה השנייה יש שרשרת נפרדת ומלאה משלה, שאינה נוגעת ב-60167 בשום נקודה:
--     10239 (100)  →  40240 (300)  →  50067 (305)  →  80061 (400, קבלה)
--
-- ═══ מה הקובץ לא עושה, וזה העיקר ═══
-- ⚠️ אפס שינוי כסף. שתי העבודות שולמו באמת ושתיהן מסומנות נכון, ו-jobs אינה
-- נוגעת בכלל — לא paid, לא invoice_biz, לא invoice_tax. 2c005a1f שולמה כי
-- 60167 הוא 320, חשבונית מס וקבלה באחד, שהנפקתו היא הצהרה שהכסף נכנס;
-- b3eaafd3 שולמה כי על 50067 יצאה קבלה 80061 ב-19.7.26. שתי שרשראות סגורות,
-- status=1 ו-ref ריק ו-amountOpened אפס בכל אחד מששת המסמכים. הסימון של
-- b3eaafd3 היום אינו הסימון השגוי של 26.7 — ההוא בוטל ב-30.7, והנוכחי נוצר
-- ב-3.8 דרך מסך הכספים אחרי שהכסף על 40240 באמת התקבל.
-- גם documents אינה נוגעת: job_id של 60167 כבר נכון. md5 על שתי הטבלאות
-- מאמת את שתי הטענות אחרי הכתיבה.
--
-- ═══ מה זה מתקן בפועל — שתי תקלות תצוגה ═══
-- הנזק אינו בכסף אלא בקישורים, ולכן הוא לא נראה עד שחיפשו אותו:
--   finance/page.tsx:62 עושה docs.find על type=מס. ל-b3eaafd3 יש היום שתי
--   שורות מס — 50067 שלה ו-60167 הזרה — ו-find מחזיר את הראשונה במערך לא
--   מסודר. קישור ה-PDF במשבצת המס שלה עלול לפתוח את הקבלה של עבודה אחרת.
--   המספר המוצג תקין, כי j.invoice_tax גובר ב-finance/page.tsx:81; ה-PDF לא.
--   ול-2c005a1f אין ולו שורת invoices אחת, ולכן שתי משבצותיה מציגות מספר
--   בלי שום קישור PDF.
--   jobs/[id]/show-link/route.ts:21 מחזיר את שתי השורות ב-taxDocs (שורה 43),
--   כך שמודל הקישור מציג ל-b3eaafd3 מסמך מס שאינו שלה.
-- אחרי הקובץ: שורה אחת מסוג מס לכל אחת מהשתיים, וכל קישור מצביע על המסמך
-- שלו.
--
-- ═══ זה המקרה היחיד, ונמדד ולא הונח ═══
-- 77 שורות invoices מצטרפות למסמך לפי morning_doc_id. אחת מהן, זו, נושאת
-- job_id שונה מ-documents.job_id. אפס שורות בכיוון ההפוך ואפס עם צד ריק אחד.
-- זו שארית של תיקון ידני יחיד ולא תופעה, וקנרי 3d מוודא שאחרי הכתיבה המספר
-- הוא אפס על פני כל הטבלה ולא רק על השורה הזאת.
--
-- ═══ 40238 — נבדק והוכרע שלא לגעת ═══
-- בתחקיר עלה 40238, חשבונית 300 על 2,360 של אותו לקוח שנושאת status=2 עם
-- amountOpened=2,360 ואינה מקושרת לשום job. הוכרע שלא לגעת: 40238 הוחלף
-- ב-40240 על 1,180, שני המסמכים נושאים אותו פירוט ואותו תאריך הקלטה ואותן
-- שעות — 4 שעות אולפן כפול 250 שווה 1,000 נטו — אין יתרה לחיוב, המסמך סגור
-- במורנינג ואינו נספר בשום מקום במערכת. נרשם כאן כדי שהשאלה לא תיפתח שוב.
--
-- ═══ PERMISSIONS — STATED, NOT ASSUMED (rule 49) ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא כותב ערך לעמודה
-- קיימת בשורה אחת ומוסיף שתי שורות ל-events. אין כאן GRANT ואין דבר
-- שהרשאותיו יכולות להיוולד שגויות. זה נאמר במפורש כי אין שינוי הרשאות היא
-- טענה שקורא צריך למצוא ולא להסיק.
--
-- החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: invoices כבר מוגנת
-- ב-RLS דרך invoices_view עם can_view_money ו-invoices_update עם
-- can_edit_money, ואף אחת מהן לא נגעה; הקובץ רץ כ-postgres ועוקף RLS כמו כל
-- מיגרציה, וזה המצב הקיים ולא דבר שהוא יוצר.
--
-- ZERO DELETE. ZERO schema change. שורה אחת, עמודה אחת, שתי שורות ביומן.

do $mig$
declare
  v_inv   constant uuid := 'b495cdf2-b03c-4f60-b8a1-05bbec560070';  -- שורת invoices של 60167
  v_doc   constant uuid := '576f1a38-6bde-411a-870e-24e942954917';  -- המסמך 60167
  v_from  constant uuid := 'b3eaafd3-87b1-4450-aeca-38430fc7f1d1';  -- הכתובת השגויה
  v_to    constant uuid := '2c005a1f-3f55-4e7b-8ad6-5b7e99f1cf4a';  -- הכתובת הנכונה
  v_num   constant text := '60167';

  v_upd        int;
  v_events     int;
  v_bad        int;
  v_inv_pre    int;  v_inv_post   int;
  v_jobs_pre   text; v_jobs_post  text;
  v_docs_pre   text; v_docs_post  text;
  v_rest_pre   text; v_rest_post  text;
  v_mas_to     int;  v_mas_from   int;
begin
  -- =====================================================================
  -- 0. GUARDS
  -- =====================================================================

  -- 0a. הפנקס הוא הרצף, לא שמות הקבצים.
  if exists (select 1 from public.schema_ledger where version = '0085') then
    raise exception '0085 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0084') then
    raise exception '0085: 0084 אינה בפנקס — המספור נגזר מפנקס אחר, מדדי מחדש';
  end if;

  -- 0b. השורה קיימת ובמצב שנמדד: על הכתובת השגויה, ועם כל מה שכבר נכון בה.
  --     amount ו-type ו-source נבדקים אף שאינם נכתבים, כי שורה שהשתנתה בהם
  --     מאז המדידה אינה השורה שהתחקיר תיאר.
  if not exists (
    select 1 from public.invoices i
     where i.id = v_inv
       and i.job_id = v_from
       and i.doc_number = v_num
       and i.type = 'מס'
       and i.amount = 1180
       and i.source = 'morning_api') then
    raise exception '0085: שורת invoices % אינה במצב שנמדד', v_inv;
  end if;

  -- 0c. ⚠️ הבדיקה שמכשירה את ההעברה. המסמך נושא את הכתובת הנכונה, ואותו
  --     morning_doc_id כמו השורה — כלומר השניים באמת מתארים מסמך אחד.
  --     בלי הזהות הזאת ההעברה היא ניחוש ולא יישור.
  if not exists (
    select 1 from public.documents d, public.invoices i
     where d.id = v_doc
       and i.id = v_inv
       and d.job_id = v_to
       and d.morning_doc_id = i.morning_doc_id
       and d.morning_doc_number = v_num
       and d.client_id = i.client_id
       and d.cancelled_at is null
       and d.archived_at is null) then
    raise exception '0085: המסמך % אינו נושא את הכתובת הנכונה או אינו אותו מסמך כמו השורה', v_doc;
  end if;

  -- 0d. שתי העבודות קיימות ושייכות לאותו לקוח כמו השורה. העברה בין לקוחות
  --     הייתה משנה למי הכסף שייך, וזה לא מה שהקובץ הזה עושה.
  if (select count(*) from public.jobs j, public.invoices i
       where j.id in (v_from, v_to) and i.id = v_inv and j.client_id = i.client_id) <> 2 then
    raise exception '0085: שתי העבודות אינן קיימות או אינן של אותו לקוח כמו השורה';
  end if;

  -- 0e. והמצב שהתחקיר תיאר: זו השורה היחידה בטבלה כולה שבה
  --     invoices.job_id שונה מ-documents.job_id. אילו היו יותר, הקובץ הזה
  --     מתקן אחת ומשאיר את השאר בלי שאיש יידע.
  select count(*) into v_bad
    from public.invoices i
    join public.documents d on d.morning_doc_id = i.morning_doc_id
   where i.job_id is distinct from d.job_id;
  if v_bad <> 1 then
    raise exception '0085: נמצאו % שורות עם job_id שאינו תואם למסמך, במקום אחת — המצב השתנה מאז המדידה', v_bad;
  end if;

  -- =====================================================================
  -- 1. SNAPSHOT
  -- =====================================================================
  select count(*) into v_inv_pre from public.invoices;

  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_pre
    from (select to_jsonb(j)::text as x from public.jobs j) t;

  select md5(string_agg(t.x, '|' order by t.x)) into v_docs_pre
    from (select to_jsonb(d)::text as x from public.documents d) t;

  select md5(string_agg(t.x, '|' order by t.x)) into v_rest_pre
    from (select to_jsonb(i)::text as x from public.invoices i where i.id <> v_inv) t;

  -- =====================================================================
  -- 2. THE WRITE. and job_id = v_from הוא ההגנה ולא ה-WHERE על המזהה:
  --    שורה שמישהו הזיז בין השומר לכתיבה פשוט לא תיכתב, וספירת השורות
  --    למטה תתפוס זאת ותפיל את הקובץ.
  -- =====================================================================
  with upd as (
    update public.invoices
       set job_id = v_to
     where id = v_inv
       and job_id = v_from
    returning 1
  ) select count(*) into v_upd from upd;

  -- 2b. היומן, על שתי העבודות. שתיהן ולא אחת: העבודה הנכונה קיבלה שורה,
  --     והשגויה איבדה אותה, ושתי העובדות צריכות להיות ניתנות למציאה מהיומן
  --     ולא משחזור. actor_id ריק במכוון, מוסכמת 0064/0066: מיגרציה עשתה
  --     זאת ולא אדם. התקדים לצמד הזה הוא job_receipt_detached_manual_sql
  --     שנכתב ב-30.7 על הצד שאיבד.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', x.jid, 'invoice_row_reassigned', null,
           jsonb_build_object(
             'via', '0085_fix',
             'invoice_id', v_inv,
             'morning_doc_number', v_num,
             'from_job_id', v_from,
             'to_job_id', v_to,
             'reason', x.reason)
      from (values
        (v_to,   'שורת החיוב של קבלה 60167 הועברה לעבודה הזאת. 60167 הוא בן של חשבונית 40226, שהיא invoice_biz של עבודה זו; המסמך עצמו מצביע עליה מאז התיקון הידני של 30.7.26, ורק שורת invoices נשארה מאחור.'),
        (v_from, 'שורת החיוב של קבלה 60167 ירדה מהעבודה הזאת. היא נכתבה עליה בשיוך שגוי ב-26.7.26; התיקון הידני של 30.7.26 ניתק את המסמך ואת jobs ולא נגע ב-invoices. אין שינוי בסטטוס התשלום: העבודה שולמה באמת, על סמך 40240 ואז 50067 וקבלה 80061.')
      ) as x(jid, reason)
    returning 1
  ) select count(*) into v_events from ev;

  -- =====================================================================
  -- 3. CANARY
  -- =====================================================================
  if v_upd <> 1 then
    raise exception '0085 canary: % שורות עודכנו במקום אחת', v_upd;
  end if;
  if v_events <> 2 then
    raise exception '0085 canary: נכתבו % אירועים במקום 2', v_events;
  end if;
  if (select count(*) from public.events where payload->>'via' = '0085_fix') <> 2 then
    raise exception '0085 canary: מספר אירועי 0085_fix ביומן אינו 2';
  end if;

  -- 3a. הערך באמת שם, נקרא חזרה מהטבלה ולא מונח מספירת השורות שעודכנו,
  --     ונבדק מול המסמך ולא מול הקבוע.
  if not exists (
    select 1 from public.invoices i join public.documents d on d.id = v_doc
     where i.id = v_inv and i.job_id = d.job_id and i.job_id = v_to) then
    raise exception '0085 canary: job_id של השורה אינו שווה ל-job_id של המסמך';
  end if;

  -- 3b. ⚠️ מה שהקובץ נכתב כדי להשיג: שורה אחת מסוג מס לכל אחת מהשתיים.
  --     זו הבדיקה שמכסה את docs.find ב-finance/page.tsx:62 ואת taxDocs
  --     ב-show-link, ששניהם שברו על שתי שורות אצל עבודה אחת ואפס אצל השנייה.
  select count(*) into v_mas_to   from public.invoices where job_id = v_to   and type = 'מס';
  select count(*) into v_mas_from from public.invoices where job_id = v_from and type = 'מס';
  if v_mas_to <> 1 or v_mas_from <> 1 then
    raise exception '0085 canary: שורות מס — לעבודה הנכונה % ולשגויה %, במקום אחת לכל אחת', v_mas_to, v_mas_from;
  end if;

  -- 3c. אפס נזק צדדי. jobs ו-documents לא זזו בכלל, וזו הטענה הנושאת:
  --     הקובץ מיישר רישום ואינו נוגע בכסף ואינו משנה שיוך של מסמך.
  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_post
    from (select to_jsonb(j)::text as x from public.jobs j) t;
  if v_jobs_post is distinct from v_jobs_pre then
    raise exception '0085 canary: שורה בטבלת jobs השתנתה';
  end if;

  select md5(string_agg(t.x, '|' order by t.x)) into v_docs_post
    from (select to_jsonb(d)::text as x from public.documents d) t;
  if v_docs_post is distinct from v_docs_pre then
    raise exception '0085 canary: שורה בטבלת documents השתנתה';
  end if;

  select md5(string_agg(t.x, '|' order by t.x)) into v_rest_post
    from (select to_jsonb(i)::text as x from public.invoices i where i.id <> v_inv) t;
  if v_rest_post is distinct from v_rest_pre then
    raise exception '0085 canary: שורת invoices אחרת השתנתה';
  end if;

  select count(*) into v_inv_post from public.invoices;
  if v_inv_post <> v_inv_pre then
    raise exception '0085 canary: מספר השורות ב-invoices השתנה: % -> %', v_inv_pre, v_inv_post;
  end if;

  -- 3d. ואפס אי-התאמה על פני כל הטבלה, לא רק על השורה הזאת. זו ההוכחה
  --     שהמחלקה כולה נסגרה ולא שמקרה אחד טופל.
  select count(*) into v_bad
    from public.invoices i
    join public.documents d on d.morning_doc_id = i.morning_doc_id
   where i.job_id is distinct from d.job_id;
  if v_bad <> 0 then
    raise exception '0085 canary: נותרו % שורות עם job_id שאינו תואם למסמך', v_bad;
  end if;

  -- =====================================================================
  -- 4. הפנקס — באותו בלוק אטומי, נופל או עובר עם השינוי
  -- =====================================================================
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0085', now(), 'bnaya',
    'שורת invoices של קבלה 60167 עוברת לעבודה הנכונה. שורה אחת, עמודה אחת, שני אירועים, אפס שינוי סכימה ואפס DELETE. הרקע בשלושה תאריכים: ב-26.7.26 בשעה 21:49:05 UTC מנהל החשבונות שייך את 60167 ל-job b3eaafd3 ביד, וזו הייתה טעות כי 60167 הוא בן של חשבונית 40226 ואילו b3eaafd3 נושאת 40240; linkDocumentToJob עשתה את מה שנתבקשה, חתמה את documents.job_id וכתבה שורת invoices חדשה עם אותו job_id ב-reconcile.ts:596 וסימנה את העבודה כשולמה על סמך קבלה שאינה שלה. ב-30.7.26 בשעות 21:14 ו-21:17 UTC בא התיקון הידני, שרשום בפנקס כ-fix-2026-07-31-a וכ-fix-2026-07-31-b, והוא עשה את הדבר הנכון: יצר את job 2c005a1f להקלטת 28.4, הזיז אליה את documents.job_id של 40226 ושל 60167, והחזיר את b3eaafd3 ל-paid שווה לא עם invoice_biz שווה 40240, הכל מתועד באירועים job_created_manual_sql ו-job_receipt_detached_manual_sql ו-job_payment_corrected_manual_sql. מה שהוא פספס הוא טבלת invoices: הוא נגע ב-documents וב-jobs, ושורת b495cdf2 נשארה על b3eaafd3 עד היום, וזו כל השארית וזה כל הקובץ. למה 2c005a1f היא הכתובת הנכונה ולא שיפוט: 60167 נושא parent_doc_numbers שווה 40226, ו-40226 היא invoice_biz של 2c005a1f, והשרשרת במורנינג שלמה ומצביעה על עבודה אחת בלבד, 10227 ואז 40226 ואז 60167; ולעבודה השנייה שרשרת נפרדת ומלאה משלה שאינה נוגעת ב-60167 בשום נקודה, 10239 ואז 40240 ואז 50067 ואז קבלה 80061. אפס שינוי כסף, וזה העיקר: שתי העבודות שולמו באמת ושתיהן מסומנות נכון, ו-jobs אינה נוגעת בכלל, לא paid ולא invoice_biz ולא invoice_tax. 2c005a1f שולמה כי 60167 הוא 320, חשבונית מס וקבלה באחד, שהנפקתו היא הצהרה שהכסף נכנס; b3eaafd3 שולמה כי על 50067 יצאה קבלה 80061 ב-19.7.26. שתי השרשראות סגורות, status אחד ו-ref ריק ו-amountOpened אפס בכל אחד מששת המסמכים. הסימון של b3eaafd3 היום אינו הסימון השגוי של 26.7 אלא סימון אחר לגמרי: ההוא בוטל ב-30.7, והנוכחי נוצר ב-3.8 דרך מסך הכספים אחרי שהכסף על 40240 באמת התקבל. גם documents אינה נוגעת כי job_id של 60167 כבר נכון, ו-md5 על שתי הטבלאות מאמת את שתי הטענות אחרי הכתיבה. מה שזה מתקן בפועל הוא שתי תקלות תצוגה, ולכן הנזק לא נראה עד שחיפשו אותו: finance/page.tsx:62 עושה docs.find על type שווה מס, ול-b3eaafd3 יש היום שתי שורות מס, 50067 שלה ו-60167 הזרה, ו-find מחזיר את הראשונה במערך לא מסודר, כך שקישור ה-PDF במשבצת המס שלה עלול לפתוח את הקבלה של עבודה אחרת בעוד המספר המוצג תקין כי j.invoice_tax גובר ב-finance/page.tsx:81; ול-2c005a1f אין ולו שורת invoices אחת ולכן שתי משבצותיה מציגות מספר בלי שום קישור PDF; ו-jobs/[id]/show-link/route.ts:21 מחזיר את שתי השורות ב-taxDocs בשורה 43, כך שמודל הקישור מציג ל-b3eaafd3 מסמך מס שאינו שלה. אחרי הקובץ יש שורה אחת מסוג מס לכל אחת מהשתיים וכל קישור מצביע על המסמך שלו. זה המקרה היחיד ונמדד ולא הונח: 77 שורות invoices מצטרפות למסמך לפי morning_doc_id, אחת מהן נושאת job_id שונה מ-documents.job_id, אפס בכיוון ההפוך ואפס עם צד ריק אחד; זו שארית של תיקון ידני יחיד ולא תופעה, וקנרי 3d מוודא שאחרי הכתיבה המספר הוא אפס על פני כל הטבלה ולא רק על השורה הזאת. שבע קבוצות בדיקה לפני שורת הפנקס: הפנקס מכיל 0084 ואינו מכיל 0085; השורה קיימת ובמצב שנמדד על הכתובת השגויה, ו-amount ו-type ו-source נבדקים אף שאינם נכתבים כי שורה שהשתנתה בהם אינה השורה שהתחקיר תיאר; המסמך נושא את הכתובת הנכונה ואותו morning_doc_id כמו השורה ואותו לקוח ואינו מבוטל ואינו מאורכב, וזו הבדיקה שמכשירה את ההעברה כי בלי זהות המסמך ההעברה היא ניחוש ולא יישור; שתי העבודות קיימות ושייכות לאותו לקוח כמו השורה, שכן העברה בין לקוחות הייתה משנה למי הכסף שייך; ויש בדיוק אי-התאמה אחת בטבלה כולה לפני הכתיבה, כי אילו היו יותר הקובץ היה מתקן אחת ומשאיר את השאר בלי שאיש יידע. ואחרי הכתיבה: בדיוק שורה אחת עודכנה ובדיוק שני אירועים עם via שווה 0085_fix נכתבו; הערך נקרא חזרה מהטבלה ונבדק מול המסמך ולא מול הקבוע; יש בדיוק שורת מס אחת לכל אחת משתי העבודות, וזו הבדיקה שמכסה את docs.find ואת taxDocs ששניהם שברו על שתי שורות אצל אחת ואפס אצל השנייה; md5 על כל jobs ועל כל documents זהה לפני ואחרי; md5 על כל שורות invoices מלבד זו זהה ומספר השורות בטבלה זהה; ואפס אי-התאמה נותרה על פני כל הטבלה. שני האירועים נכתבים על שתי העבודות ולא על אחת, כי העבודה הנכונה קיבלה שורה והשגויה איבדה אותה ושתי העובדות צריכות להיות ניתנות למציאה מהיומן ולא משחזור; התקדים לצמד הזה הוא job_receipt_detached_manual_sql שנכתב ב-30.7 על הצד שאיבד, ו-actor_id ריק במכוון לפי מוסכמת 0064 ו-0066. 40238 נבדק והוכרע שלא לגעת: זו חשבונית 300 על 2,360 של אותו לקוח שנושאת status שתיים עם amountOpened 2,360 ואינה מקושרת לשום job, והיא הוחלפה ב-40240 על 1,180; שני המסמכים נושאים אותו פירוט ואותו תאריך הקלטה ואותן שעות, ארבע שעות אולפן כפול 250 שהם 1,000 נטו, אין יתרה לחיוב, המסמך סגור במורנינג ואינו נספר בשום מקום במערכת. הרשאות מוצהרות לפי כלל 49: הקובץ אינו יוצר שום אובייקט נושא-ACL, לא טבלה ולא עמודה ולא טיפוס ולא policy ולא אינדקס ולא view, ואינו מחליף שום פונקציה; הוא כותב ערך לעמודה קיימת בשורה אחת ומוסיף שתי שורות ל-events, ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות. החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: invoices כבר מוגנת ב-RLS דרך invoices_view עם can_view_money ו-invoices_update עם can_edit_money ואף אחת מהן לא נגעה, והקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה וזה המצב הקיים ולא דבר שהוא יוצר. מחוץ להיקף במכוון: 40238 כאמור; הענף existingInv ב-reconcile.ts:588, שהוא המבנה שיצר את הבאג המקורי ושהיום אינו ניתן להשגה מאחורי שער 1 של linkPreflight, וקיבל בקומיט הזה הערה בלבד בלי שינוי לוגיקה; ו-123 שורות הזרע שנותרו בנטו אחרי 0083 ו-0084.');

  -- =====================================================================
  -- 5. NOTICE — מה שהבעלים מדביק בחזרה
  -- =====================================================================
  raise notice '0085 הועברה : שורת invoices % (מסמך %) מ-% ל-%', v_inv, v_num, v_from, v_to;
  raise notice '0085 יומן   : % אירועי invoice_row_reassigned (אחד לכל צד)', v_events;
  raise notice '0085 שורות מס: העבודה הנכונה % · העבודה השגויה % (1 ו-1 = תקין)', v_mas_to, v_mas_from;
  raise notice '0085 invoices: % שורות לפני, % אחרי (אפס שורה נוצרה או נמחקה)', v_inv_pre, v_inv_post;
  raise notice '0085 jobs/documents: md5 זהה לפני ואחרי — אפס כסף זז, אפס שיוך מסמך זז';
  raise notice '0085 אי-התאמות invoices מול documents שנותרו: % (0 = המחלקה נסגרה)', v_bad;
  raise notice '0085 הוחלה ונרשמה.';

end $mig$;
