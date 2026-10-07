-- ============================================================================
-- 0099 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. **שאילתה אחת בלבד בקובץ**, שורה אחת, כל העמודות בוליאניות —
-- כולן חייבות להיות true. `Success. No rows returned` אינו הוכחה לכלום כאן.
--
-- ⚠️ כל ספירה `=` ולא `>=`: 12 עמודות מ-0096+0097 ועוד חמש כאן = 17.
-- ============================================================================

with
cols as (
  select column_name, is_nullable, data_type, column_default
  from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests'
    and column_name in ('calendar_event_id','calendar_event_uid','calendar_write_status',
                         'calendar_write_error','production_id')
),
cols_all as (
  select count(*) as n from information_schema.columns
  where table_schema = 'public' and table_name = 'booking_requests'
),
chk as (
  select count(*) as n, coalesce(max(pg_get_constraintdef(oid)), '') as def
  from pg_constraint
  where conrelid = 'public.booking_requests'::regclass
    and contype = 'c' and conname = 'booking_requests_calendar_write_status_chk'
),
fk as (
  select count(*) as n, coalesce(max(pg_get_constraintdef(oid)), '') as def
  from pg_constraint
  where conrelid = 'public.booking_requests'::regclass
    and contype = 'f' and confrelid = 'public.productions'::regclass
    and conname like '%production_id%'
),
idx as (
  select count(*) as n, coalesce(max(indexdef), '') as def
  from pg_indexes
  where schemaname = 'public' and tablename = 'booking_requests'
    and indexname = 'booking_requests_production_id_key'
),
-- 0096's five CHECKs and 0097's guest CHECK — still there. A new column is
-- not grounds to lose an existing constraint.
chk_prior as (
  select count(*) as n from pg_constraint
  where conrelid = 'public.booking_requests'::regclass and contype = 'c'
    and conname in ('booking_requests_status_chk','booking_requests_studio_chk',
                    'booking_requests_range_chk','booking_requests_note_len_chk',
                    'booking_requests_decided_chk','booking_requests_guest_len_chk')
),
grants as (
  select
    has_column_privilege('authenticated','public.booking_requests','calendar_event_id','select')     as auth_eid,
    has_column_privilege('authenticated','public.booking_requests','calendar_event_uid','select')    as auth_uid,
    has_column_privilege('authenticated','public.booking_requests','calendar_write_status','select') as auth_status,
    has_column_privilege('authenticated','public.booking_requests','calendar_write_error','select')  as auth_error,
    has_column_privilege('authenticated','public.booking_requests','production_id','select')         as auth_prod,
    has_column_privilege('authenticated','public.booking_requests','guest','select')                 as auth_guest_still,
    has_column_privilege('anon','public.booking_requests','calendar_event_uid','select')              as anon_uid,
    has_column_privilege('anon','public.booking_requests','production_id','select')                   as anon_prod,
    has_table_privilege ('anon','public.booking_requests','select')                                    as anon_table,
    has_table_privilege ('authenticated','public.booking_requests','insert')                           as auth_ins,
    has_table_privilege ('authenticated','public.booking_requests','update')                           as auth_upd,
    has_table_privilege ('authenticated','public.booking_requests','delete')                           as auth_del
),
led as (select count(*) as n from public.schema_ledger where version = '0099'),
led97 as (select count(*) as n from public.schema_ledger where version = '0097'),
-- אף שורה קיימת לא נגעה
filled as (
  select count(*) as n from public.booking_requests
  where calendar_event_id is not null or calendar_event_uid is not null
     or calendar_write_status is not null or calendar_write_error is not null
     or production_id is not null
)

select
  -- ── חמש העמודות ───────────────────────────────────────────────────────────
  (select count(*) from cols)                                        = 5     as t01_all_five_columns_exist,
  (select count(*) from cols where is_nullable = 'YES')               = 5     as t02_all_five_nullable,
  (select count(*) from cols where column_default is null)            = 5     as t03_none_has_a_default,
  (select data_type from cols where column_name = 'production_id')    = 'uuid' as t04_production_id_is_uuid,
  (select n from cols_all)                                            = 17    as t05_requests_has_17_cols,
  -- ── ה-CHECK ───────────────────────────────────────────────────────────────
  (select n from chk)                                                 = 1     as t06_status_check_exists,
  (select def from chk) like '%created%' and (select def from chk) like '%failed%' as t07_check_names_both_values,
  (select n from chk_prior)                                           = 6     as t08_six_prior_checks_intact,
  -- ── ה-FK וה-אינדקס הייחודי ────────────────────────────────────────────────
  (select n from fk)                                                  = 1     as t09_production_fk_exists,
  (select def from fk) like '%ON DELETE SET NULL%'                            as t10_fk_is_set_null_not_cascade,
  (select n from idx)                                                 = 1     as t11_unique_partial_index_exists,
  (select def from idx) like '%WHERE%'                                        as t12_index_is_partial,
  -- ── הרשאות ────────────────────────────────────────────────────────────────
  (select auth_eid        from grants) = true  as t13_auth_reads_event_id,
  (select auth_uid        from grants) = true  as t14_auth_reads_event_uid,
  (select auth_status     from grants) = true  as t15_auth_reads_write_status,
  (select auth_error      from grants) = true  as t16_auth_reads_write_error,
  (select auth_prod       from grants) = true  as t17_auth_reads_production_id,
  (select auth_guest_still from grants) = true as t18_0097_grant_still_intact,
  (select anon_uid        from grants) = false as t19_anon_cannot_read_uid,
  (select anon_prod       from grants) = false as t20_anon_cannot_read_production_id,
  (select anon_table      from grants) = false as t21_anon_no_table_select,
  (select auth_ins        from grants) = false as t22_auth_cannot_insert,
  (select auth_upd        from grants) = false as t23_auth_cannot_update,
  (select auth_del        from grants) = false as t24_auth_cannot_delete,
  -- ── פנקס ונתונים ──────────────────────────────────────────────────────────
  (select n from led)                  = 1     as t25_ledger_0099_exists,
  (select n from led97)                = 1     as t26_ledger_0097_still_there,
  (select n from filled)               = 0     as t27_no_row_carries_a_value_yet;
