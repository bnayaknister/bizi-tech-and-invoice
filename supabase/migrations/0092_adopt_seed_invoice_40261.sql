-- ============================================================================
-- 0092 — אימוץ שורת הזרע של 40261, והצמדת המסמך ל-job שכבר נושא את מספרו
--
-- ⚠️ להריץ את supabase/verify/0092_dryrun.sql לפני. שם, ולא כאן, נמצאת
--    ההוכחה שההיקף הוא שורה אחת. כלל 50: קובץ אימות אינו יושב בתיקיית
--    המיגרציות.
--
-- מתווה 0083 בדיוק, על שורה אחת. אין כאן שום כלל חדש ושום אריתמטיקה חדשה —
-- הקובץ מאמץ שורת זרע קיימת במקום להוסיף שנייה לצידה, ומצמיד את המסמך.
--
-- ═══ למה 0083 דילגה עליה, וזו כל הסיבה שהקובץ הזה קיים ═══
-- הפרדיקט של 0083 דרש **אותו לקוח למסמך ול-job ולשורת הזרע**. ל-40261 יש
-- `documents.client_id` ריק — מזהה המורנינג שלו, `fcf1e261` (שחף סגינר), אינו
-- נתבע ע"י אף לקוח, וזה **F10**. שלושת האחרים תואמים (דה פקטו), אבל המסמך
-- עצמו ריק, ולכן הוא נפל מהפרדיקט ונשאר חסום בשער 1 של `linkPreflight`.
--
-- ═══ ולמה אי אפשר היה פשוט ללחוץ "שייך" במסך ═══
-- שני הכיוונים חסומים, ובמתכוון:
--   · מהרג'יסטרי — שער 1 (reconcile.ts:620) מוצא את `biz-40261.0` ומסרב.
--   · מהכספים — ה-job כבר `closed` ולא `red`, ו-`jobNeedsDocType`
--     (reconcile.ts:172-179) דוחה אותו, ולכן הוא אינו מועמד לעולם.
-- זה בדיוק מה ש-T6 קבע: "רק מיגרציה ממוקדת תסגור אותם".
--
-- ═══ למה ההתאמה ודאית — ארבע ראיות בלתי תלויות ═══
--   1. ה-job `f3cf9a5b` **כבר נושא** `invoice_biz = '40261'`. המספר הוקלד
--      ידנית בתקופת הגיליון; מה שחסר הוא `documents.job_id`, לא ההחלטה.
--   2. האח-התאום 60181 (320, `parent_doc_numbers = ['40261']`) כבר שויך
--      לאותו job ב-16.9 ויש לו שורת `invoices` תקינה. 40261 הוא החצי שנשאר.
--   3. סכום, בשני כיוונים: ₪2,400 (סכום ה-job, וגם סכום שורת הזרע) × 1.18
--      = ₪2,832 (סכום המסמך). ✅
--   4. שרשרת רצופה: 10260 → 40261 → 60181.
--
-- ═══ מה הקובץ מקובע אליו, ולמה לא פרדיקט כללי ═══
-- 🔴 **הקובץ מקובע ל-40261 בלבד.** פרדיקט כללי בצורת 0083 היה מחזיר **שניים**,
-- והשני אינו ודאי:
--   · **40215** (גל אורן לרנר, 300, ₪944, job `75f3140e`) — עונה על הצורה,
--     אבל **לקוח המסמך הוא `גל אורן לרנר` ולקוח ה-job הוא `גל אורן`**, שתי
--     שורות נפרדות ב-`clients` לאותו גוף. זו משפחת F10 מהצד השני — כפילות
--     **לקוח** ולא כפילות **מזהה** — והיא הכרעה שאיש טרם קיבל. סעיף 3ה מוודא
--     שהוא **לא זז**.
-- ושלושה נוספים נושאים **יותר מ-job אחד** ולכן אינם חד-משמעיים כלל:
-- **40275** (3 jobs), **60132** ו-**40217** (2 כל אחד).
--
-- ═══ מה נכתב, ולמה כל אחד — זהה ל-0083 שדה בשדה ═══
--   job_id            ← ה-job. זו הכתיבה שמכניסה את השורה לתצוגה לראשונה:
--                       finance/page.tsx:41 עושה continue על job_id ריק.
--   morning_doc_id    ← ה-uuid האמיתי במקום המפתח הסינתטי. זה מה שמסיר את
--                       השורה משער 1 ומכניס אותה ל-dedupe של reconcile/issue.
--   doc_number        ← המספר החשוף, '40261'.
--   type              ← 'עסקה' לפי סוג המסמך (300), לא לפי קידומת המפתח.
--   amount            ← documents.amount, כלומר **ברוטו** ₪2,832.
--   source            ← morning_api. 'manual' היה מצייר תג ידני כתום
--                       (FinanceClient.tsx:902) על מסמך שאיש לא הקליד.
--   issued_at         ← documents.document_date (2026-06-22).
--   pdf_url           ← ה-PDF של המסמך; לשורת הזרע אין.
--   date_is_estimated ← false. התאריך מגיע מהמסמך עצמו.
--   issued_by         נשאר ריק — מוסכמת 0064/0066: מיגרציה עשתה זאת, לא אדם.
--   documents.client_id ← לקוח ה-job, ורק אם ריק (`coalesce`), בדיוק כמו
--                       reconcile.ts:571. כאן הוא ריק, וזה מוציא את המסמך
--                       מלשונית "לא משויך".
--
-- ⚠️ **אפס כתיבה ל-`jobs`, וזו מדידה ולא הימנעות.** `invoice_biz` כבר '40261'
--    ו-`paid` כבר 'כן', כלומר `jobPatch` של linkDocumentToJob היה ריק ו-
--    `flippedPaid` כבוי (המסמך הוא 300, לא 320/400). סעיף 3ג מוכיח את זה עם
--    md5 על **כל** הטבלה, לפני ואחרי.
--
-- ⚠️ **העמודה amount נשארת מעורבת**, כפי ש-0083 הצהיר: שורה אחת נוספת עוברת
--    לברוטו ו-124 שורות זרע נותרות בנטו. אף קורא במערכת אינו בוחר את
--    invoices.amount, ולכן שום סכום על שום מסך אינו זז.
--
-- ⚠️ **ה-DELETE בביטול מתחיל לחול על השורה הזו.** cancel/route.ts:66-71 מוחק
--    invoices לפי morning_doc_id, מגודר ב-if (jobId). היום שתי הרגליים סגורות
--    (מפתח סינתטי, job_id ריק); אחרי הקובץ שתיהן נפתחות. זהה ל-29 של 0083
--    ומקובל באותה הכרעת בעלים. נרשם כדי שיהיה ידוע ולא יתגלה.
--
-- ═══ מה הקובץ אינו נוגע בו ═══
-- אפס שינוי סכימה · אפס DELETE · שורת UPDATE אחת ב-invoices ואחת ב-documents ·
-- אפס שורה חדשה מלבד שני האירועים ושורת הפנקס · אפס כתיבה ל-jobs.
-- **שער 1 נשאר כפי שהוא** — זה תיקון נתונים ולא שינוי כלל, וכל שורת זרע
-- שנותרת ממשיכה לחסום, וזה נכון (ראה T21: 111 נותרות אחרי הקובץ הזה).
--
-- ═══ כלל 49 — השפעת ACL, מוצהרת ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא כותב ערכים
-- לעמודות קיימות בשתי טבלאות ומוסיף שורות ל-events. אין GRANT ואין דבר
-- שהרשאותיו יכולות להיוולד שגויות. והחצי השקט, שנאמר בכל זאת: `invoices`
-- מוגנת ב-RLS (`invoices_view` עם can_view_money, `invoices_update` עם
-- can_edit_money) ו-`documents` במדיניות שלה; אף אחת מהן לא נגעה. הקובץ רץ
-- כ-postgres ועוקף RLS כמו כל מיגרציה — מצב קיים, לא דבר שהוא יוצר.
-- ============================================================================

