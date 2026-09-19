-- ============================================================================
-- 0093 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה המיגרציה עושה: יוצרת **שני jobs** לסבטלנה ניקסון על שתי שרשראות חיוב
-- שנגבו במלואן ומעולם לא נרשמו כעבודה, מקשרת אותם לארבע ההפקות שלהם, מאמצת
-- את **ארבע** שורות הזרע החוסמות, ומצמידה את ארבעת המסמכים.
--
-- ═══ שתי השרשראות ═══
--   א׳  10202 → 40207 (300, ₪4,248, 28.02) → 60141 (320, ₪4,248, 10.05)
--       ₪3,600 נטו · הקלטה 19.02.2026 · שלוש הפקות
--   ב׳  10248 → 40249 (300, ₪1,416, 31.05) → 60160 (320, ₪1,416, 23.06)
--       ₪1,200 נטו · הקלטה 10.05.2026 · הפקה אחת
--
-- ⚠️ שרשרת א׳ **חוצה את שני מזהי המורנינג באמצע** — 10202 ו-40207 נושאים את
--    `0b3b8274` (ממופה) ו-60141 נושא את `90b369a5` (יתום). זה F10 בתמונה אחת.
--
-- ═══ הסכום, ומה הראיה — אומת מול הבעלים 19.9 ═══
--   ברוטו ÷ 1.18:      4,248 ÷ 1.18 = 3,600   ·   1,416 ÷ 1.18 = 1,200
--   שתי שורות הזרע:    3,600 ו-3,600          ·   1,200 ו-1,200
--   issued_at שלהן:    2026-02-19             ·   2026-05-10
--   הפקות באותו תאריך: 3                      ·   1
--   מתחלק ב-1,200:     3 × 1,200 ✅            ·   1 × 1,200 ✅
-- 🎯 `issued_at` של שורות הזרע נופל **בדיוק** על תאריכי ההקלטה — זה מה שקושר
--    את הכסף להפקות ולא רק לתאריך מסמך. **מחיר מלא, ₪1,200 לפרק, בלי הנחה.**
--
-- ═══ paid='כן' בלידה, וההכרעה מאחוריו ═══
-- שתי השרשראות מסתיימות ב-**320** (חשבונית מס/קבלה), ו-320 הוא ב-PAYMENT_TYPES
-- מפני שהוא **הוכחת תשלום**. שני המסמכים קיימים, `status=1`, לא בוטלו. הכרעת
-- בעלים: `'לא ידוע'` היה מייצר **חוב מדומה על כסף שהתקבל**.
-- ⚠️ ההשוואה שמאשרת שהכלל מבחין: `d39c2148` (אוגוסט) אינו משולם, ו-40305 שלו
--    הוא `status=0` **בלי 320**. אותו מבנה ראיה, תוצאה הפוכה.
--
-- ═══ kind='internal' — אינו חוסם, ואינו נוגעים בו ═══
-- נבדק 19.9: `job_productions` נושאת PK ושני FK בלבד — אפס טריגר, אפס CHECK —
-- ו-`jobs` נושאת רק `trg_compute_due_date` על INSERT; שני הגארדים האחרים הם
-- `BEFORE UPDATE` בלבד. P9 הוא על `on_production_approved`, טריגר על
-- `productions.status`, ומיגרציה אינה עוברת דרכו. **הדגל נשאר `internal`
-- בהכרעת בעלים**, וארבע ההפקות יציגו תג "פנימי" למרות שחויבו ושולמו — נרשם
-- ב-P9 כדוגמה החיה.
--
-- ═══ מה הקובץ מכוון לא לעשות ═══
-- אפס שינוי סכימה · אפס DELETE · **אפס נגיעה ב-`productions`** (לא kind ולא
-- status) · אפס נגיעה ב-`clients` (F10 בא אחר כך) · אפס UPDATE על job קיים.
-- מבחנים 7-9 נועלים את שלושת אלה ב-md5.
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API.
-- הצלחה:  ✅ 0093 DRY RUN OK — ...   ·   כישלון: ❌ ...
-- ⚠️ auth.uid() הוא null דרך Management API; actor_id ייצא null. צפוי.
-- ============================================================================
do $dry$
declare
  c_client  constant uuid := 'b42808ad-4e91-4951-bcff-23111644a88b'; -- סבטלנה ניקסון
  c_show    constant uuid := 'b6357a2f-50c2-46b1-afa6-dc7caac02fc8'; -- אסתטיטוקס

  -- שרשרת א׳
  c_d40207  constant uuid := 'c646b773-b388-4693-ab7d-aa7c8a22e8de';
  c_d60141  constant uuid := '88dd8183-d9da-4037-8856-5bd7fe7ba014';
  c_s40207  constant uuid := '2d093a2a-9fc1-4bc2-92fb-b3874ff54730'; -- biz-40207.0
  c_s60141  constant uuid := 'af3b081e-2799-40d9-85f9-1bf09f538d55'; -- tax-60141.0
  c_p7      constant uuid := '1cbaaf6c-4b80-46ab-835d-a9ac2f9f707b'; -- פרק 7 · דפי
  c_p8      constant uuid := '46c244e6-4b55-411c-8acc-5ee19815b654'; -- פרק 8 · ליסה
  c_p9      constant uuid := '5b260ec3-3728-4fe3-84a3-bf90b16712cf'; -- פרק 9 · עמית

  -- שרשרת ב׳
  c_d40249  constant uuid := '86b05230-23dd-4518-be2d-d0934406af1d';
  c_d60160  constant uuid := 'be2a9274-dc48-40ec-8bbf-e7d69a0caf99';
  c_s40249  constant uuid := '90c499c5-325d-403b-a5da-10686d8da62a'; -- biz-40249.0
  c_s60160  constant uuid := '78059f40-afcc-49cb-b3c1-70e17b6e8f1c'; -- tax-60160.0
  c_pB      constant uuid := '310e37c8-91a3-4530-a815-f12dd94d8d09'; -- 10.05

  v_job_a uuid; v_job_b uuid;
  v_jobs_before text; v_jobs_after text;
  v_inv_before  text; v_inv_after  text;
  v_prod_before text; v_prod_after text;
  v_inv_rows_before int; v_inv_rows_after int;
  v_rev_before numeric; v_rev_after numeric;
  v_n int; v_txt text; v_due date;
  v_prob int;   -- שער הבקרה של כלל 51: מוכיח שהשאילתה מוצאת שורות בכלל
  v_fail text := ''; v_rep text := '';
