-- ============================================================================
-- 0104 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא יוצר את `wa_conversations` באמת, כותב שורות אמיתיות, מוכיח כל אילוץ,
-- את המפתח הראשי ואת נעילת הגרסה, מאמת את ההרשאות, ומסיים ב-`raise
-- exception` — כך שאפס שינוי נשאר על המסד. **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- הדוח נאסף ב-`v_rep` ונשלח **בתוך** ה-exception, גם בהצלחה וגם בכשל.
-- ההודעה נבנית במשתנה עם `||`, כל מקטע ליטרל שלם משלו — אין המשך ליטרלים.
-- כל מספר מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט עברי.
-- ============================================================================

do $dry$
declare
  v_rep text := '';
  v_msg text;
  v_n_cols     int := -1;
  v_n_rows     int := -1;
  v_caught     int := 0;
  v_expected   int := 7;
  v_rls        boolean;
  v_anon_sel   boolean;
  v_auth_sel   boolean;
  v_auth_ins   boolean;
  v_n_policies int := -1;
  v_show       uuid;
  v_win        int;
  v_lose       int;
  v_version    int;
  v_exp        timestamptz := now() + interval '30 minutes';
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'wa_conversations'
  ) then
    raise exception 'wa_conversations כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0104 כבר הוחלה, הרץ את 0104_verify.sql';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0104') then
    raise exception '0104 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0103') then
    raise exception '0103 טרם הוחלה — הרץ אותה קודם';
  end if;

  select id into v_show from public.shows order by created_at limit 1;
  if v_show is null then
    raise exception 'צריך לפחות תוכנית אחת כדי להוכיח את ה-FK';
  end if;

  begin
    -- ── 1. היצירה, מילה במילה כמו ב-0104 ──────────────────────────────────
    create table public.wa_conversations (
      wa_id       text primary key,
      show_id     uuid not null references public.shows(id) on delete cascade,
      step        text not null,
      state       jsonb not null,
      version     integer not null default 1,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now(),
      expires_at  timestamptz not null,
      constraint wa_conversations_wa_id_chk
        check (wa_id ~ '^[0-9]{7,15}$'),
      constraint wa_conversations_step_chk
        check (step in ('menu', 'duration', 'studio-default', 'studio', 'day', 'hour',
                        'guest', 'note', 'summary', 'submitting', 'done')),
      constraint wa_conversations_state_object_chk
        check (jsonb_typeof(state) = 'object'),
      constraint wa_conversations_version_chk
        check (version >= 1)
    );
    create index wa_conversations_show_idx on public.wa_conversations (show_id);

    alter table public.wa_conversations enable row level security;
    revoke all privileges on public.wa_conversations from public, anon, authenticated;

    select count(*) into v_n_cols from information_schema.columns
      where table_schema = 'public' and table_name = 'wa_conversations';
    v_rep := v_rep || E'\n  table created: ncols=' || v_n_cols::text || ' expected=8';

    -- ── 2. השורות שחייבות לעבור ───────────────────────────────────────────
    insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
      values ('972501234567', v_show, 'menu', '{"v":1,"step":"menu"}'::jsonb, v_exp);
    insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
      values ('972521111111', v_show, 'summary', '{"v":1,"step":"summary"}'::jsonb, v_exp);
    -- גבולות wa_id: 7 ו-15 ספרות
    insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
      values ('1234567', v_show, 'done', '{}'::jsonb, v_exp);
    insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
      values ('123456789012345', v_show, 'studio-default', '{}'::jsonb, v_exp);

    select count(*) into v_n_rows from public.wa_conversations;
    v_rep := v_rep || E'\n  rows accepted: nrows=' || v_n_rows::text || ' expected=4';
    if v_n_rows <> 4 then
      raise exception 'לא כל השורות החוקיות התקבלו: nrows=% expected=4', v_n_rows;
    end if;

    -- 🔴 3. נעילת הגרסה, בדיוק כפי שהקוד כותב: שני כותבים קראו version=1
    update public.wa_conversations set version = 2, step = 'submitting'
      where wa_id = '972521111111' and version = 1;
    get diagnostics v_win = row_count;
    update public.wa_conversations set version = 2, step = 'submitting'
      where wa_id = '972521111111' and version = 1;
    get diagnostics v_lose = row_count;
    select version into v_version from public.wa_conversations where wa_id = '972521111111';
    v_rep := v_rep || E'\n  version lock: first_writer_rows=' || v_win::text || ' expected=1'
                   || ' second_writer_rows=' || v_lose::text || ' expected=0'
                   || ' version_after=' || v_version::text || ' expected=2';
    if v_win <> 1 or v_lose <> 0 or v_version <> 2 then
      raise exception 'נעילת הגרסה לא עבדה: first=% second=% version=%', v_win, v_lose, v_version;
    end if;

    -- ── 4. מה שחייב להידחות ───────────────────────────────────────────────
    -- 🔴 שיחה שנייה לאותו מספר — המפתח הראשי
    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('972501234567', v_show, 'menu', '{}'::jsonb, v_exp);
      raise exception 'שיחה שנייה לאותו מספר התקבלה';
    exception when unique_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught primary key on wa_id: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('+972501234568', v_show, 'menu', '{}'::jsonb, v_exp);
      raise exception 'מספר עם + התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_id with plus: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('972501234569', v_show, 'paying', '{}'::jsonb, v_exp);
      raise exception 'שלב לא מוכר התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught unknown step: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('972501234570', v_show, 'menu', '[1,2]'::jsonb, v_exp);
      raise exception 'state שאינו אובייקט התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught state not an object: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, version, expires_at)
        values ('972501234571', v_show, 'menu', '{}'::jsonb, 0, v_exp);
      raise exception 'version=0 התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught version below 1: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state)
        values ('972501234572', v_show, 'menu', '{}'::jsonb);
      raise exception 'שורה בלי expires_at התקבלה';
    exception when not_null_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught missing expires_at: caught=1';
    end;

    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('972501234573', '00000000-0000-0000-0000-000000000000', 'menu', '{}'::jsonb, v_exp);
      raise exception 'שיחה לתוכנית שאינה קיימת התקבלה';
    exception when foreign_key_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught FK on show_id: caught=1';
    end;

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 5. הרשאות ו-RLS ───────────────────────────────────────────────────
    select relrowsecurity into v_rls from pg_class where oid = 'public.wa_conversations'::regclass;
    v_anon_sel := has_table_privilege('anon',          'public.wa_conversations', 'select');
    v_auth_sel := has_table_privilege('authenticated', 'public.wa_conversations', 'select');
    v_auth_ins := has_table_privilege('authenticated', 'public.wa_conversations', 'insert');
    select count(*) into v_n_policies from pg_policies
      where schemaname = 'public' and tablename = 'wa_conversations';

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
    if v_n_cols <> 8 then raise exception 'ncols=% expected=8', v_n_cols; end if;

  exception when others then
    v_msg := E'❌ 0104 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0104 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · הטבלה נוצרת עם 8 עמודות, מפתח ראשי על wa_id, אינדקס על show_id ו-RLS דלוק\n'
        || E'  · 🔴 שיחה שנייה לאותו מספר — נדחית על המפתח הראשי\n'
        || E'  · 🔴 נעילת הגרסה: מתוך שני כותבים שקראו אותה גרסה, רק הראשון מעדכן\n'
        || E'  · wa_id עם + — נדחה. שלב לא מוכר — נדחה. state שאינו אובייקט — נדחה\n'
        || E'  · version מתחת ל-1 — נדחה. בלי expires_at — נדחה. תוכנית שאינה קיימת — נדחית ב-FK\n'
        || E'  · אפס הרשאות לכל תפקיד של סשן, ואפס policy\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0104_wa_conversations.sql';
  raise exception '%', v_msg;
end $dry$;
