-- 0087 — סגירת שלושת המסמכים המאוגדים שנמשכו ממורנינג
--
-- מה זה ולמה. `paidNoTax` עמדה על 7 שורות ו-₪4,400: עבודות שהכסף עליהן נכנס
-- ושאינן נושאות מספר חשבונית מס. התחקיר של 16.9.26 מצא שלכל אחת מהן, מלבד
-- אחת, יש חשבונית מס חיה במורנינג — והיא מאוגדת, כלומר מסמך אחד שמכסה כמה
-- פרקים. המערכת יודעת לייצג בדיוק את זה: `documents.bundle_job_ids`. אבל
-- העמודה הזאת נכתבת אך ורק על מסמך שהאפליקציה הנפיקה (issue.ts:672), ומסמך
-- שנמשך ממורנינג לעולם אינו מקבל אותה — נמדד: 560 מסמכי 300/305/320 עם
-- source='pull', אפס עם bundle. אין שום מסך שמשייך מסמך שנמשך לכמה עבודות:
-- "שייך מסמך קיים" עובד עבודה-אחת-למסמך-אחד. ההסתרה הייתה המוצא היחיד
-- שנותר לבוקקיפרית, וזה Q9 בלוח.
--
-- הקובץ הזה כותב את מה ש-issue.ts הייתה כותבת לו היא הנפיקה את שלושת
-- המסמכים: bundle_job_ids על המסמך, invoice_tax על כל עבודה בו, ושורת
-- invoices אחת לכל מסמך עם job_id ריק ובסכום הנטו. התבנית הועתקה משורות
-- 660-707 ו-747-860 ב-issue.ts, ואומתה מול 60193 — הבנדל האפליקטיבי האחרון —
-- שנושא job_id ריק, amount=2400 שהוא הנטו, source='morning_api'.
--
-- ═══ שלושת המסמכים, והמיפוי שנמדד ═══
--
-- 60171 · חתונמיות · 13.7.26 · ₪4,956 ברוטו / ₪4,200 נטו · שמונה שורות:
--   27.5 פרק 1 ₪0 (פרו בונו, אין עבודה ואין צורך) · 3.6 פרק 2 + 10.6 פרק 3
--   → 3cf4c6dc ("2 פרקים", ₪1,200) · 16.6 פרק 4 → f6af7ca8 · 22.6 פרק 5
--   → אין עבודה, נוצרת כאן · 30.6 פרק 6 → 517a8152 (רשומה 1.7, הפרש יום)
--   · 7.7 פרק 7 → 4ccf3682 (מוסתרת) · 8.7 פרק 8 → אין עבודה, נוצרת כאן.
--   שמונה שורות המסמך תואמות אחת-לאחת שמונה הפקות של חתונמיות באותם
--   תאריכים, וזה מה שמכשיר את המיפוי: הוא לפי תאריך הקלטה ולא לפי שם.
--   Σ אחרי: 1200+600+600+600+600+600 = 4,200 = הנטו.
--
-- 60178 · ליעד הרמן · 20.7.26 · ₪1,770 / ₪1,500 · שלוש שורות:
--   "פרק 1 - 2.7" ₪300 → 51b4bdc4 (רשומה 2.7, קרויה "פרק 2") ·
--   "פרק 2 - 5.7" ₪600 → e1cb88cc (מוסתרת) · "פרק 3 - 8.7" ₪600 → 5260f872.
--   ⚠️ מספור הפרקים ב-bizi מוזז בפרק אחד מול מורנינג לכל האורך, ולכן
--   המיפוי כאן הוא לפי תאריך בלבד. שלוש הפקות קיימות (2.7, 5.7, 8.7)
--   ולעומתן ארבע עבודות — 2e651251 (1.7) היא היחידה בלי הפקה ובלי שורה
--   במסמך, ונוצרה מתאריך ההזמנה 10285 ולא מהקלטה. הבעלים הכריע: כפילות,
--   מוסתרת. הסכומים ב-bizi (₪400 לכל אחת) הם מ-40285 שהוחלף ב-40286
--   (300/600/600), ולכן שלושתם מתוקנים לסכום שבמסמך החי.
--   Σ אחרי: 300+600+600 = 1,500 = הנטו.
--
-- 60183 · ברק הרשקוביץ · 2.8.26 · ₪2,124 / ₪1,800 · שלוש שורות:
--   "יהודה טאוב 7.7" → 8394b49f (מוסתרת) · "מתן לב ארי 19.7" → 22618f53
--   · "הרב דויד סתיו 26.7" → אין עבודה, נוצרת כאן.
--   22618f53 רשומה 22.7 אבל ההפקה שלה (c3b88f38) נושאת record_date 19.7,
--   וזו ההתאמה המדויקת לשורה. שתיים משלוש ההפקות הן kind='internal',
--   ולכן on_production_approved יצא מוקדם ולא יצר להן עבודה מעולם.
--   Σ אחרי: 600+600+600 = 1,800 = הנטו.
--
-- ═══ נטע צמח — היחידה שאין לה מסמך, ואינה מטופלת כמו האחרות ═══
-- e9eb2d91 (₪600, invoice_biz=40267). חשבונית המס שלה, 60162, הונפקה 28.6
-- ובוטלה 12.7 — status=4, עם חשבונית זיכוי 70011 וקבלה שלילית 80059. לא
-- הונפק שום מסמך אחריה. הכרעת הבעלים: הפרק שוחרר מחיוב, וה-₪600 לא נגבו;
-- 80059 הוא ביטול מסמכי ולא החזר כספי. לכן paid='ללא חיוב' ולא 'כן' —
-- deriveState (state.ts:23) מחזיר "closed" על הערך הזה, כך שהשורה יוצאת
-- מ-paidNoTax בלי לטעון שנכנס כסף. amount ו-invoice_biz נשארים, בדיוק
-- כמו בתקדים היחיד לערך הזה, 99d9d06b. invoice_tax לא נכתב: אין חשבונית.
--
-- ═══ paid: ארבע עבודות מתהפכות, וזו הכרעת הבעלים ═══
-- 4ccf3682, e1cb88cc, 5260f872 ו-8394b49f נושאות paid='לא' וכולן מכוסות
-- ב-320 — חשבונית מס **וקבלה** באחד, שהנפקתה היא הצהרה שהכסף נכנס. זה בדיוק
-- מה ש-linkDocumentToJob עושה ב-reconcile.ts:585 כשהיא מקשרת מסמך תשלום
-- לעבודה שאינה משולמת. להשאיר אותן 'לא' היה יוצר עבודה שנושאת מספר קבלה
-- ומסומנת לא-שולמה, ו-deriveState היה מחזיר עליה "לא חויב". נרשם
-- job_marked_paid על כל אחת, בתבנית 0082.
--
-- ═══ מה הקובץ אינו נוגע בו ═══
-- productions, job_productions, pending_documents — אף לא שורה. אין קישור
-- בין העבודות החדשות להפקות: כל עבודות שלושת הלקוחות אינן מקושרות היום,
-- והפקות חתונמיות כולן ב'עתיד_להתחיל' — קישור היה משחזר בדיוק את הצורה
-- הפגומה שהבקלוג מתאר ("7 הפקות היסטוריות נושאות חשבונית ויושבות
-- בעתיד_להתחיל"). כמו כן /shows סוכם הכנסה מ-jobs.amount **דרך**
-- job_productions (shows/page.tsx:146-168), ולכן אי-קישור משאיר את המספר
-- ההוא ללא שינוי. responded_at, client_review_* והדף הציבורי — מחוץ להיקף.
--
-- ═══ בטיחות הטריגרים, נמדד ולא הונח ═══
-- ensure_job_for_production ו-on_production_approved יושבים על productions
-- ונכנסים רק במעבר סטטוס אל 'הוקלט' או אל 'אושר_ע"י_לקוח'; הקובץ אינו נוגע
-- ב-productions כלל. על jobs שלושה טריגרים: trg_compute_due_date (BEFORE
-- INSERT) — יורה על שלוש השורות החדשות ומחשב due_date מתנאי התשלום של
-- הלקוח, ולכן due_date אינו נכתב כאן ביד; trg_guard_job_money ו-
-- trg_guard_job_dismissal — יורים ואינם חוסמים, כי can_edit_money() מחזירה
-- NULL כש-auth.uid() ריק (תת-שאילתה בלי שורות) ו-`if not NULL` אינו נכנס.
-- זו אותה התנהגות ש-0082 הסתמכה עליה. על job_productions, invoices
-- ו-documents אין ולו טריגר אחד.
--
-- ═══ הרשאות, כלל 49 ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס ולא view — ואינו מחליף שום פונקציה. הוא כותב ערכים
-- לעמודות קיימות ומוסיף שורות ל-jobs, invoices ו-events. אין GRANT ואין דבר
-- שהרשאותיו יכולות להיוולד שגויות. RLS על שלוש הטבלאות אינו נוגע: הקובץ רץ
-- כ-postgres ועוקף אותו כמו כל מיגרציה, וזה המצב הקיים ולא דבר שהוא יוצר.

do $mig$
declare
  -- ---- לקוחות ----
  c_neta   constant uuid := '4cb8007e-cd43-4e02-82b0-ff7e61235dc6';
  c_hat    constant uuid := '7bb6319a-eff4-43bf-8570-5f2eadcdefcd';
  c_liad   constant uuid := '4f16e25e-152b-475e-981b-7372117b17f5';
  c_barak  constant uuid := '23b66ac0-8229-4b64-a5d1-36074b9e251c';

  -- ---- המסמכים (documents.id · morning_doc_id · נטו) ----
  d71      constant uuid := '3fd96cf5-071f-4a03-938f-5c3259dbfe8a';
  m71      constant text := '8856b589-a307-4df9-af47-94bff3d17cda';
  d78      constant uuid := 'c7bcc56a-bd30-4dce-ac0b-7fd9f4628237';
  m78      constant text := '0b6dc040-2b6e-487f-a323-9f88a9a76a2f';
  d83      constant uuid := 'a2561d1a-319d-4dbe-8028-55b3d95e6d11';
  m83      constant text := '2b99c420-2362-498c-8d55-d4b6818ee216';

  -- ---- עבודות קיימות ----
  j_neta   constant uuid := 'e9eb2d91-47be-427b-8097-0fd1080e7a6f';
  j_h2ep   constant uuid := '3cf4c6dc-385a-4173-8d2b-edf5326467b9'; -- "2 פרקים" 1,200
  j_h4     constant uuid := 'f6af7ca8-c404-49e7-a8a3-e11db81b254b'; -- פרק 4
  j_h6     constant uuid := '517a8152-8171-4654-8db8-b1be0bc4f5fa'; -- פרק 6
  j_h7     constant uuid := '4ccf3682-9f1c-46e1-b809-7601c7151669'; -- פרק 7, מוסתרת
  j_ldup   constant uuid := '2e651251-a826-4b20-9d86-bdd351a3e97c'; -- הכפילות
  j_l27    constant uuid := '51b4bdc4-ee53-4de6-9e65-65e9911eb52a'; -- 2.7 → 300
  j_l57    constant uuid := 'e1cb88cc-1882-4db4-be8e-375ac7b73802'; -- 5.7, מוסתרת → 600
  j_l87    constant uuid := '5260f872-e46a-4e2b-974b-470405b2a8ea'; -- 8.7 → 600
  j_b19    constant uuid := '22618f53-929f-4a81-9ef8-c6125df092a7'; -- מתן לב ארי 19.7
  j_b7     constant uuid := '8394b49f-27ac-462f-847b-e0a6e4bb19ae'; -- יהודה טאוב 7.7, מוסתרת

  -- ---- שלוש העבודות החדשות ----
  j_h5     uuid := gen_random_uuid();  -- חתונמיות פרק 5 · 22.6
  j_h8     uuid := gen_random_uuid();  -- חתונמיות פרק 8 · 8.7
  j_b26    uuid := gen_random_uuid();  -- ברק · הרב דויד סתיו · 26.7

  v_note_neta constant text :=
    'הפרק שוחרר מחיוב — 60162 בוטלה 12.7.26 (זיכוי 70011, ביטול 80059). לא נגבה.';
  v_note_new  constant text := 'נוצר 16.9 — כיסוי %s (0087)';

  v_pnt_pre  int;  v_pnt_post  int;
  v_am_pre   int;  v_am_post   int;
  v_debt_pre numeric; v_debt_post numeric;
  v_jobs_pre int;  v_jobs_post int;
  v_inv_pre  int;  v_inv_post  int;
  v_s71 numeric; v_s78 numeric; v_s83 numeric;
  v_n71 int; v_n78 int; v_n83 int;
  v_ev_rec int; v_ev_paid int; v_ev_rest int; v_ev_dis int; v_ev_amt int;
  v_bad int;
begin
  -- =====================================================================
  -- 0. שומרים
  -- =====================================================================

  -- 0a. הפנקס הוא הרצף, לא שמות הקבצים.
  if exists (select 1 from public.schema_ledger where version = '0087') then
    raise exception '0087 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0086') then
    raise exception '0087: 0086 אינה בפנקס — המספור נגזר מפנקס אחר, מדדי מחדש';
  end if;

  -- 0b. נקודת המוצא שנמדדה: שבע שורות ב-paidNoTax.
  select count(*) into v_pnt_pre
    from public.jobs
   where dismissed = false and paid = 'כן'
     and (invoice_tax is null or btrim(invoice_tax) = '');
  if v_pnt_pre <> 7 then
    raise exception '0087: paidNoTax = % במקום 7 — המצב השתנה מאז המדידה', v_pnt_pre;
  end if;

  -- 0c. כל עבודה בדיוק במצב שהתוכנית תיארה. עבודה שזזה מאז אינה העבודה
  --     שהתחקיר מיפה, והמיפוי כולו נשען על סכום ותאריך.
  if not exists (select 1 from public.jobs where id = j_neta and client_id = c_neta
                   and paid = 'כן' and amount = 600 and invoice_tax is null
                   and invoice_biz = '40267' and dismissed = false) then
    raise exception '0087: נטע (%) אינה במצב שנמדד', j_neta;
  end if;

  if not exists (select 1 from public.jobs where id = j_h2ep and client_id = c_hat
                   and paid = 'כן' and amount = 1200 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_h4 and client_id = c_hat
                   and paid = 'כן' and amount = 600 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_h6 and client_id = c_hat
                   and paid = 'כן' and amount = 600 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_h7 and client_id = c_hat
                   and paid = 'לא' and amount = 600 and invoice_tax is null and dismissed = true) then
    raise exception '0087: אחת מארבע עבודות חתונמיות אינה במצב שנמדד';
  end if;

  if not exists (select 1 from public.jobs where id = j_ldup and client_id = c_liad
                   and paid = 'כן' and amount = 400 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_l27 and client_id = c_liad
                   and paid = 'כן' and amount = 400 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_l57 and client_id = c_liad
                   and paid = 'לא' and amount = 400 and invoice_tax is null and dismissed = true)
     or not exists (select 1 from public.jobs where id = j_l87 and client_id = c_liad
                   and paid = 'לא' and amount = 400 and invoice_tax is null and dismissed = false) then
    raise exception '0087: אחת מארבע עבודות ליעד אינה במצב שנמדד';
  end if;

  if not exists (select 1 from public.jobs where id = j_b19 and client_id = c_barak
                   and paid = 'כן' and amount = 600 and invoice_tax is null and dismissed = false)
     or not exists (select 1 from public.jobs where id = j_b7 and client_id = c_barak
                   and paid = 'לא' and amount = 600 and invoice_tax is null and dismissed = true) then
    raise exception '0087: אחת משתי עבודות ברק אינה במצב שנמדד';
  end if;

  -- 0d. שלושת המסמכים: חיים, לא משויכים, ובלי בנדל. מסמך שכבר נושא job_id
  --     או bundle_job_ids טופל בינתיים בדרך אחרת, והקובץ הזה היה דורס אותה.
  if not exists (select 1 from public.documents where id = d71 and morning_doc_number = '60171'
                   and morning_doc_id = m71 and type = 320 and status = 1 and client_id = c_hat
                   and job_id is null and bundle_job_ids is null
                   and cancelled_at is null and archived_at is null
                   and (raw->>'amountExcludeVat')::numeric = 4200)
     or not exists (select 1 from public.documents where id = d78 and morning_doc_number = '60178'
                   and morning_doc_id = m78 and type = 320 and status = 1 and client_id = c_liad
                   and job_id is null and bundle_job_ids is null
                   and cancelled_at is null and archived_at is null
                   and (raw->>'amountExcludeVat')::numeric = 1500)
     or not exists (select 1 from public.documents where id = d83 and morning_doc_number = '60183'
                   and morning_doc_id = m83 and type = 320 and status = 1 and client_id = c_barak
                   and job_id is null and bundle_job_ids is null
                   and cancelled_at is null and archived_at is null
                   and (raw->>'amountExcludeVat')::numeric = 1800) then
    raise exception '0087: אחד משלושת המסמכים אינו במצב שנמדד';
  end if;

  -- 0e. אפס שורות invoices לשלושת המספרים, בכל כתיב — כולל שני הכתיבים
  --     הסינתטיים של הזרע. זה בדיוק מה ששער 1 של linkPreflight בודק
  --     (reconcile.ts:466-505), ומשם גם רשימת המפתחות.
  if exists (
    select 1 from public.invoices
     where morning_doc_id in (m71, m78, m83)
        or doc_number in ('60171','60178','60183',
                          'biz-60171.0','tax-60171.0',
                          'biz-60178.0','tax-60178.0',
                          'biz-60183.0','tax-60183.0')
  ) then
    raise exception '0087: כבר קיימת שורת invoices לאחד משלושת המסמכים — הקובץ היה סופר אותו כסף פעמיים';
  end if;

  -- =====================================================================
  -- 1. תצלום
  -- =====================================================================
  select count(*) into v_am_pre  from public.jobs where dismissed = false and amount is null;
  select count(*) into v_jobs_pre from public.jobs;
  select count(*) into v_inv_pre  from public.invoices;
  select coalesce(sum(amount), 0) into v_debt_pre
    from public.jobs where dismissed = false and paid = 'לא';

  -- =====================================================================
  -- 2א. נטע — שוחרר מחיוב
  -- =====================================================================
  update public.jobs
     set paid  = 'ללא חיוב',
         notes = case when coalesce(btrim(notes), '') = '' then v_note_neta
                      else notes || ' | ' || v_note_neta end
   where id = j_neta and paid = 'כן';

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', j_neta, 'job_payment_corrected_manual_sql', null,
          jsonb_build_object('via', '0087', 'from', 'כן', 'to', 'ללא חיוב',
                             'reason', v_note_neta,
                             'cancelled_doc', '60162',
                             'credit_note', '70011', 'cancellation', '80059'));

  -- =====================================================================
  -- 2ב. חתונמיות — 60171
  -- =====================================================================
  insert into public.jobs (id, client_id, date, campaign, amount, paid,
                           invoice_tax, legacy, dismissed, notes)
  values
    (j_h5, c_hat, date '2026-06-22', 'פרק 5', 600, 'כן', '60171', true, false,
     format(v_note_new, '60171')),
    (j_h8, c_hat, date '2026-07-08', 'פרק 8', 600, 'כן', '60171', true, false,
     format(v_note_new, '60171'));

  update public.jobs
     set dismissed = false, dismiss_reason = null, dismissed_by = null, dismissed_at = null
   where id = j_h7 and dismissed = true;

  update public.jobs set paid = 'כן' where id = j_h7 and paid = 'לא';

  update public.jobs
     set invoice_tax = '60171'
   where id in (j_h2ep, j_h4, j_h6, j_h7) and invoice_tax is null;

  update public.documents
     set bundle_job_ids = array[j_h2ep, j_h4, j_h6, j_h7, j_h5, j_h8],
         updated_at = now()
   where id = d71 and bundle_job_ids is null;

  insert into public.invoices (client_id, job_id, type, doc_number, morning_doc_id,
                               amount, issued_at, source, issued_by, pdf_url)
  select c_hat, null, 'מס', '60171', m71, 4200,
         (d.document_date)::timestamptz, 'morning_api', null, d.pdf_url
    from public.documents d where d.id = d71;

  -- =====================================================================
  -- 2ג. ליעד — 60178
  -- =====================================================================
  update public.jobs
     set dismissed = true,
         dismiss_reason = 'כפילות — נוצר מתאריך הזמנה 10285 (1.7); ההקלטה של 2.7 היא 51b4bdc4',
         dismissed_by = null,
         dismissed_at = now()
   where id = j_ldup and dismissed = false;

  update public.jobs
     set dismissed = false, dismiss_reason = null, dismissed_by = null, dismissed_at = null
   where id = j_l57 and dismissed = true;

  update public.jobs set amount = 300 where id = j_l27 and amount = 400;
  update public.jobs set amount = 600 where id = j_l57 and amount = 400;
  update public.jobs set amount = 600 where id = j_l87 and amount = 400;

  update public.jobs set paid = 'כן' where id in (j_l57, j_l87) and paid = 'לא';

  update public.jobs
     set invoice_tax = '60178'
   where id in (j_l27, j_l57, j_l87) and invoice_tax is null;

  update public.documents
     set bundle_job_ids = array[j_l27, j_l57, j_l87],
         updated_at = now()
   where id = d78 and bundle_job_ids is null;

  insert into public.invoices (client_id, job_id, type, doc_number, morning_doc_id,
                               amount, issued_at, source, issued_by, pdf_url)
  select c_liad, null, 'מס', '60178', m78, 1500,
         (d.document_date)::timestamptz, 'morning_api', null, d.pdf_url
    from public.documents d where d.id = d78;

  -- =====================================================================
  -- 2ד. ברק — 60183
  -- =====================================================================
  insert into public.jobs (id, client_id, date, campaign, amount, paid,
                           invoice_tax, legacy, dismissed, notes)
  values
    (j_b26, c_barak, date '2026-07-26', 'דעה לא פופולרית — הרב דויד סתיו', 600, 'כן',
     '60183', true, false, format(v_note_new, '60183'));

  update public.jobs
     set dismissed = false, dismiss_reason = null, dismissed_by = null, dismissed_at = null
   where id = j_b7 and dismissed = true;

  update public.jobs set paid = 'כן' where id = j_b7 and paid = 'לא';

  update public.jobs
     set invoice_tax = '60183'
   where id in (j_b19, j_b7) and invoice_tax is null;

  update public.documents
     set bundle_job_ids = array[j_b7, j_b19, j_b26],
         updated_at = now()
   where id = d83 and bundle_job_ids is null;

  insert into public.invoices (client_id, job_id, type, doc_number, morning_doc_id,
                               amount, issued_at, source, issued_by, pdf_url)
  select c_barak, null, 'מס', '60183', m83, 1800,
         (d.document_date)::timestamptz, 'morning_api', null, d.pdf_url
    from public.documents d where d.id = d83;

  -- =====================================================================
  -- 2ה. היומן. actor_id ריק במכוון, מוסכמת 0064/0066/0085: מיגרציה עשתה
  --     זאת ולא אדם.
  -- =====================================================================

  -- document_reconciled — אחד לכל עבודה שנקשרה, 12 בסך הכול. שם האירוע
  -- ומבנה ה-payload מ-reconcile.ts:642-649, כדי שהיומן ייקרא אותו דבר בין
  -- שיוך מהמסך לבין הקובץ הזה.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', x.jid, 'document_reconciled', null,
           jsonb_build_object('via', '0087', 'auto', false,
                              'doc_id', x.did,
                              'morning_doc_id', x.mid,
                              'morning_doc_number', x.num,
                              'doc_type', 320,
                              'bundled', true,
                              'moved_state', 'red→closed')
      from (values
        (j_h2ep, d71, m71, '60171'), (j_h4, d71, m71, '60171'),
        (j_h6,  d71, m71, '60171'), (j_h7, d71, m71, '60171'),
        (j_h5,  d71, m71, '60171'), (j_h8, d71, m71, '60171'),
        (j_l27, d78, m78, '60178'), (j_l57, d78, m78, '60178'),
        (j_l87, d78, m78, '60178'),
        (j_b7,  d83, m83, '60183'), (j_b19, d83, m83, '60183'),
        (j_b26, d83, m83, '60183')
      ) as x(jid, did, mid, num)
    returning 1
  ) select count(*) into v_ev_rec from ev;

  -- job_marked_paid — ארבע העבודות שהתהפכו. התבנית מ-0082, והנימוק בכותרת.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', x.jid, 'job_marked_paid', null,
           jsonb_build_object('via', '0087_backfill', 'auto', false,
                              'from', 'לא', 'morning_doc_number', x.num,
                              'doc_type', 320,
                              'reason', '320 היא חשבונית מס וקבלה באחד — הנפקתה היא הצהרה שהכסף נכנס')
      from (values (j_h7, '60171'), (j_l57, '60178'), (j_l87, '60178'), (j_b7, '60183'))
        as x(jid, num)
    returning 1
  ) select count(*) into v_ev_paid from ev;

  -- job_restored / job_dismissed — שם האירוע ומבנה ה-payload מראוט ההסתרה
  -- (finance/dismiss/route.ts:35-37 ו-53-55), כדי שלשונית "מוסתרים" תקרא
  -- את השורות האלה כמו כל אחרת.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', x.jid, 'job_restored', null,
           jsonb_build_object('via', '0087', 'amount', x.amt,
                              'reason', 'מכוסה במסמך מאוגד ' || x.num)
      from (values (j_h7, 600, '60171'), (j_l57, 600, '60178'), (j_b7, 600, '60183'))
        as x(jid, amt, num)
    returning 1
  ) select count(*) into v_ev_rest from ev;

  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('job', j_ldup, 'job_dismissed', null,
            jsonb_build_object('via', '0087', 'amount', 400,
                               'reason', 'כפילות — נוצר מתאריך הזמנה 10285 (1.7); ההקלטה של 2.7 היא 51b4bdc4'))
    returning 1
  ) select count(*) into v_ev_dis from ev;

  -- job_amount_aligned — שלוש עבודות ליעד. השם מ-issue.ts:790, אותו מקרה
  -- בדיוק: סכום העבודה עוקב אחרי המסמך שמחייב אותה.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', x.jid, 'job_amount_aligned', null,
           jsonb_build_object('via', '0087', 'from', 400, 'to', x.amt,
                              'morning_doc_number', '60178',
                              'reason', '40285 (3×400) הוחלף ב-40286 (300/600/600); 60178 נגזרת מ-40286')
      from (values (j_l27, 300), (j_l57, 600), (j_l87, 600)) as x(jid, amt)
    returning 1
  ) select count(*) into v_ev_amt from ev;

  -- =====================================================================
  -- 3. קנרי
  -- =====================================================================
  select count(*) into v_pnt_post
    from public.jobs
   where dismissed = false and paid = 'כן'
     and (invoice_tax is null or btrim(invoice_tax) = '');
  if v_pnt_post <> 0 then
    raise exception '0087 canary: paidNoTax = % אחרי הכתיבה, במקום 0', v_pnt_post;
  end if;

  select count(*) into v_am_post from public.jobs where dismissed = false and amount is null;
  if v_am_post <> 0 then
    raise exception '0087 canary: amountMissing = % אחרי הכתיבה, במקום 0', v_am_post;
  end if;

  -- 3b. לכל מסמך: הבנדל מסתכם בנטו שלו, וכל עבודה בו נושאת את המספר.
  select count(*), coalesce(sum(j.amount), 0) into v_n71, v_s71
    from public.documents d
    cross join lateral unnest(d.bundle_job_ids) as b(jid)
    join public.jobs j on j.id = b.jid
   where d.id = d71 and j.invoice_tax = '60171';
  if v_n71 <> 6 or v_s71 <> 4200 then
    raise exception '0087 canary: 60171 — % עבודות בסך % במקום 6 בסך 4200', v_n71, v_s71;
  end if;

  select count(*), coalesce(sum(j.amount), 0) into v_n78, v_s78
    from public.documents d
    cross join lateral unnest(d.bundle_job_ids) as b(jid)
    join public.jobs j on j.id = b.jid
   where d.id = d78 and j.invoice_tax = '60178';
  if v_n78 <> 3 or v_s78 <> 1500 then
    raise exception '0087 canary: 60178 — % עבודות בסך % במקום 3 בסך 1500', v_n78, v_s78;
  end if;

  select count(*), coalesce(sum(j.amount), 0) into v_n83, v_s83
    from public.documents d
    cross join lateral unnest(d.bundle_job_ids) as b(jid)
    join public.jobs j on j.id = b.jid
   where d.id = d83 and j.invoice_tax = '60183';
  if v_n83 <> 3 or v_s83 <> 1800 then
    raise exception '0087 canary: 60183 — % עבודות בסך % במקום 3 בסך 1800', v_n83, v_s83;
  end if;

  -- 3c. ספירות: שלוש עבודות חדשות, שלוש שורות invoices חדשות.
  select count(*) into v_jobs_post from public.jobs;
  if v_jobs_post - v_jobs_pre <> 3 then
    raise exception '0087 canary: נוצרו % עבודות במקום 3', v_jobs_post - v_jobs_pre;
  end if;
  select count(*) into v_inv_post from public.invoices;
  if v_inv_post - v_inv_pre <> 3 then
    raise exception '0087 canary: נוצרו % שורות invoices במקום 3', v_inv_post - v_inv_pre;
  end if;

  -- 3d. היומן, בדיוק.
  if v_ev_rec <> 12 or v_ev_paid <> 4 or v_ev_rest <> 3 or v_ev_dis <> 1 or v_ev_amt <> 3 then
    raise exception '0087 canary: אירועים % / % / % / % / % במקום 12/4/3/1/3',
      v_ev_rec, v_ev_paid, v_ev_rest, v_ev_dis, v_ev_amt;
  end if;

  -- 3e. אפס אי-התאמה בין invoices.job_id ל-documents.job_id על פני כל
  --     הטבלה — הקנרי של 0085, ששלוש השורות החדשות חייבות לשמור עליו.
  --     שלושתן נושאות job_id ריק ושלושת המסמכים כך גם, ולכן is distinct
  --     from מחזיר false ואין אי-התאמה.
  select count(*) into v_bad
    from public.invoices i
    join public.documents d on d.morning_doc_id = i.morning_doc_id
   where i.job_id is distinct from d.job_id;
  if v_bad <> 0 then
    raise exception '0087 canary: % שורות invoices עם job_id שאינו תואם למסמך', v_bad;
  end if;

  select coalesce(sum(amount), 0) into v_debt_post
    from public.jobs where dismissed = false and paid = 'לא';

  -- =====================================================================
  -- 4. הפנקס — באותו בלוק אטומי, נופל או עובר עם השינוי
  -- =====================================================================
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0087', now(), 'bnaya',
    'סגירת שלושת המסמכים המאוגדים שנמשכו ממורנינג. paidNoTax יורדת מ-7 ל-0. שלושה מסמכי 320 שנמשכו — 60171 חתונמיות 4,200 נטו, 60178 ליעד הרמן 1,500 נטו, 60183 ברק הרשקוביץ 1,800 נטו — מקבלים bundle_job_ids, שתים-עשרה עבודות מקבלות invoice_tax, ונכתבות שלוש שורות invoices עם job_id ריק ובסכום הנטו, בדיוק בתבנית שהאפליקציה כותבת לבנדל שהיא מנפיקה (issue.ts:660-707 ו-747-860, ואומתה מול 60193). הסיבה שזה נדרש בכלל: bundle_job_ids נכתבת רק על מסמך שהאפליקציה הנפיקה, ומסמך שנמשך ממורנינג לעולם אינו מקבל אותה — 560 מסמכי 300/305/320 עם source pull, אפס עם בנדל — ואין שום מסך שמשייך מסמך שנמשך לכמה עבודות. שלוש עבודות נוצרות לפרקים שחויבו ומעולם לא נרשמו: חתונמיות פרק 5 ב-22.6 ופרק 8 ב-8.7, וברק הרב דויד סתיו ב-26.7; לשלושתן paid נקוב במפורש לפי הכרעת 0081, legacy אמת, ובלי due_date כי trg_compute_due_date מחשב אותו. שלוש עבודות משוחזרות מהסתרה — 4ccf3682 ו-e1cb88cc ו-8394b49f — כי כולן מכוסות במסמך, וההסתרה הייתה המוצא היחיד שנותר לבוקקיפרית בהיעדר כלי שיוך, וזה Q9 בלוח. ארבע עבודות עוברות מ-לא ל-כן: 4ccf3682 ו-e1cb88cc ו-5260f872 ו-8394b49f, כולן מכוסות ב-320 שהיא חשבונית מס וקבלה באחד ושהנפקתה היא הצהרה שהכסף נכנס, וזה בדיוק מה ש-linkDocumentToJob עושה ב-reconcile.ts:585; להשאירן לא היה יוצר עבודה שנושאת מספר קבלה ומסומנת לא-שולמה. עבודה אחת מוסתרת, 2e651251, ככפילות שנוצרה מתאריך ההזמנה 10285 ולא מהקלטה: לליעד שלוש הפקות ביולי ושלוש שורות במסמך ולעומתן ארבע עבודות, וזו היחידה בלי הפקה ובלי שורה. שלושת סכומי ליעד מתוקנים מ-400 ל-300 ו-600 ו-600 כי 40285 שנשא 3 כפול 400 הוחלף ב-40286 שנושא 300 ו-600 ו-600, ו-60178 נגזרת מ-40286. נטע צמח מטופלת אחרת מכולן ואינה חלק מהבנדלים: e9eb2d91 עוברת ל-ללא חיוב ולא ל-כן, כי חשבונית המס שלה 60162 בוטלה ב-12.7.26 עם זיכוי 70011 וקבלה שלילית 80059, לא הונפק שום מסמך אחריה, והכרעת הבעלים היא שהפרק שוחרר מחיוב ושה-600 לא נגבו ושהביטול הוא מסמכי ולא החזר כספי; deriveState מחזיר closed על הערך הזה ולכן השורה יוצאת מההתראה בלי לטעון שנכנס כסף, והתקדים היחיד לערך הוא 99d9d06b. המיפוי בשלושת המסמכים הוא לפי תאריך הקלטה ולא לפי שם: שמונה שורות 60171 תואמות אחת-לאחת שמונה הפקות חתונמיות, מספור הפרקים של ליעד מוזז בפרק אחד מול מורנינג לכל האורך, ו-22618f53 רשומה 22.7 אבל ההפקה שלה נושאת record_date 19.7 שהוא התאריך בשורת מתן לב ארי. הקובץ אינו נוגע ב-productions ולא ב-job_productions ולא ב-pending_documents, ואינו מקשר את העבודות החדשות להפקות: כל עבודות שלושת הלקוחות אינן מקושרות היום, הפקות חתונמיות כולן בעתיד_להתחיל וקישור היה משחזר את הצורה הפגומה של שבע ההפקות ההיסטוריות שנושאות חשבונית ויושבות שם, ו-shows סוכם הכנסה מ-jobs.amount דרך job_productions ולכן אי-קישור משאיר את המספר ההוא ללא שינוי. בטיחות הטריגרים נמדדה: ensure_job_for_production ו-on_production_approved יושבים על productions ונכנסים רק במעבר אל הוקלט או אל אושר_ע\"י_לקוח, ועל jobs trg_compute_due_date יורה על שלוש ההכנסות ומחשב due_date, ו-trg_guard_job_money ו-trg_guard_job_dismissal יורים ואינם חוסמים כי can_edit_money מחזירה NULL כשauth.uid ריק וif not NULL אינו נכנס, אותה התנהגות ש-0082 הסתמכה עליה; על job_productions ו-invoices ו-documents אין ולו טריגר אחד. שמונה קבוצות שומרים לפני הכתיבה: הפנקס מכיל 0086 ואינו מכיל 0087; paidNoTax שווה שבע; כל אחת מאחת-עשרה העבודות בדיוק במצב שנמדד לפי לקוח וסכום וpaid וinvoice_tax וdismissed; שלושת המסמכים חיים ולא משויכים ובלי בנדל ועם הנטו שנמדד; ואפס שורות invoices לשלושת המספרים בכל כתיב כולל שני הכתיבים הסינתטיים של הזרע, שזו בדיוק בדיקת שער 1 של linkPreflight. ואחרי: paidNoTax אפס וamountMissing אפס; לכל מסמך מספר העבודות בבנדל וסכומן שווים למדוד ולכולן invoice_tax נכון; שלוש עבודות ושלוש שורות invoices נוצרו ולא יותר; שנים-עשר אירועי document_reconciled וארבעה job_marked_paid ושלושה job_restored ואחד job_dismissed ושלושה job_amount_aligned; ואפס אי-התאמה בין invoices.job_id לdocuments.job_id על פני כל הטבלה, הקנרי של 0085. הרשאות לפי כלל 49: אפס אובייקט נושא-ACL נוצר, אפס פונקציה מוחלפת, אין GRANT; RLS על jobs וinvoices וdocuments אינו נוגע והקובץ רץ כpostgres ועוקף אותו כמו כל מיגרציה. מחוץ להיקף במכוון: הפרק של ליעד ב-28.8 על שתי ההפקות הכפולות 6bd7289f ו-94d4a7ea והעבודה המוסתרת 8ce89e57 ו-40311 בלי חשבונית מס ו-df5758d7 שpaid שלה לא; 40261 ו-60181 של שחף סגינר שהם T6; והתיקון בקוד עצמו שהוא F9.');

  -- =====================================================================
  -- 5. NOTICE — מה שהבעלים מדביק בחזרה
  -- =====================================================================
  raise notice '0087 paidNoTax   : % → % (0 = נסגר)', v_pnt_pre, v_pnt_post;
  raise notice '0087 amountMissing: % → %', v_am_pre, v_am_post;
  raise notice '0087 60171 חתונמיות: % עבודות · Σ % (נטו 4200)', v_n71, v_s71;
  raise notice '0087 60178 ליעד    : % עבודות · Σ % (נטו 1500)', v_n78, v_s78;
  raise notice '0087 60183 ברק     : % עבודות · Σ % (נטו 1800)', v_n83, v_s83;
  raise notice '0087 jobs      : % → % (+3)', v_jobs_pre, v_jobs_post;
  raise notice '0087 invoices  : % → % (+3)', v_inv_pre, v_inv_post;
  raise notice '0087 חוב לגבייה: % → %', v_debt_pre, v_debt_post;
  raise notice '0087 יומן      : % reconciled · % marked_paid · % restored · % dismissed · % amount_aligned',
    v_ev_rec, v_ev_paid, v_ev_rest, v_ev_dis, v_ev_amt;
  raise notice '0087 הוחלה ונרשמה.';

end $mig$;
