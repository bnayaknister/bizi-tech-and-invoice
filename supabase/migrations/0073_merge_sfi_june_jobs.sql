-- 0073: שני ה-jobs של SFI מיוני — מיזוג לאחד, כדי שחשבון עסקה 40269 יוכל
--       להישויך ולהוליד חשבונית מס קבלה.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- ═══ מה קרה ═══
-- חשבון עסקה 40269 (קבוצת SFI, ₪2,360 ברוטו / ₪2,000 נטו, 22.6.26) נמשך
-- ממורנינג ויושב ב-documents עם job_id ריק. הוא מכסה שני פרקים — שורות
-- ההכנסה שלו הן 'פרק 1    8.6' ו-'פרק 2    16.6', ₪1,000 כל אחת.
-- הבעלים צריך להוציא ממנו חשבונית מס קבלה, וזה חסום.
--
-- הבדיקה בקוד מראה שהחסימה היא שורה אחת, documents/registry/page.tsx:158:
--     if (!c.job_id) { state: "blocked", reason: 'יש לשייך את המסמך לעבודה…' }
-- וכל שאר גייטים של mapPullDocToSource נבדקו מול הנתונים בפועל ועוברים:
-- source=pull · type=300 · לא מבוטל · לא מאורכב · morning_doc_id ומספר
-- קיימים · client_id משויך · raw.client.id קיים · vatType=0 · currency=ILS ·
-- status=0 ו-ref מכיל 305 · נטו 2,000 מתחת לתקרת PULL_NET_CEILING=10,000.
-- אין שום שורת תור שמצביעה על המסמך, ולכן גם גייט "כבר קיים מסמך מס" נקי.
-- job_id הוא החוסם היחיד.
--
-- ═══ למה מיזוג ולא job חדש ═══
-- שני ה-jobs כבר קיימים, ושניהם כבר נושאים invoice_biz='40269':
--   af4d5f30  8.6.26      'פרק 1'  ₪1,000  external_id C0123
--   cad52049  date null   'פרק 2'  ₪1,000  external_id C0132
-- שניהם legacy=true ונוצרו באותה שנייה ב-12.7 — ייבוא היסטורי מהגיליון,
-- לא מהאפליקציה. אין להם productions. יצירת job חדש היתה כפילות שלישית.
--
-- החסם שמחייב דווקא מיזוג, ולא שיוך לאחד מהשניים: documents.job_id הוא
-- עמודה יחידה. מסמך אחד, job אחד. taxFromParent.ts:463-465 אוסף למקור
-- מסוג pull את documents.job_id בלבד (הנפילה החלופית דרך job_productions
-- דורשת production_id, שכאן null), ומה שנאסף נכתב ל-bundle_job_ids של שורת
-- התור — וזה מה ש-issue.ts חותם עליו invoice_tax בהנפקה. כלומר בלי מיזוג,
-- חשבונית המס היתה חותמת job אחד, והשני היה נשאר נראה כלא-מחויב וצף
-- מחדש במסך הפערים.
--
-- ═══ מי השורדת ═══
-- af4d5f30. לא בגלל ותק — שתיהן נוצרו באותה שנייה — אלא כי היא נושאת
-- date='2026-06-08', רישום אמיתי של הפרק הראשון, ואילו ל-cad52049 אין
-- date כלל. תאריך הוא מה שמסכי הכספים והצבירה ממיינים לפיו.
--
-- ═══ dismissed ולא DELETE ═══
-- מוסכמת 0065/0066, מילה במילה: "אפס DELETE". גם /api/finance/dismiss
-- פותח ב-"Never deletes". שלוש סיבות שתקפות כאן במיוחד:
--   • אותה תוצאה מעשית — finance/jobs-search/route.ts:29 מסנן
--     .eq("dismissed", false), וזה המסלול היחיד שדרכו השיוך של 40269
--     יקרה בפועל (ההצעות האוטומטיות יוצאות ריקות, ראה הערה בסוף).
--     מסכי הכספים, /projects ו-mark-paid מסננים באותו predicate.
--   • הפיך.
--   • event b9d2e355 מ-31.7.26 (invoice_number_suffix_cleaned_manual_sql)
--     מצביע על cad52049 בשמו, בתוך מפה של 35 תיקוני '40269.0'→'40269'.
--     מחיקה היתה הופכת אותו למזהה יתום ברשומת אודיט.
--
-- dismissed_by נשאר null במכוון — הנוסח של 0065: מיגרציה עשתה זאת, לא
-- אדם, והדבקת מזהה של מישהו תשים את שמו על החלטה שלא קיבל.
--
-- ═══ למה amount=2000, אם זה לא משפיע על המסמך ═══
-- אינו משפיע: הבנאי יורש את שורות ההכנסה מ-raw של המסמך שנמשך, לא
-- מ-jobs.amount, ויוציא ₪2,360 ברוטו בכל מקרה. השינוי הוא תיקון ספרים —
-- החוב של SFI על יוני הוא ₪2,000, ואחרי המיזוג הוא צריך לשבת על שורה
-- אחת ולא על שתיים.
--
-- ═══ שורת invoices 42296025 — למה נוגעים בה ═══
-- השורה: doc_number='biz-40269.0', morning_doc_id='biz-40269.0',
-- job_id=null, ₪2,000, source=manual. זו רשומת הייבוא ההיסטורי של אותה
-- חשבונית עסקה.
--
-- reconcile.ts:432-436 בודק כפילות לפני שהוא כותב שורת invoices חדשה:
--     .eq("morning_doc_id", doc.morning_doc_id)
-- כלומר מול המזהה האמיתי ממורנינג, '23c2dabf-…'. 'biz-40269.0' לא יתאים,
-- הבדיקה תחטיא, וברגע שהבעלים ישייך את 40269 ל-job תיווצר שורה שנייה על
-- אותה חשבונית — ₪2,000 שנספרים פעמיים ברישום הכספי.
--
-- 🔶 זו איננה אנומליה נקודתית, וזה נאמר כאן במפורש כדי שלא ייקרא כך:
-- מפקד invoices ב-2026-09-06 — 186 שורות, מהן 155 עם סיומת '.0', 90 עם
-- קידומת 'biz-', ו-158 בלי job_id. זהו המצב הרגיל של כל הייבוא ההיסטורי.
-- המיגרציה מתקנת שורה אחת בלבד — זו שהפעולה שאנחנו עומדים לאפשר תיצור
-- עליה כפילות — ומשאירה את 154 האחיות שלה כמות שהן. הן פריט נפרד.
--
-- אחרי התיקון יש שתי הגנות ולא אחת: הבדיקה ב-reconcile.ts תפגע ותדלג על
-- ה-INSERT, ואם בכל זאת ינסה — invoices_morning_doc_id_key הוא UNIQUE
-- ויחסום ב-23505. אומת שהמזהה '23c2dabf-…' פנוי היום (0 שורות).
--
-- ═══ הטריגרים על jobs — למה הם עוברים ═══
-- שלושה טריגרים יושבים על הטבלה:
--   trg_guard_job_money      — יורה על שינוי amount, דורש can_edit_money()
--   trg_guard_job_dismissal  — יורה על שינוי dismissed
--   trg_compute_due_date     — BEFORE UPDATE OF date, client_id בלבד
-- ב-SQL Editor auth.uid() הוא NULL. can_edit_money() הוא
-- `select … from profiles where id = auth.uid()` → אפס שורות → הפונקציה
-- מחזירה NULL, ו-`not NULL` אינו TRUE, ולכן ה-raise לא מתרחש. אותה תבנית
-- שמתועדת ב-0019:41. guard_job_dismissal מגודר במפורש ב-
-- `auth.uid() is not null and …` ולכן עובר מאותה סיבה.
-- trg_compute_due_date כלל לא יורה — המיגרציה אינה נוגעת ב-date או
-- ב-client_id, וזה מכוון: נגיעה בהם היתה דורסת את due_date.
--
-- ═══ מה המיגרציה לא עושה ═══
-- • אפס DELETE, אפס שינוי סכימה.
-- • לא נוגעת ב-date, client_id, due_date, invoice_biz, paid, legacy,
--   external_id — לא בשורדת ולא בכפילות.
-- • לא נוגעת ב-documents: השיוך של 40269 ל-job נעשה בממשק, בכפתור
--   "שייך ל-job", בידיים של אדם. זו החלטה כספית ושמו צריך להיות עליה.
-- • לא נוגעת ב-event b9d2e355 — תיעוד של מה שהיה, לא הפניה חיה.
-- • לא מתקנת את 154 שורות ה-invoices האחרות.
--
-- ═══ אימות מצב לפני הכתיבה (2026-09-06) ═══
--   שני ה-jobs: ₪1,000 כל אחד, invoice_biz='40269', invoice_tax null,
--     paid='לא', dismissed=false, legacy=true, אותו client_id
--   אפס שורות מצביעות על cad52049 בתשע הבדיקות: invoices.job_id,
--     documents.job_id, documents.bundle_job_ids, pending_documents.job_id,
--     pending_documents.bundle_job_ids, job_productions.job_id,
--     contract_milestones.job_id, events.entity_id, v_prev_job
--   invoices 42296025: כמתואר, job_id null
--   '23c2dabf-…' פנוי ב-invoices.morning_doc_id (UNIQUE)
--   schema_ledger: אין שורת '0073'

