-- ============================================================================
-- 0096 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. השורה הראשונה: עמודות בוליאניות, **כולן חייבות להיות true**.
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה.
--
-- ⚠️ כל ספירה כאן היא `=` ולא `>=` (מלכודת 3 מההנדאוף, 22.9: `tlv_still_there`
-- נכתב `>= 1` כשהמספר לא היה ידוע, והוא היה עובר גם אם 9 מתוך 10 השורות היו
-- נעלמות). המספרים כאן ידועים בדיוק, כי הטבלאות נוצרו בקובץ אחד:
--   booking_links     7 עמודות · 1 PK · 1 unique(token) · 1 unique חלקי · 1 index
--   booking_requests 11 עמודות · 5 CHECK-ים שלנו · 5 אינדקסים · 0/1 EXCLUDE
--
-- השורה השנייה (למטה) היא המצאי המלא לעין: כל CHECK עם ההגדרה שלו, כל
-- אינדקס, וכל גרנט — כדי שאפשר יהיה לראות בעיניים ולא רק לסמוך על true.
-- ============================================================================

with
-- ── קיום ─────────────────────────────────────────────────────────────────────
tabs as (
  select count(*) as n from information_schema.tables
  where table_schema = 'public' and table_name in ('booking_links','booking_requests')
),
cols_links as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_links'
),
cols_reqs as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests'
),
-- ── CHECK-ים ─────────────────────────────────────────────────────────────────
-- מסונן לשמות שלנו: PostgreSQL מוסיף CHECK ל-NOT NULL בכמה גרסאות, וספירה
-- גורפת של contype='c' הייתה מספר אותם ומשתנה בין גרסאות.
our_checks as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.booking_requests'::regclass and contype = 'c'
    and conname in ('booking_requests_status_chk','booking_requests_studio_chk',
                    'booking_requests_range_chk','booking_requests_note_len_chk',
                    'booking_requests_decided_chk')
),
studio_def as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conname = 'booking_requests_studio_chk'
),
-- ── EXCLUDE (אופציונלי לפי הכרעת הבעלים) ────────────────────────────────────
excl as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.booking_requests'::regclass and contype = 'x'
    and conname = 'booking_requests_no_overlap_approved'
),
gist as (select count(*) as n from pg_extension where extname = 'btree_gist'),
ledger_choice as (
  select coalesce((select note from public.schema_ledger where version = '0096'), '') as note
),
-- ── אינדקסים ────────────────────────────────────────────────────────────────
idx_links as (
  select count(*) as n from pg_indexes
  where schemaname = 'public' and tablename = 'booking_links'
    and indexname in ('booking_links_pkey','booking_links_token_key',
                      'booking_links_one_active_per_show','booking_links_show_idx')
),
idx_reqs as (
  select count(*) as n from pg_indexes
  where schemaname = 'public' and tablename = 'booking_requests'
    and indexname in ('booking_requests_pkey','booking_requests_show_idx',
                      'booking_requests_link_idx','booking_requests_pending_idx',
                      'booking_requests_approved_idx')
),
partial_is_partial as (
  select count(*) as n from pg_indexes
  where schemaname='public' and indexname='booking_links_one_active_per_show'
    and indexdef ilike '%where (revoked_at is null)%'
),
-- ── RLS ─────────────────────────────────────────────────────────────────────
rls as (
  select count(*) as n from pg_class
  where oid in ('public.booking_links'::regclass,'public.booking_requests'::regclass)
    and relrowsecurity
),
pols as (
  select count(*) as n from pg_policies
  where schemaname = 'public' and tablename in ('booking_links','booking_requests')
),
-- ── הרשאות ──────────────────────────────────────────────────────────────────
-- 🔴 העמודה הכי חשובה בקובץ הזה: token אינו קריא מאף סשן.
grants as (
  select
    has_table_privilege('anon','public.booking_links','select')            as anon_links,
    has_table_privilege('anon','public.booking_requests','select')         as anon_reqs,
    has_column_privilege('anon','public.booking_links','token','select')   as anon_token,
    has_column_privilege('authenticated','public.booking_links','token','select') as auth_token,
    has_column_privilege('authenticated','public.booking_links','show_id','select') as auth_show,
    has_column_privilege('authenticated','public.booking_requests','status','select') as auth_status,
    has_column_privilege('authenticated','public.booking_requests','note','select')   as auth_note,
    has_table_privilege('authenticated','public.booking_requests','insert') as auth_ins,
    has_table_privilege('authenticated','public.booking_requests','update') as auth_upd,
    has_table_privilege('authenticated','public.booking_requests','delete') as auth_del
),
-- ── הטבלאות נולדו ריקות ─────────────────────────────────────────────────────
rows_links as (select count(*) as n from public.booking_links),
rows_reqs  as (select count(*) as n from public.booking_requests),
led as (select count(*) as n from public.schema_ledger where version = '0096')

