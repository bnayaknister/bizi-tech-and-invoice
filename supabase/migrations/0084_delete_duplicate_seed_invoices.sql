-- 0084 — מחיקת שתי שורות הזרע הכפולות ב-invoices
--
-- מה זה ולמה. שתי שורות זרע מתארות חיוב שכבר יש לו שורת רישום אמיתית: אותו
-- מסמך, אותו לקוח, פעמיים בטבלה, בשני סכומים שונים. זו בדיוק הפתולוגיה
-- ש-linkPreflight נבנה למנוע — reconcile.ts:398-400 מתאר אותה במילים, 295
-- לצד 250 עבור חשבונית אחת של 295 — והיא כבר קרתה, פעמיים, לפני שהשער היה
-- קיים. הקובץ הזה מוחק את שתי שורות הזרע ומשאיר את שורות ה-morning_api.
--
-- ═══ איך זה קרה, לפי היומן ═══
-- שני המסמכים שויכו ביד על ידי אותו מנהל חשבונות, לפני 0e6b3ca:
--   60167  שויך 26.7.26 בשעה 21:49:04 UTC  (auto=false, moved_state unpaid→closed)
--   40266  שויך 11.8.26 בשעה 07:59:47 UTC  (auto=false, moved_state linked)
-- בכל אחד מהם linkDocumentToJob כתב שורת invoices חדשה ב-source=morning_api,
-- כי ה-dedupe שלו (reconcile.ts:589) מחפש לפי morning_doc_id בלבד ושורת הזרע
-- נושאת מפתח סינתטי — biz-40266.0 ו-tax-60167.0 — שאינו דומה ל-uuid בשום
-- צורה. המפתחות באמת שונים, ולכן גם invoices_morning_doc_id_key לא ירה.
-- התוצאה: שתי שורות לאותו חיוב, אחת בנטו ואחת בברוטו.
--   tax-60167.0  1,000 נטו   לצד  60167  1,180 ברוטו
--   biz-40266.0  2,400 נטו   לצד  40266  2,832 ברוטו
--
-- ═══ למה מחיקה, ולמה היא בטוחה ═══
-- אלה אינן מועמדות לאימוץ כמו 29 השורות של 0083. שם שורת הזרע הייתה הרישום
-- היחיד של החיוב ולכן אימוץ שימר אותה; כאן הרישום כבר קיים, מלא יותר ונכון
-- יותר — הוא נושא את ה-uuid, את הברוטו, את ה-PDF ואת ה-job — ושורת הזרע היא
-- עודף. אימוץ כאן היה נופל ממילא על invoices_morning_doc_id_key, כי ה-uuid
-- כבר תפוס.
--
-- ⚠️ ואף קורא לא בחר את שתי השורות האלה מעולם. job_id שלהן ריק, ולכן
-- finance/page.tsx:41 עשה עליהן continue ו-jobs/[id]/show-link סינן אותן
-- ב-eq(job_id). היחידים שראו אותן הם שער 1 של linkPreflight ו-alerts.ts,
-- שסופר date_is_estimated — ושתיהן false. כלומר המחיקה אינה מסירה דבר מאף
-- מסך; היא מסירה ספירה כפולה משורת ארכיון שאיש לא הציג.
--
-- ═══ מה לא נגע ═══
-- שתי שורות ה-morning_api נשארות בדיוק כפי שהן, ו-md5 עליהן מוודא זאת. גם
-- documents ו-jobs אינן נוגעות בכלל: ה-job כבר נושא את מספר המסמך, המסמך כבר
-- נושא את ה-job, והמחיקה אינה משנה זאת.
--
-- ⚠️ נמצא בדרך ולא מטופל כאן, כי זה תיקון אחר: שורת ה-morning_api של 60167
-- (b495cdf2) נושאת job_id = b3eaafd3, בעוד המסמך עצמו נושא job_id = 2c005a1f.
-- שתי העבודות של אותו לקוח ושתיהן 1,000, אבל b3eaafd3 כבר נשאה
-- invoice_tax=50067 בזמן השיוך ולכן ה-patch דילג עליה בשקט — בדיוק החור השני
-- ש-linkPreflight סוגר היום בשער 2 (reconcile.ts:498-513). הקובץ הזה אינו
-- נוגע בזה: הוא מוחק את הכפילות, והשיוך השגוי הוא הכרעה נפרדת של הבעלים.
-- 40266 אינו סובל מזה — שם השורה והמסמך מצביעים על אותה עבודה.
--
-- ═══ PERMISSIONS — STATED, NOT ASSUMED (rule 49) ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא מוחק שתי שורות
-- מטבלה קיימת. אין כאן GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות.
-- invoices מוגנת ב-RLS דרך invoices_view ו-invoices_update, ואף אחת מהן לא
-- נגעה; הקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה, וזה המצב הקיים.
--
-- ZERO schema change. שתי שורות נמחקות, אפס שורה נוצרת, אפס שורה מתעדכנת.