do $mig$
declare
  v_keep     uuid := 'af4d5f30-a639-44bb-a4f6-81bb4d25bfad';  -- 8.6, נשארת
  v_dup      uuid := 'cad52049-b3de-4dc0-94d8-700b934d526e';  -- בלי תאריך, מוזגת
  v_client   uuid := '510d19f7-b2df-48d1-9e64-51a13375e56d';  -- SFI פודקאסט
  v_inv      uuid := '42296025-2bf3-463f-8b86-3456a3f5fc02';  -- שורת הייבוא
  v_morning  text := '23c2dabf-e632-48c5-908a-36450bc6922d';  -- מזהה 40269 במורנינג
  v_biz      text := '40269';
  v_campaign text := 'פרקים 8.6 + 16.6';
  v_amount   numeric := 2000;
  v_reason   text := 'מוזג ל-af4d5f30 — שני פרקי יוני (8.6 ו-16.6) יושבים על חשבון עסקה 40269, שהוא מסמך אחד ולכן יכול לשאת job אחד';
  k          record;
  d          record;
  i          record;
  v_guard    integer;
begin
  if exists (select 1 from schema_ledger where version = '0073') then
    raise exception '0073 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---- גארד 1: השורדת היא עדיין מה שזיהינו ------------------------------
  select * into k from public.jobs where id = v_keep;
  if not found then raise exception 'ה-job השורד % לא נמצא', v_keep; end if;
  if k.dismissed then
    raise exception 'השורד % כבר מוסתר — עצור, אין למזג לתוך job מוסתר', v_keep;
  end if;
  if k.amount is distinct from 1000 then
    raise exception 'סכום השורד % הוא % ולא 1000 — מישהו כבר נגע בו, עצור', v_keep, k.amount;
  end if;
  if k.campaign is distinct from 'פרק 1' then
    raise exception 'campaign של השורד % הוא "%" ולא "פרק 1" — עצור', v_keep, k.campaign;
  end if;
  if k.invoice_biz is distinct from v_biz then
    raise exception 'invoice_biz של השורד % הוא "%" ולא % — עצור', v_keep, k.invoice_biz, v_biz;
  end if;
  if k.invoice_tax is not null then
    raise exception 'השורד % כבר נושא חשבונית מס % — המיזוג מיותר או מסוכן, עצור', v_keep, k.invoice_tax;
  end if;
  if k.client_id is distinct from v_client then
    raise exception 'השורד % שייך ללקוח % ולא ל-SFI — עצור', v_keep, k.client_id;
  end if;

  -- ---- גארד 2: הכפילות היא עדיין מה שזיהינו -----------------------------
  select * into d from public.jobs where id = v_dup;
  if not found then raise exception 'ה-job הכפול % לא נמצא', v_dup; end if;
  if d.dismissed then
    raise exception 'הכפילות % כבר מוסתרת — כנראה הוחל קודם, עצור', v_dup;
  end if;
  if d.amount is distinct from 1000 then
    raise exception 'סכום הכפילות % הוא % ולא 1000 — מישהו כבר נגע בה, עצור', v_dup, d.amount;
  end if;
  if d.campaign is distinct from 'פרק 2' then
    raise exception 'campaign של הכפילות % הוא "%" ולא "פרק 2" — עצור', v_dup, d.campaign;
  end if;
  if d.invoice_biz is distinct from v_biz then
    raise exception 'invoice_biz של הכפילות % הוא "%" ולא % — עצור', v_dup, d.invoice_biz, v_biz;
  end if;
  if d.invoice_tax is not null then
    raise exception 'הכפילות % כבר נושאת חשבונית מס % — הסתרתה תסתיר כסף אמיתי, עצור', v_dup, d.invoice_tax;
  end if;
  if d.client_id is distinct from v_client then
    raise exception 'הכפילות % שייכת ללקוח % ולא ל-SFI — עצור', v_dup, d.client_id;
  end if;

  -- ---- גארד 3: אלה באמת שניים, לא יותר ----------------------------------
  -- ברוח גארד 3 של 0065. אם צץ job שלישי על אותה חשבונית עסקה, ההנחה
  -- שהמיזוג בנוי עליה — ששני פרקי יוני הם כל מה שיש — כבר לא נכונה.
  select count(*) into v_guard
    from public.jobs
   where client_id = v_client and invoice_biz = v_biz and dismissed = false;
  if v_guard <> 2 then
    raise exception 'צפויים 2 jobs חיים של SFI על חשבון עסקה %, נמצאו % — עצור וברר', v_biz, v_guard;
  end if;

  -- ---- גארד 4: שום שורה אינה מצביעה על הכפילות --------------------------
  -- הבדיקה המלאה. אם משהו רכש הפניה לכפילות מאז התחקיר, הסתרתה תסתיר
  -- קישור חי — והמיזוג הזה נשען על כך שאין מה להעביר.
  select count(*) into v_guard from public.invoices where job_id = v_dup;
  if v_guard <> 0 then raise exception 'invoices מצביעה על הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.documents where job_id = v_dup;
  if v_guard <> 0 then raise exception 'documents מצביעה על הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.documents where bundle_job_ids @> array[v_dup];
  if v_guard <> 0 then raise exception 'documents.bundle_job_ids מכילה את הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.pending_documents where job_id = v_dup;
  if v_guard <> 0 then raise exception 'pending_documents מצביעה על הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.pending_documents where bundle_job_ids @> array[v_dup];
  if v_guard <> 0 then raise exception 'pending_documents.bundle_job_ids מכילה את הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.job_productions where job_id = v_dup;
  if v_guard <> 0 then raise exception 'job_productions מצביעה על הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  select count(*) into v_guard from public.contract_milestones where job_id = v_dup;
  if v_guard <> 0 then raise exception 'contract_milestones מצביעה על הכפילות % ב-% שורות — עצור', v_dup, v_guard; end if;

  -- ---- גארד 5: שורת ה-invoices היא עדיין מה שזיהינו ---------------------
  select * into i from public.invoices where id = v_inv;
  if not found then raise exception 'שורת invoices % לא נמצאה', v_inv; end if;
  if i.morning_doc_id is distinct from 'biz-40269.0' then
    raise exception 'morning_doc_id של % הוא "%" ולא "biz-40269.0" — מישהו כבר תיקן, עצור', v_inv, i.morning_doc_id;
  end if;
  if i.job_id is not null then
    raise exception 'שורת invoices % כבר משויכת ל-job % — עצור', v_inv, i.job_id;
  end if;
  if i.client_id is distinct from v_client then
    raise exception 'שורת invoices % שייכת ללקוח % ולא ל-SFI — עצור', v_inv, i.client_id;
  end if;
  if i.amount is distinct from v_amount then
    raise exception 'סכום שורת invoices % הוא % ולא % — עצור', v_inv, i.amount, v_amount;
  end if;

  -- ---- גארד 6: המזהה האמיתי פנוי (invoices_morning_doc_id_key הוא UNIQUE)
  select count(*) into v_guard from public.invoices where morning_doc_id = v_morning;
  if v_guard <> 0 then
    raise exception 'כבר קיימת שורת invoices עם morning_doc_id % — הכפילות כנראה כבר נוצרה, עצור וברר', v_morning;
  end if;

  -- ═══ הפעולות ═════════════════════════════════════════════════════════════

  -- 1. השורדת סופגת את הפרק השני. amount ו-campaign בלבד.
  update public.jobs
     set amount = v_amount, campaign = v_campaign
   where id = v_keep;

  -- 2. הכפילות מוסתרת. dismissed_by נשאר null — ראה ההסבר בכותרת.
  update public.jobs
     set dismissed = true, dismiss_reason = v_reason, dismissed_at = now()
   where id = v_dup and dismissed = false;

  -- 3. שורת הייבוא מצביעה מעכשיו על המסמך האמיתי ועל ה-job השורד, כדי
  --    שבדיקת הכפילות ב-reconcile.ts תפגע כשהבעלים ישייך את 40269.
  update public.invoices
     set morning_doc_id = v_morning, doc_number = v_biz, job_id = v_keep
   where id = v_inv;

  -- ═══ שובל האודיט ════════════════════════════════════════════════════════

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', v_dup, 'job_dismissed', null,
          jsonb_build_object('reason', v_reason, 'via', 'migration_0073',
                             'amount', 1000, 'campaign', 'פרק 2',
                             'invoice_biz', v_biz,
                             -- null::text ולא null חשוף: jsonb_build_object
                             -- על NULL לא-מוקלד זורק "could not determine
                             -- polymorphic type" (הלקח של 0065)
                             'invoice_tax', null::text,
                             'merged_into', v_keep));

  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('job', v_keep, 'job_merged_duplicate', null,
          jsonb_build_object('via', 'migration_0073',
                             'absorbed_job_id', v_dup,
                             'reason', v_reason,
                             'changes', jsonb_build_object(
                               'amount',   jsonb_build_object('from', 1000, 'to', v_amount),
                               'campaign', jsonb_build_object('from', 'פרק 1', 'to', v_campaign)),
                             'invoices_row_repointed', jsonb_build_object(
                               'id', v_inv,
                               'morning_doc_id', jsonb_build_object('from', 'biz-40269.0', 'to', v_morning),
                               'doc_number',     jsonb_build_object('from', 'biz-40269.0', 'to', v_biz),
                               'job_id',         jsonb_build_object('from', null::text, 'to', v_keep)),
                             'untouched', jsonb_build_array('date', 'client_id', 'due_date',
                                                            'invoice_biz', 'paid', 'legacy',
                                                            'external_id')));

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0073', now(), 'bnaya',
          'מיזוג שני ה-jobs של SFI מיוני: cad52049 (פרק 2, ₪1,000) הוסתר ב-dismissed ומוזג ל-af4d5f30 (פרק 1, 8.6), שעודכן ל-₪2,000 ו-campaign "פרקים 8.6 + 16.6". הסיבה: חשבון עסקה 40269 (₪2,360 ברוטו / ₪2,000 נטו, 22.6) נמשך ממורנינג עם job_id ריק, ו-registry/page.tsx:158 חוסם עליו את "צור חשבונית מס" בדיוק בגלל זה — כל שאר גייטים של mapPullDocToSource נבדקו מול הנתונים ועוברים. שיוך לאחד מהשניים לא היה מספיק כי documents.job_id הוא עמודה יחידה ו-taxFromParent.ts:463-465 אוסף למקור pull את documents.job_id בלבד, כך שחשבונית המס היתה חותמת invoice_tax על job אחד והשני היה נשאר נראה כלא-מחויב. השורדת היא af4d5f30 כי היא נושאת date=2026-06-08 ואילו לכפילות אין date כלל. dismissed ולא DELETE, כמוסכמת 0065/0066 ("אפס DELETE") ו-/api/finance/dismiss: jobs-search מסנן dismissed=false ולכן ההסתרה מספיקה מעשית, היא הפיכה, ו-event b9d2e355 מ-31.7 מצביע על cad52049 בשמו במפת תיקוני הסיומת .0 — מחיקה היתה מייתמת אותו. dismissed_by נשאר null במכוון. בנוסף תוקנה שורת invoices 42296025 (רשומת הייבוא ההיסטורי של אותה חשבונית): morning_doc_id ו-doc_number עברו מ-biz-40269.0 למזהה ולמספר האמיתיים, ו-job_id הוצמד לשורדת — אחרת reconcile.ts:432-436, שבודק כפילות לפי morning_doc_id, היה מחטיא וכותב שורת invoices שנייה על אותה חשבונית ברגע שהבעלים משייך את 40269, כלומר ₪2,000 נספרים פעמיים. זו שורה אחת מתוך תופעה רחבה ומודעת — מפקד 6.9: 186 שורות invoices, 155 עם סיומת .0, 90 עם קידומת biz-, 158 בלי job_id — והמיגרציה נוגעת רק בשורה שהפעולה שהיא מאפשרת היתה יוצרת עליה כפילות. amount=2000 אינו משפיע על תוכן חשבונית המס (הבנאי יורש את שורות ההכנסה מ-raw ולא מ-jobs.amount) והוא תיקון ספרים בלבד. date/client_id לא נגעו כדי ש-trg_compute_due_date לא יירה וידרוס את due_date. הטריגרים הכספיים עוברים כי auth.uid() ריק ב-SQL Editor ו-can_edit_money() מחזירה NULL, כתבנית 0019:41. אפס DELETE, אפס שינוי סכימה.');

  raise notice '0073 הוחלה. af4d5f30: ₪1,000→₪2,000, campaign "פרק 1"→"פרקים 8.6 + 16.6". cad52049 הוסתר (dismissed). שורת invoices 42296025 הופנתה ל-% ולמספר %, ושויכה ל-af4d5f30. השלב הבא ידני: "שייך ל-job" על 40269 ברישום, ואז "צור חשבונית מס".', v_morning, v_biz;
end $mig$;

-- ═══ מה קורה אחרי, ומה לצפות לו במסך ═══
-- 1. ברישום, בשורה של 40269, הכפתור "שייך ל-job" (RegistryClient.tsx:514).
--    ⚠️ ההצעות האוטומטיות בראש המודל ייצאו ריקות, ואין בכך תקלה: לסוג 300
--    reconcile.ts:173 דורש שה-job יהיה במצב 'purple', והשורדת היא 'blue'
--    (יש לה invoice_biz, טרם שולמה). לכן יש להשתמש בחיפוש החופשי בתחתית
--    המודל — "SFI" ימצא אותה. תופיע גם אזהרת אי-התאמת סכום (המסמך ₪2,360
--    ברוטו מול job של ₪2,000 נטו) — אזהרה בלבד, לא חסימה.
-- 2. אחרי השיוך הכפתור "צור חשבונית מס" בשורה אמור להידלק.
-- 3. השיוך עצמו לא ישנה את jobs: reconcile.ts:424 כותב invoice_biz רק אם
--    הוא ריק, והשורדת כבר נושאת 40269. הוא גם לא יכתוב שורת invoices
--    חדשה — בזכות תיקון 42296025 כאן.
