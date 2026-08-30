-- 0066: כפילות ההקלטה של חתונמיות ב-13.8 — מיזוג, הסתרת ה-job, וביטול
--       הזמנת העבודה הצבורה.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- ═══ מה קרה ═══
-- אותו כשל של 0065, בפעם השנייה ובלקוח אחר:
--   13.8 03:01:32  סנכרון היומן  → 5a95ffb6, uid AA9C9845-…, 18:00
--   16.8 06:13:22  יצירה ידנית   → 3d0e3fad, בלי uid,        18:00
-- אותה תוכנית, אותו יום, אותה שעה, ותיאור הזמנת העבודה זהה בית-בבית:
-- 'הזמנת עבודה — חתונמיות 2026-08-13'. שני ה-jobs נוצרו יחד במילוי-אחורה
-- של 24.8 (accrued_prep_2026_09) ושניהם ברשימת 18 המזהים של 0064.
--
-- ═══ למה זה דחוף יותר מ-0065 ═══
-- הלקוח הוא billing_cadence='every_n' עם every_n=6, ושתי הזמנות העבודה
-- במצב accrued. redeem/route.ts:39 מקפל `.eq("status","accrued")`, כלומר
-- הפדיון המרוכז הבא היה מחייב את 13.8 פעמיים. ב-0065 שום דבר לא היה
-- בדרך למורנינג; כאן הכפילות ממתינה בתור הפדיון.
--
-- ═══ ספירת הפרקים — אימות עצמאי ═══
-- לחתונמיות 12 פרקים. 1-8 שולמו: 100 no.10284 (1.7) → 300 no.40284 (12.7)
-- → 320 no.60171 (13.7), ₪4,956 = פרק 1 ב-0 (ללא חיוב) + 7×600 + מע״מ.
-- שורות המסמך נוקבות בתאריכי הפרקים אחד לאחד, וכל שמונת הפרקים יושבים על
-- שורות legacy עם episode_no 1-8, בלי jobs ובלי מסמכים משלהם — אף אחד מהם
-- אינו בצבירה. נשארו 9-12: 22.7, 30.7, 13.8, 24.8.
-- הצבירה מציגה 5 שורות ו-3,000₪; אחרי המיזוג 4 ו-2,400₪, בדיוק כמספר
-- הפרקים שנותרו. הפער הוא הכפילות ולא דבר אחר.
--
-- ═══ 🔶 סטייה מ-0065, במכוון ומוצהרת ═══
-- ב-0065 שלב 1 היה דחיית הזמנת העבודה הכפולה בממשק, והמיגרציה סירבה לרוץ
-- לפניו — כדי ששם של אדם יהיה על ההחלטה הכספית. כאן זה בלתי אפשרי:
--   review/route.ts:87  ACTIONABLE_STATUSES = ["pending","failed"]
-- שורת accrued אינה ניתנת לדחייה במסך האישורים (409), ואין שום מסלול UI
-- אחר שמוציא שורה צבורה מהתור בלי לבטל את ההפקה כולה — וביטול הוא בדיוק
-- מה שאסור כאן (ההקלטה קרתה; רק הרישום כפול).
-- לכן המיגרציה מבטלת אותה בעצמה, בסטטוס 'cancelled' ולא 'rejected':
--   • 'cancelled' הוא מה ש-cancel/route.ts:110 כותב לשורת accrued שאסור לה
--     להיפדות, עם נימוק זהה — "שורה חיה שמעולם לא עזבה את הבניין".
--   • 'rejected' נושא approved_by, כלומר אדם שסקר ודחה. איש לא סקר, והמסלול
--     עצמו אוסר. לכתוב אותו יהיה להמציא ביקורת שלא היתה.
--   • תקדים באותו לקוח: הכפילות של 22.7 (2b7289bb) — הזמנת העבודה שלה
--     נושאת 'cancelled', שנכתב על ידי מסלול ביטול ההפקה.
-- גארד 5 מוודא שהשורה באמת מעולם לא הגיעה למורנינג לפני שהיא נסגרת.
--
-- ═══ מה אין כאן, בשונה מ-0065 ═══
-- • guest: שתי השורות ריקות — אין מה להעתיק.
-- • record_time: שתיהן 18:00 — אין מה להכריע.
--
-- ═══ אימות מצב לפני הכתיבה (2026-08-30) ═══
--   שתי ההפקות: merged_into null, cancelled_at null
--   שתי הזמנות העבודה: accrued, morning_doc_id null, morning_doc_number null
--   שני ה-jobs: 600₪, invoice_biz/invoice_tax null, paid 'לא ידוע', לא מודחים
--   job 608dac49 אינו מוזכר ב-documents / pending_documents / invoices /
--     contract_milestones — לא ב-job_id ולא ב-bundle_job_ids
--   הצבירה של הלקוח: 5 שורות, 3,000₪