do $mig$
declare
  -- שתי שורות הזרע שנמחקות, ומולן השורה האמיתית של אותו מסמך.
  v_seed_60167 constant uuid := 'ffed9824-7411-48f9-8353-5ee226081542';  -- tax-60167.0  1,000
  v_seed_40266 constant uuid := 'df671d38-62ea-460c-bb21-0b2e809116e7';  -- biz-40266.0  2,400
  v_real_60167 constant uuid := 'b495cdf2-b03c-4f60-b8a1-05bbec560070';  -- 60167  1,180  morning_api
  v_real_40266 constant uuid := '98dd8430-4392-46b4-af91-8ceea3e06d87';  -- 40266  2,832  morning_api

  v_seeds constant uuid[] := array[v_seed_60167, v_seed_40266];
  v_reals constant uuid[] := array[v_real_60167, v_real_40266];

  v_bad        int;
  v_deleted    int;
  v_inv_pre    int;  v_inv_post    int;
  v_real_pre   text; v_real_post   text;
  v_jobs_pre   text; v_jobs_post   text;
  v_docs_pre   text; v_docs_post   text;
begin
  -- =====================================================================
  -- 0. GUARDS
  -- =====================================================================

  -- 0a. הפנקס הוא הרצף. 0083 חייבת להיות שם: שתי הכפילויות התגלו באותו תחקיר
  --     שהגדיר את 29, והמחיקה נשענת על אותה מדידה.
  if exists (select 1 from public.schema_ledger where version = '0084') then
    raise exception '0084 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0083') then
    raise exception '0084: 0083 אינה בפנקס — המחיקה נשענת על אותה מדידה ואינה יכולה להקדים אותה';
  end if;

  -- 0b. שתי שורות הזרע קיימות ובמצב שנמדד: manual, job_id ריק, והמפתח
  --     הסינתטי שלהן. and source/job_id חוזרים גם בפרדיקט של ה-DELETE.
  select count(*) into v_bad
    from unnest(v_seeds, array['tax-60167.0', 'biz-40266.0']) as s(sid, skey)
   where not exists (
     select 1 from public.invoices i
      where i.id = s.sid
        and i.source = 'manual'
        and i.job_id is null
        and i.morning_doc_id = s.skey
        and i.doc_number = s.skey);
  if v_bad <> 0 then
    raise exception '0084: % משתי שורות הזרע אינן במצב שנמדד', v_bad;
  end if;

  -- 0c. ⚠️ הבדיקה שמכשירה את המחיקה. לכל אחת מהשתיים קיימת השורה האמיתית,
  --     עם job_id מלא, אותו client_id ואותו מספר מסמך. בלי שלושת אלה המחיקה
  --     אינה הסרת כפילות אלא מחיקת הרישום היחיד.
  select count(*) into v_bad
    from unnest(v_seeds, v_reals, array['60167', '40266']) as s(sid, rid, num)
   where not exists (
     select 1
       from public.invoices seed, public.invoices real
      where seed.id = s.sid
        and real.id = s.rid
        and real.job_id is not null
        and real.source = 'morning_api'
        and real.client_id = seed.client_id
        and real.doc_number = s.num
        -- הסוגריים אינם קוסמטיים: AND נקשר חזק מ-OR, ובלעדיהם הענף השני
        -- לבדו היה מספיק כדי להעביר את הבדיקה ולעקוף את כל התנאים שמעליו.
        and (seed.morning_doc_id = 'biz-' || s.num || '.0'
          or seed.morning_doc_id = 'tax-' || s.num || '.0'));
  if v_bad <> 0 then
    raise exception '0084: ל-% מהשתיים אין שורה אמיתית עם job_id, אותו לקוח ואותו מספר', v_bad;
  end if;

  -- 0d. ואותו מספר מסמך באמת מצביע על אותו מסמך: המפתח הסינתטי של שורת הזרע
  --     נגזר ממספר שהשורה האמיתית נושאת, ולשורה האמיתית יש uuid של מסמך קיים.
  select count(*) into v_bad
    from unnest(v_reals, array['60167', '40266']) as s(rid, num)
   where not exists (
     select 1 from public.invoices real
       join public.documents d on d.morning_doc_id = real.morning_doc_id
      where real.id = s.rid
        and d.morning_doc_number = s.num
        and d.cancelled_at is null
        and d.archived_at is null);
  if v_bad <> 0 then
    raise exception '0084: ל-% מהשורות האמיתיות אין מסמך חי תואם', v_bad;
  end if;

  -- 0e. ואף אחת משתי שורות הזרע אינה אחת מ-29 של 0083. חפיפה כאן פירושה
  --     שהמדידה נעשתה על מסד אחר — 0083 אימצה שורה ש-0084 עומדת למחוק.
  if exists (
    select 1 from public.invoices i
     where i.id = any(v_seeds) and (i.job_id is not null or i.source = 'morning_api')) then
    raise exception '0084: שורת זרע שעומדת להימחק כבר אומצה — חפיפה עם 0083';
  end if;

  -- =====================================================================
  -- 1. SNAPSHOT
  -- =====================================================================
  select count(*) into v_inv_pre from public.invoices;

  select md5(string_agg(t.x, '|' order by t.x)) into v_real_pre
    from (select to_jsonb(i)::text as x from public.invoices i where i.id = any(v_reals)) t;

  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_pre
    from (select to_jsonb(j)::text as x from public.jobs j) t;

  select md5(string_agg(t.x, '|' order by t.x)) into v_docs_pre
    from (select to_jsonb(d)::text as x from public.documents d) t;

  -- =====================================================================
  -- 2. THE WRITE. הפרדיקט הוא ההגנה: source=manual ו-job_id ריק חוזרים כאן
  --    ולא רק בשומר, כך ששורה שאומצה או שויכה בין השומר למחיקה פשוט לא
  --    תימחק, וספירת השורות תתפוס זאת ותפיל את הקובץ.
  -- =====================================================================
  with del as (
    delete from public.invoices i
     where i.id = any(v_seeds)
       and i.source = 'manual'
       and i.job_id is null
    returning 1
  ) select count(*) into v_deleted from del;

  -- =====================================================================
  -- 3. CANARY
  -- =====================================================================
  if v_deleted <> 2 then
    raise exception '0084 canary: נמחקו % שורות במקום 2', v_deleted;
  end if;

  -- 3a. שתיהן באמת אינן שם, נקרא חזרה ולא מונח מספירת המחיקה.
  if exists (select 1 from public.invoices where id = any(v_seeds)) then
    raise exception '0084 canary: שורת זרע עדיין קיימת אחרי המחיקה';
  end if;

  -- 3b. ⚠️ שתי השורות האמיתיות עדיין שם ולא השתנו. זו הטענה הנושאת: הקובץ
  --     הסיר עודף ולא רישום.
  select md5(string_agg(t.x, '|' order by t.x)) into v_real_post
    from (select to_jsonb(i)::text as x from public.invoices i where i.id = any(v_reals)) t;
  if v_real_post is null or v_real_post is distinct from v_real_pre then
    raise exception '0084 canary: שורת morning_api נמחקה או השתנתה';
  end if;
  if (select count(*) from public.invoices where id = any(v_reals)) <> 2 then
    raise exception '0084 canary: שתי השורות האמיתיות אינן שתיים';
  end if;

  -- 3c. הטבלה ירדה בדיוק בשתיים — לא שלוש, ולא שתיים ועוד אחת שנוצרה.
  select count(*) into v_inv_post from public.invoices;
  if v_inv_post <> v_inv_pre - 2 then
    raise exception '0084 canary: מספר השורות ב-invoices עבר מ-% ל-% במקום לרדת בשתיים', v_inv_pre, v_inv_post;
  end if;

  -- 3d. אפס נזק צדדי בשתי הטבלאות שהמחיקה נוגעת בהן דרך מפתח זר.
  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_post
    from (select to_jsonb(j)::text as x from public.jobs j) t;
  if v_jobs_post is distinct from v_jobs_pre then
    raise exception '0084 canary: שורה בטבלת jobs השתנתה';
  end if;

  select md5(string_agg(t.x, '|' order by t.x)) into v_docs_post
    from (select to_jsonb(d)::text as x from public.documents d) t;
  if v_docs_post is distinct from v_docs_pre then
    raise exception '0084 canary: שורה בטבלת documents השתנתה';
  end if;

  -- =====================================================================
  -- 4. הפנקס
  -- =====================================================================
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0084', now(), 'bnaya',
    'מחיקת שתי שורות הזרע הכפולות ב-invoices. שתי שורות נמחקות, אפס שורה נוצרת, אפס שורה מתעדכנת, אפס שינוי סכימה. הרקע: שתי שורות זרע מתארות חיוב שכבר יש לו שורת רישום אמיתית — אותו מסמך, אותו לקוח, פעמיים בטבלה ובשני סכומים שונים. זו בדיוק הפתולוגיה ש-linkPreflight נבנה למנוע ושהערת reconcile.ts:398-400 מתארת במילים, 295 לצד 250 עבור חשבונית אחת של 295, והיא כבר קרתה פעמיים לפני שהשער היה קיים. איך זה קרה לפי היומן: שני המסמכים שויכו ביד על ידי אותו מנהל חשבונות לפני 0e6b3ca — 60167 שויך 26.7.26 בשעה 21:49:04 UTC עם auto שווה false ו-moved_state שווה unpaid סגור, ו-40266 שויך 11.8.26 בשעה 07:59:47 UTC עם auto שווה false ו-moved_state שווה linked. בכל אחד מהם linkDocumentToJob כתב שורת invoices חדשה ב-source שווה morning_api, כי ה-dedupe שלו ב-reconcile.ts:589 מחפש לפי morning_doc_id בלבד ושורת הזרע נושאת מפתח סינתטי, biz-40266.0 ו-tax-60167.0, שאינו דומה ל-uuid בשום צורה; המפתחות באמת שונים ולכן גם האילוץ invoices_morning_doc_id_key לא ירה. התוצאה היא שתי שורות לאותו חיוב, אחת בנטו ואחת בברוטו: tax-60167.0 על 1,000 נטו לצד 60167 על 1,180 ברוטו, ו-biz-40266.0 על 2,400 נטו לצד 40266 על 2,832 ברוטו. למה מחיקה ולא אימוץ כמו ב-0083: שם שורת הזרע הייתה הרישום היחיד של החיוב ולכן אימוץ שימר אותה, וכאן הרישום כבר קיים ומלא יותר ונכון יותר — הוא נושא את ה-uuid ואת הברוטו ואת ה-PDF ואת ה-job — ושורת הזרע היא עודף; אימוץ כאן היה נופל ממילא על invoices_morning_doc_id_key כי ה-uuid כבר תפוס. למה המחיקה בטוחה: אף קורא לא בחר את שתי השורות האלה מעולם, כי job_id שלהן ריק ולכן finance/page.tsx:41 עשה עליהן continue ו-jobs/[id]/show-link סינן אותן ב-eq על job_id; היחידים שראו אותן הם שער 1 של linkPreflight, ו-alerts.ts שסופר date_is_estimated ובשתיהן הוא false. כלומר המחיקה אינה מסירה דבר מאף מסך, היא מסירה ספירה כפולה משורת ארכיון שאיש לא הציג. שתי שורות ה-morning_api נשארות בדיוק כפי שהן ו-md5 עליהן מוודא זאת, וגם documents ו-jobs אינן נוגעות בכלל כי ה-job כבר נושא את מספר המסמך והמסמך כבר נושא את ה-job. נמצא בדרך ואינו מטופל כאן כי זה תיקון אחר: שורת ה-morning_api של 60167, שמזהה b495cdf2, נושאת job_id שווה b3eaafd3 בעוד המסמך עצמו נושא job_id שווה 2c005a1f; שתי העבודות של אותו לקוח ושתיהן על 1,000, אבל b3eaafd3 כבר נשאה invoice_tax שווה 50067 בזמן השיוך ולכן ה-patch דילג עליה בשקט, וזה בדיוק החור השני ש-linkPreflight סוגר היום בשער 2 ב-reconcile.ts:498-513. הקובץ אינו נוגע בזה: הוא מוחק את הכפילות, והשיוך השגוי הוא הכרעה נפרדת של הבעלים; 40266 אינו סובל מזה כי שם השורה והמסמך מצביעים על אותה עבודה. חמש קבוצות בדיקה לפני שורת הפנקס: הפנקס מכיל 0083 ואינו מכיל 0084, כי שתי הכפילויות התגלו באותו תחקיר שהגדיר את 29 והמחיקה נשענת על אותה מדידה; שתי שורות הזרע קיימות ובמצב שנמדד, source ו-job_id ריק והמפתח הסינתטי ושוויון doc_number למפתח; לכל אחת קיימת השורה האמיתית עם job_id מלא ו-source שווה morning_api ואותו client_id ואותו מספר מסמך, וזו הבדיקה שמכשירה את המחיקה כי בלעדיה המחיקה אינה הסרת כפילות אלא מחיקת הרישום היחיד; לשורה האמיתית יש מסמך חי תואם שאינו מבוטל ואינו מאורכב; ואף אחת משתי שורות הזרע אינה אחת מ-29 של 0083, כי חפיפה כאן פירושה שהמדידה נעשתה על מסד אחר. ואחרי הכתיבה: בדיוק 2 נמחקו, שתיהן באמת אינן שם כשקוראים חזרה ולא מונח מספירת המחיקה, md5 על שתי השורות האמיתיות זהה לפני ואחרי ושתיהן עדיין שתיים, מספר השורות בטבלה ירד בדיוק בשתיים ולא בשלוש ולא בשתיים ועוד אחת שנוצרה, ו-md5 על כל jobs ועל כל documents זהה לפני ואחרי. הרשאות מוצהרות לפי כלל 49: הקובץ אינו יוצר שום אובייקט נושא-ACL, לא טבלה ולא עמודה ולא טיפוס ולא policy ולא אינדקס ולא view, ואינו מחליף שום פונקציה; הוא מוחק שתי שורות מטבלה קיימת ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות. invoices מוגנת ב-RLS דרך invoices_view ו-invoices_update ואף אחת מהן לא נגעה, והקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה וזה המצב הקיים ולא דבר שהוא יוצר. מחוץ להיקף במכוון: השיוך השגוי של b495cdf2 לעבודה b3eaafd3; 125 שורות הזרע שנותרות בנטו אחרי 0083; ושתי שורות הזרע שאינן מותאמות לשום מסמך.');

  -- =====================================================================
  -- 5. NOTICE
  -- =====================================================================
  raise notice '0084 נמחקו : % שורות זרע כפולות (tax-60167.0 · biz-40266.0)', v_deleted;
  raise notice '0084 invoices: % שורות לפני, % אחרי (ירידה של %)', v_inv_pre, v_inv_post, v_inv_pre - v_inv_post;
  raise notice '0084 נשמרו  : 60167 (1,180) ו-40266 (2,832) — md5 זהה לפני ואחרי';
  raise notice '0084 jobs/documents: md5 זהה לפני ואחרי — אפס עמודה זזה';
  raise notice '0084 פתוח   : b495cdf2 עדיין מצביע על b3eaafd3 ולא על 2c005a1f — הכרעה נפרדת';
  raise notice '0084 הוחלה ונרשמה.';

end $mig$;
