-- ============================================================================
-- 0098 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. **שאילתה אחת בלבד בקובץ**, שורה אחת, וכל העמודות בוליאניות —
-- **כולן חייבות להיות true**.
--
-- ⚠️ שאילתה אחת ולא שתיים, במכוון: ה-SQL Editor מציג רק את תוצאת השאילתה
--    האחרונה בקובץ. ב-0096 ישב מצאי שני מתחת לשורת הבוליאנים, והוא זה
--    שהוצג — כלומר השורה שאמורה להיבדק נדחקה מהמסך. כאן אין מה לדחוק.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה.
--
-- ⚠️ כל ספירה היא `=` ולא `>=` (מלכודת 3 מההנדאוף, 22.9): המספרים ידועים
--    בדיוק — 9 עמודות ל-contracts לפני ועוד `included_episodes` = 10.
--
-- ⚠️ t07 נבדק על **הגדרת** ה-CHECK ולא על קיומו: אילוץ בשם הנכון שכתוב בו
--    5000 היה נספר כקיים. הליטרלים הם מה שהמסד באמת אוכף — הלקח של 0097:t07.
-- ============================================================================

with
col as (
  select count(*)                                                        as n_exists,
         count(*) filter (where is_nullable = 'YES')                     as n_nullable,
         count(*) filter (where data_type = 'integer')                   as n_integer,
         count(*) filter (where column_default is null)                  as n_no_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts'
    and column_name = 'included_episodes'
),
cols_all as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'contracts'
),
-- ה-CHECK של 0098, בשמו. ספירה גורפת של contype='c' הייתה סופרת גם את
-- NOT NULL בכמה גרסאות ומשתנה ביניהן — אותו שיקול כמו ב-0096 וב-0097.
chk as (
  select count(*) as n, coalesce(max(pg_get_constraintdef(oid)), '') as def
  from pg_constraint
  where conrelid = 'public.contracts'::regclass
    and contype = 'c' and conname = 'contracts_included_episodes_chk'
),
-- אילוץ הסטטוס של 0002 עדיין שם. עמודה חדשה אינה עילה לאבד אילוץ קיים,
-- וספירה של "האילוץ שלי קיים" לבדה לא הייתה מגלה שאחר נעלם. לפי ההגדרה
-- ולא לפי שם: 0002 לא נקבה בשם ו-Postgres בחר אותו.
chk_status as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.contracts'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%active%'
    and pg_get_constraintdef(oid) like '%closed%'
),
-- האינדקס הייחודי החלקי של 0056. הוא מה שהופך את "כמה פרקים נשארו לתוכנית"
-- לשאלה עם תשובה אחת, ולכן הוא חלק מהחוזה של התכונה הזו ולא רקע.
idx_0056 as (
  select count(*) as n from pg_indexes
  where schemaname = 'public' and tablename = 'contracts'
    and indexname = 'contracts_one_active_per_show'
),
grants as (
  select
    has_column_privilege('authenticated','public.contracts','included_episodes','select') as auth_col,
    has_column_privilege('authenticated','public.contracts','total_amount','select')      as auth_total,
    has_column_privilege('anon','public.contracts','included_episodes','select')          as anon_col,
    has_table_privilege ('anon','public.contracts','select')                              as anon_tbl
),
rls as (
  select
    (select count(*) from pg_class
      where oid = 'public.contracts'::regclass and relrowsecurity)                        as n_rls,
    (select count(*) from pg_policies
      where schemaname = 'public' and tablename = 'contracts'
        and policyname in ('contracts_view','contracts_write','contracts_update','contracts_delete')) as n_pol
),
-- הגארד הכספי הורחב, והעמודה הרביעית בפנים. נבדק על גוף הפונקציה ולא על
-- קיומה: הפונקציה קיימת מ-0010 ושאלת האימות היא אם ההרחבה תפסה.
guard as (
  select count(*) as n from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname = 'public' and p.proname = 'guard_contract_money_columns'
    and pg_get_functiondef(p.oid) like '%included_episodes%'
    and pg_get_functiondef(p.oid) like '%total_amount%'
    and pg_get_functiondef(p.oid) like '%client_id%'
    and pg_get_functiondef(p.oid) like '%show_id%'
),
trg as (
  select count(*) as n from pg_trigger
  where tgrelid = 'public.contracts'::regclass
    and tgname = 'trg_guard_contract_money' and not tgisinternal
),
led  as (select count(*) as n from public.schema_ledger where version = '0098'),
led97 as (select count(*) as n from public.schema_ledger where version = '0097'),
-- אף חוזה לא קיבל מכסה: מיגרציית סכימה בלבד, ושום קוד עדיין לא כותב לעמודה.
-- 🔴 אחרי שהבעלים יזין 6 לחוזה EY — **t18 תהפוך ל-false, וזה נכון.**
--    להריץ את הקובץ הזה לפני ההזנה.
filled as (select count(*) as n from public.contracts where included_episodes is not null),
-- כל חוזה קיים הוא null, כלומר "חוזה רגיל לפי אבני דרך" — ואף אחד מהם לא
-- שינה התנהגות. זו האמירה המשלימה ל-t18 ולא כפל שלה: t18 סופרת כתיבות,
-- וזו סופרת שהמצב ההתחלתי נכון לכל השורות.
regular as (select count(*) as n from public.contracts where included_episodes is null),
total as (select count(*) as n from public.contracts)

