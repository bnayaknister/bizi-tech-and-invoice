-- ============================================================================
-- 0122 — אימות. להריץ **אחרי** קובץ המיגרציה. קריאה בלבד.
-- כל שורה צריכה לצאת ok = true.
-- ============================================================================
select '1. הפנקס: 0122 רשומה' as check_name,
       exists (select 1 from public.schema_ledger where version = '0122') as ok
union all
select '2. שלוש עמודות ההסרה ב-client_review_versions',
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'client_review_versions'
           and column_name in ('withdrawn_at', 'withdrawn_by', 'withdrawn_reason')) = 3
union all
select '3. CHECK crv_withdrawn_chk קיים',
       exists (select 1 from pg_constraint where conrelid = 'public.client_review_versions'::regclass
                and conname = 'crv_withdrawn_chk' and contype = 'c')
union all
select '4. אף גרסה לא סומנה כמוסרת על ידי המיגרציה',
       not exists (select 1 from public.client_review_versions where withdrawn_at is not null)
union all
select '5. client_review_version_views קיימת, RLS דלוק',
       coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.client_review_version_views')), false)
union all
select '6. …אפס policies',
       not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_review_version_views')
union all
select '7. …anon / authenticated בלי שום הרשאה',
       not (has_table_privilege('anon', 'public.client_review_version_views', 'select,insert,update,delete')
            or has_table_privilege('authenticated', 'public.client_review_version_views', 'select,insert,update,delete'))
union all
select '8. …service_role כותב וקורא',
       has_table_privilege('service_role', 'public.client_review_version_views', 'insert')
       and has_table_privilege('service_role', 'public.client_review_version_views', 'select')
union all
select '9. אירוע review_withdraw_and_views_added — פעם אחת',
       (select count(*) from public.events where event_type = 'review_withdraw_and_views_added') = 1;
