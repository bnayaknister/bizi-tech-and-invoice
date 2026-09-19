-- ============================================================================
-- 0092 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה המיגרציה עושה: מאמצת שורת זרע אחת ב-invoices — `biz-40261.0` — להיות
-- הרישום של מסמך 40261, ומצמידה את המסמך ל-job שכבר נושא את מספרו. בדיוק
-- מתווה 0083, על שורה אחת, בלי לגעת ב-jobs.
--
-- ═══ למה 0083 דילגה עליה ═══
-- הפרדיקט של 0083 דרש **אותו לקוח למסמך ול-job**. ל-40261 יש `client_id` ריק
-- (מזהה המורנינג `fcf1e261` יתום — זה F10), ולכן הוא נפל מהפרדיקט ונשאר חסום
-- בשער 1 של linkPreflight. אין דרך להגיע אליו משום מסך: הרג'יסטרי יסרב בשער,
-- ומנוע ההצעות לא יציע כי ה-job כבר `closed` ו-jobNeedsDocType דוחה אותו.
--
-- ═══ למה ההתאמה ודאית — ארבע ראיות בלתי תלויות ═══
--   1. ה-job `f3cf9a5b` **כבר נושא** `invoice_biz = '40261'`.
--   2. האח-התאום 60181 (`parent_doc_numbers = ['40261']`) כבר שויך לאותו job
--      ב-16.9, ויש לו שורת invoices תקינה. 40261 הוא החצי שנשאר.
--   3. סכום: ₪2,400 נטו × 1.18 = ₪2,832 ברוטו. ✅
--   4. שרשרת רצופה: 10260 → 40261 → 60181.
--
-- ═══ מה הקובץ מכוון לא לעשות ═══
-- 🔴 **אפס כתיבה ל-`jobs`.** `invoice_biz` כבר '40261' ו-`paid` כבר 'כן', כלומר
-- ה-jobPatch של linkDocumentToJob היה ריק ממילא. מבחן 4 נועל את זה עם md5 על
-- **כל** הטבלה.
-- 🔴 **הקובץ מקובע ל-40261 ואינו פרדיקט כללי.** יש מסמך שני שעונה על אותה
-- צורה — **40215** (גל אורן לרנר, ₪944, job `75f3140e`) — והוא **מוחרג
-- במכוון**: לקוח המסמך הוא `גל אורן לרנר` ולקוח ה-job הוא `גל אורן`, שתי שורות
-- נפרדות ב-`clients` לאותו גוף. זו משפחת F10 מהצד השני (כפילות לקוח ולא
-- כפילות מזהה), והיא הכרעה שאיש טרם קיבל. מבחן 9 מוודא ש-40215 **לא זז**.
-- שלושה נוספים — 40275, 60132, 40217 — נושאים **יותר מ-job אחד** ולכן אינם
-- חד-משמעיים כלל.
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API.
-- הצלחה נראית כך:  ✅ 0092 DRY RUN OK — ...   (בתוך הודעת שגיאה)
-- כישלון נראית כך: ❌ ...
--
-- ⚠️ auth.uid() הוא null דרך Management API, ולכן actor_id ייצא null. צפוי.
-- ============================================================================
do $dry$
declare
  c_doc      constant uuid := '4bcc6f53-855a-435e-ab21-da7afd6761a5'; -- מסמך 40261
  c_job      constant uuid := 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a'; -- דה פקטו · חבילת רילז *8
  c_seed     constant uuid := 'e0dafaf8-3fa8-4f17-80bf-b559704d2bad'; -- invoices: biz-40261.0
  c_client   constant uuid := '261c0445-c013-4f87-9dc6-e82f8c7e9c30'; -- דה פקטו
  c_mid      constant text := '89ef494e-d3f1-4c55-a990-3049cf1dd2d4'; -- uuid המורנינג האמיתי
  c_other    constant text := '40215';                                -- המוחרג במכוון

  v_jobs_before text; v_jobs_after text;
  v_inv_before  text; v_inv_after  text;
  v_n int; v_txt text; v_amt numeric; v_dt date; v_uuid uuid;
  v_pdf text; v_docpdf text;
  v_other_job uuid; v_other_job_after uuid;
  v_fail text := ''; v_rep text := '';