select
  -- ── העמודה ────────────────────────────────────────────────────────────────
  (select n_exists     from col)      = 1     as t01_included_episodes_exists,
  (select n_nullable   from col)      = 1     as t02_is_nullable,
  (select n_integer    from col)      = 1     as t03_is_integer,
  (select n_no_default from col)      = 1     as t04_has_no_default,
  (select n from cols_all)            = 10    as t05_contracts_has_10_cols,
  -- ── ה-CHECK ───────────────────────────────────────────────────────────────
  (select n from chk)                 = 1     as t06_check_exists,
  (select def from chk) like '%500%'          as t07_check_names_500,
  -- `>= 1` ולא `1`: '%1%' היה מתקיים על כל הגדרה שבה מופיעה הספרה, כולל
  -- 500, ולא היה בודק דבר. Postgres מפרק BETWEEN ל-`>= 1 AND <= 500`,
  -- ולכן זו הצורה שבאמת כתובה בקטלוג — והיא מה שדוחה את 0.
  (select def from chk) like '%>= 1%'         as t08_check_lower_bound_is_one,
  (select def from chk) like '%included_episodes IS NULL%'
                                              as t09_check_allows_null_explicitly,
  (select n from chk_status)          = 1     as t10_status_check_0002_intact,
  (select n from idx_0056)            = 1     as t11_one_active_contract_per_show_intact,
  -- ── הרשאות ────────────────────────────────────────────────────────────────
  -- 🔴 t12 הוא לב הקובץ: בלי קשר לשאלה אם הגרנט בא ברמת הטבלה (הממצא) או
  --    עמודתית (הענף השני), העמודה **חייבת** להיות קריאה בפועל — אחרת
  --    המסך יציג מכסה ריקה בלי שגיאה, הכשל של 0055.
  (select auth_col   from grants)     = true  as t12_auth_can_read_quota,
  (select auth_total from grants)     = true  as t13_auth_still_reads_total_amount,
  (select anon_col   from grants)     = false as t14_anon_cannot_read_quota,
  (select anon_tbl   from grants)     = false as t15_anon_no_table_select,
  -- ── RLS: מה שמגן על הכסף כאן ──────────────────────────────────────────────
  (select n_rls from rls)             = 1     as t16_rls_enabled_on_contracts,
  (select n_pol from rls)             = 4     as t17_four_contract_policies_intact,
  -- ── הגארד הכספי ───────────────────────────────────────────────────────────
  (select n from guard)               = 1     as t18_money_guard_covers_quota,
  (select n from trg)                 = 1     as t19_guard_trigger_still_attached,
  -- ── פנקס ונתונים ──────────────────────────────────────────────────────────
  (select n from led)                 = 1     as t20_ledger_0098_exists,
  (select n from led97)               = 1     as t21_ledger_0097_still_there,
  (select n from filled)              = 0     as t22_no_contract_has_a_quota_yet,
  (select n from regular) = (select n from total)
                                              as t23_every_contract_reads_as_regular;