do $mig$
declare
  c_doc    constant uuid := '4bcc6f53-855a-435e-ab21-da7afd6761a5'; -- מסמך 40261
  c_job    constant uuid := 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a'; -- דה פקטו · חבילת רילז *8
  c_seed   constant uuid := 'e0dafaf8-3fa8-4f17-80bf-b559704d2bad'; -- invoices: biz-40261.0
  c_client constant uuid := '261c0445-c013-4f87-9dc6-e82f8c7e9c30'; -- דה פקטו
  c_mid    constant text := '89ef494e-d3f1-4c55-a990-3049cf1dd2d4'; -- uuid המורנינג האמיתי

  v_jobs_before text; v_jobs_after text;
  v_inv_before  text; v_inv_after  text;
  v_rows_before int;  v_rows_after int;
  v_other_job   uuid; v_other_job_after uuid;
  v_n int; v_txt text; v_pdf text; v_docpdf text;
begin
  -- ── 0. הפנקס ────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0092') then
    raise exception '0092 עצרה: הקובץ כבר הוחל.';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0091') then
    raise exception '0092 עצרה: 0091 אינו בפנקס — הקבצים מוחלים לפי הסדר.';
  end if;

  -- ── 1. מצב הפתיחה. כל אחד מאלה נמדד 19.9; אם אחד השתנה, זו כבר לא ───────
  --       אותה עובדה, והקובץ עוצר במקום להחליט מחדש.

  -- 1a. המסמך
  select count(*) into v_n from public.documents
   where id = c_doc and morning_doc_number = '40261' and type = 300 and amount = 2832
     and document_date = date '2026-06-22' and morning_doc_id = c_mid
     and job_id is null and client_id is null
     and cancelled_at is null and archived_at is null
     and (bundle_job_ids is null or cardinality(bundle_job_ids) = 0)
     and pdf_url is not null;
  if v_n <> 1 then
    raise exception '0092 עצרה: המסמך 40261 אינו במצב שנמדד (300, ₪2832, 22.06, job/client ריקים, PDF קיים).';
  end if;

  -- 1b. job יחיד בכל המסד נושא את המספר, והוא הנכון
  select count(*) into v_n from public.jobs where invoice_biz = '40261' or invoice_tax = '40261';
  if v_n <> 1 then
    raise exception '0092 עצרה: % jobs נושאים את 40261, ציפיתי לאחד בדיוק.', v_n;
  end if;
  select count(*) into v_n from public.jobs
   where id = c_job and invoice_biz = '40261' and invoice_tax = '60181'
     and paid = 'כן' and client_id = c_client and dismissed = false;
  if v_n <> 1 then
    raise exception '0092 עצרה: ה-job f3cf9a5b אינו במצב שנמדד (biz=40261, tax=60181, paid=כן, דה פקטו, לא מוסתר).';
  end if;

  -- 1c. שורת זרע יחידה, והיא הנכונה
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40261.0','tax-40261.0') or doc_number in ('biz-40261.0','tax-40261.0');
  if v_n <> 1 then
    raise exception '0092 עצרה: % שורות זרע ל-40261, ציפיתי לאחת בדיוק.', v_n;
  end if;
  select count(*) into v_n from public.invoices
   where id = c_seed and morning_doc_id = 'biz-40261.0' and doc_number = 'biz-40261.0'
     and source = 'manual' and job_id is null and amount = 2400 and client_id = c_client;
  if v_n <> 1 then
    raise exception '0092 עצרה: שורת הזרע אינה במצב שנמדד (biz-40261.0, manual, job ריק, ₪2400, דה פקטו).';
  end if;

  -- 1d. ⚠️ זהות הסכום בשני כיוונים בלתי תלויים — בדיוק הבדיקה של 0083, ומאותה
  --     סיבה: שורה שאומצה לכתובת הלא נכונה היא כסף שנרשם על עבודה זרה.
  select count(*) into v_n from public.documents d
   join public.jobs j on j.id = c_job
   join public.invoices i on i.id = c_seed
   where d.id = c_doc
     and abs(i.amount - d.amount / 1.18) <= 0.01   -- הנטו = הברוטו חלקי מע״מ
     and i.amount = j.amount;                       -- והנטו = סכום העבודה
  if v_n <> 1 then
    raise exception '0092 עצרה: זהות הסכום נכשלה — ₪2400 נטו מול ₪2832 ברוטו מול סכום העבודה.';
  end if;

  -- 1e. אין כבר שורה על ה-uuid האמיתי ולא על המספר החשוף — אחרת ה-UPDATE
  --     היה נופל על invoices_morning_doc_id_key באמצע, או יוצר ספירה כפולה.
  select count(*) into v_n from public.invoices where morning_doc_id = c_mid or doc_number = '40261';
  if v_n <> 0 then
    raise exception '0092 עצרה: כבר קיימת שורת invoices על ה-uuid האמיתי או על 40261 — אימוץ ייצור כפילות.';
  end if;

  -- ── 2. טביעות אצבע לפני ─────────────────────────────────────────────────
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_before from public.jobs j;

  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text,
                                 ',' order by i.id),'')),
         count(*)
    into v_inv_before, v_rows_before from public.invoices i where i.id <> c_seed;

  select job_id into v_other_job from public.documents where morning_doc_number = '40215';
  select pdf_url into v_docpdf   from public.documents where id = c_doc;

  -- ── 3. הכתיבות. שתיים, ואירוע. ──────────────────────────────────────────

  -- 3a. שורת הזרע. ה-type נגזר מסוג המסמך בתוך המשפט עצמו, לא מהקידומת.
  update public.invoices i
     set job_id            = c_job,
         morning_doc_id    = d.morning_doc_id,
         doc_number        = d.morning_doc_number,
         type              = (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type,
         amount            = d.amount,
         source            = 'morning_api',
         issued_at         = d.document_date,
         pdf_url           = d.pdf_url,
         date_is_estimated = false
    from public.documents d
   where i.id = c_seed
     and d.id = c_doc
     and i.source = 'manual'
     and i.job_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0092 עצרה: אומצו % שורות invoices, ציפיתי לאחת.', v_n;
  end if;

  -- 3b. המסמך. client_id נכתב רק אם ריק — כאן הוא ריק, והתנאי קיים כדי
  --     שהמשפט לא ידרוס לקוח קיים. זה בדיוק reconcile.ts:571.
  update public.documents d
     set job_id     = c_job,
         client_id  = coalesce(d.client_id, j.client_id),
         updated_at = now()
    from public.jobs j
   where d.id = c_doc
     and j.id = c_job
     and d.job_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0092 עצרה: עודכנו % שורות documents, ציפיתי לאחת.', v_n;
  end if;

  -- 3c. היומן. אותו מבנה payload כמו document_reconciled ב-reconcile.ts,
  --     עם via=0092_adopt. moved_state הוא linked: jobPatch ריק ו-flippedPaid
  --     כבוי (300 אינו מסמך תשלום). actor_id ריק — מיגרציה עשתה זאת.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  select 'job', c_job, 'document_reconciled', null,
         jsonb_build_object(
           'via',                '0092_adopt',
           'auto',               false,
           'doc_id',             d.id,
           'morning_doc_id',     d.morning_doc_id,
           'morning_doc_number', d.morning_doc_number,
           'doc_type',           d.type,
           'amount',             d.amount,
           'moved_state',        'linked',
           'adopted_invoice_id', c_seed,
           'seed_key',           'biz-40261.0',
           'client_backfilled',  true,
           'reason',             'F10 — מזהה מורנינג fcf1e261 יתום, ולכן 0083 דילגה על השורה')
    from public.documents d where d.id = c_doc;

  -- ── 4. אימות אחרי הכתיבה, לפני שורת הפנקס ───────────────────────────────

  -- 4a. כל שדה שנכתב נקרא חזרה ונבדק מול המקור שממנו נגזר, ולא מונח מספירה.
  select count(*) into v_n from public.invoices i join public.documents d on d.id = c_doc
   where i.id = c_seed and i.job_id = c_job and i.morning_doc_id = d.morning_doc_id
     and i.doc_number = d.morning_doc_number and i.type = 'עסקה' and i.amount = d.amount
     and i.source = 'morning_api' and i.issued_at = d.document_date::timestamptz
     and i.date_is_estimated = false and i.client_id = c_client;
  if v_n <> 1 then
    select 'job='||coalesce(i.job_id::text,'-')||' mid='||coalesce(i.morning_doc_id,'-')||
           ' num='||coalesce(i.doc_number,'-')||' amt='||i.amount::text||' src='||i.source::text||
           ' at='||i.issued_at::text into v_txt from public.invoices i where i.id = c_seed;
    raise exception '0092 עצרה: שורת הזרע לא אומצה כנדרש — %', v_txt;
  end if;

  select i.pdf_url into v_pdf from public.invoices i where i.id = c_seed;
  if v_pdf is distinct from v_docpdf then
    raise exception '0092 עצרה: ה-PDF לא הועתק מהמסמך לשורה.';
  end if;

  -- 4b. המסמך הוצמד וקיבל את לקוח ה-job
  select count(*) into v_n from public.documents where id = c_doc and job_id = c_job and client_id = c_client;
  if v_n <> 1 then
    raise exception '0092 עצרה: המסמך לא הוצמד ל-job או לא קיבל את הלקוח.';
  end if;

  -- 4c. 🔴 הטענה הנושאת: jobs לא נגעה. md5 על כל עמודה של כל שורה.
  --     זו ההפרדה בין "אימוץ רישום" לבין "יצירת כסף".
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_after from public.jobs j;
  if v_jobs_after is distinct from v_jobs_before then
    raise exception '0092 עצרה: טבלת jobs השתנתה! הקובץ אינו אמור לגעת בה כלל.';
  end if;

  -- 4d. שום שורת invoices אחרת לא זזה, ומספר השורות בטבלה זהה
  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text,
                                 ',' order by i.id),'')),
         count(*)
    into v_inv_after, v_rows_after from public.invoices i where i.id <> c_seed;
  if v_inv_after is distinct from v_inv_before or v_rows_after <> v_rows_before then
    raise exception '0092 עצרה: שורת invoices אחרת זזה, או שנוספה/נמחקה שורה (% → %).', v_rows_before, v_rows_after;
  end if;

  -- 4e. ⚠️ 40215, המוחרג במכוון, לא זז — לא המסמך ולא שורת הזרע שלו
  select job_id into v_other_job_after from public.documents where morning_doc_number = '40215';
  if v_other_job_after is distinct from v_other_job then
    raise exception '0092 עצרה: 40215 זז! הוא מוחרג במכוון (לקוח המסמך ולקוח ה-job שונים).';
  end if;
  select count(*) into v_n from public.invoices where morning_doc_id = 'biz-40215.0' and job_id is null;
  if v_n <> 1 then
    raise exception '0092 עצרה: שורת הזרע של 40215 זזה.';
  end if;

  -- 4f. אין כפילות: שורת עסקה אחת בלבד על ה-job, ואפס מפתח morning_doc_id כפול
  select count(*) into v_n from public.invoices where job_id = c_job and type = 'עסקה';
  if v_n <> 1 then
    raise exception '0092 עצרה: % שורות עסקה על ה-job — זו בדיוק הכפילות שהשער מונע.', v_n;
  end if;
  select count(*) into v_n from (
    select morning_doc_id from public.invoices where morning_doc_id is not null
    group by morning_doc_id having count(*) > 1) x;
  if v_n <> 0 then
    raise exception '0092 עצרה: % מפתחות morning_doc_id מופיעים יותר מפעם אחת.', v_n;
  end if;

  -- 4g. המטרה הושגה: שער 1 לא מוצא עוד מפתח סינתטי ל-40261
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40261.0','tax-40261.0') or doc_number in ('biz-40261.0','tax-40261.0');
  if v_n <> 0 then
    raise exception '0092 עצרה: נותרו % מפתחות סינתטיים ל-40261 — השער עדיין יחסום.', v_n;
  end if;

  raise notice '0092: שורת הזרע biz-40261.0 אומצה ל-job f3cf9a5b, המסמך הוצמד וקיבל את דה פקטו. jobs לא נגעה.';
