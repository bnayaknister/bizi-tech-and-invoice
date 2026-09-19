-- ============================================================================
-- 0093 — P19: שני jobs לשתי שרשראות שנגבו במלואן ומעולם לא נרשמו כעבודה
--
-- ⚠️ להריץ את supabase/verify/0093_dryrun.sql לפני. שם, ולא כאן, נמצאת
--    ההוכחה שההיקף הוא שתי עבודות וארבעה מסמכים. כלל 50.
--
-- ═══ שתי השרשראות ═══
--   א׳  10202 → 40207 (300, ₪4,248, 28.02) → 60141 (320, ₪4,248, 10.05)
--       ₪3,600 נטו · הקלטה 19.02.2026 · שלוש הפקות
--   ב׳  10248 → 40249 (300, ₪1,416, 31.05) → 60160 (320, ₪1,416, 23.06)
--       ₪1,200 נטו · הקלטה 10.05.2026 · הפקה אחת
--
-- ⚠️ שרשרת א׳ **חוצה את שני מזהי המורנינג באמצע** — 10202 ו-40207 נושאים את
--    `0b3b8274` (ניקסון מדיקונסלט, ממופה) ו-60141 נושא את `90b369a5` (טל
--    מדיקל גרופ, יתום). אותה עסקה, הראש ממופה והזנב יתום. זה **F10** בתמונה
--    אחת, והוא הסיבה ש-60141 צף בלשונית "לא משויך" בעוד 40207 לא.
--
-- ═══ למה לא היה job מלכתחילה — זה P9, ולא תקלת נתונים ═══
-- ארבע ההפקות קיימות ומתועדות בתוכנית **אסתטיטוקס** (`per_episode`, **עם**
-- לקוח), אבל כולן `kind='internal'`, ו-`on_production_approved` יוצרת job רק
-- כש-`kind='client'`. הטריגר לא ירה, ואף job לא נולד — בשקט.
--
-- ═══ הסכום, ומה הראיה — אומת מול הבעלים 19.9 ═══
--   ברוטו ÷ 1.18:      4,248 ÷ 1.18 = 3,600   ·   1,416 ÷ 1.18 = 1,200
--   שתי שורות הזרע:    3,600 ו-3,600          ·   1,200 ו-1,200
--   issued_at שלהן:    2026-02-19             ·   2026-05-10
--   הפקות באותו תאריך: 3                      ·   1
--   מתחלק ב-1,200:     3 × 1,200 ✅            ·   1 × 1,200 ✅
-- 🎯 `issued_at` של שורות הזרע נופל **בדיוק** על תאריכי ההקלטה. זה מה שקושר
--    את הכסף להפקות ולא רק לתאריך מסמך, וזה האות שהכריע את ההיקף.
--    **מחיר מלא, ₪1,200 לפרק, בלי הנחה** — אומת מול הבעלים.
--
-- ═══ paid='כן' בלידה, וההכרעה מאחוריו ═══
-- שתי השרשראות מסתיימות ב-**320** (חשבונית מס/קבלה), ו-320 יושב ב-
-- `PAYMENT_TYPES` מפני שהוא **הוכחת תשלום**. שני המסמכים קיימים, `status=1`,
-- לא בוטלו. הכרעת בעלים: `'לא ידוע'` היה מייצר **חוב מדומה על כסף שהתקבל**.
-- ⚠️ ההשוואה שמאשרת שהכלל מבחין ואינו הנחה גורפת: `d39c2148` (אוגוסט) אינו
--    משולם, ו-40305 שלו הוא `status=0` **בלי 320**. אותו מבנה ראיה, תוצאה
--    הפוכה.
-- ⚠️ ולכן נכתב גם `job_marked_paid`: הוא **הרשומה היחידה של מתי** שולם
--    (alerts.ts:224, issue.ts:130) — ל-`jobs` אין עמודת תאריך תשלום. job
--    שנולד `paid='כן'` בלי האירוע הזה הוא כסף בלי מועד.
--
-- ═══ kind='internal' — אינו חוסם, ואין נוגעים בו ═══
-- נמדד 19.9: `job_productions` נושאת PK ושני FK בלבד — **אפס טריגר, אפס
-- CHECK** — ו-`jobs` נושאת רק `trg_compute_due_date` על INSERT; שני הגארדים
-- האחרים (`guard_job_money_columns`, `guard_job_dismissal`) הם `BEFORE UPDATE`
-- בלבד ולכן אינם חלים על INSERT. P9 הוא על `on_production_approved`, טריגר על
-- `productions.status`, ומיגרציה אינה עוברת דרכו. כלומר **מיגרציה יוצרת job
-- להפקה `internal` בלי שום התנגדות**.
-- 🔴 **הדגל נשאר `internal` בהכרעת בעלים.** ארבע ההפקות ימשיכו להציג תג
--    "פנימי" למרות שחויבו ושולמו במלואן — נרשם ב-**P9** כדוגמה החיה, והן
--    ארבע שורות שאפשר להצביע עליהן כשמכריעים שם. סעיף 4ה נועל את זה עם md5
--    על `productions` **כולל `kind` ו-`status`**, כדי שאיש לא "יתקן בדרך".
--
-- ═══ מה זה מזיז על המסך ═══
-- הכנסת **אסתטיטוקס** עולה מ-₪4,400 ל-**₪9,200** (+₪4,800). ⚠️ זה **התיקון**
-- ולא תופעת לוואי: הכסף נגבה ומעולם לא נספר על התוכנית. נאמר מראש כי זה מספר
-- שיזוז, וסעיף 4ז מוודא שהוא זז בדיוק ב-4,800 ולא באגורה אחרת.
-- לשונית "לא משויך" יורדת מ-7 ל-4 מסמכי חיוב; זנב **T21** מ-108 ל-104.
--
-- ═══ מה הקובץ אינו נוגע בו ═══
-- אפס שינוי סכימה · אפס DELETE · **אפס נגיעה ב-`productions`** · אפס נגיעה
-- ב-`clients` (F10 בא אחרי) · **אפס UPDATE על job קיים** — הקובץ רק מוסיף
-- שניים. סעיפים 4ד-4ו נועלים את שלושת אלה ב-md5.
--
-- ═══ כלל 51 — צורת השערים ═══
-- כל שער השוואה כאן הוא `VALUES` + `join` עם `is null` כתנאי **נפרד**, ולעולם
-- לא `(…) in ((…, null))` — השוואת שורה מחזירה NULL על איבר ריק ולכן אינה
-- יכולה להתקיים. וכל שער מנוסח "ציפיתי ל-N, קבל N"; היחיד שמנוסח "ודא שאין
-- כלום" (סעיף 1ד) נושא לצידו שער בקרה חיובי שמוכיח שהשאילתה מוצאת שורות
-- בכלל, אחרת 0 שלו חסר משמעות.
--
-- ═══ כלל 49 — השפעת ACL, מוצהרת ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא מוסיף שורות
-- ל-`jobs`, ל-`job_productions` ול-`events`, ומעדכן עמודות קיימות ב-`invoices`
-- וב-`documents`. אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות. והחצי
-- השקט, שנאמר בכל זאת: `jobs`, `invoices` ו-`documents` כבר מוגנות ב-RLS ואף
-- אחת מהן לא נגעה; הקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה — מצב קיים,
-- לא דבר שהוא יוצר.
--
-- ═══ מה מחוץ להיקף, במכוון ═══
-- **F10** (טבלת `client_morning_ids`) — בא אחרי, ובמכוון: מדידת `certain`
-- מ-19.9 הראתה שהמפה המורחבת מכניסה זוג **שגוי** ל-`certainPaymentMatches`,
-- `60160 → d39c2148`, מפני ששתי השרשראות הן ₪1,416. הקובץ הזה נותן ל-60160
-- את ה-job האמיתי שלו, ו-`buildEdges` מסנן `!d.job_id` — כלומר **אחרי 0093
-- הזוג השגוי אינו יכול להיווצר כלל**. זו הסיבה שהסדר התהפך. ראה **F14**.
-- 104 מסמכי הזנב הנותרים — **T21**. הדגל `kind` — **P9**.
-- ============================================================================

