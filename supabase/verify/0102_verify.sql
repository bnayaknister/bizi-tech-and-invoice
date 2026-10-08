-- ============================================================================
-- 0102 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קריאה בלבד. שתים עשרה עמודות בוליאניות, **כולן חייבות להיות true**, ועוד
-- שלוש עמודות מידע.
--
-- `Success. No rows returned` אינו הוכחה לכלום כאן — יש שורה אחת, וצריך
-- להסתכל עליה.
--
-- ⚠️ מה הקובץ הזה **אינו** בודק: ששליחה אמיתית עובדת, שהטוקן תקף, ושעדכוני
--    המצב מגיעים. אלה אינם עובדות על המסד. את הצד הזה מוכיחה
--    `scripts/test_wa_send.ts` (טהורה, אפס מסד ואפס רשת), וההודעה הראשונה
--    שתעבור ל-`sent` עם `provider_wamid` היא ההוכחה מקצה לקצה.
-- ============================================================================

with
cols as (
  select
    count(*) filter (where column_name = 'provider_wamid') as provider_wamid,
    count(*) filter (where column_name = 'error')          as err,
    count(*) filter (where column_name = 'status_at')      as status_at,
    count(*)                                               as n_all
  from information_schema.columns
  where table_schema = 'public' and table_name = 'wa_messages'
),
wa_chk as (
  select pg_get_constraintdef(oid) as def
  from pg_constraint
  where conrelid = 'public.wa_messages'::regclass and conname = 'wa_messages_status_chk'
),
br_chk as (
  select pg_get_constraintdef(oid) as def
  from pg_constraint
  where conrelid = 'public.booking_requests'::regclass and conname = 'booking_requests_status_chk'
),
counts as (
  select
    (select count(*) from public.wa_messages)                                      as wa_rows,
    (select count(*) from public.wa_messages where direction = 'out')              as wa_out,
    (select count(*) from public.booking_requests where status = 'cancelled')      as cancelled_rows
)
select
  -- 0. הפנקס. בלעדיו המיגרציה רצה ולא נרשמה — הלקח של 0052.
  (exists (select 1 from public.schema_ledger where version = '0102'))              as ledger_row_present,

  -- 1. שלוש העמודות, ו-13 בסך הכול (10 מ-0101 + 3)
  (select provider_wamid from cols) = 1                                            as provider_wamid_col,
  (select err from cols) = 1                                                       as error_col,
  (select status_at from cols) = 1                                                  as status_at_col,
  (select n_all from cols) = 13                                                    as ncols_is_13,

  -- 🔴 2. האינדקס הייחודי החלקי. **הבדיקה שאין לה תחליף כאן.** עדכון מצב
  --    מ-Meta מותאם לשורה לפי provider_wamid; בלי ייחודיות, עדכון אחד יכול
  --    להתאים לשתי שורות ולדרוס את המצב של הודעה אחרת. והוא חייב להיות
  --    חלקי (`where ... is not null`), אחרת שתי שורות dry_run היו מתנגשות
  --    על NULL ואי אפשר היה לרשום שתי התראות יבשות.
  (exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'wa_messages'
      and indexname = 'wa_messages_provider_wamid_key'
  ))                                                                               as provider_wamid_unique_idx,
  (select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'wa_messages'
      and indexname = 'wa_messages_provider_wamid_key') like '%UNIQUE%'             as idx_is_unique,
  (select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'wa_messages'
      and indexname = 'wa_messages_provider_wamid_key') like '%IS NOT NULL%'        as idx_is_partial,

  -- 3. ה-CHECK של ההודעות מכיל את שני הערכים החדשים ולא איבד את הישנים
  ((select def from wa_chk) like '%delivered%'
    and (select def from wa_chk) like '%read%'
    and (select def from wa_chk) like '%received%'
    and (select def from wa_chk) like '%queued%'
    and (select def from wa_chk) like '%dry_run%')                                 as wa_status_chk_complete,

  -- 4. אילוץ הצימוד של 0101 שרד את ההחלפה (הוא על אותה עמודה)
  (exists (
    select 1 from pg_constraint
    where conrelid = 'public.wa_messages'::regclass
      and conname = 'wa_messages_direction_status_chk'
  ))                                                                               as pair_chk_survived,

  -- 5. cancelled נוסף, והשלושה הישנים נשארו
  ((select def from br_chk) like '%cancelled%'
    and (select def from br_chk) like '%pending%'
    and (select def from br_chk) like '%approved%'
    and (select def from br_chk) like '%declined%')                                as br_status_chk_complete,

  -- 🔴 6. אילוץ ה-EXCLUDE של 0096 חי. **זה מה שמשחרר את המשבצת בביטול**:
  --    הוא נושא `where (status = 'approved')`, ולכן שורה מבוטלת חדלה לחסום
  --    מעצמה. אם הוא נעלם, ביטול לא ישחרר כלום ושני אישורים יוכלו לחפוף.
  (exists (
    select 1 from pg_constraint where conname = 'booking_requests_no_overlap_approved'
  ))                                                                               as exclude_constraint_alive,

  -- 7. ההרשאות של 0101 נשארו במלואן — עמודה חדשה לא פתחה דלת
  (not has_table_privilege('anon', 'public.wa_messages', 'select')
    and not has_table_privilege('authenticated', 'public.wa_messages', 'select')
    and not has_column_privilege('authenticated', 'public.wa_messages', 'provider_wamid', 'select')
    and (select count(*) from pg_policies
          where schemaname = 'public' and tablename = 'wa_messages') = 0)          as no_session_privileges,

  -- ── עמודות מידע, לא בדיקות ──────────────────────────────────────────────
  (select wa_rows from counts)        as nrows_wa,
  (select wa_out from counts)         as nrows_wa_outbound,
  (select cancelled_rows from counts) as nrows_cancelled;
