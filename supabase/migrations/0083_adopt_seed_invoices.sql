-- 0083 — אימוץ 29 שורות הזרע ב-invoices
--
-- מה זה ולמה. 0e6b3ca הוסיף את linkPreflight ל-linkDocumentToJob, ושער 1 שלו
-- (reconcile.ts:459-497) מסרב לשייך מסמך 300/305/320 כשקיימת לו שורת invoices
-- ישנה — כדי שלא ייווצר רישום שני לאותו חיוב, בסכום אחר. השער עושה בדיוק את
-- מה שנבנה לעשות, והמחיר הוא ש-29 מסמכים אמיתיים נתקעים: ל-29 האלה יש כבר
-- job יחיד שנושא את מספרם, ויש להם שורת זרע יחידה שמתארת את אותו חיוב עצמו.
-- הקובץ הזה מאמץ את שורת הזרע — מעדכן אותה להיות הרישום של המסמך — במקום
-- להוסיף שורה שנייה לצידה. אחרי האימוץ שער 1 לא ימצא עוד מפתח סינתטי לאף
-- אחד מה-29, ו-linkDocumentToJob הרגיל היה עובר בהם בלי שורת קוד שהשתנתה.
--
-- ⚠️ שער 1 נשאר כפי שהוא, בהכרעת הבעלים. זה תיקון נתונים ולא שינוי כלל:
-- ההגנה שנבנתה ב-0e6b3ca ממשיכה לחול על כל שיוך עתידי, וכל שורת זרע שתיוותר
-- אחרי הקובץ הזה תמשיך לחסום — וזה נכון, כי שורה כזו היא מקרה שאיש טרם הכריע
-- בו. הנוסח שהמשתמש רואה, הקישור דורש טיפול ידני, נשאר גם הוא כפי שהוא.
--
-- ═══ מי הם 29, ואיך הם נבחרו ═══
-- הפרדיקט המלא, שנמדד על נתונים חיים 15.9.26 ונמדד שוב ברגע ההרצה בסעיף 0:
-- מסמך מסוג 300/305/320, לא מבוטל ולא מאורכב, documents.job_id ריק,
-- bundle_job_ids ריק; job יחיד בכל המסד שנושא את מספר המסמך ב-invoice_biz או
-- ב-invoice_tax; אותו לקוח למסמך ול-job; ושורת זרע יחידה ב-invoices עם
-- source=manual, job_id ריק ומפתח בצורת biz-<מספר>.0 או tax-<מספר>.0.
--   29 שורות · ברוטו 436,085.52 · נטו 369,564 · על 26 jobs
-- שלוש עבודות מקבלות שתי שורות, אחת מסוג עסקה ואחת מסוג מס, וזה תקין: אלה
-- ה-300 וה-320 של אותה עבודה. 0e7c16a7 מקבלת 40211 ו-60130, 79b1b214 מקבלת
-- 40247 ו-60166, ו-50b53709 מקבלת 40220 ו-50065.
--
-- ═══ מה נכתב לכל שורת זרע, ולמה כל אחד ═══
--   job_id           ← ה-job. זו הכתיבה שמכניסה את השורה לתצוגה לראשונה:
--                      finance/page.tsx:41 עושה continue על job_id ריק, ולכן
--                      כל 154 שורות הזרע בלתי נראות היום.
--   morning_doc_id   ← ה-uuid האמיתי של המסמך, במקום המפתח הסינתטי. זה מה
--                      שמסיר אותן משער 1 ומכניס אותן ל-dedupe של
--                      reconcile.ts:589 ו-issue.ts:589.
--   doc_number       ← המספר החשוף. בתצוגה זה no-op, כי finance/page.tsx:76,81
--                      קורא j.invoice_biz ?? bizDoc?.doc_number וה-job גובר
--                      בכל 29; הערך נכתב כדי שאפשר יהיה למצוא שורה לפי מספר.
--   type             ← לפי סוג המסמך, לא לפי קידומת המפתח. ראה אזהרה למטה.
--   amount           ← documents.amount, כלומר ברוטו.
--   source           ← morning_api. שורת הזרע מתארת מסמך שהגיע ממורנינג
--                      במשיכה, ו-manual היה מצייר תג ידני כתום
--                      (FinanceClient.tsx:902) על מסמך שאיש לא הקליד.
--   issued_at        ← documents.document_date.
--   pdf_url          ← ה-PDF של המסמך. לכל 29 המסמכים יש, ולאף שורת זרע אין.
--   date_is_estimated← false. התאריך מגיע מהמסמך עצמו ואינו מוערך עוד; שתיים
--                      מה-29 נושאות true היום ויורדות מספירת ההתראה
--                      ב-alerts.ts:323.
--   issued_by        נשאר ריק. מיגרציה עשתה זאת, לא אדם — מוסכמת 0064/0066.
--
-- ⚠️ שתי שורות שבהן ה-type משתנה, וזו ההכרעה היחידה בקובץ שאינה העתקה.
-- 50058 ו-50060 הם מסמכי 305, אבל בגיליון המקור הם נרשמו תחת הקידומת biz-
-- ולכן שורת הזרע שלהם נושאת type=עסקה. הקובץ כותב מס לשתיהן, לפי סוג המסמך.
-- בלי זה finance/page.tsx:73 היה מוצא אותן כ-bizDoc ומציג PDF של חשבונית מס
-- במשבצת של חשבון העסקה. שתי אלה הן גם היחידות שמצב אימוץ בתוך
-- linkDocumentToJob לא היה משחרר: שער 2 (reconcile.ts:508) משווה את
-- job.invoice_tax, שנושא 80053 ו-80054, מול 50058 ו-50060, ומסרב. מיגרציה
-- כותבת את ה-type ישירות ואינה נזקקת לשאלה הזאת בכלל.
--
-- ═══ מה הקובץ מכוון לא לעשות ═══
-- עמודות ה-jobs לא נגעו — לא invoice_biz, לא invoice_tax, לא paid. זו אינה
-- הימנעות אלא מדידה: ב-29 מתוך 29 העמודה שהמסמך היה ממלא כבר מלאה, ולכן
-- jobPatch של linkDocumentToJob (reconcile.ts:579-583) ריק בכל אחד מהם
-- וה-update על jobs אינו נקרא אפילו פעם אחת. גם flippedPaid אינו נדלק: רק
-- שניים מה-29 הם 320, ושני ה-jobs שלהם כבר paid=כן. סעיף 0h מוודא את שלוש
-- הטענות האלה מחדש לפני הכתיבה, ו-md5 על כל jobs מוודא אותן אחריה.
--
-- ═══ מה זה מזיז במסך ═══
-- לא doc_number. מה שמשתנה הוא עצם ההופעה: 29 השורות נכנסות ל-invByJob
-- לראשונה, ואיתן קישור PDF במסך הכספים, וחמש שורות מס נוספות שיחזרו
-- מ-jobs/[id]/show-link. שום סכום על שום מסך אינו זז, כי אף קורא במערכת אינו
-- בוחר את invoices.amount בכלל — נבדקו כל שמונת אתרי הקריאה.
--
-- ⚠️ העמודה amount נשארת מעורבת, וזה נאמר במפורש ולא מושאר לשתיקה. אחרי
-- הקובץ הזה 29 שורות עוברות לברוטו ומצטרפות ל-47 שורות ה-morning_api, ו-125
-- שורות זרע נותרות בנטו. מי שיסכם את העמודה יקבל מספר חסר משמעות, היום ואחרי.
-- זה לא נסגר כאן כי הסגירה היא הכרעה על 125 שורות שאיש לא סיווג אחת-אחת.
--
-- ⚠️ ה-DELETE בביטול מתחיל לחול על 29 השורות האלה. cancel/route.ts:66-71
-- מוחק invoices לפי morning_doc_id, מגודר ב-if (jobId). היום שתי הרגליים
-- סגורות: המפתח סינתטי ו-documents.job_id ריק. אחרי הקובץ שתיהן נפתחות,
-- וביטול אחד מ-29 המסמכים ימחק את שורת הזרע שלו. בהכרעת הבעלים זה מקובל
-- ונחשב כמו כל מסמך משויך, והקוד לא משתנה. נרשם כאן כדי שזה יהיה ידוע ולא
-- יתגלה.
--
-- ═══ PERMISSIONS — STATED, NOT ASSUMED (rule 49) ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא כותב ערכים
-- לעמודות קיימות בשתי טבלאות ומוסיף שורות ל-events. אין כאן GRANT ואין דבר
-- שהרשאותיו יכולות להיוולד שגויות. זה נאמר במפורש כי אין שינוי הרשאות היא
-- טענה שקורא צריך למצוא ולא להסיק.
--
-- החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: invoices כבר מוגנת
-- ב-RLS דרך invoices_view (can_view_money) ו-invoices_update (can_edit_money),
-- ו-documents דרך המדיניות שלה; אף אחת מהן לא נגעה. הקובץ רץ כ-postgres
-- ועוקף RLS כמו כל מיגרציה, וזה המצב הקיים ולא דבר שהוא יוצר.
--
-- ZERO DELETE. ZERO schema change. 29 שורות invoices, 29 שורות documents,
-- 29 שורות ב-events.