select
  -- קיום ומבנה — ספירות מדויקות
  (select n from tabs)        = 2   as t01_two_tables,
  (select n from cols_links)  = 7   as t02_links_has_7_cols,
  (select n from cols_reqs)   = 11  as t03_requests_has_11_cols,
  (select n from our_checks)  = 5   as t04_five_named_checks,
  -- שלושת החדרים, ו-TLV לא ביניהם. נבדק על הגדרת ה-CHECK עצמה, לא על ספירה.
  -- ⚠️ הליטרל במרכאות, לא תת-מחרוזת: '%גבעון%' היה עובר גם אם רק
  -- 'גבעון גדול' היה ב-CHECK ו'גבעון' עצמו נשמט. זו אותה מלכודת שהקובץ
  -- מזהיר ממנה בכותרת, בגרסתה הטקסטואלית.
  (select def from studio_def) like '%''גבעון''%'                          as t05_check_names_givon,
  (select def from studio_def) like '%''גבעון גדול''%'                     as t06_check_names_givon_gadol,
  (select def from studio_def) like '%''חשמונאים''%'                       as t07_check_names_hashmonaim,
  (select def from studio_def) not like '%TLV%'                            as t08_check_excludes_tlv,
  -- אינדקסים
  (select n from idx_links)   = 4   as t09_links_four_indexes,
  (select n from idx_reqs)    = 5   as t10_requests_five_indexes,
  (select n from partial_is_partial) = 1 as t11_active_link_index_is_partial,
  -- RLS
  (select n from rls)         = 2   as t12_rls_on_both,
  (select n from pols)        = 2   as t13_one_select_policy_each,
  -- הרשאות: anon אפס, token סגור, עמודות רגילות פתוחות, אפס כתיבה
  (select anon_links  from grants) = false as t14_anon_no_links,
  (select anon_reqs   from grants) = false as t15_anon_no_requests,
  (select anon_token  from grants) = false as t16_anon_no_token,
  (select auth_token  from grants) = false as t17_auth_cannot_read_token,
  (select auth_show   from grants) = true  as t18_auth_can_read_show_id,
  (select auth_status from grants) = true  as t19_auth_can_read_status,
  (select auth_note   from grants) = true  as t20_auth_can_read_note,
  (select auth_ins    from grants) = false as t21_auth_cannot_insert,
  (select auth_upd    from grants) = false as t22_auth_cannot_update,
  (select auth_del    from grants) = false as t23_auth_cannot_delete,
  -- נולדו ריקות
  (select n from rows_links)  = 0   as t24_links_empty,
  (select n from rows_reqs)   = 0   as t25_requests_empty,
  -- פנקס
  (select n from led)         = 1   as t26_ledger_row_exists,
  -- ⚠️ ההכרעה: האילוץ קיים אם ורק אם ההרחבה מותקנת. שתי האפשרויות תקינות,
  -- ומה שאסור הוא חצי-מצב — הרחבה בלי אילוץ, או אילוץ בלי הרחבה.
  ((select n from excl) = 1) = ((select n from gist) = 1) as t27_exclude_matches_extension,
  -- ולתיעוד, לא כמבחן: מה בפועל נבחר
  (select n from gist) = 1 as x_btree_gist_installed,
  (select n from excl) = 1 as x_exclude_constraint_present;

-- ── המצאי המלא, לעין ────────────────────────────────────────────────────────
-- 📌 הרץ גם את זה. t04 סופר חמישה CHECK-ים; זה מראה **מה** הם אומרים, וזו
-- השאלה שספירה אינה יכולה לענות עליה.
select 'check' as kind, conname as name, pg_get_constraintdef(oid) as detail
from pg_constraint where conrelid in ('public.booking_links'::regclass,'public.booking_requests'::regclass)
union all
select 'index', indexname, indexdef
from pg_indexes where schemaname='public' and tablename in ('booking_links','booking_requests')
union all
select 'policy', policyname, coalesce(qual,'-')
from pg_policies where schemaname='public' and tablename in ('booking_links','booking_requests')
union all
select 'grant', grantee || ' ' || privilege_type, table_name || '.' || coalesce(column_name,'*')
from information_schema.column_privileges
where table_schema='public' and table_name in ('booking_links','booking_requests')
union all
-- 📌 הסכימה של ההרחבה נמדדת ולא מונחת: לא המיגרציה ולא ההרצה המדומה נוקבות
-- ב-SCHEMA, ולכן ההרחבה נוחתת בסכימת היצירה המשתמעת מה-search_path. השורה
-- הזו אומרת איפה היא באמת. pgcrypto מוצגת לצידה כבסיס להשוואה — היא נוצרה
-- ב-0001 באותה צורה בדיוק, בלי SCHEMA, ולכן שתיהן אמורות לשבת באותו מקום.
select 'extension', e.extname || ' @ ' || n.nspname, e.extversion::text
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname in ('btree_gist','pgcrypto')
order by kind, name;
