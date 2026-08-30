-- 0065: כפילות ההקלטה של ליעד הרמן / אוכלי סרטים ב-28.8 — מיזוג והסתרת ה-job.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- ⚠️ הרץ אחרי שלב 1 (דחיית הזמנת העבודה הכפולה במסך האישורים). המיגרציה
-- מסרבת לרוץ לפניו — ראה גארד 4. זה מכוון: דחיית מסמך היא החלטה כספית
-- ושמו של אדם צריך להיות עליה, לא שמה של מיגרציה.
--
-- ═══ מה קרה ═══
-- 28.8.2026, שני רישומים של הקלטה אחת:
--   03:01:36Z  calendar_created  → 6bd7289f, calendar_uid 4705C10E-…, 15:00
--   03:01:36Z  document_queued   → f319930d, 600₪
--   ── 11 שעות 18 דקות ──
--   14:20:19Z  production_created_manually (שחר, tech) → 94d4a7ea, בלי UID, 16:00
--   14:20:20Z  document_queued   → ee228d06, 600₪
--   14:20:27Z  שחר סימן 6bd7289f כ"הוקלט"  → job df5758d7 (600₪)
--   14:20:43Z  שחר סימן 94d4a7ea כ"הוקלט"  → job 8ce89e57 (600₪)
-- סנכרון היומן רץ פעם אחת ויצר הפקה אחת. אירוע יומן אחד בלבד קיים ל-28.8.
-- שחר יצר הפקה שנייה ידנית — כנראה בלי לדעת שהסנכרון כבר יצר אחת — וסימן
-- את שתיהן כהוקלטו תוך 16 שניות. התוצאה: שתי הזמנות עבודה של 600₪ בתור
-- ושני jobs של 600₪, על פרק אחד.
--
-- ═══ למה merged_into ולא ביטול ═══
-- אותו נימוק של 0064 באולמדיה, ואותו מנגנון. ההקלטה קרתה; רק הרישום כפול.
-- 'בוטל' היה מצהיר שהיא לא קרתה — הצהרה שקרית. 0019 מגדיר את merged_into
-- כמנגנון המחיקה הרכה לכפילות רישום, והוא הפיך.
-- בנוסף, מסלול הביטול דורש can_manage_users לפרק שהוקלט (0062) — כלומר
-- הוא בכלל לא זמין לשחר, מי שיצר את הכפילות.
--
-- ═══ למה SQL ולא הכפתור בממשק ═══
-- api/productions/[id]/duplicate-group תומך רק בכפילות יומן: findDupGroup
-- מסנן `.not("calendar_uid","is",null)` ודורש שני UID נבדלים. להפקה הידנית
-- אין UID כלל, ולכן הקבוצה יוצאת ריקה והכפתור מחזיר 400. זו כפילות
-- יומן+ידני, מחוץ להגדרה שהממשק יודע לטפל בה.
--
-- ═══ מי השורדת ═══
-- 6bd7289f, זו של היומן — לא בגלל ותק אלא בגלל עוגן: אירוע היומן מצביע
-- עליה. אם היא תוסתר, סנכרון עתידי יראה אירוע בלי הפקה ועלול ליצור אותה
-- מחדש או לסמן calendar_removed. ל-94d4a7ea אין UID והיומן אדיש לה.
--
-- ═══ guest ═══
-- 94d4a7ea נושאת guest='משה' ו-6bd7289f ריקה. הבעלים אישר ש"משה" הוא
-- האורח הנכון, ולכן הוא מועתק לשורדת לפני שהכפילות נעלמת — אחרת המידע
-- היחיד שרק לה יש היה הולך לאיבוד. מועתק רק אם השדה עדיין ריק (גארד 9):
-- אם מישהו הקליד שם אחר בינתיים, המיגרציה עוצרת ולא דורסת.
--
-- ═══ record_time — הכרעה: 15:00 נשארת, אין שינוי ═══
-- היומן אומר 15:00; שחר הקליד 16:00. אין כאן אילוץ טכני — בדקתי: מסלול
-- ה-update של הסנכרון כותב calendar_synced_at בלבד ואינו נוגע ב-record_time,
-- ו-toFlagChanged אינו משווה שעות. כלומר 16:00 לא היה נדרס ולא היה מדליק
-- דגל. זו הכרעה עובדתית בלבד, ואלה השיקולים:
--   • 15:00 הוא רישום בן-זמנו של התכנון, שנוצר לפני ההקלטה.
--   • 16:00 הוקלד 26 שעות אחרי, כחלק מאותה פעולה שכבר הוכחה כשגויה
--     (יצירת רישום כפול). מספר שהוקלד תוך כדי טעות הוא ראיה חלשה יותר.
--   • אף אחת מהשתיים לא אומתה מול ההקלטה עצמה.
-- לכן: לא נוגעים. record_time אינו משפיע על שום סכום, והתיקון אם שחר יאמר
-- אחרת הוא עריכת שדה אחד במגירה. שווה לשאול אותו — לא שווה לנחש כאן.
--
-- ═══ מה המיגרציה לא עושה ═══
-- • אפס DELETE, אפס שינוי סכימה.
-- • לא נוגעת ב-6bd7289f מלבד העתקת guest.
-- • לא נוגעת ב-job df5758d7 (של השורדת) — הוא ה-job האמיתי של הפרק.
-- • לא דוחה מסמכים. שלב 1 נעשה בממשק, בידיים של אדם.
--
-- ═══ אימות מצב לפני הכתיבה (2026-08-30) ═══
--   שתי ההפקות: merged_into null, cancelled_at null, status הוקלט
--   שתי שורות התור: pending, morning_doc_id null — שום דבר לא הגיע למורנינג
--   שני ה-jobs: 600₪, invoice_biz/invoice_tax null, paid 'לא ידוע', לא מודחים
--   job 8ce89e57 אינו מוזכר ב-documents / invoices / contract_milestones /
--     pending_documents — לא ב-job_id ולא ב-bundle_job_ids
--   trg_guard_production_split עובר: can_edit_stages() מחזירה NULL כש-
--     auth.uid() ריק, ו-`not NULL` אינו TRUE (מתועד ב-0019:41).

