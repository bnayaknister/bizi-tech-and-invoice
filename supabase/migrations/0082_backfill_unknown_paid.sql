-- 0082 — יישור 22 העבודות שנולדו 'לא ידוע'
--
-- מה זה ולמה. 0081 עצרה את הדימום: ensure_job_for_production כותבת מאז
-- paid='לא' במפורש, ומעכשיו כל יוצר jobs במערכת נוקב בערך. הקובץ הזה מנקה את
-- מה שכבר על הרצפה — 22 השורות החיות שנולדו לפני כן ונשארו ב-'לא ידוע'.
--
-- למה זה משנה: חמישה קוראים בודקים paid === 'לא' בשוויון מדויק ולכן עיוורים
-- ל-'לא ידוע' — issue.ts:105 (320 אינה מסמנת שולם), issue.ts:107 (400 אינה
-- מסמנת שולם), reconcile.ts:425 (linkDocumentToJob אינה מסמנת שולם),
-- reconcile.ts:172 (jobNeedsDocType אינה מציעה מסמך תשלום כמועמד, ולכן מסך
-- הפערים אינו רואה את השורה בכלל), ו-alerts.ts:263 (debtToCollect אינה סופרת
-- אותה). ⚠️ בהכרעת הבעלים חמשת הקוראים נשארים כפי שהם — הרחבה לחמישה מקומות
-- היא חור שישי מובטח, הנימוק ש-milestone.ts:17-25 רשמה. הקובץ מזיז נתונים,
-- לא כללים.
--
-- ═══ שלוש קבוצות, שלוש הכרעות שונות — ולכן קובץ אחד עם שני UPDATE ═══
--
-- קבוצה 1 — 5 jobs · ₪5,100 נטו · → 'כן'
--   לכולם כבר יצאה חשבונית מס/קבלה (320), כלומר הכסף נכנס. ⚠️ אלה מעולם לא
--   היו חוב — הם תקבול שלא נרשם, ולכן ההכרעה שלהם הפוכה מזו של 2 ו-3:
--     e348c985, abb26af7, 52512120  (דינמיקס איזון / ואם נחיה לנצח) → 60192
--     57398419                      (ידידיה ויטל / המניפה)          → 60196
--     c1f348f0                      (שחר קרטזמן / אסתטיקה)          → 60194
--   שלושתם הונפקו 7-10.9.26, כלומר אחרי 6.9 — הם בדיוק המקרים שהאירוע
--   auto_tax_receipt_paid_not_flipped (שנוסף בקומיט של 0081) היה מתעד לו
--   היה קיים אז. הם ההוכחה החיה לבאג, וזו הסיבה שהם מקבלים אירוע ו-2/3 לא.
--
-- קבוצה 2 — 7 jobs · ₪7,200 · → 'לא'
--   מסמך חיוב פתוח בלבד. כל שבעת ה-300 הם status=0 במורנינג, כלומר חוב אמיתי
--   ונוכחי שטרם נגבה.
--
-- קבוצה 3 — 10 jobs · ₪8,300 · → 'לא'
--   אין להם מסמך כלל. ⚠️ הבעלים אישר 15.9.26 שכולן ממתינות לחיוב — זו אינה
--   מסקנה של הקובץ אלא הכרעה שהתקבלה, כי "אין מסמך" לבדו יכול היה להיות גם
--   עבודה שלא תחויב לעולם.
--
-- ═══ מה זה מזיז במספר שעל המסך ═══
--   debtToCollect לפני:   10 jobs · ₪33,050
--   קבוצות 2+3 נכנסות:    17 jobs · ₪15,500
--   debtToCollect אחרי:   27 jobs · ₪48,550
-- קבוצה 1 אינה נכנסת לשם וגם לא הייתה אמורה — היא עוברת ל-'כן' ומצטרפת
-- ל-paidNoTax אם חסר לה invoice_tax, ולכלום אם לא.
--
-- ═══ מה נמדד מחדש לפני שנכתבה שורה, ולמה זה בקובץ ולא רק בצ'אט ═══
-- הסיווג נעשה בתחקיר, והקובץ אינו סומך עליו. כל המספרים נמדדו שוב 15.9.26
-- אחרי ש-0081 כבר הוחלה (12:32:29 UTC), והבדיקות שלמטה מריצות את אותה מדידה
-- שוב ברגע ההרצה — כי בין המדידה לכתיבה יכולה לצאת חשבונית, ואז שורה שסווגה
-- כ"אין מסמך" כבר אינה כזו.
--
-- ⚠️ כיסוי מלא, לא חלקי. עבור כל אחד משלושת מסמכי ה-320 נבדק שסכום העבודות
-- שהוא מכסה, בתוספת מע"מ, שווה בדיוק לברוטו שמורנינג עצמו חישב:
--     60192   3 jobs   ₪2,400 × 1.18 = ₪2,832   מול raw.amount 2832   Δ 0.00
--     60194   1 job    ₪1,600 × 1.18 = ₪1,888   מול raw.amount 1888   Δ 0.00
--     60196   1 job    ₪1,100 × 1.18 = ₪1,298   מול raw.amount 1298   Δ 0.00
-- זו הבדיקה שמפרידה בין "שולם" לבין "שולם חלקית", וכשל בה חייב לעצור את כל
-- הקובץ ולא רק לדלג על שורה: תקבול חלקי שמסומן 'כן' הוא כסף שנמחק מהמעקב.
--
-- ═══ מה לא נגע ═══
-- 5 שורות מבוטלות (dismissed=true) נשארות ב-'לא ידוע' ואינן ברשימת המזהים:
-- שתי הפקות טסט מ-29.7 שסכומן null, ושלוש כפילויות רישום ש-0065 ו-0066 כבר
-- הכריעו בהן. שורה מבוטלת היא מחוץ לכל משטח כספי (0041), ולתת לה ערך paid
-- הוא לנקות חלון בבית שנהרס.
--
-- ═══ PERMISSIONS — STATED, NOT ASSUMED (rule 49) ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס — ואינו מחליף שום פונקציה. הוא כותב ערכים לעמודה קיימת
-- ומוסיף שורות ל-events. אין כאן GRANT, ואין דבר שהרשאותיו יכולות להיוולד
-- שגויות. זה נאמר במפורש ולא מושאר לשתיקה, כי "אין שינוי הרשאות" היא טענה
-- שקורא צריך למצוא ולא להסיק.
--
-- החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: jobs.paid כבר מוגנת
-- ב-trg_guard_job_money (BEFORE UPDATE, דורשת can_edit_money) וב-RLS, ושתיהן
-- לא נגעו. סשן SQL Editor עובר את הטריגר כי auth.uid() ריק — אותה התנהגות
-- ש-0072 תיעדה — וזה המצב הקיים ולא דבר שהקובץ הזה יוצר.
--
-- ZERO DELETE. ZERO schema change. 22 שורות, עמודה אחת, ו-5 שורות ביומן.

