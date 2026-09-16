-- 0088 — החזרת המיזוג של 0065: אוכלי סרטים / ליעד הרמן, 28.8.2026
--
-- ═══ מה זה ולמה ═══
-- ב-30.8 מיגרציה 0065 מיזגה את ההפקה הידנית 94d4a7ea אל ההפקה שנקלטה מהיומן
-- 6bd7289f, הסתירה את ה-job הכפול 8ce89e57 (₪600), והעתיקה guest='משה'
-- לשורדת. **ב-8.9 12:27:11 טכנאי (gilhasid43@gmail.com) ביטל את המיזוג
-- בממשק**, ומאז שתי ההפקות חיות שוב בלוח — וזה מה שהבעלים רואה.
--
-- הקובץ הזה כותב עמודה אחת בשורה אחת: מחזיר את merged_into. הוא אינו מתקן
-- את הצד הכספי, כי **הצד הכספי מעולם לא התקלקל** — וזו העובדה שקובעת את כל
-- היקף הקובץ. ביטול המיזוג ב-[duplicate-group/route.ts:113-147] כותב
-- `merged_into = null` ותו לא: job 8ce89e57 עדיין dismissed, הזמנת העבודה
-- ee228d06 עדיין rejected, ו-guest='משה' עדיין על השורדת. שלוש הפעולות של
-- 0065 מתוך ארבע שרדו את הביטול, ולכן החזרת הרביעית היא כל מה שנדרש.
--
-- ═══ למה לא בממשק ═══
-- מאותה סיבה בדיוק ש-0065 לא יכלה: findDupGroup
-- ([duplicate-group/route.ts:40-54]) דורש calendar_uid על **כל** חברי הקבוצה
-- ולפחות שני UID נבדלים, ולהפקה הידנית אין UID כלל — distinctUids.size = 1
-- ולכן הכפתור מחזיר 400 "אין קבוצת כפילויות פעילה".
--
-- וזו אי-הסימטריה שהיא השורש: ל-DELETE באותו קובץ **אין** דרישת UID. הוא
-- בודק merged_into IS NOT NULL ושכל השלבים pending — ותו לא. לכן מיזוג
-- שהממשק לא יכול היה ליצור, הממשק כן יכול לבטל, וטכנאי בלי can_edit_money
-- ביטל החלטה כספית שהבעלים קיבל. התיקון הקודי לזה הוא טיקט נפרד באותו יום;
-- הקובץ הזה מחזיר את הנתון בלבד.
--
-- ═══ למה merged_into ולא ביטול ═══
-- הנימוק של 0065, שהוא הנימוק של 0064 באולמדיה, ולא השתנה: ההקלטה קרתה
-- ורק הרישום כפול. 'בוטל' היה מצהיר שהיא לא קרתה — הצהרה שקרית.
--
-- ═══ למה זה דחוף ═══
-- 94d4a7ea יושבת ב-'נשלח_ללקוח'. אישור לקוח עליה מגיע ל-[links.ts:759],
-- וארבעת כללי findBilledEvidence שותקים עליה: ל-job 8ce89e57 אין
-- invoice_biz/invoice_tax (כלל a), הזמנה ee228d06 היא work_order ו-rejected
-- (כלל b), אין מסמך מקושר (כלל c), ושני המסמכים הלא-מקושרים של הלקוח
-- (40285 ₪1,416 · 40286 ₪1,770) אינם תואמים ל-₪600 ולכן גם c2 שותק.
-- הלקוח per_episode ו-default_rate=600 ⇒ **חשבונית עסקה ₪600 הייתה נכנסת
-- לתור על הקלטה שכבר חויבה ₪300 ב-40311**. כלל d, שנכתב באותו יום, חוסם
-- את זה מצד הקוד; המיזוג חוסם אותו מצד הנתון. שניהם נדרשים.
--
-- ═══ מה הקובץ הזה לא נוגע בו, ולמה כל אחד ═══
-- • jobs — 8ce89e57 כבר dismissed עם הנימוק של 0065; df5758d7 נושא
--   invoice_biz='40311' ו-₪300, וזהו החיוב האמיתי.
-- • pending_documents — ee228d06 כבר rejected ומעולם לא הגיעה למורנינג;
--   f319930d הונפקה כ-10319.
-- • documents / invoices — 10319 (type 100) ו-40311 (type 300) תקינים
--   ומקושרים. חשבונית המס שטרם יצאה היא P7 ואינה הקובץ הזה.
-- • stages — חמשת השלבים של הכפילות pending, וזה מה שמכשיר את המיזוג ולא
--   מה שהוא משנה.
-- • status — 94d4a7ea נשארת 'נשלח_ללקוח'. merged_into מסתיר אותה מהלוח
--   ומהסנכרון, והסטטוס הוא רישום בן-זמנו של מה שהיה. שינויו היה מחיקת
--   היסטוריה כדי לייפות שורה מוסתרת.
-- • guest — כבר על השורדת מ-0065, שרד את הביטול.
-- • calendar_dup_ack — 0065 לא נגעה בו וגם כאן לא: הוא מסמן "אדם אישר
--   שהכפילות הזאת תקינה", ואיש לא אישר.
--
-- ═══ מה זה אינו — הצהרה כדי שלא ייקרא כתקדים ═══
-- זו אינה ביטול-של-ביטול גנרי ואין כאן מנגנון. מיגרציה שתצטט את 0088 כדי
-- לדרוס החלטת משתמש בטבלה כלשהי מצטטת את החצי הלא נכון: מה שמכשיר את
-- הכתיבה כאן הוא ששלושת החלקים האחרים של אותה החלטה עצמה עדיין עומדים על
-- המסד, כלומר הנתון סותר את עצמו ואנחנו מיישרים אותו לרוב — ולא שדעתנו
-- על הכפילות טובה מדעתו של מי שלחץ.
--
-- אפס שינוי סכימה, אפס DELETE, אפס שורה שנוצרת, עמודה אחת בשורה אחת.