do $mig$
declare
  v_survivor uuid := '5a95ffb6-3173-4158-bc7b-83802c0715ec';  -- של היומן, נשארת
  v_dup      uuid := '3d0e3fad-d25d-4ca4-be65-b717ce4ac874';  -- הידנית, מוזגת
  v_keep_job uuid := '06d03050-7256-4a2c-8a35-680a6e504b12';  -- לא נוגעים
  v_dup_job  uuid := '608dac49-c914-45ae-890f-6d2d8e46aa0e';  -- מוסתר
  v_keep_wo  uuid := '6e133b76-40d6-4c29-a177-694f84703dc6';  -- נשאר accrued
  v_dup_wo   uuid := 'f1cc3207-7016-4538-a5ff-49e6f17759f8';  -- מבוטל כאן
  v_show     uuid := '6bbe699c-08f2-483a-b45a-21c2d4c97465';
  v_client   uuid := '7bb6319a-eff4-43bf-8570-5f2eadcdefcd';
  v_uid      text := 'AA9C9845-6A17-4D42-AE66-C1DEEB7344F1';
  v_date     date := '2026-08-13';
  v_reason   text := 'כפילות רישום של הקלטה אחת ב-13.8; ההפקה האמיתית היא 5a95ffb6 (זו של היומן) ו-job 06d03050 הוא החיוב שלה';
  s          record;
  d          record;
  v_guard    integer;
  v_total    numeric;