do $mig$
declare
  -- ═══ 29 השלשות, מפורשות. seed = שורת invoices, doc = המסמך, job = העבודה.
  --     שלשה אחת לכל שורה ובאותו זוג סוגריים, כך שאי-התאמה בין שלוש רשימות
  --     מקבילות אינה מצב שהקובץ הזה יכול להגיע אליו בכלל.
  v_map constant jsonb := '[
    {"num":"40150","seed":"d0b013f1-bea2-4348-a24a-7121ab7fcdb2","doc":"0155a001-252a-47db-9935-3b462fb8f787","job":"acb6eb73-07f8-4640-82f0-1809d4df0e85"},
    {"num":"40192","seed":"945bab2c-abbc-4058-8081-92936227f780","doc":"8a7ba970-c3fa-40cd-a134-91d16656ddd3","job":"99d9d06b-0ef5-48f2-b2ab-cbc4a8aa7cbf"},
    {"num":"40196","seed":"d23dffcd-258f-4da6-94a8-f53e92f1d3e9","doc":"183dbda5-a64f-451d-b435-7df546ec864b","job":"eb42317d-a69a-4c79-b3a0-cdce8d9d280a"},
    {"num":"40211","seed":"cd41387c-9f30-41da-864d-47df3650b6ef","doc":"1486e07c-e066-498c-be2e-70cbac906754","job":"0e7c16a7-6d67-4e21-a368-d1add0001231"},
    {"num":"40212","seed":"93a00bbb-e3db-4d26-8c1b-c645cb8fa44f","doc":"fba05d1b-9892-41db-b904-9a060802eee4","job":"fd8c8dc1-c554-4517-af8f-cd72972456a9"},
    {"num":"40220","seed":"1418d367-ade6-4bc9-9ed9-15d78584a2ab","doc":"8a681c5d-4c6a-4acd-8d7c-fbd3cbbb3c4e","job":"50b53709-df8c-48c5-9f10-307cebbfac12"},
    {"num":"40228","seed":"8e41d5a3-10a7-4797-8dc3-04e42022c5cb","doc":"a4984d51-fdf8-478d-8ab8-fcd6687a2e6b","job":"7fad9fff-9a87-4cbe-a322-e790dea3d327"},
    {"num":"40237","seed":"903fd8f3-9f8d-44de-8a08-fb35ba25897d","doc":"f23482ac-1a52-41d0-818b-bd1f197f4ce0","job":"0faa2bd1-c580-4396-a0c4-bfbfe619ddab"},
    {"num":"40243","seed":"58aa25eb-38dc-4f40-8c88-5d281d5d7c0b","doc":"1e06584f-00de-4234-b36c-c6dd0856a281","job":"f5ccaaea-f0ab-4de4-8a8d-53df23fc2af1"},
    {"num":"40245","seed":"d403782a-8b63-47e6-85fe-85e5e0b74767","doc":"14773b36-4952-4219-9b1d-34cc03e5c600","job":"f80d2252-d3fe-49ba-9466-4d24e6727e32"},
    {"num":"40247","seed":"48da5c0f-5887-4c63-900f-54d776bd8ba8","doc":"2bba91d0-33f7-4014-a503-312d9360e524","job":"79b1b214-9792-445b-aa62-8f3c4edd3106"},
    {"num":"40267","seed":"fd6d4443-0579-42f1-911d-acf6dd9b8880","doc":"ced6a340-1c7a-4f0f-97fc-16dbd6c5bde3","job":"e9eb2d91-47be-427b-8097-0fd1080e7a6f"},
    {"num":"40271","seed":"80b43617-6ebd-4d43-9549-1d37d4423b08","doc":"f5b9bd7b-4850-467c-ac08-e9ea290ddce1","job":"2af81daf-6952-4c61-8415-01dafe19d373"},
    {"num":"40272","seed":"2b0547ac-f0d8-43ab-ae36-50438b18acad","doc":"0d6139cc-c111-43c1-9560-7f4954336558","job":"bce346b8-7aa1-42d5-8dd8-cd1034a52b25"},
    {"num":"40273","seed":"adaabc94-a728-43a6-9dbb-d7f2ecc05505","doc":"1bc6241e-cb95-4de8-88ae-b2325175afbc","job":"96eb201f-451f-458f-9d26-07b6bbb0b5bf"},
    {"num":"40277","seed":"348514f9-2f86-481c-b33d-e0eaf261b106","doc":"938147b8-17ae-47be-85f3-cc84240d5c7e","job":"61a702c0-5032-479c-ba2f-334a315e281a"},
    {"num":"40278","seed":"5015bbe8-cd8b-4ef3-bf1a-575b24175ed3","doc":"26b76d46-faa7-435d-a793-b199bd123ac5","job":"2f133837-0153-4543-9e79-c3e4928a2470"},
    {"num":"40279","seed":"a8cf2f33-b6bd-40e3-9f70-2fef3211cd65","doc":"a56573c8-a8b7-4b76-9150-3176593e4815","job":"5008e0c1-d4f3-4ba4-8899-3fc703c4522f"},
    {"num":"40280","seed":"f07138b6-4801-466c-8780-65d4a8a30d2d","doc":"f1c4cca4-6817-45a7-b888-022fd53f0677","job":"a0181cb5-cc3f-4667-81a4-6c58542e25cd"},
    {"num":"40281","seed":"8338b548-a7de-450e-b018-9efc79001139","doc":"a2461f20-b1aa-493e-a0e7-16b917335f6a","job":"46808c3f-b133-432a-8feb-3c1413d341c2"},
    {"num":"40282","seed":"e392c4f7-1f13-4eed-9d2e-33f557eafb87","doc":"385e704b-e4e1-4326-b1f4-928d5f52376d","job":"f3eef106-aa54-45c9-a96b-27b8b10fad4c"},
    {"num":"40283","seed":"4f76dff8-d03b-442a-84cb-e0d6ebdc9d31","doc":"568c77bd-9a4e-4163-b916-3e2c7f8eea92","job":"4388cb08-6d81-4c85-befc-98c34647ae40"},
    {"num":"50045","seed":"e3f80acb-3070-43eb-b84b-9a67ce27daea","doc":"c111f7ed-e553-4d63-b4b0-0003f923b785","job":"79881c4b-462b-44d4-9236-45bc9437b6c6"},
    {"num":"50046","seed":"08608922-b991-4082-9141-9826189d9ac3","doc":"04068e7f-657c-44ca-825c-2a1535866dfc","job":"1e3ca79e-9d18-48f8-974d-bfc1b39dd6b8"},
    {"num":"50058","seed":"e84fc9ed-297a-4891-8792-d99ceeefa2a5","doc":"e8aa925c-9e0e-404e-a820-ec641f21fab7","job":"07ea2ec5-4d56-48f8-9aa3-82b81d9503c6"},
    {"num":"50060","seed":"a7734b61-7763-4f85-8b9e-c5bda7c30323","doc":"290d23c0-ebce-4e0a-bf5d-717daa3a27ec","job":"121bcae3-2155-4914-bc00-4546260632c8"},
    {"num":"50065","seed":"4b530229-5585-4d65-9f91-2f9ccb2be087","doc":"5f09cdb3-6069-4974-80b7-af28301847c9","job":"50b53709-df8c-48c5-9f10-307cebbfac12"},
    {"num":"60130","seed":"4080d8db-b385-4275-87a3-9529fab18195","doc":"671ecfaf-58f5-4b72-bc9f-87a2035e8c95","job":"0e7c16a7-6d67-4e21-a368-d1add0001231"},
    {"num":"60166","seed":"5b3e20ac-1df1-4c84-a4d8-a7521a2cfcf5","doc":"c9c65fac-4265-4402-b828-35b14b644dc0","job":"79b1b214-9792-445b-aa62-8f3c4edd3106"}
  ]'::jsonb;

  v_n            constant int := 29;
  v_gross        constant numeric := 436085.52;
  v_net          constant numeric := 369564;

  v_bad          int;
  v_upd_inv      int;
  v_upd_doc      int;
  v_events       int;

  v_inv_pre      int;  v_inv_post      int;
  v_jobs_digest_pre  text;  v_jobs_digest_post  text;
  v_rest_digest_pre  text;  v_rest_digest_post  text;
  v_gross_sum    numeric;
  v_net_sum      numeric;
  v_seed_left    int;
  v_dup_key      int;