do $mig$
declare
  -- קבוצה 1 — יצא 320, הכסף נכנס
  v_paid_ids  constant uuid[] := array[
    'e348c985-2873-4165-96cd-e3cd53d958f6',  -- דינמיקס איזון 13.8  ₪800   60192
    'abb26af7-91a1-412f-a2aa-a94a50442f85',  -- דינמיקס איזון 20.8  ₪800   60192
    '52512120-e294-4474-ba99-304ea766c940',  -- דינמיקס איזון 25.8  ₪800   60192
    '57398419-e3b8-4866-a2b0-d43ac7b53851',  -- ידידיה ויטל   31.8  ₪1100  60196
    'c1f348f0-fcef-40d8-b7de-bd883a56f4da'   -- שחר קרטזמן    29.7  ₪1600  60194
  ]::uuid[];

  -- קבוצות 2+3 — טרם נגבו
  v_unpaid_ids constant uuid[] := array[
    -- קבוצה 2: מסמך חיוב פתוח בלבד (₪7,200)
    '9a2a3360-24c3-4dc3-a4ee-7dc6750f3cec',  -- אולמדיה פי.אר     ₪800   40293
    '2b2545fb-6e1c-4662-8038-8c55dae5c268',  -- חשבים ה.פ.ס       ₪1200  40322
    '6d5c2d07-d6af-48c4-bc23-81063068958e',  -- ידידיה ויטל       ₪1100  40321
    'df5758d7-d339-4a36-a2a4-cb7968079791',  -- ליעד הרמן         ₪300   40311
    'd8609f74-158a-4bad-929f-ee996eb725d6',  -- מישל טולמסוב      ₪1000  40314
    'd39c2148-ee82-4a31-bbb8-3f4cb019742d',  -- סבטלנה ניקסון     ₪1200  40305
    '5f2a30c1-1845-4157-b28b-d26e051bdf45',  -- קוסט פורר גבאי    ₪1600  40306
    -- קבוצה 3: אין מסמך כלל (₪8,300)
    '6d02c1ac-0823-40c7-9413-64d2701147a5',  -- ברק הרשקוביץ  1.9   ₪600
    'b384e539-2433-448a-b1b9-bf35b252e0ce',  -- דינמיקס איזון 10.9  ₪800
    '8a1bcf1c-ba2a-4dd5-9edd-7ed22e15bdf4',  -- חברת החשמל    13.8  ₪1300
    '49200f83-a6e8-42af-8182-0b7fe086b9fb',  -- ידידיה ויטל   10.9  ₪1100
    '5bd93d87-e89b-44e2-8754-9b36836d29a4',  -- סטימצקי        9.8  ₪800
    '3d5fb4cd-9bae-46d7-9430-3f6be81d7355',  -- סטימצקי        6.9  ₪800
    'f689fdae-7be9-45d0-b715-c4e06010c31f',  -- סטימצקי        6.9  ₪800
    '01e7d5d4-bce7-4317-bb7c-2d3a82c07565',  -- עומר חן        3.8  ₪700
    '3a8ba213-26e1-42af-844a-34892263f916',  -- עומר חן        3.8  ₪700
    'c55c5ad3-19a0-43ff-ab4b-1ec29548a0f6'   -- עומר חן        3.8  ₪700
  ]::uuid[];

  v_docs      constant text[] := array['60192','60194','60196'];

  v_pop_pre        int;
  v_ready_paid     int;
  v_ready_unpaid   int;
  v_upd_paid       int;
  v_upd_unpaid     int;
  v_events         int;
  v_bad            int;
  v_covered        uuid[];

  v_jobs_pre       int;
  v_jobs_post      int;
  v_digest_pre     text;
  v_digest_post    text;
  v_other_unknown_pre  int;
  v_other_unknown_post int;
  v_left_over      int;

  v_yes_pre  int; v_no_pre  int; v_unk_pre  int; v_nc_pre  int;
  v_yes_post int; v_no_post int; v_unk_post int; v_nc_post int;
  v_debt_pre numeric; v_debt_post numeric;