do $mig$
declare
  v_survivor uuid := '6bd7289f-478a-4e1a-a686-207019ec0dd7';  -- של היומן, נשארת
  v_dup      uuid := '94d4a7ea-19cb-4ea8-b46a-e42821c02c6f';  -- הידנית, חוזרת להיות ממוזגת
  v_keep_job uuid := 'df5758d7-d339-4a36-a2a4-cb7968079791';  -- לא נוגעים
  v_dup_job  uuid := '8ce89e57-4f5d-4bd0-a43e-2ad5ee5d4f46';  -- חייב להישאר מוסתר
  v_dup_wo   uuid := 'ee228d06-19c3-4aa7-8025-2957f6793bb1';  -- חייב להישאר rejected
  v_keep_biz text := '40311';
  v_uid      text := '4705C10E-0462-4E6C-BEB3-44E6ED225D1A';
  v_date     date := '2026-08-28';
  v_reason   text := 'המיזוג של 0065 בוטל ידנית 8.9 — הוחזר';
  s          record;
  d          record;
  v_guard    integer;
begin
  if exists (select 1 from schema_ledger where version = '0088') then
    raise exception '0088 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0065 היא ההנחה שעליה כל הקובץ עומד: אם היא לא בפנקס, המיזוג שאנחנו
  -- "מחזירים" מעולם לא קרה, וזו מיגרציה אחרת לגמרי.
  if not exists (select 1 from schema_ledger where version = '0065') then
    raise exception '0065 אינה בפנקס — אין מיזוג להחזיר, עצור';
  end if;

  -- ---- גארד 1: הכפילות היא עדיין מה שזיהינו ------------------------------
  select * into d from public.productions where id = v_dup;
  if not found then raise exception 'ההפקה הכפולה % לא נמצאה', v_dup; end if;
  if d.merged_into is not null then
    raise exception 'הכפילות % כבר ממוזגת (אל %) — כנראה הוחל קודם', v_dup, d.merged_into;
  end if;
  if d.cancelled_at is not null then
    raise exception 'הכפילות % בוטלה בינתיים — החליטו מחדש', v_dup;
  end if;
  -- אם צמח לה UID היא כבר אינה הרישום הידני, והבחירה מי השורדת נפתחת מחדש
  if d.calendar_uid is not null then
    raise exception 'לכפילות % יש כעת calendar_uid (%) — היא כבר לא הרישום הידני, עצור', v_dup, d.calendar_uid;
  end if;
  if d.record_date is distinct from v_date then
    raise exception 'תאריך ההקלטה של הכפילות השתנה (%) — עצור', d.record_date;
  end if;

  -- ---- גארד 2: השלבים של הכפילות עדיין נקיים -----------------------------
  -- אותו מבחן שה-DELETE בממשק מפעיל לפני ביטול מיזוג: שלב שאינו pending
  -- אומר שמישהו עבד על השורה הזאת מאז, והמיזוג היה מסתיר עבודה אמיתית.
  select count(*) into v_guard
    from public.stages where production_id = v_dup and status <> 'pending';
  if v_guard <> 0 then
    raise exception 'לכפילות % יש % שלבים שאינם pending — כבר התחילה עבודה, אל תמזג', v_dup, v_guard;
  end if;

  -- ---- גארד 3: השורדת היא עדיין מה שזיהינו -------------------------------
  select * into s from public.productions where id = v_survivor;
  if not found then raise exception 'ההפקה השורדת % לא נמצאה', v_survivor; end if;
  if s.merged_into is not null then
    raise exception 'השורדת % כבר מוזגה למישהו אחר — עצור', v_survivor;
  end if;
  if s.cancelled_at is not null then
    raise exception 'השורדת % בוטלה בינתיים — עצור', v_survivor;
  end if;
  if s.calendar_uid is distinct from v_uid then
    raise exception 'לשורדת % אין את ה-UID שזוהה (% במקום %) — עצור', v_survivor, s.calendar_uid, v_uid;
  end if;
  if s.record_date is distinct from v_date or s.show_id is distinct from d.show_id then
    raise exception 'השורדת והכפילות כבר אינן אותו יום/אותה תוכנית — עצור';
  end if;

  -- ---- גארד 4: זו באמת קבוצה של שתיים, לא יותר ---------------------------
  select count(*) into v_guard
    from public.productions
   where show_id = s.show_id and record_date = v_date and merged_into is null;
  if v_guard <> 2 then
    raise exception 'צפויות 2 הפקות חיות לתוכנית ביום הזה, נמצאו % — עצור וברר', v_guard;
  end if;

  -- ---- גארד 5: ה-job הכפול עדיין מוסתר ולא רכש כסף -----------------------
  -- הגארד הזה הוא הלב. אם הביטול ב-8.9 **היה** מחזיר את ה-job, הקובץ הזה
  -- לא היה מספיק והיה צריך להסתיר אותו שוב — ואז זו הכרעה כספית שדורשת
  -- אישור הבעלים ולא שורה בקובץ. הוא מסרב לרוץ בדיוק במקרה הזה.
  select count(*) into v_guard from public.jobs j
   where j.id = v_dup_job
     and j.dismissed = true
     and j.invoice_biz is null and j.invoice_tax is null and j.paid <> 'כן'
     and not exists (select 1 from public.documents         x where x.job_id = j.id)
     and not exists (select 1 from public.pending_documents x where x.job_id = j.id)
     and not exists (select 1 from public.documents         x where x.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.pending_documents x where x.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.contract_milestones x where x.job_id = j.id);
  if v_guard <> 1 then
    raise exception 'job % אינו במצב "מוסתר ונקי מכסף" — הביטול החזיר אותו או שהוא רכש מסמך, עצור והכריעו ידנית', v_dup_job;
  end if;

  -- ---- גארד 6: ה-job הכפול שייך לכפילות בלבד -----------------------------
  select count(*) into v_guard from public.job_productions where job_id = v_dup_job;
  if v_guard <> 1 then
    raise exception 'job % קשור ל-% הפקות ולא לאחת — עצור', v_dup_job, v_guard;
  end if;
  if not exists (select 1 from public.job_productions where job_id = v_dup_job and production_id = v_dup) then
    raise exception 'job % אינו קשור לכפילות % — עצור', v_dup_job, v_dup;
  end if;

  -- ---- גארד 7: הזמנת העבודה הכפולה עדיין דחויה ---------------------------
  select count(*) into v_guard
    from public.pending_documents
   where id = v_dup_wo and production_id = v_dup
     and status = 'rejected' and morning_doc_id is null;
  if v_guard <> 1 then
    raise exception 'הזמנת העבודה הכפולה % אינה rejected (או שהגיעה למורנינג) — עצור', v_dup_wo;
  end if;

  -- ---- גארד 8: אין שורת תור חיה שהמיזוג היה מייתם ------------------------
  -- accrued ברשימה יחד עם pending/approved: שורה צבורה היא חיוב שממתין
  -- לפדיון, והסתרת ההפקה שמתחתיה הייתה מותירה אותה בתור בלי מקור.
  select count(*) into v_guard
    from public.pending_documents
   where (production_id = v_dup or job_id = v_dup_job)
     and status in ('pending', 'approved', 'accrued');
  if v_guard <> 0 then
    raise exception 'יש % שורות תור חיות על הכפילות או על ה-job שלה — טפלו בהן קודם', v_guard;
  end if;

  -- ---- גארד 9: ה-job של השורדת שלם, ונושא את החיוב האמיתי ----------------
  if not exists (
    select 1 from public.jobs where id = v_keep_job
       and dismissed = false and invoice_biz = v_keep_biz
  ) then
    raise exception 'job % של השורדת אינו נושא invoice_biz=% או שהוסתר — עצור, זה החיוב האמיתי', v_keep_job, v_keep_biz;
  end if;
  if not exists (
    select 1 from public.job_productions
     where job_id = v_keep_job and production_id = v_survivor
  ) then
    raise exception 'job % אינו מקושר לשורדת % — עצור', v_keep_job, v_survivor;
  end if;

  -- ═══ הפעולה ════════════════════════════════════════════════════════════
  -- אחת, ויחידה. 0065 כתבה כאן ארבעה דברים (guest, merged_into, dismissed,
  -- ואת שובל האודיט); שלושת הראשונים מלבד merged_into שרדו את הביטול ולכן
  -- אינם נכתבים שוב. merged_into היחיד, בדיוק כפי ש-0065 כתבה אותו —
  -- הטבלה אינה נושאת merged_at, ו-calendar_dup_ack לא נגע שם וגם לא כאן.
  update public.productions set merged_into = v_survivor
   where id = v_dup and merged_into is null;

  -- שובל האודיט — אותו event_type ואותה תבנית פיילוד של 0065, עם via
  -- שמפריד בין המיזוג המקורי לבין ההחזרה. actor_id נשאר null במכוון:
  -- מיגרציה עשתה זאת, לא אדם, והדבקת מזהה של מישהו תשים את שמו על החלטה
  -- שלא קיבל.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', v_dup, 'production_merged_duplicate', null,
          jsonb_build_object('merged_into', v_survivor, 'dismissed_job_id', v_dup_job,
                             'rejected_work_order_id', v_dup_wo, 'reason', v_reason,
                             'created_by', 'production_created_manually',
                             'survivor_calendar_uid', v_uid,
                             'via', '0088'));

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0088', now(), 'bnaya',
          'החזרת המיזוג של 0065 — ליעד הרמן / אוכלי סרטים 28.8. עמודה אחת בשורה אחת: productions.merged_into של 94d4a7ea מוחזר ל-6bd7289f. אפס שינוי סכימה, אפס DELETE, אפס שורה שנוצרה מלבד אירוע ושורת פנקס. הרקע: 0065 מיזגה ב-30.8 והסתירה את job 8ce89e57, וב-8.9 12:27:11 טכנאי (gilhasid43@gmail.com, tech, בלי can_edit_money) ביטל את המיזוג דרך DELETE /api/productions/[id]/duplicate-group — מסלול שאין לו את דרישת ה-calendar_uid שחסמה את המיזוג בממשק מלכתחילה, ושבודק רק merged_into IS NOT NULL ושכל השלבים pending. שני התנאים התקיימו כי כל העבודה בוצעה על השורדת. למה עמודה אחת מספיקה, וזו העובדה שקובעת את ההיקף: ה-DELETE כותב merged_into=null ותו לא, ולכן שלוש מארבע הפעולות של 0065 שרדו את הביטול — job 8ce89e57 עדיין dismissed עם הנימוק המקורי, הזמנה ee228d06 עדיין rejected ומעולם לא הגיעה למורנינג, ו-guest=משה עדיין על השורדת. אילו הביטול כן היה מחזיר את ה-job, זו הייתה הכרעה כספית הדורשת את אישור הבעלים ולא שורה בקובץ, וגארד 5 מסרב לרוץ בדיוק במצב הזה. למה זה דחוף: 94d4a7ea יושבת ב-נשלח_ללקוח, וארבעת כללי findBilledEvidence שותקים עליה — אין invoice על 8ce89e57 (a), ee228d06 היא work_order ו-rejected (b), אין מסמך מקושר (c), ושני המסמכים הלא-מקושרים של הלקוח (40285 ב-1,416 ו-40286 ב-1,770) אינם תואמים ל-600 ולכן גם c2 שותק; הלקוח per_episode ו-default_rate=600, כך שאישור לקוח היה מכניס חשבונית עסקה 600 על הקלטה שכבר חויבה 300 ב-40311. כלל d שנכתב באותו יום חוסם את זה מצד הקוד והמיזוג מצד הנתון, ושניהם נדרשים. תשעה גארדים לפני הכתיבה, וכולם נמדדו כמתקיימים לפני שנכתבו: הכפילות בלי UID ובלי ביטול ובלי merged_into, חמשת שלביה pending, השורדת נושאת את UID 4705C10E ולא מוזגה ולא בוטלה, בדיוק שתי הפקות חיות לתוכנית ביום, ה-job הכפול מוסתר ונקי מכל חשבונית תשלום מסמך בנדל ואבן דרך, קשור להפקה אחת בלבד והיא הכפילות, הזמנה ee228d06 rejected ובלי morning_doc_id, אפס שורות תור חיות (pending/approved/accrued — accrued ברשימה כי שורה צבורה היא חיוב שממתין לפדיון והסתרת ההפקה מתחתיה הייתה מותירה אותה יתומה), ו-job df5758d7 של השורדת לא מוסתר ונושא invoice_biz=40311 ומקושר לשורדת. מה לא נגע ולמה: status נשאר נשלח_ללקוח כי merged_into מסתיר את השורה ממילא והסטטוס הוא רישום בן-זמנו, ושינויו היה מחיקת היסטוריה כדי לייפות שורה מוסתרת; stages לא נגעו כי הם מה שמכשיר את המיזוג ולא מה שהוא משנה; documents ו-invoices תקינים ומקושרים, וחשבונית המס שטרם יצאה על 40311 היא P7 ואינה הקובץ הזה; calendar_dup_ack לא נגע כי הוא מסמן שאדם אישר שהכפילות תקינה ואיש לא אישר. הצהרה כדי שלא ייקרא כתקדים: זו אינה ביטול-של-ביטול גנרי ואין כאן מנגנון. מה שמכשיר את הכתיבה הוא ששלושת החלקים האחרים של אותה החלטה עצמה עדיין עומדים על המסד — כלומר הנתון סותר את עצמו ואנחנו מיישרים אותו לרוב — ולא שדעתנו על הכפילות טובה משל מי שלחץ. מיגרציה שתצטט את 0088 כדי לדרוס החלטת משתמש בטבלה כלשהי מצטטת את החצי הלא נכון. שאילתת האימות אינה בקובץ הזה ואינה בתיקיית המיגרציות — כלל 50.');

  raise notice '0088 הוחלה. 94d4a7ea מוזגה חזרה ל-6bd7289f. הצד הכספי לא נגע.';
end $mig$;