begin
  if exists (select 1 from schema_ledger where version = '0066') then
    raise exception '0066 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---- גארד 1: השורדת היא עדיין מה שזיהינו -------------------------------
  select * into s from public.productions where id = v_survivor;
  if not found then raise exception 'ההפקה השורדת % לא נמצאה', v_survivor; end if;
  if s.merged_into  is not null then raise exception 'השורדת % כבר מוזגה — עצור', v_survivor; end if;
  if s.cancelled_at is not null then raise exception 'השורדת % בוטלה בינתיים — עצור', v_survivor; end if;
  if s.calendar_uid is distinct from v_uid then
    raise exception 'לשורדת % אין את ה-UID שזוהה (%) — עצור', v_survivor, s.calendar_uid;
  end if;
  if s.record_date is distinct from v_date or s.show_id is distinct from v_show then
    raise exception 'השורדת כבר אינה אותה תוכנית/יום — עצור';
  end if;

  -- ---- גארד 2: הכפילות היא עדיין מה שזיהינו ------------------------------
  select * into d from public.productions where id = v_dup;
  if not found then raise exception 'ההפקה הכפולה % לא נמצאה', v_dup; end if;
  if d.merged_into  is not null then raise exception 'הכפילות % כבר מוזגה — כנראה הוחל קודם', v_dup; end if;
  if d.cancelled_at is not null then raise exception 'הכפילות % בוטלה בינתיים — החליטו מחדש', v_dup; end if;
  if d.calendar_uid is not null then
    raise exception 'לכפילות % יש כעת calendar_uid (%) — היא כבר לא הרישום הידני, עצור', v_dup, d.calendar_uid;
  end if;
  if d.record_date is distinct from v_date or d.show_id is distinct from v_show then
    raise exception 'הכפילות כבר אינה אותה תוכנית/יום — עצור';
  end if;

  -- ---- גארד 3: בדיוק שתי הפקות חיות לתוכנית ביום הזה ---------------------
  select count(*) into v_guard
    from public.productions
   where show_id = v_show and record_date = v_date and merged_into is null;
  if v_guard <> 2 then
    raise exception 'צפויות 2 הפקות חיות ל-13.8, נמצאו % — עצור וברר', v_guard;
  end if;

  -- ---- גארד 4: הצבירה של הלקוח היא בדיוק מה שנספר ------------------------
  -- שער עסקי ולא טכני: אם הצבירה כבר לא 5 שורות ו-3,000₪, משהו זז מאז
  -- הספירה ואסור להסיר שורה על סמך תמונה ישנה.
  select count(*), coalesce(sum(amount), 0) into v_guard, v_total
    from public.pending_documents
   where client_id = v_client and doc_type = 'work_order' and status = 'accrued';
  if v_guard <> 5 or v_total <> 3000 then
    raise exception 'הצבירה של חתונמיות אינה 5 שורות/3000₪ אלא %/% — עצור וברר', v_guard, v_total;
  end if;

  -- ---- גארד 5: הזמנת העבודה הכפולה צבורה ומעולם לא הגיעה למורנינג --------
  -- זה מה שמתיר למיגרציה לסגור אותה בעצמה. אילו היה לה morning_doc_id, סגירה
  -- מקומית הייתה קוברת מסמך אמיתי מאחורי סטטוס — בדיוק מה ש-ACTIONABLE_STATUSES
  -- נועד למנוע.
  select count(*) into v_guard
    from public.pending_documents
   where id = v_dup_wo and production_id = v_dup and doc_type = 'work_order'
     and status = 'accrued'
     and morning_doc_id is null and morning_doc_number is null;
  if v_guard <> 1 then
    raise exception 'הזמנת העבודה הכפולה % אינה accrued-ונקייה — עצור ובדוק במורנינג', v_dup_wo;
  end if;

  -- ---- גארד 6: הזמנת העבודה של השורדת עדיין צבורה ------------------------
  -- אם נסגר בטעות הצד הלא נכון, נעצור לפני שנמזג הפוך.
  select count(*) into v_guard
    from public.pending_documents
   where id = v_keep_wo and production_id = v_survivor and status = 'accrued';
  if v_guard <> 1 then
    raise exception 'הזמנת העבודה של השורדת % אינה accrued — ייתכן שנסגר הצד הלא נכון, עצור', v_keep_wo;
  end if;

  -- ---- גארד 7: ה-job של הכפילות לא רכש כסף בינתיים -----------------------
  -- הנוסח של 0064/0065, מילה במילה.
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

  -- ---- גארד 8: ה-job הזה שייך לכפילות בלבד -------------------------------
  select count(*) into v_guard from public.job_productions where job_id = v_dup_job;
  if v_guard <> 1 then
    raise exception 'job % קשור ל-% הפקות ולא לאחת — עצור', v_dup_job, v_guard;
  end if;
  if not exists (select 1 from public.job_productions where job_id = v_dup_job and production_id = v_dup) then
    raise exception 'job % אינו קשור לכפילות % — עצור', v_dup_job, v_dup;
  end if;

  -- ---- גארד 9: ה-job של השורדת שלם ואינו מוסתר ---------------------------
  if not exists (select 1 from public.jobs where id = v_keep_job and dismissed = false) then
    raise exception 'job % של השורדת חסר או כבר מוסתר — עצור, זה ה-job האמיתי', v_keep_job;
  end if;

  -- ═══ הפעולות ═══════════════════════════════════════════════════════════

  -- 1. הזמנת העבודה הכפולה יוצאת מתור הפדיון. previous_status נשמר באירוע
  --    באותה מוסכמה של cancel/route.ts, כדי שניתן יהיה לדעת ברמת השורה שזו
  --    היתה שורה צבורה ולא שורה ממתינה.
  update public.pending_documents set status = 'cancelled' where id = v_dup_wo;
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('pending_document', v_dup_wo, 'document_cancelled_on_production_merge', null,
          jsonb_build_object('previous_status', 'accrued', 'via', 'migration_0066',
                             'production_id', v_dup, 'merged_into', v_survivor,
                             'amount', 600, 'reason', v_reason));

  -- 2. המיזוג
  update public.productions set merged_into = v_survivor
   where id = v_dup and merged_into is null;

  -- 3. ה-job הכפול. dismissed_by נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
  update public.jobs
     set dismissed = true, dismiss_reason = v_reason, dismissed_at = now()
   where id = v_dup_job and dismissed = false;

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', v_dup_job, 'job_dismissed', null,
          jsonb_build_object('reason', v_reason, 'via', 'migration_0066',
                             'amount', 600, 'production_id', v_dup,
                             'merged_into', v_survivor, 'kept_job_id', v_keep_job));

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', v_dup, 'production_merged_duplicate', null,
          jsonb_build_object('merged_into', v_survivor, 'dismissed_job_id', v_dup_job,
                             'cancelled_work_order_id', v_dup_wo, 'reason', v_reason,
                             'created_by', 'production_created_manually',
                             'survivor_calendar_uid', v_uid));

  -- ---- בדיקה שלאחר מעשה: הצבירה ירדה בדיוק שורה אחת ו-600₪ --------------
  select count(*), coalesce(sum(amount), 0) into v_guard, v_total
    from public.pending_documents
   where client_id = v_client and doc_type = 'work_order' and status = 'accrued';
  if v_guard <> 4 or v_total <> 2400 then
    raise exception 'אחרי התיקון הצבירה אמורה להיות 4 שורות/2400₪ ויצאה %/% — מבטל', v_guard, v_total;
  end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0066', now(), 'bnaya',
          'כפילות חתונמיות 13.8, אותו כשל של 0065 בפעם השנייה: הפקה 3d0e3fad נוצרה ידנית ב-16.8 לפרק שסנכרון היומן כבר יצר ב-13.8 (5a95ffb6, uid AA9C9845), אותה שעה 18:00 ותיאור הזמנת עבודה זהה בית-בבית. 3d0e3fad מוזגה ל-5a95ffb6 דרך merged_into, job 608dac49 (600₪) סומן dismissed, והזמנת העבודה הצבורה f1cc3207 סומנה cancelled. דחוף יותר מ-0065 כי הלקוח הוא every_n=6 ושתי ההזמנות היו accrued: redeem מקפל status=accrued, ולכן הפדיון המרוכז הבא היה מחייב את 13.8 פעמיים. אומת מול ספירת הבעלים: 12 פרקים, 1-8 שולמו ב-320 no.60171 (₪4,956 = פרק 1 ללא חיוב + 7×600 + מע״מ, שורות המסמך נוקבות בתאריכים אחד לאחד ושמונת הפרקים יושבים על שורות legacy בלי jobs ובלי מסמכים), נשארו 9-12 = 22.7/30.7/13.8/24.8. הצבירה הראתה 5 שורות ו-3,000₪ ואחרי התיקון 4 ו-2,400₪ — הפער היה הכפילות בדיוק, ובדיקה שלאחר מעשה בתוך אותו בלוק מאמתת זאת ומגלגלת אחורה אם לא. סטייה מוצהרת מ-0065: שם שלב 1 היה דחיית המסמך בממשק והמיגרציה סירבה לרוץ לפניו, אך שורת accrued אינה ניתנת לדחייה (ACTIONABLE_STATUSES = pending/failed) ואין מסלול UI שמוציא שורה צבורה בלי לבטל את ההפקה כולה — וביטול היה טוען שההקלטה לא קרתה. לכן המיגרציה סוגרת אותה בעצמה בסטטוס cancelled, מה ש-cancel/route.ts כותב לשורת accrued שאסור לה להיפדות, אחרי גארד שמוודא morning_doc_id ו-morning_doc_number ריקים. guest ו-record_time לא נגעו — שתי השורות זהות בשניהם. dismissed_by נשאר null. אפס DELETE, אפס שינוי סכימה.');

  raise notice '0066 הוחלה. 3d0e3fad מוזגה ל-5a95ffb6, job 608dac49 הוסתר, הזמנת עבודה f1cc3207 בוטלה. הצבירה: 4 שורות, 2,400₪.';
end $mig$;