begin
  -- ══ 0. מצב הפתיחה ═════════════════════════════════════════════════════════

  -- 0a. ארבעת המסמכים, כל אחד במצב שנמדד.
  --
  -- ⚠️ כלל 51. הצורה כאן היא VALUES + join ולא `(…) in ((…))`, ו-`job_id is null`
  -- הוא תנאי **נפרד**. הניסוח הראשון של השער היה:
  --     where (id, …, job_id) in ((c_d40207, …, null), …)
  -- והוא החזיר 0 מתוך 4 על נתונים תקינים לחלוטין: השוואת שורה משווה איבר מול
  -- איבר, `job_id = null` מחזיר NULL ולא true, ולכן הפרדיקט אינו יכול להתקיים
  -- על שום שורה. `row(1,null) in (row(1,null))` הוא NULL; `row(1,'a') in
  -- (row(1,'a'))` הוא true. הצורה שלמטה פשוט אינה מאפשרת לכתוב את זה.
  with expected(num, eid, etype, eamount, edate) as (
    values ('40207', c_d40207, 300, 4248::numeric, date '2026-02-28'),
           ('60141', c_d60141, 320, 4248,          date '2026-05-10'),
           ('40249', c_d40249, 300, 1416,          date '2026-05-31'),
           ('60160', c_d60160, 320, 1416,          date '2026-06-23')
  )
  select count(*), string_agg(e.num, ', ' order by e.num)
    into v_n, v_txt
  from expected e
  join public.documents d on d.id = e.eid
  where d.morning_doc_number = e.num
    and d.type            = e.etype
    and d.amount          = e.eamount
    and d.document_date   = e.edate
    and d.job_id          is null          -- ← תנאי נפרד, לעולם לא בתוך row
    and d.cancelled_at    is null
    and d.archived_at     is null
    and d.pdf_url         is not null
    and d.status          = 1
    and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0);
  if v_n <> 4 then
    -- אומר **מי עבר**, כדי שההפרש יזהה את מי שנפל בלי חקירה נוספת
    raise exception '❌ 0093 DRY RUN: % מתוך 4 המסמכים במצב שנמדד. עברו: [%]. הנופלים הם היתר מתוך 40207, 60141, 40249, 60160.',
      v_n, coalesce(v_txt, 'אף אחד');
  end if;

  -- 0b. השרשראות, כפי שהמסמכים עצמם מצהירים עליהן
  if (select parent_doc_numbers from public.documents where id=c_d60141) <> array['40207']
     or (select parent_doc_numbers from public.documents where id=c_d60160) <> array['40249'] then
    raise exception '❌ 0093 DRY RUN: parent_doc_numbers אינו כפי שנמדד — השרשראות אינן מה שחשבנו.';
  end if;

  -- 0c. ארבע שורות הזרע, יחידות ובמצב שנמדד. אותה צורה, ומאותה סיבה — כלל 51.
  with expected(key, eid, eamount) as (
    values ('biz-40207.0', c_s40207, 3600::numeric),
           ('tax-60141.0', c_s60141, 3600),
           ('biz-40249.0', c_s40249, 1200),
           ('tax-60160.0', c_s60160, 1200)
  )
  select count(*), string_agg(e.key, ', ' order by e.key)
    into v_n, v_txt
  from expected e
  join public.invoices i on i.id = e.eid
  where i.morning_doc_id = e.key
    and i.amount         = e.eamount
    and i.client_id      = c_client
    and i.source         = 'manual'
    and i.job_id         is null;         -- ← תנאי נפרד, לעולם לא בתוך row
  if v_n <> 4 then
    raise exception '❌ 0093 DRY RUN: % מתוך 4 שורות הזרע במצב שנמדד. עברו: [%].',
      v_n, coalesce(v_txt, 'אף אחת');
  end if;
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')
      or doc_number     in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0');
  if v_n <> 4 then
    raise exception '❌ 0093 DRY RUN: % שורות נושאות את מפתחות הזרע, ציפיתי 4 בדיוק.', v_n;
  end if;

  -- 0d. ואין כבר שורה על ה-uuid האמיתי של אף אחד מהארבעה.
  --
  -- ⚠️ כלל 51, החצי השני. השער הזה מנוסח "ודא שאין כלום", וזה הניסוח שבו
  -- שאילתה שבורה **מאשרת בשתיקה**: היא מחזירה 0, השער מרוצה, והכתיבה ממשיכה
  -- על נתון שמעולם לא נבדק. לכן לצידו שער חיובי שמוכיח שצורת החיפוש הזו
  -- בכלל **מוצאת** שורות — אותו join בדיוק מול המפתחות הסינתטיים, שקיימים
  -- ברגע זה וחייבים להחזיר 4. אם החיובי מחזיר 4 והשלילי מחזיר 0, ה-0 הוא
  -- עובדה; אם שניהם מחזירים 0, השאילתה שבורה והקובץ עוצר.
  select count(*) into v_n
  from public.invoices i
  join public.documents d on d.morning_doc_id = i.morning_doc_id
  where d.id in (c_d40207, c_d60141, c_d40249, c_d60160);

  select count(*) into v_prob
  from public.invoices i
  join (values ('biz-40207.0'), ('tax-60141.0'), ('biz-40249.0'), ('tax-60160.0')) as k(key)
    on k.key = i.morning_doc_id;

  if v_prob <> 4 then
    raise exception '❌ 0093 DRY RUN: שער הבקרה החזיר % ולא 4 — צורת החיפוש ב-invoices שבורה, ולכן ה-0 של שער 0d חסר משמעות.', v_prob;
  end if;
  if v_n <> 0 then
    raise exception '❌ 0093 DRY RUN: קיימות % שורות invoices על uuid אמיתי — אימוץ ייצור כפילות.', v_n;
  end if;

  -- 0e. ארבע ההפקות: קיימות, חיות, בתוכנית הנכונה, ו**אפס jobs**
  select count(*) into v_n from public.productions
   where id in (c_p7,c_p8,c_p9,c_pB) and show_id = c_show
     and cancelled_at is null and merged_into is null
     and not exists (select 1 from public.job_productions jp where jp.production_id = productions.id);
  if v_n <> 4 then
    raise exception '❌ 0093 DRY RUN: % מתוך 4 ההפקות פנויות ובמצב שנמדד.', v_n;
  end if;
  if (select count(*) from public.productions where id in (c_p7,c_p8,c_p9) and record_date = date '2026-02-19') <> 3
     or (select record_date from public.productions where id = c_pB) <> date '2026-05-10' then
    raise exception '❌ 0093 DRY RUN: תאריכי ההקלטה אינם 19.02 (×3) ו-10.05.';
  end if;

  -- 0f. ⚠️ זהות הסכום בשני כיוונים בלתי תלויים, לשתי השרשראות.
  --     כשל כאן עוצר את הקובץ — סכום שגוי הוא עבודה שנולדת על כסף שאינו שלה.
  if (select amount from public.invoices where id=c_s40207) <> 3600
     or abs(4248 / 1.18 - 3600) > 0.01
     or (select amount from public.invoices where id=c_s40249) <> 1200
     or abs(1416 / 1.18 - 1200) > 0.01 then
    raise exception '❌ 0093 DRY RUN: זהות הסכום נכשלה.';
  end if;
  if 3600 <> 3 * 1200 or 1200 <> 1 * 1200 then
    raise exception '❌ 0093 DRY RUN: הסכום אינו מתחלק ב-₪1,200 לפרק.';
  end if;

  v_rep := v_rep || 'מצב פתיחה — 4 מסמכים, 4 שורות זרע, 4 הפקות פנויות, שרשראות וסכומים כפי שנמדדו. | ';

  -- ══ 1. טביעות אצבע לפני ═══════════════════════════════════════════════════
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_before from public.jobs j;

  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text, ',' order by i.id),'')),
         count(*)
    into v_inv_before, v_inv_rows_before
  from public.invoices i where i.id not in (c_s40207,c_s60141,c_s40249,c_s60160);

  -- ⚠️ ההפקות נועלות גם את kind ואת status — הקובץ אינו אמור לגעת בהן בכלל.
  select md5(coalesce(string_agg(p.id::text||'|'||p.kind::text||'|'||p.status::text||'|'||
                                 coalesce(p.record_date::text,'-')||'|'||coalesce(p.price_override::text,'-'),
                                 ',' order by p.id),''))
    into v_prod_before from public.productions p;

  select coalesce(sum(x.share),0) into v_rev_before from (
    select j.amount / count(*) over (partition by jp.job_id) as share
    from public.job_productions jp
    join public.productions p on p.id = jp.production_id
    join public.jobs j on j.id = jp.job_id
    where j.dismissed = false and j.amount is not null
      and p.cancelled_at is null and p.merged_into is null and p.show_id = c_show) x;

  -- ══ 2. המעשה — בדיוק מה שהמיגרציה תכתוב ═══════════════════════════════════

  -- 2a. שני ה-jobs. due_date לא נכתב — trg_compute_due_date יורה על INSERT
  --     והלקוחה היא immediate, ולכן הפירעון יוצא שווה לתאריך.
  insert into public.jobs (client_id, date, campaign, amount, paid, invoice_biz, invoice_tax, legacy)
  values (c_client, date '2026-02-19', '3 פרקים', 3600, 'כן', '40207', '60141', true)
  returning id into v_job_a;

  insert into public.jobs (client_id, date, campaign, amount, paid, invoice_biz, invoice_tax, legacy)
  values (c_client, date '2026-05-10', 'אסתטיטוקס', 1200, 'כן', '40249', '60160', true)
  returning id into v_job_b;

  -- 2b. הקישור להפקות
  insert into public.job_productions (job_id, production_id)
  values (v_job_a, c_p7), (v_job_a, c_p8), (v_job_a, c_p9), (v_job_b, c_pB);

  -- 2c. אימוץ ארבע שורות הזרע. ה-type נגזר מסוג המסמך, לא מקידומת המפתח.
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
    from (values (c_s40207, c_d40207, v_job_a), (c_s60141, c_d60141, v_job_a),
                 (c_s40249, c_d40249, v_job_b), (c_s60160, c_d60160, v_job_b)) as m(seed, doc, job)
    join public.documents d on d.id = m.doc
   where i.id = m.seed and i.source = 'manual' and i.job_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 0: אומצו %s שורות זרע, ציפיתי 4. ', v_n);
  end if;

  -- 2d. ארבעת המסמכים. client_id רק אם ריק — 40207 כבר נושא אותו.
  update public.documents d
     set job_id     = m.job,
         client_id  = coalesce(d.client_id, c_client),
         updated_at = now()
    from (values (c_d40207, v_job_a), (c_d60141, v_job_a),
                 (c_d40249, v_job_b), (c_d60160, v_job_b)) as m(doc, job)
   where d.id = m.doc and d.job_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 0ב: עודכנו %s מסמכים, ציפיתי 4. ', v_n);
  end if;

  -- ══ 3. המבחנים ════════════════════════════════════════════════════════════

  -- מבחן 1 — Job A נולד נכון, כולל due_date שהטריגר חישב
  select count(*) into v_n from public.jobs
   where id = v_job_a and client_id = c_client and date = date '2026-02-19'
     and campaign = '3 פרקים' and amount = 3600 and paid = 'כן'
     and invoice_biz = '40207' and invoice_tax = '60141' and legacy = true and dismissed = false;
  select due_date into v_due from public.jobs where id = v_job_a;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 1: Job A לא נולד כנדרש. ';
  elsif v_due is distinct from date '2026-02-19' then
    v_fail := v_fail || format('מבחן 1: due_date של Job A הוא %s ולא 2026-02-19 (immediate). ', v_due);
  else
    v_rep := v_rep || 'מבחן 1 — Job A: ₪3,600 · 19.02 · 3 פרקים · paid=כן · 40207/60141 · פירעון 19.02. | ';
  end if;

  -- מבחן 2 — Job B
  select count(*) into v_n from public.jobs
   where id = v_job_b and client_id = c_client and date = date '2026-05-10'
     and campaign = 'אסתטיטוקס' and amount = 1200 and paid = 'כן'
     and invoice_biz = '40249' and invoice_tax = '60160' and legacy = true and dismissed = false;
  select due_date into v_due from public.jobs where id = v_job_b;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 2: Job B לא נולד כנדרש. ';
  elsif v_due is distinct from date '2026-05-10' then
    v_fail := v_fail || format('מבחן 2: due_date של Job B הוא %s ולא 2026-05-10. ', v_due);
  else
    v_rep := v_rep || 'מבחן 2 — Job B: ₪1,200 · 10.05 · אסתטיטוקס · paid=כן · 40249/60160 · פירעון 10.05. | ';
  end if;

  -- מבחן 3 — הקישור להפקות: 3 ל-A, 1 ל-B, ואף הפקה אחרת לא נגעה
  if (select count(*) from public.job_productions where job_id = v_job_a) <> 3
     or (select count(*) from public.job_productions where job_id = v_job_b) <> 1 then
    v_fail := v_fail || 'מבחן 3: מספר הקישורים אינו 3 ו-1. ';
  elsif (select count(*) from public.job_productions where job_id = v_job_a
           and production_id in (c_p7,c_p8,c_p9)) <> 3
     or (select production_id from public.job_productions where job_id = v_job_b) <> c_pB then
    v_fail := v_fail || 'מבחן 3: הקישורים הצביעו על הפקות אחרות. ';
  else
    v_rep := v_rep || 'מבחן 3 — 3 הפקות ל-Job A (פרקים 7/8/9 מ-19.02), הפקה אחת ל-Job B. | ';
  end if;

  -- מבחן 4 — ארבע שורות הזרע אומצו, כל שדה מול המקור שממנו נגזר
  select count(*) into v_n
  from (values (c_s40207, c_d40207, v_job_a), (c_s60141, c_d60141, v_job_a),
               (c_s40249, c_d40249, v_job_b), (c_s60160, c_d60160, v_job_b)) as m(seed, doc, job)
  join public.invoices i on i.id = m.seed
  join public.documents d on d.id = m.doc
  where i.job_id = m.job and i.morning_doc_id = d.morning_doc_id
    and i.doc_number = d.morning_doc_number and i.amount = d.amount
    and i.source = 'morning_api' and i.issued_at = d.document_date::timestamptz
    and i.date_is_estimated = false and i.pdf_url is not distinct from d.pdf_url
    and i.type = (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type
    and i.issued_by is null;
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 4: %s מתוך 4 שורות הזרע אומצו נכון. ', v_n);
  else
    v_rep := v_rep || 'מבחן 4 — 4 שורות הזרע אומצו: uuid אמיתי, מספר חשוף, ברוטו, morning_api, PDF. | ';
  end if;

  -- מבחן 5 — ארבעת המסמכים הוצמדו וכולם נושאים את הלקוחה
  select count(*) into v_n from public.documents
   where id in (c_d40207,c_d60141,c_d40249,c_d60160) and client_id = c_client
     and job_id in (v_job_a, v_job_b);
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 5: %s מתוך 4 המסמכים הוצמדו. ', v_n);
  else
    v_rep := v_rep || 'מבחן 5 — 4 המסמכים הוצמדו וקיבלו את סבטלנה ניקסון. | ';
  end if;

  -- מבחן 6 — אפס מפתח סינתטי נותר, ואפס morning_doc_id כפול בכל הטבלה
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')
      or doc_number     in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0');
  if v_n <> 0 then
    v_fail := v_fail || format('מבחן 6: נותרו %s מפתחות סינתטיים — שער 1 עדיין יחסום. ', v_n);
  elsif (select count(*) from (select morning_doc_id from public.invoices
           where morning_doc_id is not null group by 1 having count(*) > 1) x) <> 0 then
    v_fail := v_fail || 'מבחן 6: קיים morning_doc_id כפול. ';
  else
    v_rep := v_rep || 'מבחן 6 — אפס מפתח סינתטי לארבעה, אפס uuid כפול. | ';
  end if;

  -- מבחן 7 — 🔴 שום job קיים לא נגע. md5 על כל הטבלה מלבד שתי החדשות.
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_after from public.jobs j where j.id not in (v_job_a, v_job_b);
  if v_jobs_after is distinct from v_jobs_before then
    v_fail := v_fail || 'מבחן 7: job קיים השתנה! הקובץ אמור רק להוסיף. ';
  else
    v_rep := v_rep || format('מבחן 7 — jobs הקיימים זהים בתו (%s). | ', left(v_jobs_after,8));
  end if;

  -- מבחן 8 — שום שורת invoices אחרת לא זזה, ואף שורה לא נוספה ולא נמחקה
  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text, ',' order by i.id),'')),
         count(*)
    into v_inv_after, v_inv_rows_after
  from public.invoices i where i.id not in (c_s40207,c_s60141,c_s40249,c_s60160);
  if v_inv_after is distinct from v_inv_before or v_inv_rows_after <> v_inv_rows_before then
    v_fail := v_fail || format('מבחן 8: invoices אחרות זזו, או שהשתנה מספר השורות (%s → %s). ',
                               v_inv_rows_before, v_inv_rows_after);
  else
    v_rep := v_rep || 'מבחן 8 — שאר invoices זהה, ואפס שורה נוספה או נמחקה. | ';
  end if;

  -- מבחן 9 — ⚠️ productions לא נגעה כלל, kind ו-status כולל
  select md5(coalesce(string_agg(p.id::text||'|'||p.kind::text||'|'||p.status::text||'|'||
                                 coalesce(p.record_date::text,'-')||'|'||coalesce(p.price_override::text,'-'),
                                 ',' order by p.id),''))
    into v_prod_after from public.productions p;
  if v_prod_after is distinct from v_prod_before then
    v_fail := v_fail || 'מבחן 9: productions השתנתה! kind נשאר internal בהכרעת בעלים. ';
  else
    v_rep := v_rep || format('מבחן 9 — productions זהה בתו, kind עדיין internal (%s). | ', left(v_prod_after,8));
  end if;

  -- מבחן 10 — הזנב של T21 יורד מ-108 ל-104
  select count(*) into v_n from (
    select distinct d.id from public.documents d
    join public.invoices i
      on i.morning_doc_id in ('biz-'||d.morning_doc_number||'.0','tax-'||d.morning_doc_number||'.0')
    where d.type in (300,305,320) and d.job_id is null
      and d.archived_at is null and d.cancelled_at is null
      and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0)) x;
  if v_n <> 104 then
    v_fail := v_fail || format('מבחן 10: הזנב הוא %s ולא 104. ', v_n);
  else
    v_rep := v_rep || 'מבחן 10 — זנב T21 ירד מ-108 ל-104. | ';
  end if;

  -- מבחן 11 — לשונית "לא משויך" יורדת מ-7 מסמכי חיוב ל-4
  select count(*) into v_n from public.documents
   where client_id is null and archived_at is null and cancelled_at is null and type in (300,305,320,400);
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 11: נותרו %s מסמכי חיוב לא-משויכים, ציפיתי 4. ', v_n);
  else
    v_rep := v_rep || 'מבחן 11 — "לא משויך" ירדה מ-7 ל-4 מסמכי חיוב. | ';
  end if;

  -- מבחן 12 — הכנסת אסתטיטוקס עולה ב-₪4,800 בדיוק (זה התיקון, לא תופעת לוואי)
  select coalesce(sum(x.share),0) into v_rev_after from (
    select j.amount / count(*) over (partition by jp.job_id) as share
    from public.job_productions jp
    join public.productions p on p.id = jp.production_id
    join public.jobs j on j.id = jp.job_id
    where j.dismissed = false and j.amount is not null
      and p.cancelled_at is null and p.merged_into is null and p.show_id = c_show) x;
  if round(v_rev_after - v_rev_before) <> 4800 then
    v_fail := v_fail || format('מבחן 12: הכנסת התוכנית זזה ב-%s ולא ב-4800 (%s → %s). ',
                               round(v_rev_after - v_rev_before), round(v_rev_before), round(v_rev_after));
  else
    v_rep := v_rep || format('מבחן 12 — הכנסת אסתטיטוקס %s → %s (+4,800). | ',
                             round(v_rev_before), round(v_rev_after));
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception '❌ 0093 DRY RUN FAILED — %', v_fail;
  end if;

  raise exception '✅ 0093 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
