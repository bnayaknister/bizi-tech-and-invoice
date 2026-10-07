-- ============================================================================
-- 0100 — ניקוי אבן דרך יתומה אחת: EY "חבילה 6 פרקים" ₪9,600
--
-- מה זה עושה: שורה אחת ב-jobs מסומנת dismissed, ושורה אחת ב-contract_milestones
-- נמחקת. אפס שינוי סכימה, אפס טבלה חדשה, אפס policy, אפס פונקציה.
--
-- ═══ 🔴 בלתי הפיך, ובאופן חמור יותר מ-0095 ═══
-- אין `archive.contract_milestones`. סכימת הארכיון מחזיקה שלוש טבלאות בלבד —
-- `archive.jobs`, `archive.productions`, `archive.job_productions` (0002:313-314,
-- 0009:42) — ואבן דרך אינה אחת מהן. כלומר **אין מאיפה לשחזר את השורה הנמחקת**.
-- לכן הקובץ שומר תצלום jsonb מלא של השורה בתוך שורת ה-`events` לפני המחיקה,
-- והתצלום הזה הוא העתק היחיד שישרוד. `git revert` אינו מחזיר נתונים.
--
-- ═══ הרקע, בשורה אחת ═══
-- אבן הדרך 1b55f005 הונפקה, מסמכיה בוטלו בעקבות שינוי ח.פ של הלקוח, והמסמכים
-- הונפקו מחדש על אבן דרך אחרת באותו חוזה (1b5e4654). הישנה נשארה עומדת עם
-- job נקי, ולכן היא מצטיירת ב-/projects כעבודה שלא חויבה — ראה "למה היא בכלל
-- מופיעה" למטה.
--
-- ═══ 🔒 הכרעות הבעלים (7.10), ומה שהן *לא* כוללות ═══
--   · לנקות את הרשומה הבודדת הזו. ✅ זה הקובץ.
--   · **את הדפוס לא מתקנים עכשיו.** אין כאן שינוי קוד, אין סינון חדש
--     ב-unified.ts, ואין עמודת מחיקה על contract_milestones. הדפוס נרשם
--     כ-**T29** ב-docs/TICKETS.md ולא נסגר כאן.
--   · **לא סוגרים את החוזה.** ההנפקה מחדש נעשתה על אותו חוזה, שהוא active
--     ונושא אבן דרך חיה — סגירתו הייתה משתיקה גם אותה. (הצעה 1 מהתחקיר,
--     "סינון חוזה סגור", אינה רלוונטית למקרה הזה ולכן לא מיושמת.)
--
-- ═══ למה היא בכלל מופיעה — המסלול, לקורא הבא ═══
-- `projects/page.tsx:618` מפיל מסמך מבוטל מהליכת המסמכים של אבן הדרך
-- (`if (!d.cancelled_at && !d.archived_at)`). בלי מסמך חי אין עוגן, ולכן הענף
-- המעוגן (page.tsx:974) מדלג — והענף הלא-מעוגן (page.tsx:1170-1206) קולט אותה,
-- כי הוא דורש job + תאריך ו**אינו בודק את ה-state כלל**. התוצאה היא שורה עם
-- תאי מסמכים ריקים, "עבר המועד ואין חשבונית" (`overdue`, milestone.ts:62) ו-
-- "לא חויב" (`purple`, state.ts:25) — שני התגים מסכימים על אותה עובדה: ה-job
-- קיים ונקי. `cancelLocal.ts:79-93` הוא שניקה אותו, והוא **אינו נוגע**
-- ב-contract_milestones — לא ב-status ולא ב-job_id.
--
-- ═══ ביקורת ההפניות — מה מצביע על אבן דרך, ומה קורה למחיקה ═══
-- **מפתח זר קשיח: אין אחד.** נסרקו 100 קבצי מיגרציה — אפס
-- `references public.contract_milestones`, ואפס עמודה בשם `milestone_id` בכל
-- הסכימה. ההפניות של הטבלה הן יוצאות בלבד (contract_id → contracts,
-- job_id → jobs). הקובץ בכל זאת **מודד את זה מול pg_constraint בזמן ריצה**
-- ועוצר אם נמצא מפתח זר, כהכרעת הבעלים: אם יש הפניה קשיחה — לא מוחקים.
-- **הפניה רכה: `events.payload->>'milestone_id'`.** שבעה ראוטים כותבים אותה
-- (contracts/[id]/milestones:45 · milestones/[mid]:93 · enqueue:221 · issue:115 ·
-- record-billed:349 · tax:124 · deal-invoice:111). זה jsonb בלי אילוץ, ולכן
-- המחיקה אינה נחסמת ואינה שוברת דבר. **שורות ה-events לא נמחקות, במכוון:**
-- events הוא יומן ביקורת, ומחיקת היומן של דבר היא ההפך ממה שיומן קיים בשבילו.
-- מספרן נרשם בשורת הפנקס כדי שהקורא הבא יֵדע שהן יתומות ולמה.
--
-- ═══ הטריגרים — ארבעה נבדקו, אף אחד אינו חוסם ═══
--   · `trg_guard_milestone_money` (0010:90-93) — **before UPDATE בלבד.** אינו
--     נדלק על DELETE. אין שום טריגר DELETE על contract_milestones (רק policy
--     `milestones_delete`, ש-postgres עוקף כמו כל מיגרציה).
--   · `trg_guard_job_dismissal` (0041:45-48) — נדלק על dismissed/dismiss_reason,
--     ותנאו `auth.uid() is not null and not can_manage_users()`. ב-SQL Editor
--     auth.uid() הוא null, ולכן עובר. זו המוסכמה המתועדת ב-0041:30-32.
--   · `trg_guard_job_money` (0010:34-37) — נדלק רק על amount/paid/invoice_biz/
--     invoice_tax/client_id/contract_id/manual_only. הקובץ אינו נוגע באף אחת
--     מהן, ולכן גוף הטריגר יוצא מיד ו-`can_edit_money()` אפילו לא נקרא.
--   · `trg_compute_due_date` (0002:278-280) — `of date, client_id` בלבד. לא נגע.
--
-- ═══ dismissed_by נשאר null, במכוון ═══
-- העמודה היא `uuid references public.profiles(id)` (0041:17) ואין לה ערך אמיתי
-- כאן: מיגרציה עשתה זאת, לא אדם. אותה מוסכמה שבה `events.actor_id` נשאר null
-- (0095) ו-`invoices.issued_by` נשאר ריק (0083).
--
-- ═══ כלל 49 — השפעת ACL, מוצהרת ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. אין GRANT ואין REVOKE
-- ואין דבר שהרשאותיו יכולות להיוולד שגויות. `jobs` ו-`contract_milestones`
-- מוגנות ב-RLS מ-0002 ולא נגעו. הקובץ רץ כ-postgres ועוקף RLS כמו כל מיגרציה —
-- מצב קיים, לא דבר שהוא יוצר.
--
-- ═══ 🐛 תוקן 8.10, והתיקון נמדד בהרצה מדומה שנכשלה ═══
-- ההרצה המדומה הראשונה (7.10) נכשלה ב-`מספר אבני הדרך ירד ב-0 ולא ב-1`,
-- והכשל היה **בקובץ ולא בנתונים**. הקובץ הזה נשא את אותו קוד והיה נכשל באותה
-- בדיקה — אחרי שביצע את שתי הכתיבות, ואז מגלגל אותן. אפס נזק, אפס התקדמות.
--
-- 🔴 **השורש: מדידה אחת שימשה שתי שאלות הופכיות.** הספירה והטביעה חלקו
-- `select` יחיד עם `where id <> c_dead`, ולכן:
--   · הטביעה קיבלה את מה שהיא צריכה — "כל השאר זהה" מחייב להחריג את המשתנה;
--   · הספירה קיבלה את ההפך ממה שהיא צריכה — "נעלמה בדיוק שורה אחת" מחייב
--     **לכלול** אותה, ובלעדיה ההפרש הוא 0 לנצח.
-- `before - 1 <> after` נכשל אפוא תמיד, בכל מסד, בלי תלות בנתונים.
--
-- התיקון: שני `select` נפרדים לכל טבלה — ספירה על הטבלה כולה, טביעה על כל
-- השאר. `0100_verify.sql` אינו נגוע: אין בו זוג לפני/אחרי כלל.
--
-- ⚠️ זו הפעם השנייה שאותה צורה נתפסה בקובץ הזה — קודם בטביעת ה-jobs, שהחריגה
--    את מזהה אבן הדרך במקום את מזהה ה-job. **הצורה: בדיקת "אחרי" שמודדת
--    אוכלוסייה שאינה מכילה את מה שהשתנה.** היא עוברת בשתיקה או נכשלת תמיד,
--    ובשני המקרים אינה בודקת את מה שנכתבה לבדוק.
--
-- ═══ הרצה חוזרת ═══
-- הקובץ **יסרב** בהרצה שנייה: גארד הפנקס עוצר ראשון, ואחריו הפרדיקט (אבן הדרך
-- לא תימצא). `DO` + exception מגלגל הכול, כך שסירוב אינו משאיר חצי שינוי.
--
-- ההרצה המדומה: supabase/verify/0100_dryrun.sql — **להריץ לפני.**
-- האימות שאחרי:   supabase/verify/0100_verify.sql — שלוש עשרה עמודות, כולן true.
-- ============================================================================