begin
  -- =====================================================================
  -- 0. GUARDS — כל תנאי שנמדד בתחקיר, נמדד שוב כאן ברגע ההרצה
  -- =====================================================================

  -- 0a. הפנקס הוא הרצף, לא שמות הקבצים.
  if exists (select 1 from public.schema_ledger where version = '0083') then
    raise exception '0083 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0082') then
    raise exception '0083: 0082 אינה בפנקס — המספור נגזר מפנקס אחר, מדדי מחדש';
  end if;

  -- 0b. הרשימה עצמה: 29 שלשות, בלי מזהה כפול באף אחד משלושת התפקידים.
  --     seed ו-doc חייבים להיות ייחודיים; job אינו, כי שלוש עבודות מקבלות שתי
  --     שורות כל אחת — ולכן נבדק שיש בדיוק 26 עבודות שונות ולא ש-29 שונות.
  if (select count(*) from jsonb_array_elements(v_map)) <> v_n then
    raise exception '0083: הרשימה אינה % שלשות', v_n;
  end if;
  if (select count(distinct m.seed) from jsonb_to_recordset(v_map) as m(seed uuid)) <> v_n then
    raise exception '0083: מזהה שורת זרע מופיע פעמיים ברשימה';
  end if;
  if (select count(distinct m.doc) from jsonb_to_recordset(v_map) as m(doc uuid)) <> v_n then
    raise exception '0083: מזהה מסמך מופיע פעמיים ברשימה';
  end if;
  if (select count(distinct m.job) from jsonb_to_recordset(v_map) as m(job uuid)) <> 26 then
    raise exception '0083: מספר העבודות השונות ברשימה אינו 26';
  end if;

  -- 0c. כל שורת זרע נמצאת ובמצב שנמדד. and source=manual and job_id is null
  --     חוזר גם בפרדיקט של ה-UPDATE עצמו: כאן זו אבחנה, שם זו ההגנה.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, num text)
   where not exists (
     select 1 from public.invoices i
      where i.id = m.seed
        and i.source = 'manual'
        and i.job_id is null
        and i.morning_doc_id in ('biz-' || m.num || '.0', 'tax-' || m.num || '.0')
        and i.doc_number = i.morning_doc_id);
  if v_bad <> 0 then
    raise exception '0083: % שורות זרע אינן במצב שנמדד (source, job_id או המפתח הסינתטי)', v_bad;
  end if;

  -- 0d. כל מסמך נמצא, לא משויך, בלי bundle, ונושא את כל מה שעומד להיכתב.
  --     pdf_url ו-document_date נבדקים כי הם נכתבים, ומסמך בלי אחד מהם היה
  --     מייצר שורה חסרה במקום לעצור.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(doc uuid, num text)
   where not exists (
     select 1 from public.documents d
      where d.id = m.doc
        and d.morning_doc_number = m.num
        and d.type in (300, 305, 320)
        and d.job_id is null
        and coalesce(array_length(d.bundle_job_ids, 1), 0) = 0
        and d.cancelled_at is null
        and d.archived_at is null
        and d.morning_doc_id is not null
        and d.pdf_url is not null
        and d.document_date is not null
        and d.client_id is not null
        and d.amount is not null);
  if v_bad <> 0 then
    raise exception '0083: % מסמכים אינם במצב שנמדד (שיוך, bundle, ביטול, או שדה חסר)', v_bad;
  end if;

  -- 0e. ⚠️ זהות הסכום — הבדיקה שמוכיחה ששורת הזרע מתארת את המסמך הזה ולא
  --     מסמך אחר במקרה. שני כיוונים בלתי תלויים: הנטו שווה לברוטו חלקי 1.18,
  --     והנטו שווה לסכום העבודה. כשל בה עוצר את כל הקובץ ולא מדלג על שורה,
  --     כי שורה שאומצה לכתובת הלא נכונה היא כסף שנרשם על עבודה זרה.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid, job uuid)
    join public.invoices  i on i.id = m.seed
    join public.documents d on d.id = m.doc
    join public.jobs      j on j.id = m.job
   where i.amount is distinct from round(d.amount / 1.18, 2)
      or i.amount is distinct from j.amount;
  if v_bad <> 0 then
    raise exception '0083: ב-% שורות הנטו אינו שווה לברוטו חלקי 1.18 או לסכום העבודה', v_bad;
  end if;

  -- 0f. ה-job הוא באמת היחיד שנושא את המספר, והלקוח זהה בשלושתם. אחרת
  --     ה-1:1 שעליו הקובץ נשען אינו 1:1 יותר.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid, job uuid, num text)
    join public.invoices  i on i.id = m.seed
    join public.documents d on d.id = m.doc
    join public.jobs      j on j.id = m.job
   where (select count(*) from public.jobs j2
           where j2.invoice_biz = m.num or j2.invoice_tax = m.num) <> 1
      or j.id is distinct from (select j2.id from public.jobs j2
           where j2.invoice_biz = m.num or j2.invoice_tax = m.num limit 1)
      or d.client_id is distinct from j.client_id
      or i.client_id is distinct from d.client_id;
  if v_bad <> 0 then
    raise exception '0083: ב-% מקרים ה-job אינו יחיד או שהלקוח אינו זהה בשלושתם', v_bad;
  end if;

  -- 0g. אין שורת invoices אחרת שכבר יושבת על ה-uuid האמיתי. בלי זה ה-UPDATE
  --     היה נופל על invoices_morning_doc_id_key באמצע הריצה.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid)
    join public.documents d on d.id = m.doc
    join public.invoices  i2 on i2.morning_doc_id = d.morning_doc_id
   where i2.id <> m.seed;
  if v_bad <> 0 then
    raise exception '0083: ל-% מסמכים כבר קיימת שורת invoices על ה-uuid האמיתי', v_bad;
  end if;
  -- ואותו דבר על המספר החשוף, שנכתב ל-doc_number.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, num text)
    join public.invoices i2 on i2.doc_number = m.num
   where i2.id <> m.seed;
  if v_bad <> 0 then
    raise exception '0083: ל-% מספרים כבר קיימת שורת invoices עם המספר החשוף', v_bad;
  end if;

  -- 0h. ⚠️ ההוכחה שעמודות ה-jobs אינן צריכות לזוז. שלוש הבדיקות הן בדיוק
  --     שלושת הענפים של jobPatch ב-reconcile.ts:579-583. אם אחד מהם היה
  --     נדלק, המשמעות היא שהמצב השתנה מאז המדידה והקובץ עוצר — כי אז הוא
  --     היה מאמץ שורה לעבודה שהמסמך הזה עוד לא רשום עליה.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(doc uuid, job uuid, num text)
    join public.documents d on d.id = m.doc
    join public.jobs      j on j.id = m.job
   where (d.type = 300        and coalesce(btrim(j.invoice_biz), '') = '')
      or (d.type in (305,320) and coalesce(btrim(j.invoice_tax), '') = '')
      or (d.type = 320        and j.paid = 'לא');
  if v_bad <> 0 then
    raise exception '0083: ב-% מקרים linkDocumentToJob היה כותב על ה-job — המצב השתנה מאז המדידה', v_bad;
  end if;

  -- 0i. והסכומים הכוללים הם אלה שנמדדו. שורה שהחליפה סכום בין המדידה להרצה
  --     נתפסת כאן גם אם כל בדיקה פרטנית עברה.
  select sum(d.amount), sum(i.amount) into v_gross_sum, v_net_sum
    from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid)
    join public.invoices  i on i.id = m.seed
    join public.documents d on d.id = m.doc;
  if v_gross_sum <> v_gross or v_net_sum <> v_net then
    raise exception '0083: הסכומים אינם אלה שנמדדו — ברוטו % מול %, נטו % מול %',
      v_gross_sum, v_gross, v_net_sum, v_net;
  end if;

  -- =====================================================================
  -- 1. SNAPSHOT
  -- =====================================================================
  select count(*) into v_inv_pre from public.invoices;

  -- כל jobs, כל עמודה. זו ההוכחה שהטבלה לא זזה, ולא היעדר משפט UPDATE
  -- שמוכיח רק שאיש לא כתב אחד בכוונה.
  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_digest_pre
    from (select to_jsonb(j)::text as x from public.jobs j) t;

  -- כל invoices מלבד 29 השורות. כולל 125 שורות הזרע שנשארות, שתי הכפילויות
  -- ש-0084 תטפל בהן, ו-47 שורות ה-morning_api.
  select md5(string_agg(t.x, '|' order by t.x)) into v_rest_digest_pre
    from (select to_jsonb(i)::text as x from public.invoices i
           where i.id not in (select m.seed from jsonb_to_recordset(v_map) as m(seed uuid))) t;

  -- =====================================================================
  -- 2. THE WRITES. הפרדיקט הוא ההגנה, לא ה-WHERE על המזהה: שורה שזזה בין
  --    השומר לכתיבה פשוט לא תיכתב, וספירת השורות למטה תתפוס זאת ותפיל
  --    את הקובץ כולו.
  -- =====================================================================

  -- 2a. שורות הזרע. ה-type נגזר מסוג המסמך בתוך המשפט עצמו ולא מהקידומת,
  --     וזה מה שמתקן את 50058 ו-50060 בלי סעיף נפרד.
  with upd as (
    update public.invoices i
       set job_id            = m.job,
           morning_doc_id    = d.morning_doc_id,
           doc_number        = d.morning_doc_number,
           type              = (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type,
           amount            = d.amount,
           source            = 'morning_api',
           issued_at         = d.document_date,
           pdf_url           = d.pdf_url,
           date_is_estimated = false
      from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid, job uuid)
      join public.documents d on d.id = m.doc
     where i.id = m.seed
       and i.source = 'manual'
       and i.job_id is null
    returning 1
  ) select count(*) into v_upd_inv from upd;

  -- 2b. המסמכים. client_id נכתב רק אם ריק — נמדד שאינו ריק באף אחד מה-29,
  --     והתנאי קיים כדי שהמשפט לא ידרוס לקוח קיים אם אי פעם ירוץ על שורה
  --     אחרת. זה בדיוק מה ש-reconcile.ts:571 עושה.
  with upd as (
    update public.documents d
       set job_id     = m.job,
           client_id  = coalesce(d.client_id, j.client_id),
           updated_at = now()
      from jsonb_to_recordset(v_map) as m(doc uuid, job uuid)
      join public.jobs j on j.id = m.job
     where d.id = m.doc
       and d.job_id is null
    returning 1
  ) select count(*) into v_upd_doc from upd;

  -- 2c. היומן. אותו מבנה payload כמו document_reconciled שנכתב ב-reconcile.ts
  --     שורות 619-624, עם via=0083_adopt שמבדיל אותו ממשיכה ומפעולת מנהל
  --     חשבונות. moved_state הוא linked בכל 29, כי jobPatch ריק בכולם וגם
  --     flippedPaid כבוי — סעיף 0h הוכיח את שניהם. actor_id ריק במכוון,
  --     מוסכמת 0064/0066: מיגרציה עשתה זאת ולא אדם.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', m.job, 'document_reconciled', null,
           jsonb_build_object(
             'via', '0083_adopt',
             'auto', false,
             'doc_id', d.id,
             'morning_doc_id', d.morning_doc_id,
             'morning_doc_number', d.morning_doc_number,
             'doc_type', d.type,
             'amount', d.amount,
             'moved_state', 'linked',
             'adopted_invoice_id', m.seed,
             'seed_key', 'biz-or-tax-' || d.morning_doc_number || '.0')
      from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid, job uuid)
      join public.documents d on d.id = m.doc
    returning 1
  ) select count(*) into v_events from ev;

  -- =====================================================================
  -- 3. CANARY
  -- =====================================================================
  if v_upd_inv <> v_n then
    raise exception '0083 canary: % שורות invoices עודכנו במקום %', v_upd_inv, v_n;
  end if;
  if v_upd_doc <> v_n then
    raise exception '0083 canary: % שורות documents עודכנו במקום %', v_upd_doc, v_n;
  end if;
  if v_events <> v_n then
    raise exception '0083 canary: נכתבו % אירועים במקום %', v_events, v_n;
  end if;
  if (select count(*) from public.events where payload->>'via' = '0083_adopt') <> v_n then
    raise exception '0083 canary: מספר אירועי 0083_adopt ביומן אינו %', v_n;
  end if;

  -- 3a. הערכים באמת שם — נקראים חזרה מהטבלה ולא מונחים מספירת השורות
  --     שעודכנו. כל שדה שנכתב נבדק מול המקור שממנו נגזר.
  select count(*) into v_bad
    from jsonb_to_recordset(v_map) as m(seed uuid, doc uuid, job uuid)
    join public.invoices  i on i.id = m.seed
    join public.documents d on d.id = m.doc
   where i.job_id            is distinct from m.job
      or i.morning_doc_id    is distinct from d.morning_doc_id
      or i.doc_number        is distinct from d.morning_doc_number
      or i.amount            is distinct from d.amount
      or i.source            is distinct from 'morning_api'
      or i.issued_at         is distinct from d.document_date
      or i.pdf_url           is distinct from d.pdf_url
      or i.date_is_estimated is distinct from false
      or i.type              is distinct from (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type
      or d.job_id            is distinct from m.job
      or i.job_id            is distinct from d.job_id;
  if v_bad <> 0 then
    raise exception '0083 canary: ב-% שורות הערך שנקרא חזרה אינו הערך שנגזר מהמסמך', v_bad;
  end if;

  -- 3b. שתי החריגות נושאות מס, ולא עסקה כפי שהקידומת biz- אמרה.
  if (select count(*) from public.invoices i
       join public.documents d on d.morning_doc_id = i.morning_doc_id
      where d.morning_doc_number in ('50058', '50060') and i.type = 'מס') <> 2 then
    raise exception '0083 canary: 50058 ו-50060 אינן נושאות type=מס';
  end if;

  -- 3c. ⚠️ אפס נזק צדדי, שני כיוונים. jobs לא זזה בכלל — זו הטענה הנושאת של
  --     הקובץ ומה שמפריד בין אימוץ רישום לבין יצירת כסף. ו-invoices שמחוץ
  --     ל-29 לא זזה, מה שמכסה גם את 125 שורות הזרע שנשארות.
  select md5(string_agg(t.x, '|' order by t.x)) into v_jobs_digest_post
    from (select to_jsonb(j)::text as x from public.jobs j) t;
  if v_jobs_digest_post is distinct from v_jobs_digest_pre then
    raise exception '0083 canary: שורה בטבלת jobs השתנתה';
  end if;

  select md5(string_agg(t.x, '|' order by t.x)) into v_rest_digest_post
    from (select to_jsonb(i)::text as x from public.invoices i
           where i.id not in (select m.seed from jsonb_to_recordset(v_map) as m(seed uuid))) t;
  if v_rest_digest_post is distinct from v_rest_digest_pre then
    raise exception '0083 canary: שורת invoices שמחוץ ל-29 השתנתה';
  end if;

  select count(*) into v_inv_post from public.invoices;
  if v_inv_post <> v_inv_pre then
    raise exception '0083 canary: מספר השורות ב-invoices השתנה: % -> %', v_inv_pre, v_inv_post;
  end if;

  -- 3d. אפס מפתח כפול בטבלה כולה. האילוץ invoices_morning_doc_id_key כבר
  --     מבטיח זאת, והבדיקה כאן היא על הכיוון שהאילוץ אינו מכסה — NULL.
  select count(*) into v_dup_key
    from (select i.morning_doc_id from public.invoices i
           where i.morning_doc_id is not null
           group by 1 having count(*) > 1) t;
  if v_dup_key <> 0 then
    raise exception '0083 canary: % מפתחות morning_doc_id מופיעים יותר מפעם אחת', v_dup_key;
  end if;

  -- 3e. ⚠️ הבדיקה שמוכיחה שהמטרה הושגה: שער 1 לא ימצא עוד דבר. seedInvoiceKeys
  --     (reconcile.ts:407) בונה בדיוק שתי מחרוזות לכל מספר, ומחפש אותן בשתי
  --     עמודות. אפס התאמות פירושו ש-linkDocumentToJob היה עובר עכשיו ב-29.
  select count(*) into v_seed_left
    from jsonb_to_recordset(v_map) as m(num text)
    join public.invoices i
      on i.morning_doc_id in ('biz-' || m.num || '.0', 'tax-' || m.num || '.0')
      or i.doc_number     in ('biz-' || m.num || '.0', 'tax-' || m.num || '.0');
  if v_seed_left <> 0 then
    raise exception '0083 canary: שער 1 עדיין מוצא % שורות זרע ל-29 המסמכים', v_seed_left;
  end if;

  -- =====================================================================
  -- 4. הפנקס — באותו בלוק אטומי, נופל או עובר עם השינוי
  -- =====================================================================
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0083', now(), 'bnaya',
    'אימוץ 29 שורות הזרע ב-invoices. 29 שורות invoices, 29 שורות documents, 29 שורות ביומן, אפס שינוי סכימה ואפס DELETE. הרקע: 0e6b3ca הוסיף את linkPreflight ל-linkDocumentToJob, ושער 1 שלו ב-reconcile.ts:459-497 מסרב לשייך מסמך 300/305/320 כשקיימת לו שורת invoices ישנה, כדי שלא ייווצר רישום שני לאותו חיוב בסכום אחר. השער עושה בדיוק את מה שנבנה לעשות, והמחיר הוא ש-29 מסמכים אמיתיים נתקעים: לכל אחד מהם יש כבר job יחיד שנושא את מספרו, ויש לו שורת זרע יחידה שמתארת את אותו חיוב עצמו. הקובץ מאמץ את שורת הזרע במקום להוסיף שורה שנייה לצידה, ואחרי האימוץ שער 1 לא מוצא עוד מפתח סינתטי לאף אחד מה-29. בהכרעת הבעלים שער 1 נשאר כפי שהוא וגם הנוסח הקישור דורש טיפול ידני נשאר, כי זה תיקון נתונים ולא שינוי כלל: ההגנה ממשיכה לחול על כל שיוך עתידי, וכל שורת זרע שנותרת ממשיכה לחסום וזה נכון, כי היא מקרה שאיש טרם הכריע בו. הפרדיקט שהגדיר את 29, שנמדד על נתונים חיים 15.9.26 ונמדד שוב ברגע ההרצה: מסמך מסוג 300 או 305 או 320, לא מבוטל ולא מאורכב, documents.job_id ריק ו-bundle_job_ids ריק; job יחיד בכל המסד שנושא את מספר המסמך ב-invoice_biz או ב-invoice_tax; אותו לקוח למסמך ול-job ולשורת הזרע; ושורת זרע יחידה עם source שווה manual, job_id ריק ומפתח בצורת biz מקף מספר נקודה אפס או tax מקף מספר נקודה אפס. סך הכל 29 שורות, ברוטו 436,085.52 ונטו 369,564, על 26 עבודות; שלוש עבודות מקבלות שתי שורות כל אחת, אחת עסקה ואחת מס, וזה תקין כי אלה ה-300 וה-320 של אותה עבודה. מה נכתב לכל שורת זרע: job_id מקבל את העבודה, וזו הכתיבה שמכניסה את השורה לתצוגה לראשונה כי finance/page.tsx:41 עושה continue על job_id ריק ולכן כל 154 שורות הזרע בלתי נראות היום; morning_doc_id מקבל את ה-uuid האמיתי במקום המפתח הסינתטי, וזה מה שמסיר אותן משער 1 ומכניס אותן ל-dedupe של reconcile.ts:589 ושל issue.ts:589; doc_number מקבל את המספר החשוף, שבתצוגה הוא no-op כי finance/page.tsx:76,81 קורא את עמודת ה-job קודם וה-job גובר בכל 29, והערך נכתב כדי שאפשר יהיה למצוא שורה לפי מספר מסמך; type נגזר מסוג המסמך ולא מקידומת המפתח; amount מקבל את documents.amount כלומר ברוטו; source מקבל morning_api, כי שורת הזרע מתארת מסמך שהגיע ממורנינג במשיכה ו-manual היה מצייר תג ידני כתום ב-FinanceClient.tsx:902 על מסמך שאיש לא הקליד; issued_at מקבל את document_date; pdf_url מקבל את ה-PDF של המסמך, שקיים בכל 29 ואינו קיים באף שורת זרע; date_is_estimated מקבל false כי התאריך מגיע מהמסמך עצמו, ושתיים מה-29 נושאות true היום ויורדות מספירת ההתראה ב-alerts.ts:323; ו-issued_by נשאר ריק לפי מוסכמת 0064 ו-0066 שלפיה מיגרציה עשתה זאת ולא אדם. ההכרעה היחידה בקובץ שאינה העתקה היא ה-type של 50058 ושל 50060: שניהם מסמכי 305, אבל בגיליון המקור הם נרשמו תחת הקידומת biz ולכן שורת הזרע שלהם נושאת עסקה, והקובץ כותב להם מס לפי סוג המסמך. בלי זה finance/page.tsx:73 היה מוצא אותן כ-bizDoc ומציג PDF של חשבונית מס במשבצת של חשבון העסקה. שתי אלה הן גם היחידות שמצב אימוץ בתוך linkDocumentToJob לא היה משחרר, כי שער 2 ב-reconcile.ts:508 משווה את job.invoice_tax שנושא 80053 ו-80054 מול 50058 ו-50060 ומסרב; מיגרציה כותבת את ה-type ישירות ואינה נזקקת לשאלה. עמודות ה-jobs לא נגעו, לא invoice_biz ולא invoice_tax ולא paid, וזו אינה הימנעות אלא מדידה: ב-29 מתוך 29 העמודה שהמסמך היה ממלא כבר מלאה ולכן jobPatch ב-reconcile.ts:579-583 ריק בכולם וה-update על jobs אינו נקרא אפילו פעם אחת, וגם flippedPaid כבוי כי רק שניים מה-29 הם 320 ושני ה-jobs שלהם כבר paid שווה כן. מה שזה מזיז במסך אינו doc_number אלא עצם ההופעה: 29 השורות נכנסות ל-invByJob לראשונה ואיתן קישור PDF במסך הכספים, וחמש שורות מס נוספות שיחזרו מ-jobs/[id]/show-link; שום סכום על שום מסך אינו זז, כי אף קורא במערכת אינו בוחר את invoices.amount בכלל ונבדקו כל שמונת אתרי הקריאה. העמודה amount נשארת מעורבת וזה נאמר במפורש ולא מושאר לשתיקה: אחרי הקובץ 29 שורות עוברות לברוטו ומצטרפות ל-47 שורות ה-morning_api, ו-125 שורות זרע נותרות בנטו, כך שמי שיסכם את העמודה יקבל מספר חסר משמעות היום ואחרי; זה לא נסגר כאן כי הסגירה היא הכרעה על 125 שורות שאיש לא סיווג אחת אחת. ה-DELETE בביטול מתחיל לחול על 29 השורות: cancel/route.ts:66-71 מוחק invoices לפי morning_doc_id ומגודר ב-if jobId, והיום שתי הרגליים סגורות כי המפתח סינתטי ו-documents.job_id ריק; אחרי הקובץ שתיהן נפתחות וביטול אחד מ-29 המסמכים ימחק את שורת הזרע שלו. בהכרעת הבעלים זה מקובל ונחשב כמו כל מסמך משויך, והקוד לא משתנה; נרשם כאן כדי שיהיה ידוע ולא יתגלה. שלוש עשרה קבוצות בדיקה לפני שורת הפנקס: הפנקס מכיל 0082 ואינו מכיל 0083; הרשימה היא 29 שלשות בלי מזהה כפול ב-seed וב-doc ועם בדיוק 26 עבודות שונות, כי job כן חוזר והבדיקה מכוונת לכך; כל שורת זרע במצב שנמדד, source ו-job_id והמפתח הסינתטי ושוויון doc_number למפתח; כל מסמך במצב שנמדד, סוג ושיוך ו-bundle וביטול וארכוב ו-uuid ו-pdf_url ו-document_date ו-client_id ו-amount; זהות הסכום בשני כיוונים בלתי תלויים, הנטו שווה לברוטו חלקי 1.18 והנטו שווה לסכום העבודה, וכשל בה עוצר את כל הקובץ ולא מדלג על שורה כי שורה שאומצה לכתובת הלא נכונה היא כסף שנרשם על עבודה זרה; ה-job הוא באמת היחיד שנושא את המספר והלקוח זהה בשלושתם; אין שורת invoices אחרת על ה-uuid האמיתי ואין אחת על המספר החשוף, אחרת ה-UPDATE היה נופל על invoices_morning_doc_id_key באמצע; שלושת ענפי jobPatch כבויים, וזו ההוכחה שעמודות ה-jobs אינן צריכות לזוז ולא הימנעות; הסכומים הכוללים הם אלה שנמדדו, מה שתופס שורה שהחליפה סכום גם אם כל בדיקה פרטנית עברה; בדיוק 29 שורות invoices ו-29 שורות documents עודכנו ו-29 אירועים עם via שווה 0083_adopt נכתבו; כל שדה שנכתב נקרא חזרה מהטבלה ונבדק מול המקור שממנו נגזר, ולא מונח מספירת השורות; 50058 ו-50060 נושאות מס; md5 על כל עמודה של כל שורה ב-jobs זהה לפני ואחרי, וזו הטענה הנושאת שמפרידה בין אימוץ רישום לבין יצירת כסף; md5 על כל שורות invoices שמחוץ ל-29 זהה לפני ואחרי ומספר השורות בטבלה זהה, מה שמכסה גם את 125 שורות הזרע שנשארות; אפס מפתח morning_doc_id שמופיע יותר מפעם אחת; ושער 1 לא מוצא עוד שורת זרע לאף אחד מ-29 המסמכים, כלומר המטרה הושגה ו-linkDocumentToJob היה עובר בהם עכשיו. הרשאות מוצהרות לפי כלל 49: הקובץ אינו יוצר שום אובייקט נושא-ACL, לא טבלה ולא עמודה ולא טיפוס ולא policy ולא אינדקס ולא view, ואינו מחליף שום פונקציה; הוא כותב ערכים לעמודות קיימות בשתי טבלאות ומוסיף שורות ל-events, ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות. החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: invoices כבר מוגנת ב-RLS דרך invoices_view עם can_view_money ו-invoices_update עם can_edit_money, ו-documents דרך המדיניות שלה, ואף אחת מהן לא נגעה; הקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה וזה המצב הקיים ולא דבר שהוא יוצר. מחוץ להיקף במכוון: שבע השורות הנותרות בקבוצה ב, שהן שתי קבלות 400 ששער 1 ממילא מדלג עליהן ושתי שורות שבהן הלקוח אינו תואם ושלוש שבהן יותר מ-job אחד נושא את המספר, וכל אחת מהן דורשת הכרעה אנושית שהקובץ אינו יכול לקבל; 112 שורות קבוצה ג, שהמסמך שלהן אינו משויך ואין job שנושא את מספרו, ולכן אין ל-job_id מה לקבל; שתי שורות הזרע שאינן מותאמות לשום מסמך, biz-40628.0 שכמעט ודאי שיכול ספרות של 40268 שהנטו שלו 300 תואם בדיוק ו-biz-400222.0 שסכומו אינו תואם את 40222 ולכן אינו מזוהה; ושתי הכפילויות הקיימות, tax-60167.0 ו-biz-40266.0, שלשני המסמכים שלהן כבר יש שורת morning_api משויכת ולכן הן ספירה כפולה אמיתית שנוצרה לפני linkPreflight, והן נמחקות ב-0084 ולא כאן כי מחיקה היא פעולה אחרת מאימוץ ומגיעה לה שורת פנקס משלה.');

  -- =====================================================================
  -- 5. NOTICE — מה שהבעלים מדביק בחזרה
  -- =====================================================================
  raise notice '0083 עודכנו: % שורות invoices · % שורות documents · % אירועי יומן', v_upd_inv, v_upd_doc, v_events;
  raise notice '0083 סכומים : ברוטו % (נכתב) · נטו % (הוחלף) · % עבודות', v_gross_sum, v_net_sum, 26;
  raise notice '0083 invoices: % שורות לפני, % אחרי (אפס שורה נוצרה או נמחקה)', v_inv_pre, v_inv_post;
  raise notice '0083 jobs    : md5 זהה לפני ואחרי — אפס עמודה זזה';
  raise notice '0083 שער 1   : % שורות זרע נותרו ל-29 המסמכים (0 = המטרה הושגה)', v_seed_left;
  raise notice '0083 נשארו   : 125 שורות זרע בנטו, מחוץ להיקף; 2 כפילויות ל-0084';
  raise notice '0083 הוחלה ונרשמה.';

end $mig$;
