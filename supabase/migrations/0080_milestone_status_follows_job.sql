-- 0080 — contract_milestones.status מתיישרת עם ה-job שכבר מעיד עליה
--
-- מה זה ולמה. עמודת status היא עמודה שאף מסלול הנפקה אינו מקדם. שלושת
-- הכפתורים ב-/contracts — enqueue, deal-invoice, tax — אינם נוגעים בה, וכל
-- אחד מהם מצהיר על כך במפורש (enqueue/route.ts:37-39). מה שכן כותב אליה הוא
-- הרישום הידני, תפריט הסטטוס הידני, וסקריפט ההגירה — שניים מהם ידניים והשלישי
-- רץ פעם אחת ב-2026-07.
--
-- התוצאה נמדדה 15.9.26: שלוש אבני דרך יושבות ב-'pending' אחרי שיצאו להן
-- מסמכים, ואחת מהן גם נגבתה במלואה. הכותרת "התחייבות פתוחה" דיווחה ₪26,500
-- כשהחוב האמיתי היה ₪21,500 — ההפרש הוא ₪5,000 של "בלי יריה אחת — פרק 1 ו-2",
-- שקיבלה חשבונית מס/קבלה 60197 ב-14.9 ו-jobs.paid שלה הוא 'כן' מאז.
--
-- ⚠️ הכרעת הבעלים 15.9.26, והיא הקשר של הקובץ הזה: מצב אבן הדרך נגזר מה-job.
-- העמודה מפסיקה להיות מקור אמת. הקוד כבר לא קורא אותה לבדה — deriveMilestoneState
-- מחזיקה את הכלל, וחמשת הצרכנים שקראו אותה ישירות (openCommitment,
-- openMilestones, milestoneOverdue, milestoneApproaching, ואריח ה-hub) עברו
-- לגזירה בקומיט שקדם לקובץ הזה.
--
-- ═══ אז למה בכלל לתקן עמודה שאיש כבר אינו סומך עליה ═══
-- כדי שלא תסתור. עמודה שנשארת שגויה ואיש אינו קורא אותה היא המלכודת הבאה:
-- מישהו יקרא אותה בעוד חצי שנה בדיוק כפי שהרדאר קרא אותה עד היום, ויקבל את
-- אותה תשובה שגויה בלי שדבר יאותת. התיקון כאן אינו משנה ולו פיקסל אחד במסך —
-- הגזירה כבר מחזירה את אותן תשובות — והוא נעשה כדי שהשקר לא ישכב במסד.
--
-- ═══ הכלל, ולמה הוא לא מוקלד ═══
-- הערכים מחושבים מ-jobs ולא נכתבים ביד, כדי שהמסד והקוד לא ייסחפו:
--
--   jobs.paid = 'כן'                              → 'paid'
--   invoice_biz או invoice_tax נושא ערך            → 'invoiced'
--   אחרת                                          → נשארת כפי שהיא
--
-- אותו כלל בדיוק שב-lib/finance/milestone.ts, ואותו אחד שכבר קיים ב-issue.ts:
-- jobPatchForDocument (שורות 100-107) היא הסמכות שקבעה מה כל מסמך כותב ל-job,
-- וזה רק קורא את התוצאה שלה חזרה. 'paid' גוברת על 'invoiced' כי הבדיקה שלה
-- קודמת — job ששולם עם חשבונית הוא שולם.
--
-- למה 305 אינה מגיעה ל-'paid': היא מצהירה על חוב ואינה אומרת דבר על כסף
-- שהגיע (issue.ts:104). היא כותבת invoice_tax ולכן נוחתת על 'invoiced', ורק
-- 320 או 400 הופכות את jobs.paid.
--
-- ═══ מה זה לא עושה ═══
-- אפס שינוי סכימה — אין ALTER, אין אינדקס, אין טיפוס, אין policy. לכן גם אין
-- רענון טיפוסים (צעד 3 בטקס ה-README אינו חל), ואין אובייקט נושא-ACL ולכן לא
-- הונפק GRANT (כלל 49: אין כאן דבר שהרשאותיו יכולות להיוולד שגויות).
-- אפס INSERT, אפס DELETE, אפס שורה שנוצרה או נהרסה. עמודה אחת, שלוש שורות.
--
-- ═══ מה מחוץ להיקף, במכוון, וכל אחד הוא צעד בפני עצמו ═══
-- • אין אינדקס ייחודי על contract_milestones.job_id — אין עליה שום אינדקס
--   מלבד ה-pkey (נמדד 15.9.26). היחס 1:1 נשען על בדיקת קריאה ב-
--   milestones/[mid]/route.ts:67-75, עם המרוץ שבכך. ביום ש-job יישא שתי אבני
--   דרך, jobs.paid='כן' יצבע את שתיהן. אפס הפרות היום. לבקלוג, באותה צורה
--   ש-0079 נתנה ל-pending_documents.
-- • כפל הספירה ברדאר: icr ואריאל (₪21,500) נספרות גם ב-openCommitment וגם
--   ב-debtToCollect. קדם לבאג הזה, לא נגעה, לבקלוג.
-- • התפריט הידני נשאר. "סמן שולם" ב-/finance פועל על job, ולאבן דרך אין job
--   עד שמונפק לה המסמך הראשון — מצב הפתיחה הרגיל ולא חריג.

