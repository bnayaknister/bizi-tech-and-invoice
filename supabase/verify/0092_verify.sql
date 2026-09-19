-- ============================================================================
-- 0092 — שאילתת אימות. להריץ אחרי המיגרציה.
-- כלל 50: אימות חי כאן, לעולם לא ב-supabase/migrations/.
--
-- שני חלקים, ובכוונה — שתי שאלות שונות:
--
--   ── חלק א' (קריאה בלבד) ──────────────────────────────────────────────────
--   "האם השורה אומצה, האם המסמך הוצמד, והאם שום דבר אחר לא זז?"
--   SELECT אחד שמחזיר שורת בוליאנים. כל אחד מהם חייב להיות true.
--   ⚠️ `Success. No rows returned` אינו הוכחה — רק השורה שחוזרת.
--   אינו נוגע בדבר. זה מה שמריצים תמיד.
--
--   ── חלק ב' (חי, ומגלגל את עצמו) ──────────────────────────────────────────
--   "והאם החור באמת נסגר?"
--   חלק א' מראה שהערכים נכונים. הוא אינו מראה שה**הגנה** עובדת. חלק ב' מנסה
--   בפועל להוסיף שורת invoices שנייה על אותו מסמך — הספירה הכפולה שכל התרגיל
--   בא למנוע — ומוכיח ששלוש הגנות בלתי תלויות חוסמות אותה, ואז נופל
--   ב-raise exception. הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API.
--   ⚠️ להריץ כבלוק נפרד, ולצפות ל"שגיאה" שמתחילה ב-✅.
--
-- ⚠️ ההבדל מ-0092_dryrun.sql: ההרצה המדומה הוכיחה מה **יקרה**, לפני ההחלה,
--    וגלגלה. הקובץ הזה בודק מה **קרה**, אחרי. שניהם נחוצים.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- חלק א' — קריאה בלבד. 14 בדיקות, כולן חייבות להחזיר true.
-- ════════════════════════════════════════════════════════════════════════════
select
  -- 1. שורת הפנקס — התנאי היחיד שמעיד שהקובץ באמת רץ
  (select count(*) = 1 from public.schema_ledger where version = '0092')                as ledger_row,

  -- 2. אירוע האודיט של המיגרציה נכתב
  (select count(*) = 1 from public.events
    where event_type = 'seed_invoice_adopted' and payload->>'migration' = '0092')       as audit_event,

  -- 3. אירוע ה-document_reconciled נכתב על ה-job, עם via=0092_adopt
  (select count(*) = 1 from public.events
    where entity_type = 'job' and entity_id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a'
      and event_type = 'document_reconciled' and payload->>'via' = '0092_adopt'
      and payload->>'moved_state' = 'linked')                                           as reconcile_event,

  -- 4. 🔴 הלב: שורת הזרע אומצה. כל שדה שנכתב, מול הערך שממנו נגזר.
  (select i.job_id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a'
          and i.morning_doc_id = d.morning_doc_id
          and i.doc_number = d.morning_doc_number
          and i.type = 'עסקה'
          and i.amount = d.amount
          and i.source = 'morning_api'
          and i.issued_at = d.document_date::timestamptz
          and i.date_is_estimated = false
          and i.pdf_url is not distinct from d.pdf_url
          and i.issued_by is null
     from public.invoices i, public.documents d
    where i.id = 'e0dafaf8-3fa8-4f17-80bf-b559704d2bad'
      and d.id = '4bcc6f53-855a-435e-ab21-da7afd6761a5')                                as seed_adopted,

  -- 5. המסמך הוצמד ל-job וקיבל את לקוח ה-job (דה פקטו)
  (select job_id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a'
          and client_id = '261c0445-c013-4f87-9dc6-e82f8c7e9c30'
     from public.documents where id = '4bcc6f53-855a-435e-ab21-da7afd6761a5')           as doc_linked,

  -- 6. 🔴 המטרה: שער 1 של linkPreflight לא מוצא עוד מפתח סינתטי ל-40261.
  --    זו הבדיקה שאומרת "החסימה הוסרה", ולא רק "ערך שונה".
  (select count(*) = 0 from public.invoices
    where morning_doc_id in ('biz-40261.0','tax-40261.0')
       or doc_number in ('biz-40261.0','tax-40261.0'))                                  as gate1_clear,

  -- 7. אין ספירה כפולה: שורת עסקה אחת בלבד על ה-job (ולצידה 60181 כמס)
  (select count(*) = 1 from public.invoices
    where job_id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a' and type = 'עסקה')            as one_deal_row,
  (select count(*) = 1 from public.invoices
    where job_id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a' and type = 'מס')              as one_tax_row,

  -- 8. ואפס מפתח morning_doc_id כפול בכל הטבלה
  (select count(*) = 0 from (
     select morning_doc_id from public.invoices where morning_doc_id is not null
     group by morning_doc_id having count(*) > 1) x)                                    as no_dup_keys,

  -- 9. 🔴 jobs לא נגעה. הערכים שהמיגרציה הצהירה שלא תשנה, כפי שהיו.
  (select amount = 2400 and paid = 'כן' and invoice_biz = '40261'
          and invoice_tax = '60181' and dismissed = false
     from public.jobs where id = 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a')                as job_untouched,

  -- 10. ⚠️ 40215, המוחרג במכוון, עדיין חסום — לא "נתקן בדרך".
  --     אם זה יחזור false, מישהו הרחיב את הקובץ לפרדיקט כללי.
  (select job_id is null from public.documents where morning_doc_number = '40215')      as excluded_40215_doc,
  (select count(*) = 1 from public.invoices
    where morning_doc_id = 'biz-40215.0' and job_id is null)                            as excluded_40215_seed,

  -- 11. לשונית "לא משויך" ירדה מ-8 מסמכי חיוב ל-7
  (select count(*) = 7 from public.documents
    where client_id is null and archived_at is null and cancelled_at is null
      and type in (300,305,320,400))                                                    as unmatched_tab_down,

  -- 12. ⚠️ והזנב נשאר, במכוון: 108 מסמכי חיוב חיים עדיין חסומים בשער 1
  --     (היו 109). זו לא תקלה — זה T21, ושער 1 ממשיך להגן עליהם.
  --
  --     🔴 תיקון, 19.9: הבדיקה הזו נכתבה `= 111` ונכשלה בהרצה הראשונה.
  --     **הציפייה הייתה שגויה, לא הנתון** — ואומת שדבר לא זז שלא אמור היה:
  --     בכל 12 השעות שלפני המדידה נכתב אירוע `document_reconciled` אחד בלבד,
  --     והוא של 0092 עצמה.
  --
  --     השורש: הסקר שקבע "112" ספר **זוגות (מסמך × שורת זרע)** ולא מסמכים.
  --     **שלושה מסמכים נושאים שתי שורות זרע כל אחד** — `biz-<n>.0` **וגם**
  --     `tax-<n>.0` על אותו מספר: **50048** (305, ₪8,260), **60098** (320,
  --     ₪708) ו-**60163** (320, ₪708). ה-`join` מחזיר אותם פעמיים, ו-`count(*)`
  --     בלי `distinct` ספר אותם פעמיים.
  --
  --     שתי הספירות, שתיהן נכונות לשאלה שלהן:
  --       זוגות מסמך×זרע   111   (היו 112)
  --       מסמכים נבדלים    108   (היו 109)   ← זה מה שהשאילתה למטה מודדת
  --     ההפרש הוא בדיוק 3, ומוסבר במלואו ע"י שלושת המסמכים הנ"ל.
  --     `select distinct d.id` בוחר **רק** את ה-id, ולכן הוא באמת נבדל;
  --     ב-CTE של הסקר המקורי ה-`distinct` חל על שורה שכללה גם את מפתח הזרע,
  --     ולכן לא איחד דבר. זו הטעות בשורה אחת, והיא בציפייה בלבד.
  (select count(*) = 108 from (
     select distinct d.id from public.documents d
     join public.invoices i
       on i.morning_doc_id in ('biz-'||d.morning_doc_number||'.0','tax-'||d.morning_doc_number||'.0')
     where d.type in (300,305,320) and d.job_id is null
       and d.archived_at is null and d.cancelled_at is null
       and (d.bundle_job_ids is null or cardinality(d.bundle_job_ids) = 0)) x)          as tail_still_108,

  -- 13. ומה שבאמת נטען: 40261 עצמו כבר **אינו** בזנב. זו הטענה שאינה
  --     תלויה בשום ספירה כוללת, ולכן היא זו שנועלת את התוצאה של 0092.
  (select count(*) = 0 from public.documents d
    join public.invoices i
      on i.morning_doc_id in ('biz-'||d.morning_doc_number||'.0','tax-'||d.morning_doc_number||'.0')
   where d.morning_doc_number = '40261')                                                as doc_40261_left_tail;


-- ════════════════════════════════════════════════════════════════════════════
-- חלק ב' — חי. מוכיח שהחור נסגר, ומגלגל את עצמו.
-- להריץ בנפרד. הצלחה = "שגיאה" שמתחילה ב-✅.
-- ════════════════════════════════════════════════════════════════════════════
do $live$
declare
  c_doc    constant uuid := '4bcc6f53-855a-435e-ab21-da7afd6761a5';
  c_job    constant uuid := 'f3cf9a5b-ac40-4355-816d-dc9f7ac3c98a';
  c_client constant uuid := '261c0445-c013-4f87-9dc6-e82f8c7e9c30';
  c_mid    constant text := '89ef494e-d3f1-4c55-a990-3049cf1dd2d4';
  v_blocked boolean;
  v_n int;
  v_fail text := '';
  v_rep  text := '';
begin
  -- ── מבחן 1: ההגנה הראשונה — האינדקס הייחודי על morning_doc_id ────────────
  -- מנסים בפועל להוסיף שורת invoices שנייה על אותו מסמך. זו בדיוק הספירה
  -- הכפולה שכל התרגיל בא למנוע, ובדיוק מה שהיה קורה אילו המיגרציה הייתה
  -- מוסיפה שורה לצד שורת הזרע במקום לאמץ אותה.
  v_blocked := false;
  begin
    insert into public.invoices (client_id, job_id, type, doc_number, morning_doc_id,
                                 amount, issued_at, source)
    values (c_client, c_job, 'עסקה', '40261', c_mid, 2832, now(), 'morning_api');
  exception
    when unique_violation then v_blocked := true;
  end;

  if not v_blocked then
    v_fail := v_fail || 'מבחן 1: ההוספה הכפולה עברה! invoices_morning_doc_id_key אינו מגן. ';
  else
    v_rep := v_rep || 'מבחן 1 — שורה שנייה על אותו uuid נחסמה ע"י invoices_morning_doc_id_key. | ';
  end if;

  -- ── מבחן 2: ההגנה השנייה — שער 1 של linkPreflight, בשאילתה שלו ───────────
  -- אותן שתי קריאות בדיוק (reconcile.ts:600-604): morning_doc_id ו-doc_number
  -- מול שלושת המפתחות. אחרי האימוץ הן חייבות למצוא את ה-uuid האמיתי — כלומר
  -- השער יראה שהמסמך כבר רשום, וזה נכון: הוא באמת רשום, על ה-job הנכון.
  select count(*) into v_n from public.invoices
   where morning_doc_id in (c_mid, 'biz-40261.0', 'tax-40261.0')
      or doc_number     in (c_mid, 'biz-40261.0', 'tax-40261.0');
  if v_n <> 1 then
    v_fail := v_fail || format('מבחן 2: שער 1 מוצא %s שורות ל-40261, ציפיתי לאחת (האמיתית). ', v_n);
  else
    v_rep := v_rep || 'מבחן 2 — שער 1 מוצא שורה אחת, והיא ה-uuid האמיתי על ה-job הנכון. | ';
  end if;

  -- ── מבחן 3: ההגנה השלישית — linkDocumentToJob יסרב כי המסמך כבר משויך ────
  -- reconcile.ts:672 — `if (doc.job_id) return "המסמך כבר משויך ל-job"`.
  select count(*) into v_n from public.documents where id = c_doc and job_id is not null;
  if v_n <> 1 then
    v_fail := v_fail || 'מבחן 3: המסמך אינו משויך, ולכן ההגנה השלישית אינה קיימת. ';
  else
    v_rep := v_rep || 'מבחן 3 — המסמך משויך, ולכן linkDocumentToJob יסרב עוד לפני השערים. | ';
  end if;

  -- ── מבחן 4: הכסף לא הוכפל — סך שורות ה-invoices של ה-job ────────────────
  select count(*) into v_n from public.invoices where job_id = c_job;
  if v_n <> 2 then
    v_fail := v_fail || format('מבחן 4: %s שורות invoices על ה-job, ציפיתי 2 (40261 עסקה + 60181 מס). ', v_n);
  else
    v_rep := v_rep || 'מבחן 4 — שתי שורות בדיוק על ה-job: 40261 (עסקה) ו-60181 (מס). | ';
  end if;

  -- ── הדוח ─────────────────────────────────────────────────────────────────
  if v_fail <> '' then
    raise exception '❌ 0092 VERIFY FAILED — %', v_fail;
  end if;

  raise exception '✅ 0092 VERIFY OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $live$;
