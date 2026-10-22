-- ============================================================================
-- 0122 — הסרת גרסת ביקורת + רישום צפיות (22.10, הכרעת בעלים)
--
-- ⚠️ להריץ את supabase/verify/0122_dryrun.sql לפני, ואת 0122_verify.sql אחרי.
--    כלל 50: קובצי האימות אינם יושבים בתיקיית המיגרציות.
--
-- למה: ב"המניפה" 14.10 פרק 6 נשלח קובץ של ריל לשדה הפרק ונשמר כ"פרק מלא v2"
-- (8a48befa, 21.10). אין היום דרך להוציא גרסה מתצוגת הלקוח בלי למחוק אותה,
-- ומחיקה אסורה: הערות ואישורים מצביעים על גרסאות ב-ON DELETE RESTRICT, וזו
-- ההיסטוריה של הביקורת.
--
-- 1. client_review_versions — שלוש עמודות, "הוסרה":
--      withdrawn_at      מתי
--      withdrawn_by      מי (profiles; null רק כשמיגרציה/סקריפט עשו זאת)
--      withdrawn_reason  למה — חובה, 3–500 תווים אחרי trim
--    CHECK: שלושתן יחד — withdrawn_at וה-reason ריקים יחד או מלאים יחד.
--    השורה נשארת: מספרה לא חוזר לשימוש (assign_review_version_number לוקחת
--    max על כל שורות הפריט, כולל מוסרות — 0114), והערות/אישורים עליה נשמרים.
--    מה הלקוח רואה — בקוד (clientVersions.ts): גרסה מוסרת אינה מוצגת.
--
-- 2. client_review_version_views — כל פתיחה של גרסה בדף הלקוח: הגרסה, הפריט,
--    הקישור, הזמן. **אין שום מידע מזהה על הצופה** (לא IP, לא דפדפן, לא שם).
--    RLS דלוק ואפס policies — כמו client_review_items: רק service_role, דרך
--    השרת. מחיקת גרסה (שאינה קורית) מוחקת את הצפיות שלה (cascade): זו
--    טלמטריה, לא היסטוריה.
--
-- כלל 49 — השפעת ACL, מוצהרת: נוצרת טבלה אחת (client_review_version_views)
-- ורצף אחד שלה. REVOKE ALL מפורש מ-public, anon ו-authenticated על הטבלה
-- ועל הרצף, ו-GRANT ל-service_role בלבד (select/insert; usage על הרצף) — הדפוס
-- של 0120. העמודות החדשות ב-client_review_versions יורשות את הגרנטים
-- של הטבלה (service_role בלבד היום; 0114).
--
-- אפס DELETE · אפס UPDATE על נתונים · שורות חדשות: האירוע ושורת הפנקס בלבד.
-- ============================================================================

do $m$
declare
  v_versions bigint;
