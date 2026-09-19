-- ============================================================================
-- 0093 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
-- שני חלקים, ובכוונה — שתי שאלות שונות:
--
--   ── חלק א' (קריאה בלבד) ──────────────────────────────────────────────────
--   "האם שני ה-jobs נולדו נכון, המסמכים הוצמדו, והכסף נחת על התוכנית?"
--   SELECT אחד שמחזיר שורת בוליאנים. כל אחד מהם חייב להיות true.
--   ⚠️ `Success. No rows returned` אינו הוכחה — רק השורה שחוזרת.
--   אינו נוגע בדבר. זה מה שמריצים תמיד.
--
--   ── חלק ב' (חי, ומגלגל את עצמו) ──────────────────────────────────────────
--   "והאם החורים באמת נסגרו?"
--   חלק א' מראה שהערכים נכונים. הוא אינו מראה שה**הגנות** עובדות. חלק ב' מנסה
--   בפועל לייצר את שתי התקלות שהקובץ בא למנוע — שורת invoices כפולה וקישור
--   כפול להפקה — ומוכיח שהמסד חוסם אותן, ואז נופל ב-raise exception.
--   ⚠️ להריץ כבלוק נפרד, ולצפות ל"שגיאה" שמתחילה ב-✅.
--
-- ⚠️ כלל 51 חל גם כאן: `is null` תמיד כתנאי נפרד, ולעולם לא איבר בהשוואת
--    שורה; וכל בדיקה מנוסחת "ציפיתי ל-N, קבל N" במקום "ודא שאין כלום", חוץ
--    משתיים שבהן 0 הוא באמת התשובה — ולשתיהן יש שער בקרה חיובי לצידן.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- חלק א' — קריאה בלבד. 16 בדיקות, כולן חייבות להחזיר true.
-- ════════════════════════════════════════════════════════════════════════════
with job_a as (
  select * from public.jobs
   where client_id = 'b42808ad-4e91-4951-bcff-23111644a88b'
     and date = date '2026-02-19' and campaign = '3 פרקים'
),
job_b as (
  select * from public.jobs
   where client_id = 'b42808ad-4e91-4951-bcff-23111644a88b'
     and date = date '2026-05-10' and campaign = 'אסתטיטוקס'
)
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0093')               as ledger_row,

  -- 2. אירוע האודיט של המיגרציה
  (select count(*) = 1 from public.events
    where event_type = 'jobs_created_for_paid_chains' and payload->>'migration' = '0093') as audit_event,

  -- 3. 🔴 שני ה-jobs נולדו, ובדיוק שניים — לא אחד ולא שלושה
  (select count(*) = 1 from job_a)                                                     as job_a_exists,
  (select count(*) = 1 from job_b)                                                     as job_b_exists,

  -- 4. Job A: כל שדה, כולל due_date שהטריגר חישב (immediate → שווה לתאריך)
  (select amount = 3600 and paid = 'כן' and invoice_biz = '40207' and invoice_tax = '60141'
          and legacy = true and dismissed = false and due_date = date '2026-02-19'
     from job_a)                                                                       as job_a_fields,

  -- 5. Job B: אותו דבר
  (select amount = 1200 and paid = 'כן' and invoice_biz = '40249' and invoice_tax = '60160'
          and legacy = true and dismissed = false and due_date = date '2026-05-10'
     from job_b)                                                                       as job_b_fields,

  -- 6. הקישור להפקות — 3 ל-A על פרקים 7/8/9 מ-19.02, ואחת ל-B מ-10.05
  (select count(*) = 3 from public.job_productions jp, job_a
    where jp.job_id = job_a.id
      and jp.production_id in ('1cbaaf6c-4b80-46ab-835d-a9ac2f9f707b',
                               '46c244e6-4b55-411c-8acc-5ee19815b654',
                               '5b260ec3-3728-4fe3-84a3-bf90b16712cf'))                as job_a_productions,
  (select count(*) = 1 from public.job_productions jp, job_b
    where jp.job_id = job_b.id
      and jp.production_id = '310e37c8-91a3-4530-a815-f12dd94d8d09')                   as job_b_production,

  -- 7. 🔴 ארבע שורות הזרע אומצו — כל שדה מול המסמך שממנו נגזר
  (select count(*) = 4
     from (values ('40207'), ('60141'), ('40249'), ('60160')) as k(num)
     join public.documents d on d.morning_doc_number = k.num
     join public.invoices  i on i.morning_doc_id = d.morning_doc_id
    where i.doc_number = d.morning_doc_number and i.amount = d.amount
      and i.source = 'morning_api' and i.issued_at = d.document_date::timestamptz
      and i.date_is_estimated = false and i.pdf_url is not distinct from d.pdf_url
      and i.type = (case when d.type = 300 then 'עסקה' else 'מס' end)::invoice_type
      and i.job_id = d.job_id)                                                         as seeds_adopted,

  -- 8. ארבעת המסמכים הוצמדו וכולם נושאים את סבטלנה
  (select count(*) = 4 from public.documents
    where morning_doc_number in ('40207','60141','40249','60160')
      and client_id = 'b42808ad-4e91-4951-bcff-23111644a88b'
      and job_id is not null)                                                          as docs_linked,

  -- 9. 🔴 שער 1 נקי לארבעה — אפס מפתח סינתטי.
  --    ⚠️ כלל 51: 0 הוא התשובה כאן, ולכן לצידו שער בקרה (בדיקה 10) שמוכיח
  --    שהשאילתה מוצאת שורות בכלל — אחרת 0 היה יכול להיות שאילתה שבורה.
  (select count(*) = 0 from public.invoices
    where morning_doc_id in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')
       or doc_number     in ('biz-40207.0','tax-60141.0','biz-40249.0','tax-60160.0')) as gate1_clear,

  -- 10. שער הבקרה: אותה צורת חיפוש, מול המפתחות הסינתטיים שעדיין קיימים
  --     בזנב של T21. אם זה יחזור false — השאילתה של 9 שבורה, לא המסד נקי.
  (select count(*) > 0 from public.invoices
    where morning_doc_id like 'biz-%' or morning_doc_id like 'tax-%')                  as gate1_probe,

  -- 11. אפס morning_doc_id כפול בכל הטבלה
  (select count(*) = 0 from (
     select morning_doc_id from public.invoices where morning_doc_id is not null
     group by morning_doc_id having count(*) > 1) x)                                   as no_dup_keys,

  -- 12. ⚠️ productions לא נגעה — ארבע ההפקות עדיין internal, בהכרעת בעלים.
  --     אם זה יחזור false, מישהו "תיקן בדרך" והפר את ההכרעה. ראה P9.
  (select count(*) = 4 from public.productions
    where id in ('1cbaaf6c-4b80-46ab-835d-a9ac2f9f707b','46c244e6-4b55-411c-8acc-5ee19815b654',
                 '5b260ec3-3728-4fe3-84a3-bf90b16712cf','310e37c8-91a3-4530-a815-f12dd94d8d09')
      and kind = 'internal')                                                           as kind_untouched,

  -- 13. 🔴 הכנסת אסתטיטוקס — ₪9,200. זו הבדיקה שאומרת שהכסף נחת על
  --     התוכנית הנכונה, ולא רק שהשורות נכתבו.
  (select round(coalesce(sum(x.share),0)) = 9200 from (
     select j.amount / count(*) over (partition by jp.job_id) as share
     from public.job_productions jp
     join public.productions p on p.id = jp.production_id
     join public.jobs j on j.id = jp.job_id
     where j.dismissed = false and j.amount is not null
       and p.cancelled_at is null and p.merged_into is null
       and p.show_id = 'b6357a2f-50c2-46b1-afa6-dc7caac02fc8') x)                      as show_revenue_9200,

  -- 14. לשונית "לא משויך" ירדה מ-7 ל-4 מסמכי חיוב
  (select count(*) = 4 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null
      and type in (300,305,320,400))                                                   as unmatched_tab_4,

  -- 15. ⚠️ והזנב נשאר, במכוון: 104 (היו 108). זה T21, ושער 1 ממשיך להגן.
  (select count(*) = 104 from (
     select distinct d.id from public.documents d
     join public.invoices i
       on i.morning_doc_id in ('biz-'||d.morning_doc_number||'.0','tax-'||d.morning_doc_number||'.0')
     where d.type in (300,305,320) and d.job_id is null
       and d.archived_at is null and d.cancelled_at is null
       and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0)) x)         as tail_still_104,

  -- 16. 🔴 היומן: 12 אירועים עם via=0093, ובתוכם job_marked_paid לשני ה-jobs
  --     — שהוא הרשומה היחידה של **מתי** שולם (alerts.ts:224).
  (select count(*) = 12 from public.events
    where payload->>'via' in ('0093','0093_adopt')
      and event_type in ('job_created_manual_sql','job_marked_paid',
                         'production_linked','document_reconciled'))                   as twelve_events,
  (select count(*) = 2 from public.events
    where event_type = 'job_marked_paid' and payload->>'via' = '0093'
      and (payload->>'born_paid')::boolean is true)                                    as paid_events;


