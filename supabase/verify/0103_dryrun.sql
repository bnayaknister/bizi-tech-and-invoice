-- ============================================================================
-- 0103 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא יוצר את `booking_contacts` באמת, כותב שורות אמיתיות, מוכיח כל אילוץ
-- ואת שתי הייחודיות (ואת מה שבמפורש **אינו** ייחודי), מאמת את ההרשאות,
-- ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- הדוח נאסף ב-`v_rep` ונשלח **בתוך** ה-exception, גם בהצלחה וגם בכשל.
-- ההודעה המסכמת נבנית ב-`v_msg` עם `||` ועם `E'\n'` מפורש בכל מקטע ועוברת
-- כארגומנט — אין המשך ליטרלים בכלל (הלקח של 0100_dryrun, 8.10). כל מספר
-- מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט עברי.
--
-- ⚠️ למה לבצע-ואז-לגלגל ולא רק לבדוק: CHECK שלא נוסה אינו מוכיח שהוא תופס,
--    ואינדקס ייחודי שלא הופר אינו מוכיח שהוא קיים. זו המוסכמה של
--    0098/0100/0101, מאותו נימוק.
-- ============================================================================

do $dry$
declare
  v_rep text := '';
  v_msg text;
  v_n_cols     int := -1;
  v_n_rows     int := -1;
  v_caught     int := 0;
  v_expected   int := 6;
  v_rls        boolean;
  v_anon_sel   boolean;
  v_auth_sel   boolean;
  v_auth_ins   boolean;
  v_n_policies int := -1;
  v_show_a     uuid;
  v_show_b     uuid;
  v_n_shows    int;
  v_lookup     int;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'booking_contacts'
  ) then
    raise exception 'booking_contacts כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0103 כבר הוחלה, הרץ את 0103_verify.sql';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0103') then
    raise exception '0103 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;

  -- שתי תוכניות אמיתיות, כדי שה-FK יהיה אמיתי ושאפשר יהיה להוכיח את
  -- "אותו מספר לכמה פודקאסטים".
  select count(*) into v_n_shows from public.shows;
  select id into v_show_a from public.shows order by created_at limit 1;
  select id into v_show_b from public.shows where id <> v_show_a order by created_at limit 1;
  v_rep := v_rep || E'\n  shows available: nshows=' || v_n_shows::text || ' expected>=2';
  if v_show_a is null or v_show_b is null then
    raise exception 'צריך לפחות שתי תוכניות כדי להוכיח את הייחודיות: nshows=%', v_n_shows;
  end if;

  begin
    -- ── 1. היצירה, מילה במילה כמו ב-0103 ──────────────────────────────────
    create table public.booking_contacts (
      id          uuid primary key default gen_random_uuid(),
      show_id     uuid not null references public.shows(id) on delete cascade,
      name        text not null,
      wa_id       text not null,
      created_at  timestamptz not null default now(),
      created_by  uuid references public.profiles(id),

      constraint booking_contacts_name_len_chk
        check (char_length(btrim(name)) between 1 and 120),
      constraint booking_contacts_wa_id_chk
        check (wa_id ~ '^[0-9]{7,15}$')
    );

    create unique index booking_contacts_show_wa_key on public.booking_contacts (show_id, wa_id);
    create index booking_contacts_wa_id_idx on public.booking_contacts (wa_id);
    create index booking_contacts_show_idx  on public.booking_contacts (show_id);

    alter table public.booking_contacts enable row level security;
    revoke all privileges on public.booking_contacts from public, anon, authenticated;

    select count(*) into v_n_cols from information_schema.columns
      where table_schema = 'public' and table_name = 'booking_contacts';
    v_rep := v_rep || E'\n  table created: ncols=' || v_n_cols::text || ' expected=6';

    -- ── 2. השורות שחייבות לעבור ───────────────────────────────────────────
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'דנה לוי', '972501234567');
    -- כמה אנשים לאותו פודקאסט (הכרעת בעלים)
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'יובל כהן', '972521111111');
    -- 🔴 ואותו מספר לפודקאסט אחר — זה מה שמייצר את הודעת הרשימה, ולכן
    --    ה-unique הוא על הצמד ולא על המספר לבדו.
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_b, 'דנה לוי', '972501234567');
    -- מספר זר, באורך E.164 אחר
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_b, 'אורח מחו״ל', '447911123456');
    -- הגבולות: 7 ספרות ו-15 ספרות
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'גבול תחתון', '1234567');
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'גבול עליון', '123456789012345');
    -- שם באורך המקסימום בדיוק
    insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, repeat('א', 120), '972539999999');

    select count(*) into v_n_rows from public.booking_contacts;
    v_rep := v_rep || E'\n  rows accepted: nrows=' || v_n_rows::text || ' expected=7';
    if v_n_rows <> 7 then
      raise exception 'לא כל השורות החוקיות התקבלו: nrows=% expected=7', v_n_rows;
    end if;

    -- 🔴 3. השאילתה שה-webhook שואל: מספר אחד -> שתי תוכניות
    select count(*) into v_lookup from public.booking_contacts where wa_id = '972501234567';
    v_rep := v_rep || E'\n  one number maps to shows: nshows=' || v_lookup::text || ' expected=2';
    if v_lookup <> 2 then
      raise exception 'מספר שמשויך לשתי תוכניות לא נמצא פעמיים: nfound=%', v_lookup;
    end if;

    -- ── 4. מה שחייב להידחות ───────────────────────────────────────────────
    -- אותו אדם פעמיים לאותה תוכנית
    begin
      insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'דנה שוב', '972501234567');
      raise exception 'אותו מספר התקבל פעמיים לאותה תוכנית';
    exception when unique_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught unique (show_id, wa_id): caught=1';
    end;

    -- מספר עם פלוס — מאומת ולא מנוקה
    begin
      insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'עם פלוס', '+972501234567');
      raise exception 'מספר עם + התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id with plus: caught=1';
    end;

    -- מספר עם מקף
    begin
      insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'עם מקף', '050-1234567');
      raise exception 'מספר עם מקף התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id with dash: caught=1';
    end;

    -- קצר מדי (6 ספרות)
    begin
      insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, 'קצר', '123456');
      raise exception 'מספר באורך 6 התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id too short: caught=1';
    end;

    -- שם ריק / רווחים בלבד — btrim הוא מה שתופס את השני
    begin
      insert into public.booking_contacts (show_id, name, wa_id) values (v_show_a, '   ', '972531111111');
      raise exception 'שם של רווחים בלבד התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught blank name (btrim): caught=1';
    end;

    -- תוכנית שאינה קיימת — ה-FK
    begin
      insert into public.booking_contacts (show_id, name, wa_id)
      values ('00000000-0000-0000-0000-000000000000', 'רפאים', '972541111111');
      raise exception 'שורה לתוכנית שאינה קיימת התקבלה';
    exception when foreign_key_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught FK on show_id: caught=1';
    end;

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 5. הרשאות ו-RLS ───────────────────────────────────────────────────
    select relrowsecurity into v_rls from pg_class where oid = 'public.booking_contacts'::regclass;
    v_anon_sel := has_table_privilege('anon',          'public.booking_contacts', 'select');
    v_auth_sel := has_table_privilege('authenticated', 'public.booking_contacts', 'select');
    v_auth_ins := has_table_privilege('authenticated', 'public.booking_contacts', 'insert');
    select count(*) into v_n_policies from pg_policies
      where schemaname = 'public' and tablename = 'booking_contacts';

    v_rep := v_rep || E'\n  rls_enabled=' || v_rls::text || ' expected=true';
    v_rep := v_rep || E'\n  anon_select=' || v_anon_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select=' || v_auth_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_insert=' || v_auth_ins::text || ' expected=false';
    v_rep := v_rep || E'\n  npolicies=' || v_n_policies::text || ' expected=0';

    if v_rls is not true then raise exception 'RLS אינו דלוק'; end if;
    if v_anon_sel then raise exception 'ל-anon יש SELECT — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)'; end if;
    if v_auth_sel then raise exception 'ל-authenticated יש SELECT — הטבלה נושאת שמות ומספרי טלפון'; end if;
    if v_auth_ins then raise exception 'ל-authenticated יש INSERT — כל כתיבה חייבת לעבור server-side'; end if;
    if v_n_policies <> 0 then raise exception 'נמצאה policy, npolicies=%', v_n_policies; end if;
    if v_n_cols <> 6 then raise exception 'ncols=% expected=6', v_n_cols; end if;

  exception when others then
    v_msg := E'❌ 0103 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0103 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · הטבלה נוצרת עם 6 עמודות, שלושה אינדקסים ו-RLS דלוק\n'
        || E'  · כמה אנשים לאותו פודקאסט — מתקבל\n'
        || E'  · 🔴 אותו מספר לשני פודקאסטים — מתקבל, וחיפוש לפי המספר מחזיר שתי תוכניות. זה המקרה שמייצר את הודעת הרשימה\n'
        || E'  · אותו מספר פעמיים לאותו פודקאסט — נדחה\n'
        || E'  · wa_id עם + או עם מקף או קצר מדי — נדחה. מאומת ולא מנוקה\n'
        || E'  · שם של רווחים בלבד — נדחה (btrim בתוך ה-CHECK)\n'
        || E'  · תוכנית שאינה קיימת — נדחית ב-FK\n'
        || E'  · אפס הרשאות לכל תפקיד של סשן, ואפס policy\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0103_booking_contacts.sql';
  raise exception '%', v_msg;
end $dry$;