begin
  -- ══ 0. מצב הפתיחה — אם אחד מאלה אינו כפי שנמדד, לא ממשיכים בכלל ═════════
  select count(*) into v_n from public.documents
   where id=c_doc and morning_doc_number='40261' and type=300 and amount=2832
     and document_date=date '2026-06-22' and job_id is null and client_id is null
     and cancelled_at is null and archived_at is null
     and (bundle_job_ids is null or cardinality(bundle_job_ids)=0)
     and morning_doc_id=c_mid;
  if v_n <> 1 then
    raise exception '❌ 0092 DRY RUN: המסמך אינו במצב שנמדד (40261, 300, ₪2832, 22.06, job/client ריקים).';
  end if;

  -- job יחיד בכל המסד נושא את המספר, והוא הנכון, והוא נושא אותו ב-invoice_biz
  select count(*) into v_n from public.jobs where invoice_biz='40261' or invoice_tax='40261';
  if v_n <> 1 then
    raise exception '❌ 0092 DRY RUN: % jobs נושאים את 40261, ציפיתי לאחד.', v_n;
  end if;
  select count(*) into v_n from public.jobs
   where id=c_job and invoice_biz='40261' and invoice_tax='60181' and paid='כן' and client_id=c_client;
  if v_n <> 1 then
    raise exception '❌ 0092 DRY RUN: ה-job אינו במצב שנמדד (biz=40261, tax=60181, paid=כן, דה פקטו).';
  end if;

  -- שורת זרע יחידה, והיא הנכונה
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40261.0','tax-40261.0') or doc_number in ('biz-40261.0','tax-40261.0');
  if v_n <> 1 then
    raise exception '❌ 0092 DRY RUN: % שורות זרע ל-40261, ציפיתי לאחת.', v_n;
  end if;
  select count(*) into v_n from public.invoices
   where id=c_seed and morning_doc_id='biz-40261.0' and source='manual' and job_id is null
     and amount=2400 and client_id=c_client;
  if v_n <> 1 then
    raise exception '❌ 0092 DRY RUN: שורת הזרע אינה במצב שנמדד (biz-40261.0, manual, job ריק, ₪2400).';
  end if;

  -- ואין כבר שורה על ה-uuid האמיתי — אחרת האימוץ יוצר כפילות במקום למנוע אותה
  select count(*) into v_n from public.invoices where morning_doc_id=c_mid;
  if v_n <> 0 then
    raise exception '❌ 0092 DRY RUN: כבר קיימת שורת invoices על ה-uuid האמיתי — אימוץ ייצור כפילות.';
  end if;

  v_rep := v_rep || 'מצב פתיחה — מסמך, job ושורת זרע יחידה, כולם כפי שנמדדו. | ';

  -- ══ 1. טביעות אצבע לפני ═══════════════════════════════════════════════════
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-'), ',' order by j.id),''))
    into v_jobs_before from public.jobs j;

  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text,
                                 ',' order by i.id),''))
    into v_inv_before from public.invoices i where i.id <> c_seed;

  select job_id into v_other_job from public.documents where morning_doc_number=c_other;

  -- ══ 2. המעשה — בדיוק מה שהמיגרציה תכתוב ═══════════════════════════════════
  select pdf_url into v_docpdf from public.documents where id=c_doc;

  update public.invoices i
     set job_id            = c_job,
         morning_doc_id    = d.morning_doc_id,
         doc_number        = d.morning_doc_number,
         type              = 'עסקה',
         amount            = d.amount,
         source            = 'morning_api',
         issued_at         = d.document_date,
         pdf_url           = d.pdf_url,
         date_is_estimated = false
    from public.documents d
   where i.id = c_seed and d.id = c_doc;

  update public.documents
     set job_id     = c_job,
         client_id  = coalesce(client_id, c_client),
         updated_at = now()
   where id = c_doc;

  -- ══ 3. מבחן 1 — שורת הזרע אומצה, כל שדה ושדה ══════════════════════════════
  select count(*) into v_n from public.invoices
   where id=c_seed and job_id=c_job and morning_doc_id=c_mid and doc_number='40261'
     and type='עסקה' and amount=2832 and source='morning_api'
     and issued_at=timestamptz '2026-06-22 00:00:00+00' and date_is_estimated=false
     and client_id=c_client;
  if v_n <> 1 then
    select 'job='||coalesce(job_id::text,'-')||' mid='||coalesce(morning_doc_id,'-')||' num='||coalesce(doc_number,'-')||
           ' amt='||amount::text||' src='||source::text||' at='||issued_at::text
      into v_txt from public.invoices where id=c_seed;
    v_fail := v_fail || format('מבחן 1: שורת הזרע לא אומצה כנדרש — %s. ', v_txt);
  else
    v_rep := v_rep || 'מבחן 1 — שורת הזרע אומצה: job, uuid אמיתי, 40261, ₪2832 ברוטו, morning_api. | ';
  end if;

  select pdf_url into v_pdf from public.invoices where id=c_seed;
  if v_pdf is distinct from v_docpdf then
    v_fail := v_fail || 'מבחן 1ב: ה-PDF לא הועתק מהמסמך. ';
  else
    v_rep := v_rep || 'מבחן 1ב — ה-PDF הועתק מהמסמך. | ';
  end if;

  -- ══ 4. מבחן 2 — המסמך הוצמד, וקיבל את לקוח ה-job ══════════════════════════
  select count(*) into v_n from public.documents where id=c_doc and job_id=c_job and client_id=c_client;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 2: המסמך לא הוצמד ל-job או לא קיבל את הלקוח. ';
  else
    v_rep := v_rep || 'מבחן 2 — המסמך הוצמד ל-f3cf9a5b וקיבל client_id של דה פקטו. | ';
  end if;

  -- ══ 5. מבחן 3 — אין כפילות: שורה אחת בלבד על ה-job, מסוג עסקה ════════════
  select count(*) into v_n from public.invoices where job_id=c_job and type='עסקה';
  if v_n <> 1 then
    v_fail := v_fail || format('מבחן 3: %s שורות עסקה על ה-job, ציפיתי לאחת — זו בדיוק הכפילות שהשער מונע. ', v_n);
  else
    v_rep := v_rep || 'מבחן 3 — שורת עסקה אחת בלבד על ה-job (ולצידה 60181 כמס). | ';
  end if;

  -- ══ 6. מבחן 4 — 🔴 jobs לא נגעה. md5 על כל הטבלה. ═════════════════════════
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-'), ',' order by j.id),''))
    into v_jobs_after from public.jobs j;
  if v_jobs_after is distinct from v_jobs_before then
    v_fail := v_fail || 'מבחן 4: טבלת jobs השתנתה! הקובץ אמור לא לגעת בה כלל. ';
  else
    v_rep := v_rep || format('מבחן 4 — jobs זהה בתו (%s). | ', left(v_jobs_after,8));
  end if;

  -- ══ 7. מבחן 5 — שום שורת invoices אחרת לא זזה ═════════════════════════════
  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text,
                                 ',' order by i.id),''))
    into v_inv_after from public.invoices i where i.id <> c_seed;
  if v_inv_after is distinct from v_inv_before then
    v_fail := v_fail || 'מבחן 5: שורת invoices אחרת זזה! ';
  else
    v_rep := v_rep || format('מבחן 5 — שאר invoices זהה (%s). | ', left(v_inv_after,8));
  end if;

  -- ══ 8. מבחן 6 — שער 1 של linkPreflight כבר לא ימצא מפתח סינתטי ═══════════
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40261.0','tax-40261.0') or doc_number in ('biz-40261.0','tax-40261.0');
  if v_n <> 0 then
    v_fail := v_fail || format('מבחן 6: נותרו %s מפתחות סינתטיים ל-40261 — השער עדיין יחסום. ', v_n);
  else
    v_rep := v_rep || 'מבחן 6 — אפס מפתחות סינתטיים ל-40261; שער 1 לא יחסום עוד. | ';
  end if;

  -- ══ 9. מבחן 7 — המסמך כבר לא בלשונית "לא משויך" ══════════════════════════
  select count(*) into v_n from public.documents
   where client_id is null and archived_at is null and cancelled_at is null and type in (300,305,320,400);
  if v_n <> 7 then
    v_fail := v_fail || format('מבחן 7: נותרו %s מסמכי חיוב לא-משויכים, ציפיתי 7 (היו 8). ', v_n);
  else
    v_rep := v_rep || 'מבחן 7 — לשונית "לא משויך" ירדה מ-8 מסמכי חיוב ל-7. | ';
  end if;

  -- ══ 10. מבחן 8 — 40215, המוחרג במכוון, לא זז ═════════════════════════════
  select job_id into v_other_job_after from public.documents where morning_doc_number=c_other;
  if v_other_job_after is distinct from v_other_job then
    v_fail := v_fail || 'מבחן 8: 40215 זז! הוא מוחרג במכוון (לקוח המסמך ולקוח ה-job שונים). ';
  else
    v_rep := v_rep || 'מבחן 8 — 40215 (המוחרג) לא זז. | ';
  end if;

  select count(*) into v_n from public.invoices where morning_doc_id='biz-40215.0' and job_id is null;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 8ב: שורת הזרע של 40215 זזה. ';
  else
    v_rep := v_rep || 'מבחן 8ב — שורת הזרע של 40215 נשארה יתומה, כמתוכנן. | ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception '❌ 0092 DRY RUN FAILED — %', v_fail;
  end if;

  raise exception '✅ 0092 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