-- ════════════════════════════════════════════════════════════════════════════
-- חלק ב' — חי. מוכיח שההגנות עובדות, ומגלגל את עצמו.
-- להריץ בנפרד. הצלחה = "שגיאה" שמתחילה ב-✅.
-- ════════════════════════════════════════════════════════════════════════════
do $live$
declare
  c_client constant uuid := 'b42808ad-4e91-4951-bcff-23111644a88b';
  v_job_b  uuid;
  v_prod   uuid;
  v_mid    text;
  v_blocked boolean;
  v_n int;
  v_fail text := '';
  v_rep  text := '';
begin
  select id into v_job_b from public.jobs
   where client_id = c_client and date = date '2026-05-10' and campaign = 'אסתטיטוקס';
  select morning_doc_id into v_mid from public.documents where morning_doc_number = '60160';
  select production_id into v_prod from public.job_productions where job_id = v_job_b;

  if v_job_b is null or v_mid is null or v_prod is null then
    raise exception '❌ 0093 VERIFY: המיגרציה לא הוחלה, או שה-job לא נמצא.';
  end if;

  -- ── מבחן 1: שורת invoices שנייה על 60160 נחסמת ───────────────────────────
  -- זו הספירה הכפולה שכל האימוץ בא למנוע. מנסים בפועל.
  v_blocked := false;
  begin
    insert into public.invoices (client_id, job_id, type, doc_number, morning_doc_id,
                                 amount, issued_at, source)
    values (c_client, v_job_b, 'מס', '60160', v_mid, 1416, now(), 'morning_api');
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then
    v_fail := v_fail || 'מבחן 1: שורת invoices כפולה על 60160 עברה! האינדקס אינו מגן. ';
  else
    v_rep := v_rep || 'מבחן 1 — שורה שנייה על 60160 נחסמה ע"י invoices_morning_doc_id_key. | ';
  end if;

  -- ── מבחן 2: קישור כפול לאותה הפקה נחסם ───────────────────────────────────
  v_blocked := false;
  begin
    insert into public.job_productions (job_id, production_id) values (v_job_b, v_prod);
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then
    v_fail := v_fail || 'מבחן 2: קישור כפול להפקה עבר! ה-PK אינו מגן. ';
  else
    v_rep := v_rep || 'מבחן 2 — קישור כפול להפקה נחסם ע"י job_productions_pkey. | ';
  end if;

  -- ── מבחן 3: 🔴 הזוג השגוי של F14 אינו יכול להיווצר עוד ───────────────────
  -- `buildEdges` מסנן `!d.job_id`, ולכן מסמך משויך אינו קשת. לפני 0093,
  -- 60160 היה `job_id` ריק ונכנס ל-certainPaymentMatches מול d39c2148 —
  -- job של שרשרת אוגוסט — רק מפני ששתי השרשראות הן ₪1,416. עכשיו יש לו בית.
  select count(*) into v_n from public.documents
   where morning_doc_number = '60160' and job_id is not null;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 3: 60160 אינו משויך — הזוג השגוי של F14 עדיין אפשרי. ';
  else
    v_rep := v_rep || 'מבחן 3 — 60160 משויך, ולכן buildEdges אינו רואה אותו; הזוג השגוי של F14 בלתי אפשרי. | ';
  end if;

  -- ── מבחן 4: ארבע שורות invoices על שני ה-jobs, שתיים לכל אחד ─────────────
  select count(*) into v_n from public.invoices i
   join public.jobs j on j.id = i.job_id
   where j.client_id = c_client and j.date in (date '2026-02-19', date '2026-05-10');
  if v_n <> 4 then
    v_fail := v_fail || format('מבחן 4: %s שורות invoices על שני ה-jobs, ציפיתי 4. ', v_n);
  else
    v_rep := v_rep || 'מבחן 4 — 4 שורות invoices: עסקה+מס לכל job. | ';
  end if;

  -- ── הדוח ─────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0093 VERIFY FAILED — %', v_fail;
  end if;

  raise exception '✅ 0093 VERIFY OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $live$;