begin
  -- =====================================================================
  -- 0. GUARDS
  -- =====================================================================

  -- 0a. הפנקס הוא הרצף, לא שמות הקבצים.
  if exists (select 1 from public.schema_ledger where version = '0082') then
    raise exception '0082 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0081') then
    raise exception '0082: 0081 אינה בפנקס — הקובץ הזה מנקה אחריה ואינו יכול להקדים אותה';
  end if;

  -- 0b. שתי הרשימות זרות זו לזו ובגודל הנכון. בלי זה, מזהה שהודבק פעמיים היה
  --     מקבל 'כן' ואז 'לא' — או להפך — לפי סדר המשפטים, בשקט.
  if array_length(v_paid_ids, 1) <> 5 then
    raise exception '0082: רשימת קבוצה 1 אינה 5 מזהים (%)', array_length(v_paid_ids, 1);
  end if;
  if array_length(v_unpaid_ids, 1) <> 17 then
    raise exception '0082: רשימת קבוצות 2+3 אינה 17 מזהים (%)', array_length(v_unpaid_ids, 1);
  end if;
  if exists (select 1 from unnest(v_paid_ids) x where x = any(v_unpaid_ids)) then
    raise exception '0082: אותו מזהה מופיע בשתי הרשימות';
  end if;
  if (select count(distinct x) from unnest(v_paid_ids || v_unpaid_ids) x) <> 22 then
    raise exception '0082: יש מזהה כפול בתוך הרשימות';
  end if;

  -- 0c. האוכלוסייה היא בדיוק זו שנמדדה — לא יותר ולא פחות. job שנולד בין
  --     המדידה להרצה נתפס כאן ולא נכתב לו ערך שאיש לא סיווג.
  select count(*) into v_pop_pre
    from public.jobs
   where paid = 'לא ידוע' and notes like 'נוצר אוטומטית%' and dismissed = false;
  if v_pop_pre <> 22 then
    raise exception '0082: האוכלוסייה היא % שורות ולא 22 — הסיווג נמדד על מסד אחר, מדדי מחדש', v_pop_pre;
  end if;

  -- 0d. וכל 22 המזהים הם בדיוק אותה אוכלוסייה, ועדיין 'לא ידוע'. שורה שמישהו
  --     סימן ביד בינתיים אינה נדרסת — היא עוצרת את הקובץ.
  select count(*) into v_ready_paid
    from public.jobs where id = any(v_paid_ids)
     and paid = 'לא ידוע' and dismissed = false;
  if v_ready_paid <> 5 then
    raise exception '0082: רק % מ-5 שורות קבוצה 1 עדיין ב-לא ידוע', v_ready_paid;
  end if;

  select count(*) into v_ready_unpaid
    from public.jobs where id = any(v_unpaid_ids)
     and paid = 'לא ידוע' and dismissed = false;
  if v_ready_unpaid <> 17 then
    raise exception '0082: רק % מ-17 שורות קבוצות 2+3 עדיין ב-לא ידוע', v_ready_unpaid;
  end if;

  -- 0e. ⚠️ הכיסוי — הבדיקה שמפרידה בין שולם לשולם-חלקית.
  --     שלושת המסמכים קיימים, סגורים, לא מבוטלים ולא מאורכבים, וסכום
  --     העבודות שכל אחד מכסה בתוספת מע"מ שווה בדיוק לברוטו שמורנינג חישב.
  select count(*) into v_bad
    from public.documents d
   where d.morning_doc_number = any(v_docs)
     and (d.type <> 320
          or d.status is distinct from 1
          or d.cancelled_at is not null
          or d.archived_at is not null
          or d.bundle_job_ids is null
          or (d.raw->>'amount') is null
          or abs((d.raw->>'amount')::numeric
                 - round((select coalesce(sum(j.amount), -1) from public.jobs j
                           where j.id = any(d.bundle_job_ids)) * 1.18, 2)) > 0.01);
  if v_bad <> 0 then
    raise exception '0082: % מתוך 3 מסמכי ה-320 אינם סגורים או שהסכום אינו מכסה את העבודות — תשלום חלקי, אין לסמן כן', v_bad;
  end if;
  if (select count(*) from public.documents where morning_doc_number = any(v_docs)) <> 3 then
    raise exception '0082: לא נמצאו שלושת מסמכי ה-320';
  end if;

  -- 0f. והכיסוי הוא בדיוק חמש העבודות האלה — לא ארבע ולא שש. איחוד
  --     bundle_job_ids של שלושת המסמכים חייב להיות זהה לרשימת קבוצה 1.
  select array_agg(distinct x order by x) into v_covered
    from public.documents d, unnest(d.bundle_job_ids) x
   where d.morning_doc_number = any(v_docs);
  if v_covered is distinct from (select array_agg(distinct x order by x) from unnest(v_paid_ids) x) then
    raise exception '0082: העבודות שמסמכי ה-320 מכסים אינן בדיוק חמש שורות קבוצה 1';
  end if;

  -- 0g. והכיוון ההפוך: אף אחת מ-17 השורות שעומדות לקבל 'לא' אינה מכוסה
  --     במסמך תשלום כלשהו. סימון "לא שולם" על כסף שנכנס הוא הנזק החמור
  --     מבין השניים, וזו הבדיקה היחידה שתופסת אותו.
  select count(*) into v_bad
    from public.jobs j
   where j.id = any(v_unpaid_ids)
     and exists (select 1 from public.documents d
                  where d.type in (320, 400)
                    and d.cancelled_at is null and d.archived_at is null
                    and (d.job_id = j.id or j.id = any(d.bundle_job_ids)));
  if v_bad <> 0 then
    raise exception '0082: % שורות שעומדות לקבל לא נושאות מסמך תשלום — הסיווג השתנה מאז המדידה', v_bad;
  end if;

  -- =====================================================================
  -- 1. SNAPSHOT
  -- =====================================================================
  select count(*) into v_jobs_pre from public.jobs;
  select md5(string_agg(t.x, '|' order by t.x)) into v_digest_pre
    from (select (to_jsonb(j) - 'paid')::text as x from public.jobs j) t;

  -- כל מה שנשאר ב-'לא ידוע' ואינו אחד מה-22 — 5 המבוטלות היום, וכל שורת
  -- ייבוא שתגיע לשם בעתיד. נספר לפי מזהה ולא לפי notes, כי notes ריק היה
  -- מחליק מתחת ל-NOT LIKE בלי להישמע.
  select count(*) into v_other_unknown_pre
    from public.jobs
   where paid = 'לא ידוע' and id <> all(v_paid_ids || v_unpaid_ids);

  select count(*) filter (where paid = 'כן'),
         count(*) filter (where paid = 'לא'),
         count(*) filter (where paid = 'לא ידוע'),
         count(*) filter (where paid = 'ללא חיוב')
    into v_yes_pre, v_no_pre, v_unk_pre, v_nc_pre
    from public.jobs;

  select coalesce(sum(amount), 0) into v_debt_pre
    from public.jobs where paid = 'לא' and amount is not null and dismissed = false;

  -- =====================================================================
  -- 2. THE WRITES. מזהים מפורשים בלבד, ו-`and paid = 'לא ידוע'` על שניהם:
  --    הפרדיקט הוא ההגנה, לא ה-WHERE על המזהה. שורה שזזה בין השומר לכתיבה
  --    פשוט לא תיכתב, והספירה למטה תתפוס זאת.
  -- =====================================================================

  -- 2a. קבוצה 1 → 'כן'
  with upd as (
    update public.jobs set paid = 'כן'
     where id = any(v_paid_ids) and paid = 'לא ידוע'
    returning 1
  ) select count(*) into v_upd_paid from upd;

  -- 2b. היומן, לחמש השורות האלה בלבד.
  --     jobs.paid אינה נושאת עמודת חותמת זמן משלה (0001), ולכן job_marked_paid
  --     הוא הרישום היחיד של מתי הכסף נכנס — והרדאר קורא בדיוק אותו כאות
  --     התשלום שלו. המספר והתאריך נשלפים מ-documents ולא מוקלדים, כדי שמה
  --     שנרשם ביומן יהיה מה שבאמת במסד.
  --     actor_id ריק במכוון, לפי מוסכמת 0064/0066: מיגרציה עשתה זאת, לא אדם.
  with ev as (
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    select 'job', j.id, 'job_marked_paid', null,
           jsonb_build_object(
             'via', '0082_backfill',
             'doc_type', 'tax_receipt',
             'morning_doc_number', d.morning_doc_number,
             'morning_doc_id', d.morning_doc_id,
             'document_date', d.document_date,
             'previous_paid', 'לא ידוע',
             'job_amount', j.amount,
             'document_gross', (d.raw->>'amount')::numeric)
      from public.jobs j
      join public.documents d
        on d.morning_doc_number = any(v_docs)
       and j.id = any(d.bundle_job_ids)
     where j.id = any(v_paid_ids)
    returning 1
  ) select count(*) into v_events from ev;

  -- 2c. קבוצות 2+3 → 'לא'. אין אירוע: 'לא' אינו תקבול, ושורת job_marked_paid
  --     עליו הייתה מלמדת את הרדאר שנכנס כסף שלא נכנס.
  with upd as (
    update public.jobs set paid = 'לא'
     where id = any(v_unpaid_ids) and paid = 'לא ידוע'
    returning 1
  ) select count(*) into v_upd_unpaid from upd;

  -- =====================================================================
  -- 3. CANARY
  -- =====================================================================
  if v_upd_paid <> 5 then
    raise exception '0082 canary: % שורות עודכנו ל-כן במקום 5', v_upd_paid;
  end if;
  if v_upd_unpaid <> 17 then
    raise exception '0082 canary: % שורות עודכנו ל-לא במקום 17', v_upd_unpaid;
  end if;
  if v_events <> 5 then
    raise exception '0082 canary: נכתבו % אירועים במקום 5', v_events;
  end if;
  if (select count(*) from public.events where payload->>'via' = '0082_backfill') <> 5 then
    raise exception '0082 canary: מספר אירועי 0082_backfill ביומן אינו 5';
  end if;

  -- 3a. הערכים באמת שם, נקראים חזרה ולא מונחים מספירת השורות שעודכנו.
  if (select count(*) from public.jobs where id = any(v_paid_ids) and paid = 'כן') <> 5 then
    raise exception '0082 canary: לא כל 5 שורות קבוצה 1 נושאות כן';
  end if;
  if (select count(*) from public.jobs where id = any(v_unpaid_ids) and paid = 'לא') <> 17 then
    raise exception '0082 canary: לא כל 17 שורות קבוצות 2+3 נושאות לא';
  end if;

  -- 3b. ⚠️ אפס נזק צדדי. ה-digest מכסה כל עמודה של כל שורה ב-jobs מלבד paid,
  --     וזו ההוכחה שדבר מלבד העמודה הזאת לא זז — לא היעדר משפט UPDATE נוסף,
  --     שמוכיח רק שאיש לא כתב אחד בכוונה.
  select count(*) into v_jobs_post from public.jobs;
  select md5(string_agg(t.x, '|' order by t.x)) into v_digest_post
    from (select (to_jsonb(j) - 'paid')::text as x from public.jobs j) t;

  if v_jobs_post <> v_jobs_pre then
    raise exception '0082 canary: מספר ה-jobs השתנה: % -> %', v_jobs_pre, v_jobs_post;
  end if;
  if v_digest_post is distinct from v_digest_pre then
    raise exception '0082 canary: עמודה שאינה paid השתנתה ב-jobs';
  end if;

  -- 3c. האוכלוסייה נוקתה במלואה, ומה שנשאר ב-'לא ידוע' הוא בדיוק מה שהיה
  --     שם ואינו אחד מה-22 — 5 המבוטלות. אילו המספר היה זז, הקובץ היה נוגע
  --     במשהו שלא סיווג.
  select count(*) into v_left_over
    from public.jobs
   where paid = 'לא ידוע' and notes like 'נוצר אוטומטית%' and dismissed = false;
  if v_left_over <> 0 then
    raise exception '0082 canary: נותרו % שורות חיות ב-לא ידוע', v_left_over;
  end if;

  select count(*) into v_other_unknown_post
    from public.jobs
   where paid = 'לא ידוע' and id <> all(v_paid_ids || v_unpaid_ids);
  if v_other_unknown_post <> v_other_unknown_pre then
    raise exception '0082 canary: שורות לא ידוע שמחוץ לרשימה השתנו: % -> %', v_other_unknown_pre, v_other_unknown_post;
  end if;

  -- 3d. הספירות מתיישבות: 5 עברו מ-לא ידוע ל-כן, 17 ל-לא, ואיש לא יצא או נכנס.
  select count(*) filter (where paid = 'כן'),
         count(*) filter (where paid = 'לא'),
         count(*) filter (where paid = 'לא ידוע'),
         count(*) filter (where paid = 'ללא חיוב')
    into v_yes_post, v_no_post, v_unk_post, v_nc_post
    from public.jobs;

  if v_yes_post <> v_yes_pre + 5 or v_no_post <> v_no_pre + 17
     or v_unk_post <> v_unk_pre - 22 or v_nc_post <> v_nc_pre then
    raise exception '0082 canary: ההתפלגות אינה מתיישבת: כן %->%, לא %->%, לא ידוע %->%, ללא חיוב %->%',
      v_yes_pre, v_yes_post, v_no_pre, v_no_post, v_unk_pre, v_unk_post, v_nc_pre, v_nc_post;
  end if;

  select coalesce(sum(amount), 0) into v_debt_post
    from public.jobs where paid = 'לא' and amount is not null and dismissed = false;
  if v_debt_post <> v_debt_pre + 15500 then
    raise exception '0082 canary: debtToCollect עבר מ-% ל-% במקום לגדול ב-15500', v_debt_pre, v_debt_post;
  end if;

  -- =====================================================================
  -- 4. הפנקס — באותו בלוק אטומי, נופל או עובר עם השינוי
  -- =====================================================================
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0082', now(), 'bnaya',
    'יישור 22 העבודות שנולדו לא ידוע. עמודה אחת, 22 שורות, 5 שורות ביומן, אפס שינוי סכימה ואפס DELETE. הרקע: jobs.paid הוא NOT NULL עם DEFAULT לא ידוע, ו-ensure_job_for_production מעולם לא נקבה בו עד ש-0081 תיקנה את המקור ב-15.9.26 בשעה 12:32:29 UTC. 0081 עצרה את הדימום ומעכשיו כל ששת יוצרי ה-jobs במערכת נוקבים בערך; הקובץ הזה מנקה את מה שכבר על הרצפה. למה זה משנה: חמישה קוראים בודקים paid שווה לא בשוויון מדויק ולכן עיוורים ללא ידוע — issue.ts:105 שבו 320 אינה מסמנת שולם, issue.ts:107 שבו 400 אינה מסמנת שולם, reconcile.ts:425 שבו linkDocumentToJob אינה מסמנת שולם, reconcile.ts:172 שבו jobNeedsDocType אינה מציעה מסמך תשלום כמועמד ולכן מסך הפערים אינו רואה את השורה בכלל, ו-alerts.ts:263 שבו debtToCollect אינה סופרת אותה. בהכרעת הבעלים חמשת הקוראים נשארים כפי שהם, כי הרחבה לחמישה מקומות היא אותו כלל בחמישה עותקים וחור שישי מובטח — הנימוק ש-milestone.ts:17-25 רשמה כשסירבה ללמד ארבעה מסלולים לכתוב לאבן הדרך; הקובץ הזה מזיז נתונים ולא כללים. שלוש קבוצות ושלוש הכרעות שונות, ולכן שני UPDATE ולא אחד. קבוצה 1, חמישה jobs בסך 5,100 נטו, עוברת לכן: לכולם כבר יצאה חשבונית מס קבלה 320 ולכן הכסף נכנס, והם מעולם לא היו חוב אלא תקבול שלא נרשם — e348c985 ו-abb26af7 ו-52512120 של דינמיקס איזון על 60192, 57398419 של ידידיה ויטל על 60196, ו-c1f348f0 של שחר קרטזמן על 60194. שלושת מסמכי ה-320 הונפקו בין 7.9 ל-10.9, כלומר אחרי 6.9, והם בדיוק המקרים שהאירוע auto_tax_receipt_paid_not_flipped שנוסף בקומיט של 0081 היה מתעד לו היה קיים אז — הם ההוכחה החיה לבאג, וזו הסיבה שהם מקבלים אירוע ושתי הקבוצות האחרות לא. קבוצה 2, שבעה jobs בסך 7,200, עוברת ללא: לכולם מסמך חיוב פתוח בלבד וכל שבעת ה-300 הם status אפס במורנינג, כלומר חוב אמיתי ונוכחי שטרם נגבה. קבוצה 3, עשרה jobs בסך 8,300, עוברת ללא: אין להם מסמך כלל, והבעלים אישר 15.9.26 שכולן ממתינות לחיוב — זו הכרעה שהתקבלה ולא מסקנה של הקובץ, כי אין מסמך לבדו יכול היה להיות גם עבודה שלא תחויב לעולם. מה שזה מזיז במספר שעל המסך: debtToCollect עובר מעשרה jobs ב-33,050 לעשרים ושבעה ב-48,550, וקבוצה 1 אינה נכנסת לשם וגם לא הייתה אמורה. הכיסוי נבדק ולא הונח, וזו הבדיקה שמפרידה בין שולם לשולם חלקית: עבור כל אחד משלושת מסמכי ה-320 נמדד שסכום העבודות שהוא מכסה בתוספת מעמ שווה בדיוק לברוטו שמורנינג עצמו חישב — 60192 מכסה שלוש עבודות, 2,400 כפול 1.18 שווה 2,832 מול raw.amount 2832 בדלתא אפס; 60194 מכסה עבודה אחת, 1,600 כפול 1.18 שווה 1,888 מול 1888 בדלתא אפס; 60196 מכסה עבודה אחת, 1,100 כפול 1.18 שווה 1,298 מול 1298 בדלתא אפס. כשל בבדיקה הזאת עוצר את כל הקובץ ואינו מדלג על שורה, כי תקבול חלקי שמסומן כן הוא כסף שנמחק מהמעקב. חמש שורות מבוטלות נשארות בלא ידוע ואינן ברשימת המזהים: שתי הפקות טסט מ-29.7 שסכומן ריק, ושלוש כפילויות רישום ש-0065 ו-0066 כבר הכריעו בהן; שורה מבוטלת היא מחוץ לכל משטח כספי לפי 0041, ולתת לה ערך paid הוא לנקות חלון בבית שנהרס. המזהים מפורשים ולא פרדיקט רחב, ושתי הרשימות נבדקות כזרות זו לזו ובגודל הנכון — מזהה שהודבק פעמיים היה מקבל כן ואז לא לפי סדר המשפטים, בשקט. כל UPDATE נושא and paid שווה לא ידוע, כך שהפרדיקט הוא ההגנה ולא ה-WHERE על המזהה: שורה שמישהו סימן ביד בין השומר לכתיבה פשוט לא תיכתב, וספירת השורות שעודכנו תתפוס זאת ותפיל את הקובץ. האירוע ביומן נכתב רק לחמש שורות קבוצה 1, כי jobs.paid אינה נושאת עמודת חותמת זמן משלה מ-0001 ולכן job_marked_paid הוא הרישום היחיד של מתי הכסף נכנס והרדאר קורא בדיוק אותו כאות התשלום שלו; המספר, מזהה המורנינג והתאריך נשלפים מ-documents ולא מוקלדים, כדי שמה שנרשם ביומן יהיה מה שבאמת במסד, ו-actor_id ריק במכוון לפי מוסכמת 0064 ו-0066 שלפיה מיגרציה עשתה זאת ולא אדם. לקבוצות 2 ו-3 אין אירוע כי לא אינו תקבול, ושורת job_marked_paid עליו הייתה מלמדת את הרדאר שנכנס כסף שלא נכנס. שלוש עשרה בדיקות לפני שורת הפנקס: הפנקס אינו מכיל 0082 והפנקס כן מכיל 0081; שתי הרשימות בגודל 5 ו-17, זרות זו לזו ובלי מזהה כפול; האוכלוסייה היא בדיוק 22 שורות ברגע ההרצה ולא רק ברגע המדידה; כל 5 וכל 17 המזהים עדיין בלא ידוע; שלושת מסמכי ה-320 קיימים, מסוג 320, status אחד, לא מבוטלים ולא מאורכבים ונושאים raw.amount, וסכומם מכסה את העבודות בדלתא קטנה מאגורה; איחוד bundle_job_ids של שלושתם זהה בדיוק לרשימת קבוצה 1, לא ארבע ולא שש; ואף אחת מ-17 השורות שעומדות לקבל לא אינה מכוסה במסמך תשלום כלשהו — הכיוון ההפוך, והנזק החמור מבין השניים, שכן סימון לא שולם על כסף שנכנס מוחק אותו מהמעקב; בדיוק 5 עודכנו לכן ובדיוק 17 ללא, והערכים נקראים חזרה מהטבלה ולא מונחים מספירת השורות; בדיוק 5 אירועים עם via שווה 0082_backfill; md5 על כל עמודה של כל שורה ב-jobs מלבד paid זהה לפני ואחרי, וזו ההוכחה לאפס נזק צדדי; מספר ה-jobs זהה; אפס שורות חיות נותרו בלא ידוע ומספר השורות בלא ידוע שמחוץ לרשימת ה-22 זהה לפני ואחרי, נספר לפי מזהה ולא לפי notes כי notes ריק היה מחליק מתחת ל-NOT LIKE בלי להישמע; ההתפלגות מתיישבת, כן גדל ב-5 ולא גדל ב-17 ולא ידוע קטן ב-22 וללא חיוב לא זז; ו-debtToCollect גדל בדיוק ב-15,500. הרשאות מוצהרות לפי כלל 49: הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה ולא עמודה ולא טיפוס ולא policy ולא אינדקס — ואינו מחליף שום פונקציה; הוא כותב ערכים לעמודה קיימת ומוסיף שורות ל-events, ולכן אין GRANT ואין דבר שהרשאותיו יכולות להיוולד שגויות. זה נאמר במפורש ולא מושאר לשתיקה, כי אין שינוי הרשאות היא טענה שקורא צריך למצוא ולא להסיק. החצי של כלל 49 שמכה בשקט אינו חל כאן ונאמר בכל זאת: jobs.paid כבר מוגנת ב-trg_guard_job_money שהוא BEFORE UPDATE ודורש can_edit_money, וב-RLS, ושתיהן לא נגעו; סשן SQL Editor עובר את הטריגר כי auth.uid ריק, אותה התנהגות ש-0072 תיעדה, וזה המצב הקיים ולא דבר שהקובץ הזה יוצר. מחוץ להיקף במכוון: חמשת הקוראים שבודקים שוויון מדויק נשארים כפי שהם בהכרעת הבעלים; חמש השורות המבוטלות נשארות בלא ידוע; ו-jobs.paid עדיין חסרת עמודת חותמת זמן משלה, כך שהיומן נשאר המקור היחיד לתאריך התשלום.');

  -- =====================================================================
  -- 5. NOTICE — מה שהבעלים מדביק בחזרה
  -- =====================================================================
  raise notice '0082 לפני : כן=%  לא=%  לא ידוע=%  ללא חיוב=%', v_yes_pre, v_no_pre, v_unk_pre, v_nc_pre;
  raise notice '0082 אחרי : כן=%  לא=%  לא ידוע=%  ללא חיוב=%', v_yes_post, v_no_post, v_unk_post, v_nc_post;
  raise notice '0082 עודכנו: 5 ל-כן (קבוצה 1) · 17 ל-לא (קבוצות 2+3) · % אירועי יומן', v_events;
  raise notice '0082 debtToCollect: % -> %  (גדל ב-%)', v_debt_pre, v_debt_post, v_debt_post - v_debt_pre;
  raise notice '0082 נותרו ב-לא ידוע: % שורות, כולן מבוטלות ומחוץ להיקף', v_unk_post;
  raise notice '0082 הוחלה ונרשמה.';

end $mig$;