begin
  -- ════ BODY START ════
  -- ═══ 0. guards ═══
  if exists (select 1 from public.schema_ledger where version = '0122') then
    raise exception '0122 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0121') then
    raise exception '0122: 0121 טרם הוחלה — הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0122: 0069 טרם הוחלה — בלעדיה כל טבלה חדשה נולדת קריאה ל-anon';
  end if;
  if to_regclass('public.client_review_versions') is null or to_regclass('public.client_review_links') is null then
    raise exception '0122: client_review_versions / client_review_links אינן קיימות — עצור וברר';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'client_review_versions'
                and column_name in ('withdrawn_at', 'withdrawn_by', 'withdrawn_reason')) then
    raise exception '0122: עמודות ההסרה כבר קיימות — נוצרו מחוץ לפנקס';
  end if;
  if to_regclass('public.client_review_version_views') is not null then
    raise exception '0122: client_review_version_views כבר קיימת — נוצרה מחוץ לפנקס';
  end if;

  select count(*) into v_versions from public.client_review_versions;

  -- ═══ 1. "הוסרה" ═══
  alter table public.client_review_versions
    add column withdrawn_at     timestamptz,
    add column withdrawn_by     uuid references public.profiles(id),
    add column withdrawn_reason text;
  alter table public.client_review_versions
    add constraint crv_withdrawn_chk check (
      (withdrawn_at is null and withdrawn_reason is null and withdrawn_by is null)
      or
      (withdrawn_at is not null and withdrawn_reason is not null
         and char_length(btrim(withdrawn_reason)) between 3 and 500)
    );
  comment on column public.client_review_versions.withdrawn_at is
    '0122: הגרסה הוסרה מתצוגת הלקוח (נשלחה בטעות). השורה, מספרה, הערותיה ואישוריה נשמרים.';

  -- ═══ 2. צפיות ═══
  create table public.client_review_version_views (
    id         bigint generated always as identity primary key,
    version_id uuid not null references public.client_review_versions(id) on delete cascade,
    item_id    uuid not null references public.client_review_items(id) on delete cascade,
    link_id    uuid references public.client_review_links(id) on delete set null,
    viewed_at  timestamptz not null default now()
  );
  create index crvv_version_viewed_idx on public.client_review_version_views (version_id, viewed_at desc);
  create index crvv_item_viewed_idx on public.client_review_version_views (item_id, viewed_at desc);
  alter table public.client_review_version_views enable row level security;
  revoke all on table public.client_review_version_views from public, anon, authenticated;
  revoke all on sequence public.client_review_version_views_id_seq from public, anon, authenticated;
  grant select, insert on table public.client_review_version_views to service_role;
  grant usage, select on sequence public.client_review_version_views_id_seq to service_role;
  comment on table public.client_review_version_views is
    '0122: פתיחת גרסה בדף הלקוח — גרסה, פריט, קישור, זמן. אין מידע מזהה על הצופה. RLS ללא policies: service_role בלבד.';

  -- ═══ 3. שערים ═══
  if (select count(*) from public.client_review_versions) <> v_versions then
    raise exception '0122 עצרה: מספר הגרסאות השתנה';
  end if;
  if exists (select 1 from public.client_review_versions where withdrawn_at is not null) then
    raise exception '0122 עצרה: גרסה סומנה כמוסרת בתוך המיגרציה';
  end if;
  if has_table_privilege('anon', 'public.client_review_version_views', 'select')
     or has_table_privilege('authenticated', 'public.client_review_version_views', 'select')
     or has_table_privilege('anon', 'public.client_review_version_views', 'insert')
     or has_table_privilege('authenticated', 'public.client_review_version_views', 'insert') then
    raise exception '0122 עצרה: anon/authenticated קיבלו גישה לטבלת הצפיות';
  end if;
  if not has_table_privilege('service_role', 'public.client_review_version_views', 'insert') then
    raise exception '0122 עצרה: service_role אינו יכול לכתוב צפייה';
  end if;

  -- ═══ 4. שובל ═══
  -- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('schema', '00000000-0000-0000-0000-000000000000', 'review_withdraw_and_views_added', null,
          jsonb_build_object('migration', '0122',
                             'columns', jsonb_build_array('withdrawn_at', 'withdrawn_by', 'withdrawn_reason'),
                             'table', 'client_review_version_views',
                             'versions_touched', 0,
                             'source', 'owner decision 2026-10-22 (המניפה ep6)'));

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0122', now(), 'bnaya',
          'הסרת גרסת ביקורת (withdrawn_at/by/reason + CHECK crv_withdrawn_chk; השורה ומספרה נשמרים, דף הלקוח מדלג עליה בקוד) + client_review_version_views (פתיחות בדף הלקוח, בלי מידע מזהה; RLS ללא policies, REVOKE מ-anon/authenticated). כלל 49: טבלה ורצף חדשים, service_role בלבד. אפס DELETE/UPDATE על נתונים. הרצה מדומה: supabase/verify/0122_dryrun.sql; אימות: supabase/verify/0122_verify.sql.');
  -- ════ BODY END ════
end $m$;