do $mig$
declare
  c_client  constant uuid := 'b42808ad-4e91-4951-bcff-23111644a88b'; -- סבטלנה ניקסון
  c_show    constant uuid := 'b6357a2f-50c2-46b1-afa6-dc7caac02fc8'; -- אסתטיטוקס

  c_d40207  constant uuid := 'c646b773-b388-4693-ab7d-aa7c8a22e8de';
  c_d60141  constant uuid := '88dd8183-d9da-4037-8856-5bd7fe7ba014';
  c_s40207  constant uuid := '2d093a2a-9fc1-4bc2-92fb-b3874ff54730'; -- biz-40207.0
  c_s60141  constant uuid := 'af3b081e-2799-40d9-85f9-1bf09f538d55'; -- tax-60141.0
  c_p7      constant uuid := '1cbaaf6c-4b80-46ab-835d-a9ac2f9f707b'; -- פרק 7 · דפי
  c_p8      constant uuid := '46c244e6-4b55-411c-8acc-5ee19815b654'; -- פרק 8 · ליסה
  c_p9      constant uuid := '5b260ec3-3728-4fe3-84a3-bf90b16712cf'; -- פרק 9 · עמית

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
  v_n int; v_prob int; v_txt text; v_due date;
begin
  -- ── 0. הפנקס ────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0093') then
    raise exception '0093 עצרה: הקובץ כבר הוחל.';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0092') then
    raise exception '0093 עצרה: 0092 אינו בפנקס — הקבצים מוחלים לפי הסדר.';
  end if;

  -- ── 1. מצב הפתיחה. כל שער כאן נמדד 19.9; אם אחד השתנה, זו כבר לא אותה ──
  --      עובדה, והקובץ עוצר במקום להחליט מחדש.

  -- 1a. ארבעת המסמכים. כלל 51: VALUES + join, ו-is null כתנאי נפרד.
  with expected(num, eid, etype, eamount, edate) as (
    values ('40207', c_d40207, 300, 4248::numeric, date '2026-02-28'),
           ('60141', c_d60141, 320, 4248,          date '2026-05-10'),
           ('40249', c_d40249, 300, 1416,          date '2026-05-31'),
           ('60160', c_d60160, 320, 1416,          date '2026-06-23')
  )
  select count(*), string_agg(e.num, ', ' order by e.num) into v_n, v_txt
  from expected e
  join public.documents d on d.id = e.eid
  where d.morning_doc_number = e.num
    and d.type            = e.etype
    and d.amount          = e.eamount
    and d.document_date   = e.edate
    and d.job_id          is null
    and d.cancelled_at    is null
    and d.archived_at     is null
    and d.pdf_url         is not null
    and d.status          = 1
    and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0);
  if v_n <> 4 then
    raise exception '0093 עצרה: % מתוך 4 המסמכים במצב שנמדד. עברו: [%].', v_n, coalesce(v_txt, 'אף אחד');
  end if;

  -- 1b. השרשראות, כפי שהמסמכים עצמם מצהירים עליהן. זה האות ש-F15 אומר
  --     שהמנוע מתעלם ממנו — כאן הוא נאכף, כי הוא מה שקובע מי שייך למי.
  if (select parent_doc_numbers from public.documents where id = c_d60141) <> array['40207']
     or (select parent_doc_numbers from public.documents where id = c_d60160) <> array['40249'] then
    raise exception '0093 עצרה: parent_doc_numbers אינו כפי שנמדד — השרשראות אינן מה שחשבנו.';
  end if;

  -- 1c. ארבע שורות הזרע, יחידות ובמצב שנמדד
  with expected(key, eid, eamount) as (
    values ('biz-40207.0', c_s40207, 3600::numeric),
           ('tax-60141.0', c_s60141, 3600),
           ('biz-40249.0', c_s40249, 1200),
           ('tax-60160.0', c_s60160, 1200)
  )
  select count(*), string_agg(e.key, ', ' order by e.key) into v_n, v_txt
  from expected e
  join public.invoices i on i.id = e.eid
  where i.morning_doc_id = e.key
    and i.amount         = e.eamount
    and i.client_id      = c_client
    and i.source         = 'manual'
    and i.job_id         is null;
  if v_n <> 4 then
    raise exception '0093 עצרה: % מתוך 4 שורות הזרע במצב שנמדד. עברו: [%].', v_n, coalesce(v_txt, 'אף אחת');
  end if;

  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')
      or doc_number     in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0');
  if v_n <> 4 then
    raise exception '0093 עצרה: % שורות נושאות את מפתחות הזרע, ציפיתי 4 בדיוק.', v_n;
  end if;

  -- 1d. ⚠️ כלל 51, החצי השני. השער "אין שורה על ה-uuid האמיתי" מנוסח כ"ודא
  --     שאין כלום", וזה הניסוח שבו שאילתה שבורה מאשרת בשתיקה. לצידו שער בקרה
  --     חיובי על אותו join בדיוק, מול המפתחות הסינתטיים שקיימים ברגע זה.
  select count(*) into v_n
  from public.invoices i
  join public.documents d on d.morning_doc_id = i.morning_doc_id
  where d.id in (c_d40207, c_d60141, c_d40249, c_d60160);

  select count(*) into v_prob
  from public.invoices i
  join (values ('biz-40207.0'), ('tax-60141.0'), ('biz-40249.0'), ('tax-60160.0')) as k(key)
    on k.key = i.morning_doc_id;

  if v_prob <> 4 then
    raise exception '0093 עצרה: שער הבקרה החזיר % ולא 4 — צורת החיפוש ב-invoices שבורה, ולכן ה-0 של השער הבא חסר משמעות.', v_prob;
  end if;
  if v_n <> 0 then
    raise exception '0093 עצרה: קיימות % שורות invoices על uuid אמיתי — אימוץ ייצור כפילות.', v_n;
  end if;

  -- 1e. ארבע ההפקות: קיימות, חיות, בתוכנית הנכונה, ו**אפס jobs**
  with expected(eid, edate) as (
    values (c_p7, date '2026-02-19'), (c_p8, date '2026-02-19'),
           (c_p9, date '2026-02-19'), (c_pB, date '2026-05-10')
  )
  select count(*) into v_n
  from expected e
  join public.productions p on p.id = e.eid
  where p.show_id      = c_show
    and p.record_date  = e.edate
    and p.cancelled_at is null
    and p.merged_into  is null
    and not exists (select 1 from public.job_productions jp where jp.production_id = p.id);
  if v_n <> 4 then
    raise exception '0093 עצרה: % מתוך 4 ההפקות פנויות, בתאריך הנכון ובתוכנית הנכונה.', v_n;
  end if;

  -- 1f. ⚠️ זהות הסכום בשני כיוונים בלתי תלויים, לשתי השרשראות. כשל כאן עוצר
  --     את הקובץ — סכום שגוי הוא עבודה שנולדת על כסף שאינו שלה.
  if (select amount from public.invoices where id = c_s40207) <> 3600
     or (select amount from public.invoices where id = c_s60141) <> 3600
     or (select amount from public.invoices where id = c_s40249) <> 1200
     or (select amount from public.invoices where id = c_s60160) <> 1200
     or abs(4248 / 1.18 - 3600) > 0.01
     or abs(1416 / 1.18 - 1200) > 0.01
     or 3600 <> 3 * 1200
     or 1200 <> 1 * 1200 then
    raise exception '0093 עצרה: זהות הסכום נכשלה.';
  end if;

  -- ── 2. טביעות אצבע לפני ─────────────────────────────────────────────────
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_before from public.jobs j;

  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text, ',' order by i.id),'')),
         count(*)
    into v_inv_before, v_inv_rows_before
  from public.invoices i where i.id not in (c_s40207, c_s60141, c_s40249, c_s60160);

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

  -- ── 3. הכתיבות ──────────────────────────────────────────────────────────

  -- 3a. שני ה-jobs. due_date לא נכתב — trg_compute_due_date יורה על INSERT
  --     והלקוחה היא `immediate`, ולכן הפירעון יוצא שווה לתאריך. legacy=true
  --     בעקביות ל-591b363e: אלה עבודות מתקופת הגיליון.
  insert into public.jobs (client_id, date, campaign, amount, paid, invoice_biz, invoice_tax, legacy)
  values (c_client, date '2026-02-19', '3 פרקים', 3600, 'כן', '40207', '60141', true)
  returning id into v_job_a;

  insert into public.jobs (client_id, date, campaign, amount, paid, invoice_biz, invoice_tax, legacy)
  values (c_client, date '2026-05-10', 'אסתטיטוקס', 1200, 'כן', '40249', '60160', true)
  returning id into v_job_b;

  -- 3b. הקישור להפקות
  insert into public.job_productions (job_id, production_id)
  values (v_job_a, c_p7), (v_job_a, c_p8), (v_job_a, c_p9), (v_job_b, c_pB);

  -- 3c. אימוץ ארבע שורות הזרע. ה-type נגזר מסוג המסמך, לא מקידומת המפתח.
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
    raise exception '0093 עצרה: אומצו % שורות זרע, ציפיתי 4.', v_n;
  end if;

  -- 3d. ארבעת המסמכים. client_id רק אם ריק — 40207 כבר נושא אותו.
  update public.documents d
     set job_id     = m.job,
         client_id  = coalesce(d.client_id, c_client),
         updated_at = now()
    from (values (c_d40207, v_job_a), (c_d60141, v_job_a),
                 (c_d40249, v_job_b), (c_d60160, v_job_b)) as m(doc, job)
   where d.id = m.doc and d.job_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 4 then
    raise exception '0093 עצרה: עודכנו % מסמכים, ציפיתי 4.', v_n;
  end if;

  -- 3e. היומן. actor_id ריק בכולם — מוסכמת 0064/0066: מיגרציה עשתה זאת.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  select 'job', m.job, 'job_created_manual_sql', null,
         jsonb_build_object('via', '0093', 'ticket', 'P19',
           'client', 'סבטלנה ניקסון', 'amount', m.amt, 'date', m.dt::text,
           'campaign', m.camp, 'episodes', m.eps,
           'reason', 'P9 — ההפקות internal ולכן on_production_approved לא ירתה ואף job לא נולד')
  from (values (v_job_a, 3600::numeric, date '2026-02-19', '3 פרקים', 3),
               (v_job_b, 1200,          date '2026-05-10', 'אסתטיטוקס', 1)) as m(job, amt, dt, camp, eps);

  -- ⚠️ job_marked_paid הוא הרשומה היחידה של **מתי** — ל-jobs אין עמודת תאריך
  --    תשלום, והרדאר קורא את האירוע הזה כאות תזמון (alerts.ts:224).
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  select 'job', m.job, 'job_marked_paid', null,
         jsonb_build_object('via', '0093', 'auto', false, 'born_paid', true,
           'proof_doc', m.doc, 'proof_doc_type', 320,
           'reason', '320 הוא חשבונית מס/קבלה, כלומר הוכחת תשלום; המסמך קיים, status=1, לא בוטל')
  from (values (v_job_a, '60141'), (v_job_b, '60160')) as m(job, doc);

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  select 'job', m.job, 'production_linked', null,
         jsonb_build_object('via', '0093', 'production_id', m.prod, 'confidence', 'high',
           'note', 'תאריך ההקלטה שווה ל-issued_at של שורת הזרע, והסכום מתחלק ב-₪1,200 לפרק')
  from (values (v_job_a, c_p7), (v_job_a, c_p8), (v_job_a, c_p9), (v_job_b, c_pB)) as m(job, prod);

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  select 'job', m.job, 'document_reconciled', null,
         jsonb_build_object('via', '0093_adopt', 'auto', false,
           'doc_id', d.id, 'morning_doc_id', d.morning_doc_id,
           'morning_doc_number', d.morning_doc_number, 'doc_type', d.type,
           'amount', d.amount, 'moved_state', 'linked',
           'adopted_invoice_id', m.seed, 'seed_key', m.key)
  from (values (c_s40207, c_d40207, v_job_a, 'biz-40207.0'),
               (c_s60141, c_d60141, v_job_a, 'tax-60141.0'),
               (c_s40249, c_d40249, v_job_b, 'biz-40249.0'),
               (c_s60160, c_d60160, v_job_b, 'tax-60160.0')) as m(seed, doc, job, key)
  join public.documents d on d.id = m.doc;

  -- ── 4. אימות אחרי הכתיבה, לפני שורת הפנקס ───────────────────────────────

  -- 4a. שני ה-jobs נולדו נכון, כולל ה-due_date שהטריגר חישב
  with expected(jid, edate, ecamp, eamount, ebiz, etax) as (
    values (v_job_a, date '2026-02-19', '3 פרקים',   3600::numeric, '40207', '60141'),
           (v_job_b, date '2026-05-10', 'אסתטיטוקס', 1200,          '40249', '60160')
  )
  select count(*) into v_n
  from expected e join public.jobs j on j.id = e.jid
  where j.client_id = c_client and j.date = e.edate and j.campaign = e.ecamp
    and j.amount = e.eamount and j.paid = 'כן'
    and j.invoice_biz = e.ebiz and j.invoice_tax = e.etax
    and j.legacy = true and j.dismissed = false
    and j.due_date = e.edate;   -- immediate → הפירעון שווה לתאריך
  if v_n <> 2 then
    raise exception '0093 עצרה: % מתוך 2 ה-jobs נולדו כנדרש (כולל due_date).', v_n;
  end if;

  -- 4b. הקישור להפקות: 3 ל-A, 1 ל-B, ועל ההפקות הנכונות.
  --     ⚠️ כאן השוואת שורה **מותרת**, וזו לא סתירה לכלל 51: שתי העמודות הן
  --     המפתח הראשי של `job_productions` ולכן `NOT NULL` בהגדרה, ואין איבר
  --     שיכול להחזיר NULL. הכלל אוסר **ערך ריק בתוך** השוואת שורה, לא את
  --     השוואת השורה עצמה. אם אי פעם תתווסף כאן עמודה שמותר לה להיות ריקה —
  --     היא יוצאת החוצה ל-`is null` נפרד.
  select count(*) into v_n from public.job_productions
   where (job_id, production_id) in ((v_job_a, c_p7), (v_job_a, c_p8), (v_job_a, c_p9), (v_job_b, c_pB));
  if v_n <> 4
     or (select count(*) from public.job_productions where job_id = v_job_a) <> 3
     or (select count(*) from public.job_productions where job_id = v_job_b) <> 1 then
    raise exception '0093 עצרה: הקישור להפקות אינו 3 + 1 על ההפקות הנכונות.';
  end if;

  -- 4c. ארבע שורות הזרע אומצו — כל שדה מול המקור שממנו נגזר, לא מספירה
  select count(*) into v_n
  from (values (c_s40207, c_d40207, v_job_a), (c_s60141, c_d60141, v_job_a),
               (c_s40249, c_d40249, v_job_b), (c_s60160, c_d60160, v_job_b)) as m(seed, doc, job)
  join public.invoices  i on i.id = m.seed
  join public.documents d on d.id = m.doc
  where i.job_id = m.job and i.morning_doc_id = d.morning_doc_id
    and i.doc_number = d.morning_doc_number and i.amount = d.amount
    and i.source = 'morning_api' and i.issued_at = d.document_date::timestamptz
    and i.date_is_estimated = false and i.pdf_url is not distinct from d.pdf_url
    and i.type = (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type
    and i.issued_by is null;
  if v_n <> 4 then
    raise exception '0093 עצרה: % מתוך 4 שורות הזרע אומצו נכון.', v_n;
  end if;

  -- 4d. ארבעת המסמכים הוצמדו וכולם נושאים את הלקוחה
  select count(*) into v_n from public.documents
   where id in (c_d40207, c_d60141, c_d40249, c_d60160)
     and client_id = c_client and job_id in (v_job_a, v_job_b);
  if v_n <> 4 then
    raise exception '0093 עצרה: % מתוך 4 המסמכים הוצמדו.', v_n;
  end if;

  -- 4e. 🔴 שום job קיים לא נגע — md5 על כל הטבלה מלבד שתי החדשות
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text||'|'||
                                 coalesce(j.invoice_biz,'-')||'|'||coalesce(j.invoice_tax,'-')||'|'||
                                 coalesce(j.due_date::text,'-')||'|'||j.dismissed::text, ',' order by j.id),''))
    into v_jobs_after from public.jobs j where j.id not in (v_job_a, v_job_b);
  if v_jobs_after is distinct from v_jobs_before then
    raise exception '0093 עצרה: job קיים השתנה! הקובץ אמור רק להוסיף.';
  end if;

  -- 4f. שום שורת invoices אחרת לא זזה, ואף שורה לא נוספה ולא נמחקה
  select md5(coalesce(string_agg(i.id::text||'|'||coalesce(i.morning_doc_id,'-')||'|'||coalesce(i.doc_number,'-')||'|'||
                                 i.amount::text||'|'||coalesce(i.job_id::text,'-')||'|'||i.source::text, ',' order by i.id),'')),
         count(*)
    into v_inv_after, v_inv_rows_after
  from public.invoices i where i.id not in (c_s40207, c_s60141, c_s40249, c_s60160);
  if v_inv_after is distinct from v_inv_before or v_inv_rows_after <> v_inv_rows_before then
    raise exception '0093 עצרה: invoices אחרות זזו, או שהשתנה מספר השורות (% → %).',
      v_inv_rows_before, v_inv_rows_after;
  end if;

  -- 4g. ⚠️ productions לא נגעה כלל — kind ו-status כולל. הכרעת בעלים.
  select md5(coalesce(string_agg(p.id::text||'|'||p.kind::text||'|'||p.status::text||'|'||
                                 coalesce(p.record_date::text,'-')||'|'||coalesce(p.price_override::text,'-'),
                                 ',' order by p.id),''))
    into v_prod_after from public.productions p;
  if v_prod_after is distinct from v_prod_before then
    raise exception '0093 עצרה: productions השתנתה! kind נשאר internal בהכרעת בעלים (P9).';
  end if;

  -- 4h. אפס מפתח סינתטי נותר לארבעה, ואפס morning_doc_id כפול בכל הטבלה
  select count(*) into v_n from public.invoices
   where morning_doc_id in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')
      or doc_number     in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0');
  if v_n <> 0 then
    raise exception '0093 עצרה: נותרו % מפתחות סינתטיים — שער 1 עדיין יחסום.', v_n;
  end if;
  select count(*) into v_n from (
    select morning_doc_id from public.invoices where morning_doc_id is not null
    group by morning_doc_id having count(*) > 1) x;
  if v_n <> 0 then
    raise exception '0093 עצרה: % מפתחות morning_doc_id מופיעים יותר מפעם אחת.', v_n;
  end if;

  -- 4i. הכנסת אסתטיטוקס עלתה ב-₪4,800 בדיוק — בדיקת קצה-לקצה שמוכיחה
  --     שהכסף נחת על התוכנית הנכונה ולא רק שהשורות נכתבו
  select coalesce(sum(x.share),0) into v_rev_after from (
    select j.amount / count(*) over (partition by jp.job_id) as share
    from public.job_productions jp
    join public.productions p on p.id = jp.production_id
    join public.jobs j on j.id = jp.job_id
    where j.dismissed = false and j.amount is not null
      and p.cancelled_at is null and p.merged_into is null and p.show_id = c_show) x;
  if round(v_rev_after - v_rev_before) <> 4800 then
    raise exception '0093 עצרה: הכנסת אסתטיטוקס זזה ב-% ולא ב-4,800 (% → %).',
      round(v_rev_after - v_rev_before), round(v_rev_before), round(v_rev_after);
  end if;

  raise notice '0093: שני jobs נוצרו (₪3,600 · 19.02 · 3 הפקות, ₪1,200 · 10.05 · הפקה אחת), 4 שורות זרע אומצו, 4 מסמכים הוצמדו. productions לא נגעה. הכנסת אסתטיטוקס % → %.',
    round(v_rev_before), round(v_rev_after);
