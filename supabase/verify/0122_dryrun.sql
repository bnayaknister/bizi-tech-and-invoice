-- ============================================================================
-- 0122 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ומוחל בתוך
-- הטרנזקציה. אחר כך מוכחים, על נתונים אמיתיים ובתוך אותה טרנזקציה:
--   1. שלוש העמודות קיימות; הסרה בלי סיבה / עם סיבה קצרה — נדחית (CHECK)
--   2. הסרת גרסה אמיתית עוברת, ושורת הגרסה, ההערות והאישורים שלה נשארים
--   3. מספור: גרסה חדשה לאותו פריט מקבלת max+1 — המספר המוסר לא חוזר
--   4. טבלת הצפיות: RLS דלוק, אפס policies, anon/authenticated בלי גישה,
--      service_role כותב; שורת צפייה נכנסת
--   5. הפנקס והאירוע — פעם אחת
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL: אפס שינוי נשאר.
-- **גם הצלחה היא exception.** הצלחה:  ✅ 0122 DRY RUN OK — ...
-- Supabase SQL Editor / Management API אינם מציגים NOTICE — כל הדוח בהודעה.
-- ============================================================================
do $dry$
declare
  v_versions bigint;
  v_fail text := '';
  v_rep  text := '';
  v_ver  uuid;
  v_item uuid;
  v_max  int;
  v_new  uuid;
  v_num  int;
  v_n    bigint;
  v_c0   bigint;
  v_a0   bigint;
begin
  -- ════ גוף 0122, מילה במילה ════
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
  
  -- ════ המבחנים ════
  -- ── 1. העמודות וה-CHECK ──
  select v.id, v.item_id into v_ver, v_item
    from public.client_review_versions v
   where v.number is not null
   order by (v.id = '8a48befa-a5cd-4012-bb55-108ea63d7910') desc, v.created_at desc
   limit 1;
  if v_ver is null then
    raise exception '❌ 0122 DRY RUN: אין גרסה ממוספרת לבדוק עליה';
  end if;
  begin
    update public.client_review_versions set withdrawn_at = now() where id = v_ver;
    v_fail := v_fail || 'מבחן 1: הסרה בלי סיבה התקבלה. ';
  exception when check_violation then
    v_rep := v_rep || 'מבחן 1א — בלי סיבה: נדחה. | ';
  end;
  begin
    update public.client_review_versions set withdrawn_at = now(), withdrawn_reason = ' x ' where id = v_ver;
    v_fail := v_fail || 'מבחן 1: סיבה של תו אחד התקבלה. ';
  exception when check_violation then
    v_rep := v_rep || 'מבחן 1ב — סיבה קצרה: נדחה. | ';
  end;
  begin
    update public.client_review_versions set withdrawn_reason = 'סיבה בלי זמן' where id = v_ver;
    v_fail := v_fail || 'מבחן 1: סיבה בלי withdrawn_at התקבלה. ';
  exception when check_violation then
    v_rep := v_rep || 'מבחן 1ג — סיבה בלי זמן: נדחה. | ';
  end;

  -- ── 2. הסרה אמיתית ──
  select count(*) into v_c0 from public.client_review_comments where version_id = v_ver;
  select count(*) into v_a0 from public.client_review_approvals where version_id = v_ver;
  update public.client_review_versions
     set withdrawn_at = now(), withdrawn_reason = 'קובץ ריל שנשלח לשדה הפרק'
   where id = v_ver;
  if not exists (select 1 from public.client_review_versions where id = v_ver and withdrawn_at is not null and number is not null) then
    v_fail := v_fail || 'מבחן 2: ההסרה לא נרשמה / המספר נמחק. ';
  elsif (select count(*) from public.client_review_comments where version_id = v_ver) <> v_c0
     or (select count(*) from public.client_review_approvals where version_id = v_ver) <> v_a0 then
    v_fail := v_fail || 'מבחן 2: הערות/אישורים השתנו. ';
  else
    v_rep := v_rep || format('מבחן 2 — גרסה %s הוסרה; מספרה, %s הערות ו-%s אישורים נשארו. | ', v_ver, v_c0, v_a0);
  end if;

  -- ── 3. המספור לא דורס ──
  select max(number) into v_max from public.client_review_versions where item_id = v_item;
  insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
  values (v_item, 'bunny', 1, gen_random_uuid(), 'created')
  returning id into v_new;
  v_num := public.assign_review_version_number(v_new);
  if v_num <> v_max + 1 then
    v_fail := v_fail || format('מבחן 3: גרסה חדשה קיבלה %s (צ"ל %s). ', v_num, v_max + 1);
  else
    v_rep := v_rep || format('מבחן 3 — גרסה חדשה לפריט קיבלה %s (המקסימום כולל המוסרת: %s). | ', v_num, v_max);
  end if;

  -- ── 4. טבלת הצפיות ──
  if not (select relrowsecurity from pg_class where oid = 'public.client_review_version_views'::regclass) then
    v_fail := v_fail || 'מבחן 4: RLS כבוי. ';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_review_version_views') then
    v_fail := v_fail || 'מבחן 4: יש policy. ';
  end if;
  if has_table_privilege('anon', 'public.client_review_version_views', 'select')
     or has_table_privilege('authenticated', 'public.client_review_version_views', 'select')
     or has_table_privilege('anon', 'public.client_review_version_views', 'insert')
     or has_table_privilege('authenticated', 'public.client_review_version_views', 'insert')
     or not has_table_privilege('service_role', 'public.client_review_version_views', 'insert') then
    v_fail := v_fail || 'מבחן 4: הרשאות לא כמצופה. ';
  end if;
  insert into public.client_review_version_views (version_id, item_id) values (v_ver, v_item);
  select count(*) into v_n from public.client_review_version_views;
  if v_n <> 1 then v_fail := v_fail || format('מבחן 4: %s צפיות (צ"ל 1). ', v_n);
  else v_rep := v_rep || 'מבחן 4 — צפיות: RLS, אפס policies, anon/authenticated חסומים, service_role כותב, שורה נכנסה. | '; end if;

  -- ── 5. הפנקס והאירוע ──
  if (select count(*) from public.schema_ledger where version = '0122') <> 1
     or (select count(*) from public.events where event_type = 'review_withdraw_and_views_added') <> 1 then
    v_fail := v_fail || 'מבחן 5: פנקס/אירוע. ';
  else v_rep := v_rep || 'מבחן 5 — פנקס ואירוע: פעם אחת. | '; end if;

  if v_fail <> '' then
    raise exception '❌ 0122 DRY RUN FAILED — %', v_fail;
  end if;
  raise exception '✅ 0122 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