do $mig$
declare
  v_survivor uuid := '6bd7289f-478a-4e1a-a686-207019ec0dd7';  -- של היומן, נשארת
  v_dup      uuid := '94d4a7ea-19cb-4ea8-b46a-e42821c02c6f';  -- הידנית, מוזגת
  v_keep_job uuid := 'df5758d7-d339-4a36-a2a4-cb7968079791';  -- לא נוגעים
  v_dup_job  uuid := '8ce89e57-4f5d-4bd0-a43e-2ad5ee5d4f46';  -- מוסתר
  v_keep_wo  uuid := 'f319930d-4e27-4a3f-a7e2-1bba06762447';  -- נשאר חי
  v_dup_wo   uuid := 'ee228d06-19c3-4aa7-8025-2957f6793bb1';  -- חייב להיות rejected
  v_uid      text := '4705C10E-0462-4E6C-BEB3-44E6ED225D1A';
  v_date     date := '2026-08-28';
  v_guest    text := 'משה';
  v_reason   text := 'כפילות רישום של הקלטה אחת ב-28.8; ההפקה האמיתית היא 6bd7289f (זו של היומן) ו-job df5758d7 הוא החיוב שלה';
  s          record;
  d          record;
  v_guard    integer;
begin
  if exists (select 1 from schema_ledger where version = '0065') then
    raise exception '0065 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---- גארד 1: השורדת היא עדיין מה שזיהינו -------------------------------
  select * into s from public.productions where id = v_survivor;
  if not found then raise exception 'ההפקה השורדת % לא נמצאה', v_survivor; end if;
  if s.merged_into  is not null then raise exception 'השורדת % כבר מוזגה למישהו אחר — עצור', v_survivor; end if;
  if s.cancelled_at is not null then raise exception 'השורדת % בוטלה בינתיים — עצור', v_survivor; end if;
  if s.calendar_uid is distinct from v_uid then
    raise exception 'לשורדת % אין את ה-UID שזוהה (% במקום %) — עצור', v_survivor, s.calendar_uid, v_uid;
  end if;
  if s.record_date is distinct from v_date then
    raise exception 'תאריך ההקלטה של השורדת השתנה (%) — עצור', s.record_date;
  end if;

  -- ---- גארד 2: הכפילות היא עדיין מה שזיהינו ------------------------------
  select * into d from public.productions where id = v_dup;
  if not found then raise exception 'ההפקה הכפולה % לא נמצאה', v_dup; end if;
  if d.merged_into  is not null then raise exception 'הכפילות % כבר מוזגה — כנראה הוחל קודם', v_dup; end if;
  if d.cancelled_at is not null then raise exception 'הכפילות % בוטלה בינתיים — החליטו מחדש', v_dup; end if;
  if d.calendar_uid is not null then
    raise exception 'לכפילות % יש כעת calendar_uid (%) — היא כבר לא הרישום הידני, עצור', v_dup, d.calendar_uid;
  end if;
  if d.record_date is distinct from v_date or d.show_id is distinct from s.show_id then
    raise exception 'הכפילות כבר אינה אותו יום/אותה תוכנית כמו השורדת — עצור';
  end if;

  -- ---- גארד 3: זו באמת קבוצה של שתיים, לא יותר ---------------------------
  select count(*) into v_guard
    from public.productions
   where show_id = s.show_id and record_date = v_date and merged_into is null;
  if v_guard <> 2 then
    raise exception 'צפויות 2 הפקות חיות לתוכנית ביום הזה, נמצאו % — עצור וברר', v_guard;
  end if;

  -- ---- גארד 4: שלב 1 בוצע — הזמנת העבודה הכפולה נדחתה --------------------
  select count(*) into v_guard
    from public.pending_documents
   where id = v_dup_wo and production_id = v_dup
     and status = 'rejected' and morning_doc_id is null;
  if v_guard <> 1 then
    raise exception 'הזמנת העבודה הכפולה % אינה rejected (או שהגיעה למורנינג) — בצע קודם את שלב 1 בממשק', v_dup_wo;
  end if;

  -- ---- גארד 5: הזמנת העבודה של השורדת עדיין חיה --------------------------
  -- אם בטעות נדחתה זו במקום זו, נעצור כאן ולא נמזג את הצד הלא נכון.
  select count(*) into v_guard
    from public.pending_documents
   where id = v_keep_wo and production_id = v_survivor
     and status not in ('rejected', 'failed', 'cancelled');
  if v_guard <> 1 then
    raise exception 'הזמנת העבודה של השורדת % כבר אינה חיה — ייתכן שנדחה הצד הלא נכון, עצור', v_keep_wo;
  end if;

  -- ---- גארד 6: ה-job של הכפילות לא רכש כסף בינתיים -----------------------
  -- הנוסח של 0064, מילה במילה. נדרש להסתרה ולא רק למחיקה: הסתרת job שרכש
  -- חשבונית או תשלום מסתירה כסף אמיתי.
  select count(*) into v_guard from public.jobs j
   where j.id = v_dup_job
     and j.dismissed = false
     and j.invoice_biz is null and j.invoice_tax is null and j.paid <> 'כן'
     and not exists (select 1 from public.documents         x where x.job_id = j.id)
     and not exists (select 1 from public.pending_documents x where x.job_id = j.id)
     and not exists (select 1 from public.documents         x where x.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.pending_documents x where x.bundle_job_ids @> array[j.id])
     and not exists (select 1 from public.contract_milestones x where x.job_id = j.id);
  if v_guard <> 1 then
    raise exception 'job % אינו עומד בתנאי ההסתרה (invoice/paid/מסמך מקושר) — מבטל', v_dup_job;
  end if;

  -- ---- גארד 7: ה-job הזה שייך לכפילות בלבד -------------------------------
  -- אם הוא קשור גם להפקה אחרת, הסתרתו תסתיר עבודה אמיתית.
  select count(*) into v_guard from public.job_productions where job_id = v_dup_job;
  if v_guard <> 1 then
    raise exception 'job % קשור ל-% הפקות ולא לאחת — עצור', v_dup_job, v_guard;
  end if;
  if not exists (select 1 from public.job_productions where job_id = v_dup_job and production_id = v_dup) then
    raise exception 'job % אינו קשור לכפילות % — עצור', v_dup_job, v_dup;
  end if;

  -- ---- גארד 8: ה-job של השורדת שלם ואינו מוסתר ---------------------------
  if not exists (select 1 from public.jobs where id = v_keep_job and dismissed = false) then
    raise exception 'job % של השורדת חסר או כבר מוסתר — עצור, זה ה-job האמיתי', v_keep_job;
  end if;

  -- ---- גארד 9: guest לא נדרס ---------------------------------------------
  if s.guest is not null and s.guest is distinct from v_guest then
    raise exception 'לשורדת כבר יש אורח אחר (%) — לא דורסים, החליטו ידנית', s.guest;
  end if;

  -- ═══ הפעולות ═══════════════════════════════════════════════════════════

  -- 1. המידע היחיד שרק לכפילות היה
  if s.guest is null then
    update public.productions set guest = v_guest where id = v_survivor;
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', v_survivor, 'entity_updated', null,
            jsonb_build_object('source', 'migration_0065',
                               -- null::text ולא null חשוף: jsonb_build_object
                               -- על NULL לא-מוקלד זורק "could not determine
                               -- polymorphic type"
                               'changes', jsonb_build_object('guest',
                                 jsonb_build_object('from', null::text, 'to', v_guest)),
                               'from_production', v_dup));
  end if;

  -- 2. המיזוג
  update public.productions set merged_into = v_survivor
   where id = v_dup and merged_into is null;

  -- 3. ה-job הכפול. dismissed_by נשאר null במכוון: מיגרציה עשתה זאת, לא
  --    אדם, והדבקת מזהה של מישהו תשים את שמו על החלטה שלא קיבל.
  update public.jobs
     set dismissed = true, dismiss_reason = v_reason, dismissed_at = now()
   where id = v_dup_job and dismissed = false;

  -- 4. שובל האודיט — אותם event_type של 0064
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', v_dup_job, 'job_dismissed', null,
          jsonb_build_object('reason', v_reason, 'via', 'migration_0065',
                             'amount', 600, 'production_id', v_dup,
                             'merged_into', v_survivor, 'kept_job_id', v_keep_job));

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', v_dup, 'production_merged_duplicate', null,
          jsonb_build_object('merged_into', v_survivor, 'dismissed_job_id', v_dup_job,
                             'rejected_work_order_id', v_dup_wo, 'reason', v_reason,
                             'created_by', 'production_created_manually',
                             'survivor_calendar_uid', v_uid));

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0065', now(), 'bnaya',
          'כפילות ליעד הרמן / אוכלי סרטים 28.8: הפקה 94d4a7ea מוזגה ל-6bd7289f דרך merged_into, וה-job שלה 8ce89e57 (600₪) סומן dismissed. לא כפילות יומן — סנכרון היומן רץ פעם אחת ב-03:01Z ויצר הפקה אחת (UID 4705C10E), ואילו 94d4a7ea נוצרה ידנית ב-14:20Z על ידי שחר (tech) בלי UID, שאז סימן את שתיהן כהוקלטו תוך 16 שניות ויצר שני jobs של 600₪ על פרק אחד. השורדת היא זו של היומן כי אירוע היומן מצביע עליה: הסתרתה הייתה מייצרת אירוע יתום שסנכרון עתידי עלול ליצור ממנו הפקה מחדש. merged_into ולא ביטול, מאותו נימוק של 0064 באולמדיה — ההקלטה קרתה ורק הרישום כפול, ו-בוטל היה טוען שלא. הכפתור בממשק לא יכול היה לעשות זאת: duplicate-group דורש calendar_uid על כל חברי הקבוצה ושני UID נבדלים, ולהפקה הידנית אין UID. guest=משה הועתק לשורדת לפני המיזוג (אישור הבעלים) כי זה המידע היחיד שרק לכפילות היה. record_time לא נגע: היומן אומר 15:00 ושחר הקליד 16:00, אין אילוץ טכני (מסלול ה-update של הסנכרון כותב calendar_synced_at בלבד), וההכרעה היא ש-15:00 הוא רישום בן-זמנו בעוד 16:00 הוקלד כחלק מאותה פעולה שגויה — שווה אימות מול שחר, לא משפיע על אף סכום. הזמנת העבודה הכפולה ee228d06 נדחתה קודם בממשק (rejected, מעולם לא הגיעה למורנינג) והמיגרציה מסרבת לרוץ בלי זה, כדי ששם של אדם יהיה על ההחלטה הכספית. dismissed_by נשאר null במכוון. אפס DELETE, אפס שינוי סכימה.');

  raise notice '0065 הוחלה. 94d4a7ea מוזגה ל-6bd7289f, job 8ce89e57 הוסתר, guest הועתק.';
end $mig$;
