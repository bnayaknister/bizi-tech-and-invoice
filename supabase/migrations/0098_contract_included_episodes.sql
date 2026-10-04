-- ============================================================================
-- 0098 — מכסת פרקים לחוזה. עמודה אחת, `contracts.included_episodes`.
--
-- **אפס שינוי התנהגות.** שום קוד עדיין לא קורא ולא כותב את העמודה, אין
-- backfill, ואף שורה קיימת לא נגעה — כל חוזה קיים מקבל `null`, שהוא בדיוק
-- המשמעות "חוזה רגיל לפי אבני דרך". זו סכימה בלבד.
--
-- ═══ 🔒 הכרעות הבעלים (4.10), מילה במילה ═══
--   · לחוזה אפשר להגדיר "מספר פרקים בחבילה" — **לא חובה**. ריק = חוזה רגיל
--     לפי אבני דרך, ללא שינוי.
--   · ניצול = הפקה עם `contract_id` של החוזה, שהסטטוס שלה "הוקלט" ומעלה
--     (hasBeenPerformed), ושאינה מבוטלת או ממוזגת. **ספירה, לא עמודת מונה.**
--   · מעבר למכסה: **התראה בלבד.** לא חוסם הקלטה, ולא מנפיק שום מסמך.
--   · **בלי תוקף.** `end_date` הקיים לא משתנה.
--   · המקרה הראשון: חוזה "ey 2026 -2027 חצי ראשון 041026", 6 פרקים.
--
-- ═══ 🔴 למה אין כאן עמודת מונה, ולמה זה העיקר ═══
-- הניצול נגזר בקריאה:
--
--   count(*) from productions
--   where contract_id = <החוזה> and status >= 'הוקלט'
--     and cancelled_at is null and merged_into is null
--
-- `productions.contract_id` **כבר נכתב** ביצירת ההפקה — סנכרון היומן
-- (calendar/sync/route.ts:325) והיצירה הידנית (productions/route.ts:155) —
-- כך שהמונה קיים בנתונים מהיום הראשון, גם לחוזים שכבר יש. מה שחסר הוא
-- המכנה, וזו העמודה שנוספת כאן.
--
-- עמודת מונה הייתה דורשת נתיב כתיבה בכל מעבר סטטוס, בכל ביטול, בכל מיזוג
-- ובכל פיצול — ארבעה מקומות שיכולים להיפרד מהמציאות, ומונה שנפרד מהמציאות
-- על מסך כספים הוא בדיוק מה ש-0085 נדרשה לתקן. ספירה אינה יכולה להיפרד.
--
-- ═══ למה על `contracts` ולא על `contract_milestones` ═══
-- אבן הדרך היא **החשבונית** (9,600 ₪ בחבילה של EY); המכסה היא **העסקה**.
-- ו-`contracts_one_active_per_show` (0056:73-76) מבטיח חוזה פעיל אחד לכל
-- היותר לתוכנית, כך שלשאלה "כמה פרקים נשארו לתוכנית הזו" יש תשובה אחת.
-- על אבן דרך היו לשאלה הזו כמה תשובות, אחת לכל אבן.
--
-- ═══ למה 500, וה-גבול שהוא כן תופס ═══
-- גבול שפוי ולא מדיד, באותו שיקול של 120 התווים ב-0097: אין היום שום עמודה
-- שאפשר להסיק ממנה מספר. 500 פרקים הם מעל כל חבילה אמיתית (החבילה הראשונה
-- היא 6), והוא קונה דבר אחד מוגדר: **הוא תופס החלקה של סדר גודל בשלוש
-- ספרות** — 6 שהוקלד 600 נדחה. הוא **אינו** תופס החלקה בספרה אחת: 6 שהוקלד
-- 60 עובר, וזה מודע. שום CHECK אינו יכול לתפוס את זה, והמסך הוא מה שיציג
-- "נוצלו 0 מתוך 60" כדי שמי שהקליד יראה.
--
-- ═══ 🔴 0 נדחה — וזו הנקודה שחוזרת מ-0097 ═══
-- `between 1 and 500`, ולכן `0` **נדחה**. חוזה שמכסה אפס פרקים אינו חבילה
-- והוא גם אינו "חוזה רגיל" — למצב הזה יש כבר ייצוג אחד, `null`. שני ייצוגים
-- לאותו מצב היו מחייבים כל קורא עתידי לבדוק גם `null` וגם `0` לנצח, וזו
-- בדיוק הסיבה שבגללה 0097 דחתה מחרוזת ריקה. מצב אחד, ייצוג אחד.
--
-- אין DEFAULT. `default 0` היה יוצר בדיוק את הכפילות הזו, ו-`default null`
-- הוא ממילא ההתנהגות.
--
-- ═══ 🔴 ממצא ההרשאות — והוא **הופכי** ללקח של 0097 ═══
-- 0097 נכתבה סביב הכלל "גרנט עמודתי קיים אינו מתרחב לעמודה חדשה". נבדק אם
-- הוא חל כאן, וה**תשובה היא לא**:
--
--   · אין בשום מיגרציה אף `grant` או `revoke` שנוקב ב-`contracts`
--     (נסרקו כל 97 הקבצים).
--   · 0068 הוא שקובע את הבסיס: `revoke all privileges on all tables in
--     schema public from anon` (0068:180) — ולכן ל-anon אין דבר; ואילו
--     `authenticated` איבד שם רק truncate/references/trigger/maintain
--     (0068:195), ונותר עם `arwd` **ברמת הטבלה** על כל טבלה שלא צומצמה
--     במפורש. הטבלאות שצומצמו הן `shows` (רשימת היתר עמודתית, 0068:211),
--     `production_addons` (נשללה כולה, 0068:244), `productions` (0070:186),
--     ו-`misc_productions` / `client_review_transcripts` / `booking_links` /
--     `booking_requests` שנולדו שלולות. **`contracts` אינה ביניהן.**
--   · ולכן, כפי שפנקס 0077 מנסח את המנגנון: "כל עוד authenticated=r יושב
--     ב-relacl הפונקציה has_column_privilege מחזירה true על כל עמודה".
--     עמודה חדשה על `contracts` **נולדת קריאה**.
--
-- 🔴 המסקנה המעשית: `grant select (included_episodes)` כאן היה "הצהרה
--    שעוברת נקייה ולא עושה דבר" — בדיוק הפיתוי שפנקס 0077 מזהיר מפניו
--    לגבי `revoke select (job_id)`. ולכן **אין כאן גרנט עיוור**: הקובץ
--    **מודד** את הבסיס, מעניק גרנט עמודתי **רק אם** הגרנט ברמת הטבלה חסר,
--    ובשני המקרים ה-canary דורש שהעמודה תהיה קריאה בפועל. אם הבסיס השתנה
--    מתחתינו — הענף השני יתפוס אותו.
--
-- הכסף על `contracts` מוגן ב-RLS (`contracts_view` = `can_view_money()`,
-- 0002:358) ולא בהרשאות עמודתיות. `included_episodes` יורשת את אותה הגנה,
-- וזה נכון: מי שרואה את `total_amount` רואה גם מכמה פרקים הוא מורכב.
--
-- ═══ 🔶 מעבר להיקף שאושר, ובכוונה — הגארד הכספי ═══
-- `included_episodes` מכריעה מתי ההכנסה מהחוזה נפסקת, וזו הגדרה כספית
-- באותו דרג בדיוק כמו `total_amount` ו-`show_id`. 0056 צירפה את `show_id`
-- ל-`guard_contract_money_columns` מאותו נימוק עצמו ודיווחה על כך כתוספת
-- ("מעבר לארבעת הצעדים שאושרו, ובכוונה"), וזה התקדים שנשען עליו כאן.
--
-- זהו **חגורה ולא אבזם**: `contracts_update` ב-RLS כבר דורש
-- `can_edit_money()` לכל עדכון של חוזה (0002:360), כך שהגארד אינו הקיר
-- היחיד. הוא כן מה שימשיך לעמוד אם ה-policy ישתנה אי-פעם.
--
-- ⚠️ הגארד **אינו** חוסם עדכון מה-SQL Editor: `can_edit_money()` קוראת
--    `auth.uid()`, שהוא null בסשן שאינו של אפליקציה, והתנאי `if not null`
--    ב-plpgsql אינו אמת — כך שהענף לא נלקח. זו ההתנהגות של 0010 מאז ומתמיד,
--    וזה מה שמאפשר לבעלים להזין 6 ביד אם ירצה לפני שהקוד קיים.
--
-- ⚠️ זו הכתיבה **השלישית** של גוף `guard_contract_money_columns`
--    (0010 → 0056 → כאן). `create or replace` שותק לגבי מה שהרס, ולכן יש
--    למטה שומר טביעה שדורש שהגוף הנוכחי הוא זה של 0056 לפני שהוא מוחלף —
--    הדפוס של 0077, בצורה שאפשר לבדוק בלי גישה מוקדמת למסד.
--
-- ═══ מה שאין כאן, במכוון ═══
-- אין תוקף ואין נגיעה ב-`end_date` — הכרעת הבעלים. אין עמודת "מחיר לפרק"
-- על החוזה, ולכן אין אימות `total_amount = included_episodes × מחיר`: במצב
-- "לפי חוזה" `shows.default_rate` נמחק (ShowsClient.tsx:697), אין מאיפה
-- לגזור מחיר, והמצאת אחד כאן הייתה אימות של מספר שהמסד אינו מכיר.
-- **זו שאלה פתוחה שמדווחת ולא נסגרת.**
--
-- אין אינדקס: השאילתה היחידה שתקרא את העמודה היא קריאת חוזה בודד לפי
-- מפתח ראשי או לפי `show_id` (שיש לו אינדקס מ-0056). אינדקס על עמודה שרוב
-- שורותיה null, בטבלה של שלוש שורות, הוא עלות בלי קונה.
--
-- אין התראה, אין מונה במגירה ואין קריאה בקוד — כולם בשלב הבא.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0098_dryrun.sql`  — מוסיף את העמודה ואת ה-CHECK בתוך
--      טרנזקציה, מוכיח null/1/6/500 עוברים ו-0/501/שלילי נדחים, מודד את
--      ההרשאות, ואז מגלגל. מסיים ב-`raise exception` גם בהצלחה.
--   2. הקובץ הזה.
--   3. `supabase/verify/0098_verify.sql`  — שאילתה אחת, שורה אחת, עמודות true.
--
-- ⚠️ אחרי ההחלה חובה לייצר מחדש את `src/lib/supabase/database.types.ts`,
--    אחרת בדיקת הדריפט ב-`prebuild` תיפול והדיפלוי ייחסם.
--
-- אפס DELETE, אפס שינוי נתונים, אפס טבלה חדשה, אפס נגיעה בעמודה קיימת.
-- ============================================================================

do $mig$
declare
  v_n_cols   int;
  v_rows     bigint;
  v_body     text;
  v_tbl_sel  boolean;
  v_granted  boolean := false;
  -- מצב הכתיבה לפני השינוי. נמדד ולא מונח, כדי שה-canary יוכיח "ללא שינוי"
  -- במקום להצהיר על מצב קבוע — `contracts` היא טבלה שהכתיבה אליה מותרת
  -- דרך RLS, ולכן כאן אסור להעתיק את ה-canary של 0097 שדורש אפס כתיבה.
  v_ins_before boolean;
  v_upd_before boolean;
  v_del_before boolean;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  -- גארד הרצה חוזרת. רועש, לעולם לא אידמפוטנטי-בשתיקה (הדפוס של 0074:127).
  if exists (select 1 from public.schema_ledger where version = '0098') then
    raise exception '0098 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד סדר. הפנקס הוא הרצף, לא שמות הקבצים (הדפוס של 0077): אם 0097 חסרה,
  -- המספור נגזר מפנקס אחר וכל הספירות למטה נמדדו מול מסד אחר.
  if not exists (select 1 from public.schema_ledger where version = '0097') then
    raise exception '0098: 0097 אינה בפנקס. הפנקס הוא הרצף — אם המיגרציה הקודמת חסרה, המספור והספירות כאן נגזרו ממסד אחר. הרץ אותה קודם';
  end if;

  -- גארד קיום. אם העמודה כבר שם, משהו הוסיף אותה מחוץ לפנקס — הלקח של 0052
  -- (שינוי סכימה שאיש לא ימצא אחר כך). עוצר ורועש.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts'
      and column_name = 'included_episodes'
  ) then
    raise exception '0098: העמודה contracts.included_episodes כבר קיימת אך אינה בפנקס — מישהו הוסיף אותה מחוץ למיגרציה. בדוק מה היא מחזיקה לפני שתמשיך';
  end if;

  -- גארד מצאי. כל ספירה בקובץ הזה ובקובץ האימות נגזרת מ-9 העמודות שיש
  -- ל-contracts היום (8 מ-0002 + show_id מ-0056). מספר אחר פירושו שהטבלה
  -- השתנתה מחוץ לפנקס, והספירות היו מאשרות מסד שאינני מכיר.
  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts';
  if v_n_cols <> 9 then
    raise exception '0098: ל-contracts אמורות להיות 9 עמודות לפני השינוי (8 מ-0002 + show_id מ-0056), נמצאו % — הטבלה שונתה מחוץ לפנקס', v_n_cols;
  end if;

  -- ── 1. העמודה ──────────────────────────────────────────────────────────────
  -- `null` מפורש ולא משתמע: "לא חובה" היא הכרעת הבעלים, והיא ראויה להיכתב.
  alter table public.contracts
    add column included_episodes integer null;

  -- `included_episodes is null or ...` מפורש ולא נשען על "CHECK עובר על
  -- null" — הדפוס של 0096:165 ושל 0097, ומאותה סיבה: הכוונה קריאה מהשורה
  -- עצמה ולא מסמנטיקה של שלושה-ערכים.
  alter table public.contracts
    add constraint contracts_included_episodes_chk
    check (included_episodes is null or included_episodes between 1 and 500);

  -- ── 2. הרשאות — נמדדות, לא מונחות ─────────────────────────────────────────
  -- ראה הממצא בכותרת. `has_table_privilege` אינו מתחשב בהרשאות עמודתיות,
  -- ולכן true כאן פירושו בוודאות שהגרנט ברמת הטבלה קיים — ושעמודה חדשה
  -- קריאה בלעדי כל הצהרה נוספת.
  v_tbl_sel := has_table_privilege('authenticated', 'public.contracts', 'select');
  v_ins_before := has_table_privilege('authenticated', 'public.contracts', 'insert');
  v_upd_before := has_table_privilege('authenticated', 'public.contracts', 'update');
  v_del_before := has_table_privilege('authenticated', 'public.contracts', 'delete');

  if not v_tbl_sel then
    -- הבסיס השתנה מתחתינו: `contracts` צומצמה להרשאות עמודתיות, ואז הלקח של
    -- 0097 כן חל והעמודה הייתה נולדת בלתי קריאה — הכשל של 0055, כרטיס
    -- שמרונדר ריק בלי שגיאה. גרנט מפורש, ורק בענף הזה.
    execute 'grant select (included_episodes) on public.contracts to authenticated';
    v_granted := true;
    raise notice '0098: ל-authenticated אין SELECT ברמת הטבלה על contracts — הוענק גרנט עמודתי מפורש על included_episodes.';
  else
    raise notice '0098: ל-authenticated יש SELECT ברמת הטבלה על contracts — העמודה נולדה קריאה, לא הונפק גרנט עמודתי (הוא היה הצהרה שאינה עושה דבר).';
  end if;

  -- anon אינו מוזכר כאן בכלל, וזו הנקודה: 0068:180 שלל ממנו כל הרשאה על כל
  -- טבלה ב-public, ולכן עמודה חדשה נולדת סגורה בפניו. ה-canary מודד.

  -- ── 3. 🔶 הגארד הכספי — מעבר להיקף, ומדווח ────────────────────────────────
  -- שומר טביעה לפני ההחלפה. `create or replace` שותק לגבי מה שהרס, וזו
  -- הכתיבה השלישית של הגוף הזה.
  select pg_get_functiondef(p.oid) into v_body
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'guard_contract_money_columns';

  if v_body is null then
    raise exception '0098: הפונקציה guard_contract_money_columns אינה קיימת — 0010 טרם הוחלה, ואין מה להרחיב';
  end if;
  if v_body not like '%total_amount%' or v_body not like '%client_id%' or v_body not like '%show_id%' then
    raise exception '0098: גוף guard_contract_money_columns אינו הגוף של 0056 (חסרה אחת מ-total_amount / client_id / show_id) — מישהו שינה אותו מחוץ לפנקס. אל תחליף אותו לפני שתדע מה הוא עושה';
  end if;
  if v_body like '%included_episodes%' then
    raise exception '0098: גוף guard_contract_money_columns כבר מזכיר included_episodes — העמודה או הגארד נוספו מחוץ לפנקס';
  end if;

  -- גוף 0056 מילה במילה, בתוספת סעיף אחד. ההודעה מורחבת כדי שתשקף את
  -- העמודה הרביעית — הודעה שלא מזכירה אותה הייתה שולחת את מי שנחסם לחפש
  -- סכום שלא נגע בו.
  create or replace function public.guard_contract_money_columns()
  returns trigger language plpgsql as $fn$
  begin
    if new.total_amount is distinct from old.total_amount
       or new.client_id is distinct from old.client_id
       or new.show_id is distinct from old.show_id
       or new.included_episodes is distinct from old.included_episodes then
      if not public.can_edit_money() then
        raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות סכום, לקוח, שיוך תוכנית או מכסת פרקים של חוזה';
      end if;
    end if;
    return new;
  end;
  $fn$;
  -- הטריגר עצמו (trg_guard_contract_money, 0010:73-76) כבר קיים ומצביע לכאן.

  -- ── 4. canary ──────────────────────────────────────────────────────────────
  -- הקריאוּת בפועל — הדרישה האמיתית, ושני ענפי ההרשאות מתכנסים אליה.
  if not has_column_privilege('authenticated', 'public.contracts', 'included_episodes', 'select') then
    raise exception '0098 canary: ל-authenticated אין SELECT על contracts.included_episodes — המסך היה מציג מכסה ריקה בלי שגיאה (הכשל של 0055)';
  end if;
  if not has_column_privilege('authenticated', 'public.contracts', 'total_amount', 'select') then
    raise exception '0098 canary: ל-authenticated אין SELECT על contracts.total_amount — הרשאה קיימת נשברה בדרך';
  end if;
  if has_column_privilege('anon', 'public.contracts', 'included_episodes', 'select') then
    raise exception '0098 canary: ל-anon יש SELECT על contracts.included_episodes — בדוק pg_default_acl (0069 חלק א׳) ואת 0068:180';
  end if;
  if has_table_privilege('anon', 'public.contracts', 'select') then
    raise exception '0098 canary: ל-anon יש SELECT ברמת הטבלה על contracts — השלילה של 0068:180 נשברה';
  end if;

  -- הכתיבה **ללא שינוי**, ולא "אין כתיבה": ל-authenticated יש arwd ברמת
  -- הטבלה על contracts, והכסף מוגן ב-RLS. עמודה חדשה אינה עילה לא לפתוח
  -- ולא לסגור, ולכן נדרשת זהות מול המצב שנמדד לפני.
  if has_table_privilege('authenticated', 'public.contracts', 'insert') is distinct from v_ins_before
     or has_table_privilege('authenticated', 'public.contracts', 'update') is distinct from v_upd_before
     or has_table_privilege('authenticated', 'public.contracts', 'delete') is distinct from v_del_before then
    raise exception '0098 canary: הרשאות הכתיבה על contracts השתנו בתוך המיגרציה — היא אינה אמורה לגעת בהן';
  end if;

  -- RLS דלוק וה-policy של 0002 במקומו. העמודה החדשה מוגנת על ידו ולא
  -- בהרשאות עמודתיות, ולכן זו הבדיקה שמחזיקה את הכסף.
  if not exists (
    select 1 from pg_class where oid = 'public.contracts'::regclass and relrowsecurity
  ) then
    raise exception '0098 canary: RLS כבוי על contracts';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'contracts' and policyname = 'contracts_view'
  ) then
    raise exception '0098 canary: ה-policy contracts_view אינו קיים — included_episodes אינה מוגנת';
  end if;

  -- ה-CHECK קיים ובאמת נקשר לטבלה הזו
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contracts'::regclass
      and contype = 'c' and conname = 'contracts_included_episodes_chk'
  ) then
    raise exception '0098 canary: אילוץ contracts_included_episodes_chk אינו קיים';
  end if;

  -- ה-CHECK של הסטטוס מ-0002 עדיין שם. עמודה חדשה אינה עילה לאבד אילוץ
  -- קיים, וספירה של "האילוץ שלי קיים" לבדה לא הייתה מגלה שאחר נעלם.
  -- נבדק לפי ההגדרה ולא לפי שם: 0002 לא נקבה בשם ו-Postgres בחר אותו.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.contracts'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%active%'
      and pg_get_constraintdef(oid) like '%closed%'
  ) then
    raise exception '0098 canary: אילוץ הסטטוס של 0002 (active/closed) אינו קיים יותר על contracts';
  end if;

  -- העמודה nullable ובלי DEFAULT. "לא חובה" היא ההכרעה; DEFAULT היה יוצר
  -- ייצוג שני למצב "חוזה רגיל".
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts'
      and column_name = 'included_episodes'
      and (is_nullable = 'NO' or column_default is not null or data_type <> 'integer')
  ) then
    raise exception '0098 canary: included_episodes אינה integer nullable בלי DEFAULT';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts';
  if v_n_cols <> 10 then
    raise exception '0098 canary: ל-contracts אמורות להיות 10 עמודות (9 + included_episodes), נמצאו %', v_n_cols;
  end if;

  -- אף שורה קיימת לא נגעה. `add column` בלי DEFAULT אינו כותב מחדש את
  -- הטבלה, וכל חוזה קיים מקבל null — שהוא בדיוק "חוזה רגיל לפי אבני דרך".
  select count(*) into v_rows from public.contracts;
  if exists (select 1 from public.contracts where included_episodes is not null) then
    raise exception '0098 canary: יש חוזה עם included_episodes לא-null מיד אחרי יצירת העמודה — משהו כתב, וזו מיגרציית סכימה בלבד';
  end if;

  -- ── 5. שורת הפנקס ──────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0098', now(), 'bnaya',
    'מכסת פרקים לחוזה — עמודה אחת, contracts.included_episodes, integer nullable, CHECK null או 1..500. אפס שינוי התנהגות: שום קוד עדיין לא קורא ולא כותב אותה, אין backfill, ואף שורה קיימת לא נגעה — כל חוזה קיים מקבל null, שהוא בדיוק המשמעות "חוזה רגיל לפי אבני דרך". '
    'הכרעות הבעלים (4.10): לחוזה אפשר להגדיר מספר פרקים בחבילה, לא חובה, וריק = חוזה רגיל ללא שינוי; ניצול = הפקה עם contract_id של החוזה שהסטטוס שלה הוקלט ומעלה (hasBeenPerformed) ושאינה מבוטלת או ממוזגת — ספירה ולא עמודת מונה; מעבר למכסה הוא התראה בלבד ואינו חוסם הקלטה ואינו מנפיק מסמך; בלי תוקף, end_date לא משתנה. המקרה הראשון: חוזה "ey 2026 -2027 חצי ראשון 041026", 6 פרקים. '
    'אין עמודת מונה וזה העיקר: productions.contract_id כבר נכתב ביצירת ההפקה (calendar/sync:325, productions:155), ולכן המונה קיים בנתונים מהיום הראשון גם לחוזים שכבר יש, והחסר היחיד הוא המכנה. עמודת מונה הייתה דורשת נתיב כתיבה בכל מעבר סטטוס, ביטול, מיזוג ופיצול — ארבעה מקומות שיכולים להיפרד מהמציאות, ומונה שנפרד מהמציאות על מסך כספים הוא בדיוק מה ש-0085 נדרשה לתקן. ספירה אינה יכולה להיפרד. '
    'על contracts ולא על contract_milestones: אבן הדרך היא החשבונית והמכסה היא העסקה, ו-contracts_one_active_per_show (0056) מבטיח חוזה פעיל אחד לתוכנית — כך שלשאלה כמה נשארו יש תשובה אחת ולא אחת לכל אבן דרך. '
    'גבול 500 שפוי ולא מדיד, באותו שיקול של 120 התווים ב-0097. מה שהוא קונה מוגדר: הוא תופס החלקה של סדר גודל בשלוש ספרות (6 שהוקלד 600 נדחה) ואינו תופס החלקה בספרה אחת (60 עובר) — שום CHECK אינו יכול, והמסך שיציג "נוצלו 0 מתוך 60" הוא מה שיתפוס. 0 נדחה במכוון: למצב "חוזה רגיל" יש כבר ייצוג אחד, null, ושני ייצוגים לאותו מצב היו מחייבים כל קורא עתידי לבדוק את שניהם לנצח — אותו שיקול שבגללו 0097 דחתה מחרוזת ריקה. אין DEFAULT מאותה סיבה. '
    'ממצא ההרשאות, והוא הופכי ללקח של 0097: אין בשום מיגרציה grant או revoke שנוקב ב-contracts (נסרקו 97 קבצים). 0068 קובע את הבסיס — anon נשלל מכל טבלה ב-public (0068:180) ו-authenticated נותר עם arwd ברמת הטבלה על כל טבלה שלא צומצמה במפורש (shows, production_addons, productions, misc_productions, client_review_transcripts, booking_links, booking_requests). contracts אינה ביניהן, ולכן — כפי שפנקס 0077 מנסח את המנגנון — כל עוד authenticated=r יושב ב-relacl, has_column_privilege מחזירה true על כל עמודה, ועמודה חדשה נולדת קריאה. grant select (included_episodes) היה אפוא הצהרה שעוברת נקייה ולא עושה דבר, בדיוק הפיתוי שפנקס 0077 מזהיר מפניו לגבי revoke select (job_id). לכן הקובץ מודד את הבסיס ומעניק גרנט עמודתי רק אם הגרנט ברמת הטבלה חסר, ובשני הענפים ה-canary דורש קריאוּת בפועל. הכסף על contracts מוגן ב-RLS (contracts_view = can_view_money, 0002:358) ולא בהרשאות עמודתיות, ו-included_episodes יורשת את אותה הגנה — נכון, כי מי שרואה את total_amount רואה גם מכמה פרקים הוא מורכב. canary הכתיבה דורש זהות מול מצב שנמדד לפני ולא אפס-כתיבה, כי ל-authenticated יש arwd על הטבלה הזו כחוק. '
    'מעבר להיקף שאושר ובכוונה, בתקדים 0056 שצירפה את show_id מאותו נימוק: included_episodes צורפה ל-guard_contract_money_columns, כי היא מכריעה מתי ההכנסה מהחוזה נפסקת וזו הגדרה כספית באותו דרג כמו total_amount. זו חגורה ולא אבזם — contracts_update ב-RLS כבר דורש can_edit_money לכל עדכון (0002:360) — והיא מה שימשיך לעמוד אם ה-policy ישתנה. הגארד אינו חוסם עדכון מה-SQL Editor, כי can_edit_money קוראת auth.uid() שהוא null בסשן שאינו של אפליקציה ו-if not null אינו אמת; זו ההתנהגות של 0010 מאז ומתמיד. זו הכתיבה השלישית של הגוף (0010 אל 0056 אל כאן) ולכן יש שומר טביעה שדורש שהגוף הנוכחי יזכיר את שלוש העמודות של 0056 ולא יזכיר את החדשה, לפני שהוא מוחלף — הדפוס של 0077 מול create or replace ששותק לגבי מה שהרס. ההודעה הורחבה לארבע עמודות, כי הודעה שלא מזכירה את המכסה הייתה שולחת את מי שנחסם לחפש סכום שלא נגע בו. '
    'מחוץ להיקף במכוון: אין תוקף ואין נגיעה ב-end_date (הכרעת בעלים). אין אימות total_amount = included_episodes × מחיר, כי במצב לפי-חוזה shows.default_rate נמחק ואין מאיפה לגזור מחיר לפרק — שאלה פתוחה שמדווחת ולא נסגרת. אין אינדקס: הקריאה היחידה היא חוזה בודד לפי מפתח ראשי או לפי show_id שיש לו אינדקס מ-0056, ואינדקס על עמודה שרוב שורותיה null בטבלה של שלוש שורות הוא עלות בלי קונה. אין התראת-מעבר-למכסה, אין מונה במגירה ואין שום קריאה בקוד — כולם שלב נפרד. אפס DELETE, אפס שינוי נתונים, אפס טבלה חדשה, אפס נגיעה בעמודה קיימת.');

  raise notice '✅ 0098: contracts.included_episodes נוספה (% עמודות בסך הכל, % חוזים בטבלה, גרנט עמודתי: %). זכור לייצר מחדש את database.types.ts.',
    v_n_cols, v_rows, case when v_granted then 'הונפק' else 'לא נדרש' end;
end $mig$;