do $$
declare
  v_expected  int := 3;
  v_changed   int;
  v_md5_before text;
  v_md5_after  text;
  v_rows_before int;
  v_rows_after  int;
  v_jobs_before int;
  v_jobs_after  int;
  v_still_wrong int;
begin
  -- ═══ שומרים לפני הכתיבה ═══

  if exists (select 1 from public.schema_ledger where version = '0080') then
    raise exception '0080 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- הפנקס הוא הרצף ולא שמות הקבצים. אם 0079 חסרה, המספור נגזר מפנקס אחר
  -- וכל הספירות למטה נמדדו מול מסד אחר.
  if not exists (select 1 from public.schema_ledger where version = '0079') then
    raise exception '0079 אינה בפנקס — המספור נגזר מפנקס אחר, עצור';
  end if;

  -- טביעה על כל מה שאינו status. אם היא משתנה, נגענו במשהו שלא היה אמור
  -- להשתנות — וזו ההוכחה, לא ה-UPDATE שמבטיח אותה.
  select md5(string_agg(
           id::text || '|' || contract_id::text || '|' || name || '|' ||
           amount::text || '|' || coalesce(expected_date::text,'~') || '|' ||
           is_estimated::text || '|' || coalesce(job_id::text,'~') || '|' ||
           created_at::text, ',' order by id))
    into v_md5_before from public.contract_milestones;

  select count(*) into v_rows_before from public.contract_milestones;
  select count(*) into v_jobs_before from public.jobs;

  -- כמה שורות באמת לא מסכימות עם ה-job שלהן. אם זה אינו 3, המסד אינו במצב
  -- שנמדד ב-15.9.26 ואסור להמשיך על סמך מדידה ישנה.
  select count(*) into v_changed
    from public.contract_milestones m
    join public.jobs j on j.id = m.job_id
   where m.status is distinct from
         (case when j.paid = 'כן' then 'paid'
               when coalesce(nullif(btrim(j.invoice_biz), ''), nullif(btrim(j.invoice_tax), '')) is not null
                 then 'invoiced'
               else m.status end);

  if v_changed <> v_expected then
    raise exception 'צפויות % שורות לתיקון, נמצאו % — המסד אינו במצב שנמדד, עצור',
                    v_expected, v_changed;
  end if;

  -- ═══ הכתיבה ═══
  --
  -- ה-JOIN הוא הפילטר: אבן דרך בלי job אינה נגעת כלל, כי אין לה מה להעיד
  -- עליה. ענף ה-else מחזיר את הערך הקיים, כך ש-job נקי (בלי מסמך ובלי תשלום)
  -- אינו מוריד אבן דרך שסומנה ביד — התיקון מוסיף ולעולם אינו גורע, בדיוק כמו
  -- ה-or-gate בקוד.
  update public.contract_milestones m
     set status = case
                    when j.paid = 'כן' then 'paid'
                    when coalesce(nullif(btrim(j.invoice_biz), ''), nullif(btrim(j.invoice_tax), '')) is not null
                      then 'invoiced'
                    else m.status
                  end
    from public.jobs j
   where j.id = m.job_id
     and m.status is distinct from
         (case when j.paid = 'כן' then 'paid'
               when coalesce(nullif(btrim(j.invoice_biz), ''), nullif(btrim(j.invoice_tax), '')) is not null
                 then 'invoiced'
               else m.status end);

  get diagnostics v_changed = row_count;
  if v_changed <> v_expected then
    raise exception 'עודכנו % שורות במקום % — גלגול לאחור', v_changed, v_expected;
  end if;

  -- ═══ canaries ═══

  -- 1. אפס עמודות אחרות נגעו, על פני כל הטבלה
  select md5(string_agg(
           id::text || '|' || contract_id::text || '|' || name || '|' ||
           amount::text || '|' || coalesce(expected_date::text,'~') || '|' ||
           is_estimated::text || '|' || coalesce(job_id::text,'~') || '|' ||
           created_at::text, ',' order by id))
    into v_md5_after from public.contract_milestones;
  if v_md5_after is distinct from v_md5_before then
    raise exception 'טביעת העמודות שאינן status השתנתה — נגענו במשהו שלא היה אמור להשתנות';
  end if;

  -- 2. אפס שורות נוצרו או נהרסו, כאן ובטבלה שממנה נקראה האמת
  select count(*) into v_rows_after from public.contract_milestones;
  select count(*) into v_jobs_after from public.jobs;
  if v_rows_after <> v_rows_before then
    raise exception 'מספר אבני הדרך השתנה: % → %', v_rows_before, v_rows_after;
  end if;
  if v_jobs_after <> v_jobs_before then
    raise exception 'מספר ה-jobs השתנה: % → % — מיגרציה הזאת אינה אמורה לגעת ב-jobs',
                    v_jobs_before, v_jobs_after;
  end if;

  -- 3. הבדיקה הנושאת: אף שורה בעלת job אינה סותרת עוד את ה-job שלה.
  --    נמדדת על כל הטבלה ולא רק על השורות שנכתבו.
  select count(*) into v_still_wrong
    from public.contract_milestones m
    join public.jobs j on j.id = m.job_id
   where (j.paid = 'כן' and m.status <> 'paid')
      or (j.paid <> 'כן'
          and coalesce(nullif(btrim(j.invoice_biz), ''), nullif(btrim(j.invoice_tax), '')) is not null
          and m.status not in ('invoiced','paid'));
  if v_still_wrong <> 0 then
    raise exception 'נותרו % שורות שסותרות את ה-job שלהן', v_still_wrong;
  end if;

  -- 4. אף ערך אינו מחוץ ל-CHECK (ה-constraint היה תופס, אבל בשגיאת postgres גולמית)
  if exists (select 1 from public.contract_milestones
              where status not in ('pending','invoiced','paid')) then
    raise exception 'נכתב סטטוס שאינו pending/invoiced/paid';
  end if;

  -- ═══ הפנקס — באותו בלוק אטומי, נופל או עובר עם השינוי ═══
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0080', now(), 'bnaya',
    'contract_milestones.status מתיישרת עם ה-job. שלוש שורות, עמודה אחת, אפס שינוי סכימה ואפס שורה שנוצרה או נהרסה. הרקע: status היא עמודה שאף מסלול הנפקה אינו מקדם — שלושת כפתורי /contracts מצהירים שאינם נוגעים בה — ולכן שלוש אבני דרך ישבו ב-pending אחרי שיצאו להן מסמכים, ואחת מהן גם נגבתה במלואה. נמדד 15.9.26: הכותרת "התחייבות פתוחה" דיווחה 26,500 מול חוב אמיתי של 21,500, וההפרש 5,000 הוא "בלי יריה אחת — פרק 1 ו-2" שקיבלה 320 מספר 60197 ב-14.9 ו-jobs.paid שלה כן מאז. הערכים המדויקים: פרק 1 ו-2 pending→paid, icr spotlight "1" pending→invoiced, אריאל "תשלום מלא" pending→invoiced; חלק א וחלק ב כבר הסכימו ולא נגעו. הכרעת הבעלים באותו יום, והיא ההקשר: מצב אבן הדרך נגזר מה-job ו-status מפסיקה להיות מקור אמת. הנימוק נמדד ולא נטען — מבין שלוש אבני הדרך שהציגו ירוק, אפס קיבלו אותו מהעמודה, כולן מ-jobs.paid, והכתיבה הידנית היחידה בהיסטוריית המערכת (1.9.26) נחתה על שורה שה-job שלה כבר אמר שולם ולכן לא שינתה דבר; ארבעה מסלולים בלתי תלויים מזיזים את jobs.paid ואף אחד אינו מזכיר contract_milestones (issue.ts:105 ו-107, reconcile.ts:426, mark-paid/route.ts:26 ו-61), כך שללמד כל אחד מהם לכתוב לאבן הדרך זה אותה לוגיקה בארבעה מקומות וחור חמישי מובטח. אז למה בכלל לתקן עמודה שאיש כבר אינו סומך עליה: כדי שלא תסתור. המיגרציה אינה משנה ולו פיקסל אחד — הגזירה כבר מחזירה את אותן תשובות — והיא נעשית כדי ששקר לא ישכב במסד וייקרא בעוד חצי שנה בדיוק כפי שהרדאר קרא אותו עד היום. הערכים מחושבים מ-jobs ולא מוקלדים, כדי שהמסד והקוד לא ייסחפו: paid=כן נותן paid, invoice_biz או invoice_tax נושא ערך נותן invoiced, ואחרת השורה נשארת כפי שהיא. זו אותה סמכות שכבר קיימת — jobPatchForDocument ב-issue.ts:100-107 קבעה מה כל מסמך כותב ל-job, וזה קורא את התוצאה שלה חזרה; 305 נוחתת על invoiced ולא על paid כי היא מצהירה על חוב ואינה אומרת דבר על כסף שהגיע (issue.ts:104), ורק 320 או 400 הופכות את jobs.paid. ה-JOIN הוא הפילטר ולכן אבן דרך בלי job אינה נגעת, וענף ה-else מחזיר את הערך הקיים כך שה-job נקי אינו מוריד אבן דרך שסומנה ביד — התיקון מוסיף ולעולם אינו גורע, בדיוק כמו ה-or-gate שנשאר בקוד. ה-or-gate נשאר במכוון ואינו כפילות: הוא הדבר היחיד שמחזיק את התצוגה כשהעמודה מפגרת, והתנאי להסרתו הוא היום שבו כל ארבעת מסלולי ה-paid יכתבו גם לאבן הדרך. שבע בדיקות לפני שורת הפנקס: הפנקס אינו מכיל 0080 והפנקס כן מכיל 0079; בדיוק 3 שורות בפרדיקט לפני הכתיבה, אחרת המסד אינו במצב שנמדד ואסור להמשיך על סמך מדידה ישנה; בדיוק 3 עודכנו; md5 על כל העמודות מלבד status זהה לפני ואחרי, וזו ההוכחה לאפס נזק צדדי ולא ה-WHERE שמבטיח אותה; מספר אבני הדרך לא השתנה ומספר ה-jobs לא השתנה; אפס שורות נותרו סותרות את ה-job שלהן, נמדד על כל הטבלה ולא רק על הנכתבות; ואפס ערכים מחוץ ל-CHECK. מחוץ להיקף במכוון, כל אחד צעד בפני עצמו: אין אינדקס ייחודי על contract_milestones.job_id ואין עליה שום אינדקס מלבד ה-pkey, כך שהיחס 1:1 נשען על בדיקת קריאה ב-milestones/[mid]/route.ts:67-75 עם המרוץ שבכך וביום ש-job יישא שתי אבני דרך jobs.paid=כן יצבע את שתיהן — אפס הפרות היום, לבקלוג באותה צורה ש-0079 נתנה ל-pending_documents; כפל הספירה ברדאר שבו icr ואריאל נספרות גם ב-openCommitment וגם ב-debtToCollect קדם לבאג הזה ולא נגעה; והתפריט הידני נשאר כי "סמן שולם" ב-/finance פועל על job ולאבן דרך אין job עד שמונפק לה המסמך הראשון, שהוא מצב הפתיחה הרגיל ולא חריג.');

  raise notice '0080: % שורות תוקנו, כל הבדיקות עברו', v_changed;
end $$;