end $mig$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'jobs_created_for_paid_chains', null,
        jsonb_build_object(
          'migration',     '0093',
          'ticket',        'P19',
          'jobs_created',  2,
          'seeds_adopted', 4,
          'docs_linked',   jsonb_build_array('40207', '60141', '40249', '60160'),
          'client',        'סבטלנה ניקסון',
          'show',          'אסתטיטוקס',
          'net_total',     4800,
          'root_causes',   jsonb_build_array('P9', 'F10'),
          'kind_untouched', true,
          'source',        'investigation 2026-09-19'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0093', now(), 'bnaya',
        'P19: שני jobs לסבטלנה ניקסון על שתי שרשראות חיוב שנגבו במלואן ומעולם לא נרשמו כעבודה, קישורם לארבע הפקות, אימוץ ארבע שורות זרע והצמדת ארבעה מסמכים. שתי שורות חדשות ב-jobs, ארבע ב-job_productions, ארבע UPDATE ב-invoices, ארבע ב-documents, שנים עשר אירועים, אפס שינוי סכימה, אפס DELETE ואפס UPDATE על job קיים. השרשראות: א 10202 ואז 40207 שהוא 300 על 4,248 ואז 60141 שהוא 320 על 4,248, כלומר 3,600 נטו, הקלטה 19.02.2026, שלוש הפקות; ב 10248 ואז 40249 שהוא 300 על 1,416 ואז 60160 שהוא 320 על 1,416, כלומר 1,200 נטו, הקלטה 10.05.2026, הפקה אחת. שרשרת א חוצה את שני מזהי המורנינג באמצע: 10202 ו-40207 נושאים את 0b3b8274 שהוא ניקסון מדיקונסלט וממופה, ו-60141 נושא את 90b369a5 שהוא טל מדיקל גרופ ואינו נתבע ע"י אף לקוח, וזה F10, וזו הסיבה ש-60141 צף בלשונית לא משויך בעוד 40207 לא. למה לא היה job מלכתחילה: ארבע ההפקות קיימות בתוכנית אסתטיטוקס שהיא per_episode ועם לקוח, אבל כולן kind internal ו-on_production_approved יוצרת job רק כש-kind הוא client, ולכן הטריגר לא ירה ואף job לא נולד בשקט, וזה P9. הסכום והראיה, אומת מול הבעלים: ברוטו חלקי 1.18 נותן 3,600 ו-1,200; שתי שורות הזרע של כל שרשרת נושאות את אותו נטו; ה-issued_at שלהן נופל בדיוק על תאריכי ההקלטה 19.02 ו-10.05; מספר ההפקות באותו תאריך הוא שלוש ואחת; והסכום מתחלק בדיוק ב-1,200 לפרק, מחיר מלא בלי הנחה. ה-issued_at שנופל על תאריך ההקלטה הוא האות שהכריע את ההיקף, כי הוא מה שקושר את הכסף להפקות ולא רק לתאריך מסמך. paid כן בלידה בהכרעת בעלים: שתי השרשראות מסתיימות ב-320 שהוא חשבונית מס קבלה ויושב ב-PAYMENT_TYPES מפני שהוא הוכחת תשלום, שני המסמכים קיימים ב-status 1 ולא בוטלו, ו-לא ידוע היה מייצר חוב מדומה על כסף שהתקבל; ההשוואה שמאשרת שהכלל מבחין ואינו הנחה גורפת היא d39c2148 של אוגוסט שאינו משולם ו-40305 שלו הוא status 0 בלי 320. נכתב גם job_marked_paid לכל job מפני שהוא הרשומה היחידה של מתי שולם, שכן ל-jobs אין עמודת תאריך תשלום והרדאר קורא את האירוע הזה כאות תזמון. kind internal אינו חוסם ולא נגעו בו: נמדד ש-job_productions נושאת PK ושני FK בלבד בלי טריגר ובלי CHECK, ו-jobs נושאת רק trg_compute_due_date על INSERT בעוד שני הגארדים האחרים הם BEFORE UPDATE בלבד, כלומר מיגרציה יוצרת job להפקה internal בלי שום התנגדות; הדגל נשאר internal בהכרעת בעלים וארבע ההפקות ימשיכו להציג תג פנימי למרות שחויבו ושולמו, וזה נרשם ב-P9 כדוגמה החיה, וסעיף 4ז נועל זאת עם md5 על productions כולל kind ו-status. מה שזה מזיז על המסך: הכנסת אסתטיטוקס מ-4,400 ל-9,200, תוספת של 4,800, וזה התיקון ולא תופעת לוואי כי הכסף נגבה ומעולם לא נספר על התוכנית, וסעיף 4ט מוודא שהוא זז בדיוק ב-4,800; לשונית לא משויך יורדת מ-7 ל-4 מסמכי חיוב וזנב T21 מ-108 ל-104. צורת השערים לפי כלל 51: כל שער השוואה הוא VALUES ועליו join עם is null כתנאי נפרד ולעולם לא השוואת שורה שמכילה null, מפני שהשוואת שורה מחזירה NULL על איבר ריק ואינה יכולה להתקיים; כל שער מנוסח ציפיתי ל-N וקבל N, והיחיד שמנוסח ודא שאין כלום, סעיף 1ד, נושא לצידו שער בקרה חיובי שמוכיח שהשאילתה מוצאת שורות בכלל, אחרת ה-0 שלו חסר משמעות. תשע קבוצות בדיקה לפני שורת הפנקס: ארבעת המסמכים במצב שנמדד; parent_doc_numbers של 60141 ושל 60160 מצהירים על השרשראות ונאכפים; ארבע שורות הזרע יחידות ובמצב שנמדד; אין שורת invoices על ה-uuid האמיתי, עם שער בקרה; ארבע ההפקות פנויות בתאריך ובתוכנית הנכונים; זהות הסכום בשני כיוונים; ואחרי הכתיבה שני ה-jobs כולל due_date שהטריגר חישב, הקישור 3 ועוד 1 על ההפקות הנכונות, ארבע שורות הזרע כל שדה מול המקור שממנו נגזר, ארבעת המסמכים, md5 על jobs מלבד השתיים החדשות, md5 וספירת שורות על invoices מלבד הארבע, md5 על productions, אפס מפתח סינתטי ואפס morning_doc_id כפול, והכנסת התוכנית שזזה בדיוק ב-4,800. כלל 49, ACL מוצהר: הקובץ אינו יוצר שום אובייקט נושא-ACL ואינו מחליף שום פונקציה, הוא מוסיף שורות ל-jobs ול-job_productions ול-events ומעדכן עמודות קיימות ב-invoices וב-documents, ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות; שלוש הטבלאות כבר מוגנות ב-RLS ואף אחת מהן לא נגעה, והקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה וזה מצב קיים ולא דבר שהוא יוצר. מחוץ להיקף במכוון: F10 בא אחרי הקובץ הזה ובמכוון, מפני שמדידת certain מ-19.9 הראתה שהמפה המורחבת מכניסה זוג שגוי ל-certainPaymentMatches, 60160 אל d39c2148, בגלל ששתי השרשראות הן 1,416, והקובץ הזה נותן ל-60160 את ה-job האמיתי שלו ו-buildEdges מסנן מסמך שכבר משויך, כלומר אחרי 0093 הזוג השגוי אינו יכול להיווצר כלל, וזו הסיבה שהסדר התהפך, ראה F14; 104 מסמכי הזנב הנותרים הם T21; והדגל kind הוא P9. ההרצה המדומה ב-supabase/verify/0093_dryrun.sql ושאילתת האימות ב-supabase/verify/0093_verify.sql, כלל 50.');