end $mig$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'seed_invoice_adopted', null,
        jsonb_build_object(
          'migration',      '0092',
          'ticket',         'T6',
          'adopted',        1,
          'seed_key',       'biz-40261.0',
          'invoice_id',     'e0dafaf8-3fa8-4f17-80bf-b559704d2bad',
          'document_id',    '4bcc6f53-855a-435e-ab21-da7afd6761a5',
          'doc_number',     '40261',
          'job_id',         'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a',
          'excluded',       jsonb_build_array('40215', '40275', '60132', '40217'),
          'root_cause',     'F10',
          'source',         'investigation 2026-09-19'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0092', now(), 'bnaya',
        'אימוץ שורת הזרע biz-40261.0 והצמדת מסמך 40261 ל-job f3cf9a5b. שורת UPDATE אחת ב-invoices, אחת ב-documents, שני אירועים, אפס שינוי סכימה, אפס DELETE ואפס כתיבה ל-jobs. הרקע: 0083 אימצה 29 שורות זרע, והפרדיקט שלה דרש אותו לקוח למסמך ול-job ולשורת הזרע. ל-40261 יש documents.client_id ריק מפני שמזהה המורנינג שלו fcf1e261, שחף סגינר, אינו נתבע ע"י אף לקוח, וזה F10; שלושת האחרים תואמים דה פקטו אבל המסמך עצמו ריק, ולכן הוא נפל מהפרדיקט ונשאר חסום בשער 1 של linkPreflight. אי אפשר היה להגיע אליו משום מסך ושני הכיוונים חסומים במתכוון: מהרג׳יסטרי שער 1 מוצא את biz-40261.0 ומסרב, ומהכספים ה-job כבר closed ולא red ולכן jobNeedsDocType דוחה אותו ואינו מציע אותו לעולם. זה בדיוק מה ש-T6 קבע, שרק מיגרציה ממוקדת תסגור אותם. ההתאמה ודאית בארבע ראיות בלתי תלויות: ה-job f3cf9a5b כבר נושא invoice_biz שווה 40261, כלומר המספר הוקלד ידנית בתקופת הגיליון ומה שחסר הוא documents.job_id ולא ההחלטה; האח התאום 60181, שהוא 320 ו-parent_doc_numbers שלו הוא 40261, כבר שויך לאותו job ב-16.9 ויש לו שורת invoices תקינה, כך ש-40261 הוא החצי שנשאר; זהות הסכום בשני כיוונים בלתי תלויים, 2400 נטו שהוא גם סכום העבודה וגם סכום שורת הזרע כפול 1.18 שווה 2832 שהוא סכום המסמך; ושרשרת רצופה 10260 ואז 40261 ואז 60181. הקובץ מקובע ל-40261 בלבד ואינו פרדיקט כללי, כי פרדיקט כללי בצורת 0083 היה מחזיר שניים והשני אינו ודאי: 40215, גל אורן לרנר, 300, 944 שקל, job 75f3140e, עונה על הצורה אבל לקוח המסמך הוא גל אורן לרנר ולקוח ה-job הוא גל אורן, שתי שורות נפרדות ב-clients לאותו גוף, וזו משפחת F10 מהצד השני כלומר כפילות לקוח ולא כפילות מזהה, והיא הכרעה שאיש טרם קיבל; שלושה נוספים נושאים יותר מ-job אחד ולכן אינם חד משמעיים כלל, 40275 עם שלושה ו-60132 ו-40217 עם שניים כל אחד. מה שנכתב לשורת הזרע, זהה ל-0083 שדה בשדה: job_id מקבל את העבודה וזו הכתיבה שמכניסה את השורה לתצוגה לראשונה כי finance/page.tsx:41 עושה continue על job_id ריק; morning_doc_id מקבל את ה-uuid האמיתי במקום המפתח הסינתטי וזה מה שמסיר אותה משער 1; doc_number מקבל 40261; type מקבל עסקה לפי סוג המסמך 300 ולא לפי קידומת המפתח; amount מקבל את documents.amount כלומר ברוטו 2832; source מקבל morning_api כי manual היה מצייר תג ידני כתום ב-FinanceClient.tsx:902 על מסמך שאיש לא הקליד; issued_at מקבל את document_date שהוא 22.06.2026; pdf_url מקבל את ה-PDF של המסמך שלשורת הזרע אין; date_is_estimated מקבל false; ו-issued_by נשאר ריק לפי מוסכמת 0064 ו-0066. documents.client_id מקבל את לקוח ה-job ורק אם הוא ריק, בדיוק כמו reconcile.ts:571, וזו הכתיבה שמוציאה את המסמך מלשונית לא משויך. אפס כתיבה ל-jobs וזו מדידה ולא הימנעות: invoice_biz כבר 40261 ו-paid כבר כן, כלומר jobPatch של linkDocumentToJob היה ריק ו-flippedPaid כבוי כי המסמך הוא 300 ולא מסמך תשלום, וסעיף 4ג מוכיח זאת עם md5 על כל עמודה של כל שורה בטבלה לפני ואחרי. שבע קבוצות בדיקה לפני שורת הפנקס: המסמך במצב שנמדד כולל סוג וסכום ותאריך ו-uuid ו-job וריקנות לקוח וביטול וארכוב ו-bundle ו-PDF; job יחיד בכל המסד נושא את המספר והוא הנכון ובמצב שנמדד; שורת זרע יחידה והיא הנכונה ובמצב שנמדד; זהות הסכום בשני כיוונים בלתי תלויים, שכשל בה עוצר את הקובץ כי שורה שאומצה לכתובת הלא נכונה היא כסף שנרשם על עבודה זרה; אין כבר שורת invoices על ה-uuid האמיתי ולא על המספר החשוף, אחרת ה-UPDATE היה נופל על invoices_morning_doc_id_key באמצע; ואחרי הכתיבה כל שדה נקרא חזרה ונבדק מול המקור שממנו נגזר ולא מונח מספירת שורות, md5 על jobs זהה, md5 על כל שאר שורות invoices זהה ומספר השורות זהה, 40215 והשורה שלו לא זזו, שורת עסקה אחת בלבד על ה-job, אפס מפתח morning_doc_id כפול, ואפס מפתח סינתטי שנותר ל-40261 כלומר המטרה הושגה. שער 1 נשאר כפי שהוא ולא נגע, וזה תיקון נתונים ולא שינוי כלל: ההגנה ממשיכה לחול על כל שיוך עתידי וכל שורת זרע שנותרת ממשיכה לחסום, וזה נכון כי היא מקרה שאיש טרם הכריע בו. 111 מסמכי חיוב חיים נותרים במצב הזה אחרי הקובץ, מתוכם 107 שאין להם job כלל, והם מתועדים ב-T21. העמודה amount נשארת מעורבת כפי ש-0083 הצהיר, שורה אחת נוספת עוברת לברוטו ו-124 שורות זרע נותרות בנטו, ואף קורא במערכת אינו בוחר את invoices.amount ולכן שום סכום על שום מסך אינו זז. ה-DELETE בביטול מתחיל לחול על השורה הזו כי cancel/route.ts:66-71 מוחק invoices לפי morning_doc_id מגודר ב-if jobId, והיום שתי הרגליים סגורות בעוד אחרי הקובץ שתיהן נפתחות; זהה ל-29 של 0083 ומקובל באותה הכרעת בעלים, ונרשם כדי שיהיה ידוע ולא יתגלה. כלל 49, ACL מוצהר: הקובץ אינו יוצר שום אובייקט נושא-ACL ואינו מחליף שום פונקציה, הוא כותב ערכים לעמודות קיימות בשתי טבלאות ומוסיף שורות ל-events, ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות; invoices כבר מוגנת ב-RLS דרך invoices_view עם can_view_money ו-invoices_update עם can_edit_money ו-documents דרך המדיניות שלה, ואף אחת מהן לא נגעה, והקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה וזה מצב קיים ולא דבר שהוא יוצר. ההרצה המדומה ב-supabase/verify/0092_dryrun.sql ושאילתת האימות ב-supabase/verify/0092_verify.sql — כלל 50.');
