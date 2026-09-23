-- ============================================================================
-- 0097 — אימות. להריץ **אחרי** קובץ המיגרציה.
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
-- בדיוק — 11 עמודות מ-0096 ועוד `guest` = 12.
-- ============================================================================

with
col as (
  select count(*) as n_exists,
         count(*) filter (where is_nullable = 'YES')                      as n_nullable,
         count(*) filter (where data_type = 'text')                       as n_text,
         count(*) filter (where column_default is null)                   as n_no_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests' and column_name = 'guest'
),
cols_all as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests'
),
-- ה-CHECK של 0097, בשמו. ספירה גורפת של contype='c' הייתה סופרת גם את
-- NOT NULL בכמה גרסאות ומשתנה ביניהן — אותו שיקול כמו ב-0096.
chk as (
  select count(*) as n, coalesce(max(pg_get_constraintdef(oid)), '') as def
  from pg_constraint
  where conrelid = 'public.booking_requests'::regclass
    and contype = 'c' and conname = 'booking_requests_guest_len_chk'
),
-- חמשת ה-CHECK-ים של 0096 עדיין שם. עמודה חדשה אינה עילה לאבד אילוץ קיים,
-- וספירה של "האילוץ שלי קיים" לבדה לא הייתה מגלה שמשהו אחר נעלם.
chk_0096 as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.booking_requests'::regclass and contype = 'c'
    and conname in ('booking_requests_status_chk','booking_requests_studio_chk',
                    'booking_requests_range_chk','booking_requests_note_len_chk',
                    'booking_requests_decided_chk')
),
grants as (
  select
    has_column_privilege('authenticated','public.booking_requests','guest','select')  as auth_guest,
    has_column_privilege('authenticated','public.booking_requests','status','select') as auth_status,
    has_column_privilege('anon','public.booking_requests','guest','select')           as anon_guest,
    has_table_privilege ('anon','public.booking_requests','select')                   as anon_table,
    has_table_privilege ('authenticated','public.booking_requests','insert')          as auth_ins,
    has_table_privilege ('authenticated','public.booking_requests','update')          as auth_upd,
    has_table_privilege ('authenticated','public.booking_requests','delete')          as auth_del
),
led as (select count(*) as n from public.schema_ledger where version = '0097'),
led96 as (select count(*) as n from public.schema_ledger where version = '0096'),
-- אף שורה קיימת לא נגעה: מיגרציית סכימה בלבד, ושום קוד עדיין לא כותב לעמודה.
filled as (select count(*) as n from public.booking_requests where guest is not null)

select
  -- ── העמודה ────────────────────────────────────────────────────────────────
  (select n_exists     from col)     = 1  as t01_guest_column_exists,
  (select n_nullable   from col)     = 1  as t02_guest_is_nullable,
  (select n_text       from col)     = 1  as t03_guest_is_text,
  (select n_no_default from col)     = 1  as t04_guest_has_no_default,
  (select n from cols_all)           = 12 as t05_requests_has_12_cols,
  -- ── ה-CHECK ───────────────────────────────────────────────────────────────
  (select n from chk)                = 1  as t06_guest_check_exists,
  -- ⚠️ נבדק על הגדרת ה-CHECK עצמה ולא על ספירה: אילוץ בשם הנכון שכתוב בו
  -- 1200 היה נספר כקיים. הליטרלים הם מה שהמסד באמת אוכף.
  (select def from chk) like '%120%'      as t07_check_names_120,
  (select def from chk) like '%char_length%' as t08_check_uses_char_length,
  (select def from chk) not like '%octet_length%' as t09_check_not_in_bytes,
  (select n from chk_0096)           = 5  as t10_0096_five_checks_intact,
  -- ── הרשאות ────────────────────────────────────────────────────────────────
  -- 🔴 t11 הוא לב הקובץ: גרנט עמודתי קיים אינו מתרחב לעמודה חדשה, ובלי
  --    הגרנט המפורש של 0097 העמודה הייתה בלתי קריאה מכל סשן מחובר.
  (select auth_guest  from grants)   = true  as t11_auth_can_read_guest,
  (select auth_status from grants)   = true  as t12_auth_still_reads_status,
  (select anon_guest  from grants)   = false as t13_anon_cannot_read_guest,
  (select anon_table  from grants)   = false as t14_anon_no_table_select,
  (select auth_ins    from grants)   = false as t15_auth_cannot_insert,
  (select auth_upd    from grants)   = false as t16_auth_cannot_update,
  (select auth_del    from grants)   = false as t17_auth_cannot_delete,
  -- ── פנקס ונתונים ──────────────────────────────────────────────────────────
  (select n from led)                = 1  as t18_ledger_0097_exists,
  (select n from led96)              = 1  as t19_ledger_0096_still_there,
  (select n from filled)             = 0  as t20_no_row_carries_a_guest_yet;