do $mig$
declare
  -- המזהים, מילה במילה מהמדידה של הבעלים ב-Supabase (7.10). מוצהרים כקבועים
  -- ולא מודבקים בתוך השאילתות, כדי שהפרדיקט, הפעולה ושורת הפנקס יקראו בדיוק
  -- את אותה מחרוזת.
  --
  -- ⚠️ זיהוי לפי uuid ולעולם לא לפי שם החוזה. השם מופיע בשני איותים בתיעוד
  -- עצמו — "ey 2026 -2027 חצי ראשון 041026" בשורת הפנקס של 0098 מול
  -- "ey 2026-2027 חצי ראשון 041026" בדיווח המסך — והשוואת מחרוזת הייתה נכשלת
  -- על הרווח, או גרוע מכך תופסת את החוזה הלא נכון.
  c_dead constant uuid := '1b55f005-12f8-4280-a49e-9cd4d33e0b79';
  c_live constant uuid := '1b5e4654-b2e2-4f59-8ed3-317ef336df07';

  -- הערכים שנמדדו. הפרדיקט מחמיר עליהם ולא רק על הקיום: שורה שסכומה או
  -- תאריכה זזו מאז המדידה אינה השורה שהבעלים הכריע עליה.
  c_amount   constant numeric := 9600;
  c_expected constant date    := '2026-10-04';

  v_contract   uuid;
  v_dead_job   uuid;
  v_live_job   uuid;
  v_status     text;
  v_amount     numeric;
  v_expected   date;
  v_name       text;
  v_paid       text;
  v_biz        text;
  v_tax        text;
  v_dismissed  boolean;

  v_live_docs      int;
  v_cancelled_docs int;
  v_live_ms_docs   int;
  v_hard_fks       int;
  v_event_refs     int;

  v_snapshot   jsonb;
  v_job_snap   jsonb;
  v_n          int;
  c_reason     text;

  -- "מה שלא אמור לזוז" — שתי מדידות נפרדות, ולא אחת. ראה שלב 6ב ושלב 7ב.
  --   ספירות: על הטבלה **כולה** — "האם נעלמה בדיוק שורה אחת".
  v_jobs_n_before int;
  v_jobs_n_after  int;
  v_ms_n_before   int;
  v_ms_n_after    int;
  --   טביעות: על כל השורות **מלבד** המשתנה — "האם כל השאר זהה תו-בתו".
  v_jobs_before   text;
  v_jobs_after    text;
  v_ms_before     text;
  v_ms_after      text;
