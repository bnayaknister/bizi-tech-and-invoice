-- ============================================================================
-- 0106 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא יוצר את `wa_contact_prefs` באמת, כותב שורות אמיתיות, מוכיח כל אילוץ
-- ואת ה-upsert שהקוד ישתמש בו, מאמת את ההרשאות, מוכיח בעזרת md5 שטבלאות
-- הבוט האחרות לא זזו, ומסיים ב-`raise exception` — כך שאפס שינוי נשאר על
-- המסד. **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- הדוח נאסף ב-`v_rep` ונשלח **בתוך** ה-exception, גם בהצלחה וגם בכשל.
-- ההודעה נבנית במשתנה עם `||`, כל מקטע ליטרל שלם משלו — אין המשך ליטרלים.
-- כל מספר מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט עברי.
-- ספירת "אחרי" היא על הטבלה כולה; כל השאר (מוחרג מהשינוי) נמדד ב-md5.
--
-- ⚠️ `wa_messages` היא טבלה חיה: הודעה נכנסת לבוט בדיוק בשניות שבין שני
-- ה-md5 תשנה אותו (כל שאילתה בתוך הבלוק רואה snapshot חדש). אם הכשל היחיד
-- הוא `wa_messages השתנתה` — פשוט להריץ שוב. הקובץ הזה לא נוגע בה.
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
  v_lang       text;
  v_set_at     timestamptz;
  v_created    timestamptz;
  v_created2   timestamptz;
  -- md5 של מה שמוחרג מהשינוי — לפני ואחרי
  v_md5_conv_before   text;
  v_md5_conv_after    text;
  v_md5_bc_before     text;
  v_md5_bc_after      text;
  v_md5_msg_before    text;
  v_md5_msg_after     text;
  v_md5_ledger_before text;
  v_md5_ledger_after  text;
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'wa_contact_prefs'
  ) then
    raise exception 'wa_contact_prefs כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0106 כבר הוחלה, הרץ את 0106_verify.sql';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0106') then
    raise exception '0106 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0105') then
    raise exception '0105 טרם הוחלה — הרץ אותה קודם';
  end if;

  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_conv_before   from public.wa_conversations t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_bc_before     from public.booking_contacts t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_msg_before    from public.wa_messages t;
  select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_ledger_before from public.schema_ledger t;

  begin
    -- ── 1. היצירה, מילה במילה כמו ב-0106 ──────────────────────────────────
    create table public.wa_contact_prefs (
      wa_id        text primary key,
      lang         text,
      lang_set_at  timestamptz,
      created_at   timestamptz not null default now(),
      updated_at   timestamptz not null default now(),
      constraint wa_contact_prefs_wa_id_chk
        check (wa_id ~ '^[0-9]{7,15}$'),
      constraint wa_contact_prefs_lang_chk
        check (lang is null or lang in ('he', 'en')),
      constraint wa_contact_prefs_lang_set_together_chk
        check ((lang is null) = (lang_set_at is null))
    );

    alter table public.wa_contact_prefs enable row level security;
    revoke all privileges on public.wa_contact_prefs from public, anon, authenticated;

    select count(*) into v_n_cols from information_schema.columns
      where table_schema = 'public' and table_name = 'wa_contact_prefs';
    v_rep := v_rep || E'\n  table created: ncols=' || v_n_cols::text || ' expected=5';

    -- ── 2. השורות שחייבות לעבור ───────────────────────────────────────────
    insert into public.wa_contact_prefs (wa_id, lang, lang_set_at) values ('972501234567', 'he', now());
    insert into public.wa_contact_prefs (wa_id, lang, lang_set_at) values ('972521111111', 'en', now());
    -- NULL = טרם נבחר — שורה לגיטימית
    insert into public.wa_contact_prefs (wa_id) values ('972531111111');
    -- גבולות wa_id: 7 ו-15 ספרות
    insert into public.wa_contact_prefs (wa_id) values ('1234567');
    insert into public.wa_contact_prefs (wa_id) values ('123456789012345');

    select count(*) into v_n_rows from public.wa_contact_prefs;
    v_rep := v_rep || E'\n  rows accepted: nrows=' || v_n_rows::text || ' expected=5';
    if v_n_rows <> 5 then
      raise exception 'לא כל השורות החוקיות התקבלו: nrows=% expected=5', v_n_rows;
    end if;

    -- 🔴 3. ה-upsert בדיוק כפי שהקוד יכתוב: מספר שטרם בחר בוחר English,
    --    ואז מחליף לעברית. created_at לא זז; השורה נשארת אחת.
    select created_at into v_created from public.wa_contact_prefs where wa_id = '972531111111';
    insert into public.wa_contact_prefs (wa_id, lang, lang_set_at, updated_at)
      values ('972531111111', 'en', now(), now())
      on conflict (wa_id) do update
        set lang = excluded.lang, lang_set_at = excluded.lang_set_at, updated_at = excluded.updated_at;
    insert into public.wa_contact_prefs (wa_id, lang, lang_set_at, updated_at)
      values ('972531111111', 'he', now(), now())
      on conflict (wa_id) do update
        set lang = excluded.lang, lang_set_at = excluded.lang_set_at, updated_at = excluded.updated_at;
    select lang, lang_set_at, created_at into v_lang, v_set_at, v_created2
      from public.wa_contact_prefs where wa_id = '972531111111';
    select count(*) into v_n_rows from public.wa_contact_prefs;
    v_rep := v_rep || E'\n  upsert: lang=' || v_lang || ' expected=he'
                   || ' set_at_present=' || (v_set_at is not null)::text || ' expected=true'
                   || ' created_at_kept=' || (v_created2 = v_created)::text || ' expected=true'
                   || ' nrows_whole_table=' || v_n_rows::text || ' expected=5';
    if v_lang <> 'he' or v_set_at is null or v_created2 <> v_created or v_n_rows <> 5 then
      raise exception 'ה-upsert לא התנהג כצפוי: lang=% set_at=% nrows=%', v_lang, v_set_at, v_n_rows;
    end if;

    -- ── 4. מה שחייב להידחות ───────────────────────────────────────────────
    begin
      insert into public.wa_contact_prefs (wa_id, lang, lang_set_at) values ('972501234567', 'en', now());
      raise exception 'שורה שנייה לאותו מספר התקבלה';
    exception when unique_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught primary key on wa_id: caught=1';
    end;

    begin
      insert into public.wa_contact_prefs (wa_id) values ('+972501234568');
      raise exception 'מספר עם + התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id with plus: caught=1';
    end;

    begin
      insert into public.wa_contact_prefs (wa_id) values ('123456');
      raise exception 'מספר של 6 ספרות התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id too short: caught=1';
    end;

    begin
      insert into public.wa_contact_prefs (wa_id, lang, lang_set_at) values ('972501234569', 'fr', now());
      raise exception 'שפה לא מוכרת התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught unknown lang: caught=1';
    end;

    begin
      insert into public.wa_contact_prefs (wa_id, lang) values ('972501234570', 'en');
      raise exception 'שפה בלי lang_set_at התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught lang without set_at: caught=1';
    end;

    begin
      insert into public.wa_contact_prefs (wa_id, lang_set_at) values ('972501234571', now());
      raise exception 'lang_set_at בלי שפה התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught set_at without lang: caught=1';
    end;

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 5. הרשאות ו-RLS ───────────────────────────────────────────────────
    select relrowsecurity into v_rls from pg_class where oid = 'public.wa_contact_prefs'::regclass;
    v_anon_sel := has_table_privilege('anon',          'public.wa_contact_prefs', 'select');
    v_auth_sel := has_table_privilege('authenticated', 'public.wa_contact_prefs', 'select');
    v_auth_ins := has_table_privilege('authenticated', 'public.wa_contact_prefs', 'insert');
    select count(*) into v_n_policies from pg_policies
      where schemaname = 'public' and tablename = 'wa_contact_prefs';

    v_rep := v_rep || E'\n  rls_enabled=' || v_rls::text || ' expected=true';
    v_rep := v_rep || E'\n  anon_select=' || v_anon_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select=' || v_auth_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_insert=' || v_auth_ins::text || ' expected=false';
    v_rep := v_rep || E'\n  npolicies=' || v_n_policies::text || ' expected=0';

    if v_rls is not true then raise exception 'RLS אינו דלוק'; end if;
    if v_anon_sel then raise exception 'ל-anon יש SELECT — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)'; end if;
    if v_auth_sel then raise exception 'ל-authenticated יש SELECT — הטבלה נושאת מספרי טלפון'; end if;
    if v_auth_ins then raise exception 'ל-authenticated יש INSERT — כל כתיבה חייבת לעבור server-side'; end if;
    if v_n_policies <> 0 then raise exception 'נמצאה policy, npolicies=%', v_n_policies; end if;
    if v_n_cols <> 5 then raise exception 'ncols=% expected=5', v_n_cols; end if;

    -- ── 6. מה שמוחרג מהשינוי — md5 לפני/אחרי ─────────────────────────────
    select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_conv_after   from public.wa_conversations t;
    select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_bc_after     from public.booking_contacts t;
    select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_msg_after    from public.wa_messages t;
    select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) into v_md5_ledger_after from public.schema_ledger t;

    v_rep := v_rep || E'\n  wa_conversations_unchanged=' || (v_md5_conv_after = v_md5_conv_before)::text || ' expected=true';
    v_rep := v_rep || E'\n  booking_contacts_unchanged=' || (v_md5_bc_after = v_md5_bc_before)::text || ' expected=true';
    v_rep := v_rep || E'\n  wa_messages_unchanged=' || (v_md5_msg_after = v_md5_msg_before)::text || ' expected=true';
    v_rep := v_rep || E'\n  schema_ledger_unchanged=' || (v_md5_ledger_after = v_md5_ledger_before)::text || ' expected=true';

    if v_md5_conv_after <> v_md5_conv_before then raise exception 'wa_conversations השתנתה'; end if;
    if v_md5_bc_after <> v_md5_bc_before then raise exception 'booking_contacts השתנתה'; end if;
    if v_md5_msg_after <> v_md5_msg_before then raise exception 'wa_messages השתנתה'; end if;
    if v_md5_ledger_after <> v_md5_ledger_before then raise exception 'schema_ledger השתנה'; end if;

  exception when others then
    v_msg := E'❌ 0106 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0106 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · הטבלה נוצרת עם 5 עמודות, מפתח ראשי על wa_id ו-RLS דלוק\n'
        || E'  · he, en ו-NULL (טרם נבחר) מתקבלים; גבולות 7 ו-15 ספרות מתקבלים\n'
        || E'  · 🔴 ה-upsert של הקוד: שורה אחת למספר, השפה מתחלפת, created_at נשמר\n'
        || E'  · מספר כפול, פלוס, 6 ספרות, שפה לא מוכרת — נדחים\n'
        || E'  · שפה בלי lang_set_at ו-lang_set_at בלי שפה — נדחים\n'
        || E'  · אפס הרשאות לכל תפקיד של סשן, ואפס policy\n'
        || E'  · wa_conversations, booking_contacts, wa_messages ו-schema_ledger לא זזו (md5)\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0106_wa_contact_prefs.sql';
  raise exception '%', v_msg;
end $dry$;