begin
  -- ── 0. גארדי הפנקס ─────────────────────────────────────────────────────────
  -- גארד הרצה חוזרת. רועש, לעולם לא אידמפוטנטי-בשתיקה (הדפוס של 0074:127).
  if exists (select 1 from public.schema_ledger where version = '0100') then
    raise exception '0100 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד סדר. הפנקס הוא הרצף, לא שמות הקבצים (הדפוס של 0077): אם 0099 חסרה,
  -- המספור נגזר מפנקס אחר וכל המדידות כאן נמדדו מול מסד אחר.
  if not exists (select 1 from public.schema_ledger where version = '0099') then
    raise exception '0100: 0099 אינה בפנקס. הפנקס הוא הרצף — אם המיגרציה הקודמת חסרה, המספור והמדידות כאן נגזרו ממסד אחר. הרץ אותה קודם';
  end if;

  -- ── 1. אבן הדרך המתה: קיימת, pending, ובמצב שנמדד ───────────────────────────
  select m.contract_id, m.job_id, m.status, m.amount, m.expected_date, m.name
    into v_contract, v_dead_job, v_status, v_amount, v_expected, v_name
  from public.contract_milestones m
  where m.id = c_dead;

  if v_contract is null then
    raise exception '0100: אבן הדרך % לא נמצאה. אם היא נמחקה ידנית — אין מה לעשות כאן, אבל ה-job שלה כנראה נותר לא מסומן ויש לבדוק אותו בנפרד. לא בוצע שינוי.', c_dead;
  end if;
  if v_status <> 'pending' then
    raise exception '0100: אבן הדרך % במצב "%" ולא pending. משהו קידם אותה מאז המדידה (7.10) — הכרעת הבעלים נגעה לשורה שאף מסמך חי אינו עומד מאחוריה. לא בוצע שינוי.', c_dead, v_status;
  end if;
  if v_amount <> c_amount then
    raise exception '0100: סכום אבן הדרך % הוא % ולא % שנמדד. לא בוצע שינוי.', c_dead, v_amount, c_amount;
  end if;
  if v_expected is distinct from c_expected then
    raise exception '0100: expected_date של % הוא % ולא % שנמדד. לא בוצע שינוי.', c_dead, v_expected, c_expected;
  end if;
  if v_dead_job is null then
    raise exception '0100: לאבן הדרך % אין job מקושר. במצב הזה היא אינה מגיעה לענף הלא-מעוגן ב-/projects כלל (page.tsx:1172 עושה continue), כלומר היא אינה הרעש שתוארה — ואין job לסמן. לא בוצע שינוי.', c_dead;
  end if;

  -- ── 2. ה-job המת: נקי לגמרי, ולא מסומן עדיין ───────────────────────────────
  select j.paid::text, j.invoice_biz, j.invoice_tax, j.dismissed
    into v_paid, v_biz, v_tax, v_dismissed
  from public.jobs j
  where j.id = v_dead_job;

  if v_paid is null then
    raise exception '0100: ה-job % שאבן הדרך מצביעה עליו לא נמצא. מפתח זר שבור — עצור ובדוק. לא בוצע שינוי.', v_dead_job;
  end if;
  if coalesce(btrim(v_biz), '') <> '' then
    raise exception '0100: ל-job % יש invoice_biz = "%". מסמך חיוב עומד עליו — זו אינה שורה יתומה. לא בוצע שינוי.', v_dead_job, v_biz;
  end if;
  if coalesce(btrim(v_tax), '') <> '' then
    raise exception '0100: ל-job % יש invoice_tax = "%". מסמך מס עומד עליו — זו אינה שורה יתומה, וחשיפה מול רשויות המס אינה דבר שמסמנים כמוסתר. לא בוצע שינוי.', v_dead_job, v_tax;
  end if;
  if v_paid = 'כן' then
    raise exception '0100: ה-job % מסומן paid = "כן". כסף נכנס עליו — לא מסמנים אותו כמוסתר. לא בוצע שינוי.', v_dead_job;
  end if;
  if v_dismissed then
    raise exception '0100: ה-job % כבר dismissed. ההרצה הזו כנראה כבר קרתה, או שמישהו סימן אותו ביד — בדוק את הפנקס ואת events לפני שתמשיך. לא בוצע שינוי.', v_dead_job;
  end if;

  -- ── 3. אפס מסמכים חיים, ולפחות מסמך מבוטל אחד ──────────────────────────────
  -- 🔴 שתי הדלתות, ולא אחת. מסמך יכול לנקוב ב-job ישירות (`job_id`) או לשאת
  -- אותו באגד (`bundle_job_ids`, uuid[] מ-0044:12) — חשבונית מס שנבנתה
  -- ב-taxFromParent נושאת job_id ריק ואת העבודה באגד. בדיקה על עמודה אחת
  -- בלבד הייתה מכריזה "אין מסמכים" על job שיש לו מסמך חי באגד, וזו בדיוק
  -- הטעות שאין ממנה חזרה אחרי DELETE.
  select count(*) into v_live_docs
  from public.documents d
  where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
    and d.cancelled_at is null
    and d.archived_at is null;

  if v_live_docs <> 0 then
    raise exception '0100: ל-job % יש % מסמכים חיים (לא מבוטלים ולא מאורכבים). השורה אינה יתומה. לא בוצע שינוי.', v_dead_job, v_live_docs;
  end if;

  select count(*) into v_cancelled_docs
  from public.documents d
  where (d.job_id = v_dead_job or d.bundle_job_ids @> array[v_dead_job])
    and d.cancelled_at is not null;

  if v_cancelled_docs < 1 then
    raise exception '0100: ל-job % אין אף מסמך מבוטל. "מסמכיה בוטלו והונפקו מחדש" הוא כל הנימוק לניקוי — job בלי שום מסמך, לא חי ולא מבוטל, הוא מקרה אחר (אבן דרך שהונפקה לתור ומעולם לא יצאה) ואסור לנקות אותו כאן. לא בוצע שינוי.', v_dead_job;
  end if;

  -- ── 4. אבן הדרך החיה: אותו חוזה, ועם מסמך חי ───────────────────────────────
  -- זה השער שהופך "מחיקה" ל"ניקוי כפילות". בלעדיו הקובץ היה מוחק את אבן הדרך
  -- היחידה של החוזה ומוחק איתה התחייבות אמיתית.
  select m.job_id into v_live_job
  from public.contract_milestones m
  where m.id = c_live and m.contract_id = v_contract;

  if not found then
    raise exception '0100: אבן הדרך החיה % לא נמצאה תחת החוזה % של אבן הדרך המתה. בלי המחליפה, המחיקה היא איבוד התחייבות ולא ניקוי כפילות. לא בוצע שינוי.', c_live, v_contract;
  end if;
  if v_live_job is null then
    raise exception '0100: לאבן הדרך החיה % אין job מקושר, כלומר אין לה מסמכים — היא אינה המחליפה שתוארה. לא בוצע שינוי.', c_live;
  end if;
  if v_live_job = v_dead_job then
    raise exception '0100: שתי אבני הדרך מצביעות על אותו job %. זה אמור להיות בלתי אפשרי (0086 — אינדקס ייחודי על job_id) ומשמעותו שהמדידה או האינדקס אינם במצב שנמדד. עצור. לא בוצע שינוי.', v_dead_job;
  end if;

  select count(*) into v_live_ms_docs
  from public.documents d
  where (d.job_id = v_live_job or d.bundle_job_ids @> array[v_live_job])
    and d.cancelled_at is null
    and d.archived_at is null;

  if v_live_ms_docs < 1 then
    raise exception '0100: לאבן הדרך החיה % אין אף מסמך חי (job %). ההנפקה מחדש היא ההצדקה למחיקת הישנה — בלי מסמך חי על החדשה, אין הצדקה. לא בוצע שינוי.', c_live, v_live_job;
  end if;

  -- ── 5. ביקורת ההפניות — הכרעת הבעלים: הפניה קשיחה = עצור ─────────────────
  -- מפתח זר כלשהו שמצביע על contract_milestones, מכל טבלה. אפס היום (נסרקו
  -- 100 קבצי מיגרציה), ונמדד כאן ולא מונח — מפתח שיתווסף מחר יעצור את הקובץ
  -- במקום שהמחיקה תיפול על 23503 באמצע טרנזקציה.
  select count(*) into v_hard_fks
  from pg_constraint con
  join pg_class    rel on rel.oid = con.confrelid
  join pg_namespace ns on ns.oid = rel.relnamespace
  where con.contype = 'f'
    and ns.nspname  = 'public'
    and rel.relname = 'contract_milestones';

  if v_hard_fks > 0 then
    raise exception '0100: נמצאו % מפתחות זרים שמצביעים על contract_milestones. הכרעת הבעלים: הפניה קשיחה = לא מוחקים. עצור, בדוק מה מצביע ועל מה, ואז הכרע מחדש. לא בוצע שינוי.', v_hard_fks;
  end if;

  -- ההפניה הרכה — jsonb, בלי אילוץ. נמדדת כדי להידרש בשורת הפנקס, לא כדי
  -- לחסום, ושורות ה-events עצמן אינן נמחקות (ראה הכותרת).
  select count(*) into v_event_refs
  from public.events e
  where e.payload->>'milestone_id' = c_dead::text;

  -- ── 6. התצלום — העתק היחיד שישרוד את המחיקה ───────────────────────────────
  -- לפני המחיקה ולא אחריה, וזה כל העניין: אין archive.contract_milestones.
  select to_jsonb(m) into v_snapshot from public.contract_milestones m where m.id = c_dead;
  select to_jsonb(j) into v_job_snap from public.jobs j where j.id = v_dead_job;

  -- ── 6ב. ספירות וטביעות "לפני" ─────────────────────────────────────────────
  -- 🔴 שני `select` נפרדים לכל טבלה, ושיתוף ביניהם הוא באג — נמדד 7.10
  --    בהרצה המדומה, שנכשלה ב-`מספר אבני הדרך ירד ב-0 ולא ב-1`.
  --
  --    הספירה והטביעה שואלות **שתי שאלות הופכיות**:
  --      ספירה  "האם נעלמה בדיוק שורה אחת?"  → השורה המשתנה חייבת להיכלל
  --      טביעה  "האם כל השאר זהה תו-בתו?"     → השורה המשתנה חייבת להיחרג
  --    `select` אחד שהחריג את השורה ושירת את שתיהן הפך את ההפרש ל-0 לנצח,
  --    והבדיקה `before - 1 <> after` נכשלה תמיד, בכל מסד, בלי תלות בנתונים.
  --
  -- ⚠️ `order by id` אינו קישוט: md5 של string_agg בלי סדר קבוע אינו יציב בין
  --    שתי קריאות, והבדיקה הייתה נכשלת או עוברת באקראי.
  select count(*) into v_jobs_n_before from public.jobs;
  select count(*) into v_ms_n_before   from public.contract_milestones;

  select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_jobs_before
  from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

  select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_ms_before
  from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

  -- ── 7. הפעולה, שתי שורות ─────────────────────────────────────────────────
  c_reason := 'אבן דרך יתומה: מסמכיה בוטלו והונפקו מחדש על אבן הדרך '
           || c_live::text
           || ' באותו חוזה, בעקבות שינוי ח.פ של הלקוח. נוקה במיגרציה 0100, 7.10.2026.';

  update public.jobs
     set dismissed     = true,
         dismiss_reason = c_reason,
         dismissed_at   = now(),
         dismissed_by   = null   -- מיגרציה עשתה זאת, לא אדם (מוסכמת 0041/0095)
   where id = v_dead_job
     and dismissed = false;      -- פרדיקט, לא קריאה מוקדמת
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0100: עדכון ה-job עדכן % שורות ולא 1. לא בוצע שינוי.', v_n;
  end if;

  delete from public.contract_milestones where id = c_dead;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception '0100: מחיקת אבן הדרך מחקה % שורות ולא 1. לא בוצע שינוי.', v_n;
  end if;

  -- קנרית: אבן הדרך החיה לא נגעה. DELETE על מזהה בודד אינו יכול לגעת בה,
  -- והבדיקה כאן היא מה שהופך את "אינו יכול" לנמדד.
  if not exists (select 1 from public.contract_milestones where id = c_live) then
    raise exception '0100 canary: אבן הדרך החיה % נעלמה. גלגל. לא בוצע שינוי.', c_live;
  end if;

  -- ── 7ב. 🔴 אפס נזק צדדי, נמדד ולא מונח ────────────────────────────────────
  -- `get diagnostics` למעלה מוכיח ששתי הפעולות נגעו בשורה אחת כל אחת, וזה
  -- כמעט הכול — UPDATE ו-DELETE לפי מפתח ראשי אינם יכולים לגעת בשורה אחרת.
  -- "כמעט" הוא הסיבה שזה כאן: הקובץ מוחק שורה שאין ממנה חזרה (אין
  -- archive.contract_milestones), ו-0095 כבר קבע שה-md5 הוא ההוכחה לאפס נזק
  -- צדדי **ולא** ה-WHERE שמבטיח אותה. בהרצה אמיתית אין גלגול לסמוך עליו.
  -- שני `select` נפרדים, בדיוק כמו בשלב 6ב ומאותו נימוק. ראה שם.
  select count(*) into v_jobs_n_after from public.jobs;
  select count(*) into v_ms_n_after   from public.contract_milestones;

  select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_jobs_after
  from (select j.id, j::text as row_text from public.jobs j where j.id <> v_dead_job) t;

  select md5(coalesce(string_agg(t.row_text, '|' order by t.id), '')) into v_ms_after
  from (select m.id, m::text as row_text from public.contract_milestones m where m.id <> c_dead) t;

  -- ⚠️ כל מספר בהודעות האלה הוא `label=value` ב-ASCII ולעולם לא מוטבע בתוך
  --    משפט עברי. ההרצה המדומה הראשונה (7.10) נכשלה עם `ירד ב-% ולא ב-1`,
  --    ומי שקרא לא יכול היה לדעת איזה מספר הוא מה — ערבוב דו-כיווני הופך
  --    הודעת שגיאה למטרידה במקום למאבחנת.
  if v_jobs_n_before <> v_jobs_n_after then
    raise exception '0100: מספר שורות jobs השתנה — הקובץ מעדכן ואינו מוסיף או מוחק job. jobs_before=% jobs_after=% jobs_expected_after=%. לא בוצע שינוי.',
      v_jobs_n_before, v_jobs_n_after, v_jobs_n_before;
  end if;
  if v_jobs_before <> v_jobs_after then
    raise exception '0100: טביעת ה-jobs שאינם ה-job הנגוע השתנתה — נגענו ב-job שלא היה אמור לזוז. md5_before=% md5_after=%. לא בוצע שינוי.',
      v_jobs_before, v_jobs_after;
  end if;
  if v_ms_n_after <> v_ms_n_before - 1 then
    raise exception '0100: מספר אבני הדרך לא ירד בדיוק באחת. ms_before=% ms_after=% ms_expected_after=% delta=%. לא בוצע שינוי.',
      v_ms_n_before, v_ms_n_after, v_ms_n_before - 1, v_ms_n_before - v_ms_n_after;
  end if;
  if v_ms_before <> v_ms_after then
    raise exception '0100: טביעת אבני הדרך שאינן הנמחקת השתנתה — נגענו באבן דרך שלא הייתה אמורה לזוז. md5_before=% md5_after=%. לא בוצע שינוי.',
      v_ms_before, v_ms_after;
  end if;

  -- ── 8. שובל האודיט, ובתוכו התצלום ────────────────────────────────────────
  -- entity_type = 'contract' ו-entity_id = החוזה, בדיוק כמו שבעת ראוטי אבני
  -- הדרך כותבים (milestones/[mid]:89-90) — כך שהאירוע יימצא יחד עם כל שאר
  -- ההיסטוריה של החוזה ולא בפינה משל עצמו. actor_id null: מיגרציה.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values (
    'contract',
    v_contract,
    'milestone_orphan_cleaned',
    null,
    jsonb_build_object(
      'via',                 '0100',
      'milestone_id',        c_dead,
      'milestone_name',      v_name,
      'replaced_by',         c_live,
      'contract_id',         v_contract,
      'job_id',              v_dead_job,
      'job_dismiss_reason',  c_reason,
      'cancelled_docs',      v_cancelled_docs,
      'live_docs',           v_live_docs,
      'live_milestone_docs', v_live_ms_docs,
      'orphaned_event_refs', v_event_refs,
      -- 🔴 העתק היחיד. אין archive.contract_milestones.
      'milestone_snapshot',  v_snapshot,
      'job_snapshot_before', v_job_snap
    )
  );

  -- ── 9. שורת הפנקס ────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0100', now(), 'bnaya',
    'ניקוי אבן דרך יתומה אחת — EY "חבילה 6 פרקים" ₪9,600, מזהה 1b55f005-12f8-4280-a49e-9cd4d33e0b79. שתי שורות נגעו: jobs אחת סומנה dismissed עם נימוק, ו-contract_milestones אחת נמחקה. אפס שינוי סכימה, אפס טבלה, אפס policy, אפס פונקציה, אפס אינדקס. '
    'הרקע: אבן הדרך הונפקה, מסמכיה בוטלו בעקבות שינוי ח.פ של הלקוח, והמסמכים הונפקו מחדש על אבן דרך 1b5e4654-b2e2-4f59-8ed3-317ef336df07 באותו חוזה — אותו חוזה ולא לקוח אחר, וזו המדידה שהפריכה את ההנחה הראשונה בתחקיר (ח.פ אחר = לקוח אחר במורנינג). הישנה נשארה עומדת עם job נקי. '
    'למה היא הופיעה ב-/projects, כי זה המנגנון ולא התסמין: projects/page.tsx:618 מפיל מסמך מבוטל מהליכת המסמכים של אבן הדרך, ובלי מסמך חי אין עוגן ולכן הענף המעוגן (page.tsx:974) מדלג — והענף הלא-מעוגן (page.tsx:1170-1206) קולט אותה, כי הוא דורש job ותאריך ואינו בודק את ה-state כלל. התגים שהוצגו, "עבר המועד ואין חשבונית" (overdue, milestone.ts:62) ו"לא חויב" (purple, state.ts:25), מסכימים שניהם על אותה עובדה אחת: ה-job קיים ונקי. cancelLocal.ts:79-93 הוא שניקה אותו — הוא מנקה jobs.invoice_biz ואינו נוגע ב-contract_milestones, לא ב-status ולא ב-job_id. '
    'הפרדיקט, חמש עשרה בדיקות לפני שורה אחת שנכתבה וארבע אחריה: הפנקס מכיל 0099 ואינו מכיל 0100; אבן הדרך קיימת, status pending, סכום 9600 ו-expected_date 2026-10-04 בדיוק כפי שנמדדו 7.10, וסטייה בכל אחד מהם עוצרת — שורה שזזה מאז המדידה אינה השורה שהוכרע עליה; job_id אינו ריק, שאחרת היא אינה מגיעה לענף הלא-מעוגן כלל; ה-job קיים, invoice_biz ריק, invoice_tax ריק, paid אינו כן, ואינו dismissed עדיין; אפס מסמכים חיים על ה-job לפי job_id וגם לפי bundle_job_ids, ולפחות מסמך מבוטל אחד; אבן הדרך החיה קיימת תחת אותו contract_id, יש לה job, הוא אינו אותו job, ויש לו לפחות מסמך חי אחד; ואפס מפתחות זרים שמצביעים על contract_milestones. '
    'שתי הדלתות בבדיקת המסמכים אינן קישוט: מסמך יכול לנקוב ב-job ישירות או לשאת אותו ב-bundle_job_ids (uuid[] מ-0044:12), וחשבונית מס שנבנתה ב-taxFromParent נושאת job_id ריק ואת העבודה באגד. בדיקה על עמודה אחת הייתה מכריזה "אין מסמכים" על job שיש לו מסמך חי באגד, וזו הטעות שאין ממנה חזרה אחרי DELETE. '
    'ביקורת ההפניות, שהיא תנאי הבעלים למחיקה: מפתח זר קשיח אין אחד — נסרקו 100 קבצי מיגרציה, אפס references אל contract_milestones ואפס עמודה בשם milestone_id בכל הסכימה, וההפניות של הטבלה הן יוצאות בלבד; הקובץ בכל זאת מודד זאת מול pg_constraint בזמן ריצה ועוצר אם נמצא מפתח, כדי שמפתח שיתווסף מחר יעצור את הקובץ במקום שהמחיקה תיפול על 23503 באמצע טרנזקציה. ההפניה היחידה שקיימת היא רכה: events.payload->>milestone_id, שאותה כותבים שבעה ראוטים (contracts/[id]/milestones:45, milestones/[mid]:93, enqueue:221, issue:115, record-billed:349, tax:124, deal-invoice:111), והיא jsonb בלי אילוץ ולכן אינה נחסמת ואינה נשברת. שורות ה-events לא נמחקו במכוון — events הוא יומן ביקורת, ומחיקת היומן של דבר היא ההפך ממה שיומן קיים בשבילו; מספר השורות היתומות נרשם ב-payload תחת orphaned_event_refs כדי שהקורא הבא יֵדע שהן יתומות ולמה. '
    'ואחרי הכתיבה ארבע בדיקות נזק צדדי, בשתי מדידות נפרדות שאסור לאחד: ספירה על הטבלה כולה — מספר ה-jobs לא השתנה ומספר אבני הדרך ירד בדיוק באחת — ו-md5 על כל השורות מלבד המשתנה, זהה לפני ואחרי. get diagnostics כבר מוכיח ששתי הפעולות נגעו בשורה אחת כל אחת, ו-UPDATE ו-DELETE לפי מפתח ראשי אינם יכולים לגעת בשורה אחרת; ה-md5 כאן כי הקובץ מוחק שורה שאין ממנה חזרה, ו-0095 קבע שה-md5 הוא ההוכחה לאפס נזק צדדי ולא ה-WHERE שמבטיח אותה, ובהרצה אמיתית אין גלגול לסמוך עליו. order by id בתוך string_agg, כי md5 בלי סדר קבוע אינו יציב בין שתי קריאות. '
    'ולמה שתי מדידות ולא אחת, וזה נמדד ולא נטען: ההרצה המדומה של 7.10 נכשלה ב-"מספר אבני הדרך ירד ב-0 ולא ב-1", והכשל היה בקובץ ולא בנתונים. הספירה והטביעה חלקו select יחיד עם where id <> c_dead, והן שואלות שאלות הופכיות — הטביעה שואלת האם כל השאר זהה ולכן חייבת להחריג את השורה המשתנה, והספירה שואלת האם נעלמה בדיוק שורה אחת ולכן חייבת לכלול אותה. בלעדיה ההפרש הוא אפס לנצח, והבדיקה before - 1 <> after נכשלה תמיד בכל מסד בלי תלות בנתונים. הקובץ הזה נשא את אותו קוד והיה נכשל באותה בדיקה אחרי שביצע את שתי הכתיבות, כלומר ההרצה המדומה עשתה בדיוק את מה שהיא קיימת בשבילו. זו גם הפעם השנייה שאותה צורה נתפסה כאן — קודם בטביעת ה-jobs שהחריגה את מזהה אבן הדרך במקום את מזהה ה-job — והצורה היא בדיקת אחרי שמודדת אוכלוסייה שאינה מכילה את מה שהשתנה, שעוברת בשתיקה או נכשלת תמיד ובשני המקרים אינה בודקת את מה שנכתבה לבדוק. 0100_verify.sql אינו נגוע: אין בו זוג לפני/אחרי כלל, וכל בדיקה בו מודדת או את השורה עצמה או אוכלוסייה שלמה. '
    'וכל מספר בכל הודעת שגיאה בקובץ הזה ובהרצה המדומה הוא label=value ב-ASCII ולעולם לא מוטבע בתוך משפט עברי: ההודעה שנכשלה ב-7.10 הייתה "ירד ב-% ולא ב-1", שני מספרים בתוך טקסט RTL, ומי שקרא לא יכול היה לדעת איזה מהם מה. ערבוב דו-כיווני הופך הודעת שגיאה למטרידה במקום למאבחנת. מאותה סיבה ההרצה המדומה אוספת דוח מלא ומדפיסה אותו בתוך ה-exception ולא ב-NOTICE — Supabase SQL Editor אינו מציג NOTICE, רק את השגיאה האחרונה. '
    'בלתי הפיך, וחמור יותר מ-0095: אין archive.contract_milestones. סכימת הארכיון מחזיקה שלוש טבלאות בלבד — archive.jobs, archive.productions ו-archive.job_productions (0002:313-314, 0009:42) — ואבן דרך אינה אחת מהן, כלומר אין מאיפה לשחזר את השורה. לכן שורת ה-events נושאת תצלום jsonb מלא של אבן הדרך ושל ה-job לפני השינוי (milestone_snapshot, job_snapshot_before), והתצלום הזה הוא העתק היחיד שישרוד. '
    'הטריגרים נבדקו אחד-אחד ואף אחד אינו חוסם: trg_guard_milestone_money (0010:90-93) הוא before UPDATE בלבד ואינו נדלק על DELETE, ואין שום טריגר DELETE על הטבלה — רק policy milestones_delete, ש-postgres עוקף כמו כל מיגרציה; trg_guard_job_dismissal (0041:45-48) נדלק על dismissed ו-dismiss_reason ותנאו auth.uid() is not null, שב-SQL Editor הוא null ולכן עובר, בדיוק המוסכמה המתועדת ב-0041:30-32; trg_guard_job_money (0010:34-37) נדלק רק על amount/paid/invoice_biz/invoice_tax/client_id/contract_id/manual_only ואף אחת מהן לא נגעה, ולכן גוף הטריגר יוצא מיד ו-can_edit_money אפילו לא נקרא; trg_compute_due_date (0002:278-280) הוא of date, client_id בלבד. dismissed_by נשאר null במכוון — העמודה היא uuid references profiles (0041:17) ואין לה ערך אמיתי כאן, אותה מוסכמה שבה events.actor_id נשאר null ב-0095 ו-invoices.issued_by ריק ב-0083. '
    'זיהוי לפי uuid ולעולם לא לפי שם החוזה, וזו החלטה: השם מופיע בשני איותים בתיעוד עצמו — "ey 2026 -2027 חצי ראשון 041026" בשורת הפנקס של 0098 מול "ey 2026-2027 חצי ראשון 041026" בדיווח המסך — והשוואת מחרוזת הייתה נכשלת על הרווח או, גרוע מכך, תופסת חוזה אחר. '
    'הכרעות הבעלים (7.10) ומה שהן אינן כוללות: לנקות את הרשומה הבודדת הזו, כן; את הדפוס לא מתקנים עכשיו. אין כאן שינוי קוד, אין סינון חדש ב-unified.ts ואין עמודת מחיקה על contract_milestones. ובמפורש לא סוגרים את החוזה: ההנפקה מחדש נעשתה על אותו חוזה, שהוא active ונושא אבן דרך חיה, וסגירתו הייתה משתיקה גם אותה — כלומר הצעה 1 מהתחקיר, סינון חוזה סגור ב-/projects, אינה רלוונטית למקרה הזה. '
    'הדפוס שנשאר פתוח, ונרשם כ-T29 ב-docs/TICKETS.md: ל-contract_milestones אין ייצוג למצב מבוטל — אין deleted_at, ה-CHECK הוא pending/invoiced/paid בלבד, ואין שום ראוט DELETE באפליקציה (נסרקו שמונה ראוטים שנוגעים בטבלה, כולם insert או update), כך שהפעולה הזו אפשרית רק ב-SQL ישיר. unified.ts:705 קובע cancelled: false בקוד, והענף הלא-מעוגן אינו בודק state. לכן כל ביטול-והנפקה-מחדש של אבן דרך ייצר בדיוק את אותה שורה, ושינוי ח.פ היה רק הטריגר שקרה ראשון. נמדד 7.10 שזו השורה היחידה בצורה הזו כרגע (live_docs=0 וגם cancelled_docs>0), ולכן ניקוי נקודתי ולא תיקון דפוס. '
    'מחוץ להיקף במכוון: אפס שינוי קוד, אפס שינוי סכימה, אפס מחיקת שורות events, אפס נגיעה באבן הדרך החיה או ב-job שלה או במסמכיה, אפס נגיעה בחוזה, ואפס נגיעה בכל job או אבן דרך אחרים במסד.');

  raise notice '✅ 0100: אבן הדרך % נמחקה (תצלום ב-events), ה-job % סומן dismissed. % מסמכים מבוטלים מאחוריה, % שורות events יתומות, אבן הדרך החיה % עם % מסמכים חיים.',
    c_dead, v_dead_job, v_cancelled_docs, v_event_refs, c_live, v_live_ms_docs;
end $mig$;

-- ── שובל האודיט ─────────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
-- 🔴 התצלום של השורה הנמחקת חי ב-events.payload->'milestone_snapshot' והוא
--    ההעתק היחיד — אין archive.contract_milestones.
-- האימות שאחרי ההרצה: supabase/verify/0100_verify.sql — שלוש עשרה עמודות, כולן true.
