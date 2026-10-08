-- ============================================================================
-- 0101 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא יוצר את `wa_messages` באמת, כותב לתוכה שורות אמיתיות, מוכיח כל CHECK
-- ואת מנגנון ה-de-dup ע"י ניסיונות שחייבים להיכשל, מאמת את ההרשאות, ומסיים
-- ב-`raise exception` — כך שאפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- לכן הקובץ אוסף דוח מלא לתוך `v_rep` ומדפיס אותו **בתוך ה-exception**, גם
-- בהצלחה וגם בכשל. ה-NOTICEים נשארו למי שמריץ ב-psql, אבל הם אינם הערוץ
-- הקובע.
--
-- המנגנון: בלוק `begin … exception` פנימי עוטף את כל העבודה. כשל נתפס שם,
-- ה-subtransaction מגלגל את הכתיבות, והדוח נשלח מבחוץ יחד עם השגיאה
-- המקורית. משתני plpgsql אינם טרנזקציוניים ולכן `v_rep` שורד את הגלגול.
--
-- ═══ ⚠️ אין כאן המשך ליטרלים בכלל ═══
-- ההודעה המסכמת נבנית ב-`v_msg` עם `||` ועם `E'\n'` **מפורש בכל מקטע**,
-- ועוברת כארגומנט: `raise exception '%', v_msg`. כל מקטע הוא ליטרל עצמאי
-- שאינו נשען על שכנו, ולכן השאלה "האם ההמשך יורש escape" אינה קיימת
-- (הלקח של 0100_dryrun, 8.10).
--
-- ═══ ⚠️ מספרים באנגלית, הודעות בעברית ═══
-- כל מספר בדוח מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט
-- עברי. ערבוב דו-כיווני הופך הודעת שגיאה למטרידה במקום למאבחנת (הלקח של
-- 0100, 7.10).
--
-- ⚠️ למה לבצע-ואז-לגלגל ולא רק לבדוק: CHECK שלא נוסה אינו מוכיח שהוא תופס,
--    ו-unique שלא הופר אינו מוכיח שהוא קיים. רק ביצוע בפועל יתפוס טעות
--    בניסוח האילוץ. זו המוסכמה של 0098/0100, מאותו נימוק.
-- ============================================================================

do $dry$
declare
  v_rep  text := '';
  v_msg  text;
  v_n_cols        int := -1;
  v_n_rows        int := -1;
  v_n_stored      int := -1;
  v_n_policies    int := -1;
  v_rls           boolean;
  v_anon_sel      boolean;
  v_auth_sel      boolean;
  v_auth_ins      boolean;
  v_unique_ok     boolean;
  v_caught        int := 0;   -- כמה אילוצים נוסו ותפסו
  v_expected      int := 10;  -- ניסיונות הפרה שחייבים להידחות: 9 CHECK + 1 unique
  v_long_body     text;
begin
  -- גארד: הקובץ הזה יוצר טבלה. אם היא כבר קיימת, המיגרציה כנראה הוחלה,
  -- וההרצה המדומה הייתה כותבת לתוך נתונים אמיתיים (ומגלגלת — אבל זה לא
  -- מה שהקובץ מתיימר לעשות).
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'wa_messages'
  ) then
    raise exception 'wa_messages כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0101 כבר הוחלה, הרץ את 0101_verify.sql במקום';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0101') then
    raise exception '0101 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;

  begin
    -- ── 1. היצירה, מילה במילה כמו ב-0101 ──────────────────────────────────
    create table public.wa_messages (
      id            uuid primary key default gen_random_uuid(),
      wamid         text not null unique,
      direction     text not null,
      wa_id         text not null,
      type          text,
      body          text,
      template_name text,
      status        text not null,
      payload       jsonb not null default '{}'::jsonb,
      created_at    timestamptz not null default now(),

      constraint wa_messages_direction_chk
        check (direction in ('in', 'out')),
      constraint wa_messages_status_chk
        check (status in ('received', 'queued', 'sent', 'failed', 'dry_run')),
      constraint wa_messages_direction_status_chk
        check (
          (direction = 'in'  and status = 'received' and template_name is null)
          or
          (direction = 'out' and status <> 'received')
        ),
      constraint wa_messages_wa_id_len_chk
        check (char_length(wa_id) between 1 and 32),
      constraint wa_messages_body_len_chk
        check (body is null or char_length(body) <= 8000),
      constraint wa_messages_template_len_chk
        check (template_name is null or char_length(template_name) between 1 and 200)
    );

    create index wa_messages_wa_id_idx   on public.wa_messages (wa_id, created_at desc);
    create index wa_messages_created_idx on public.wa_messages (created_at desc);
    create index wa_messages_failed_idx  on public.wa_messages (created_at desc) where status = 'failed';

    alter table public.wa_messages enable row level security;
    revoke all privileges on public.wa_messages from public, anon, authenticated;

    select count(*) into v_n_cols from information_schema.columns
      where table_schema = 'public' and table_name = 'wa_messages';
    v_rep := v_rep || E'\n  table created: ncols=' || v_n_cols::text || ' expected=10';

    -- ── 2. השורות שחייבות לעבור ───────────────────────────────────────────
    -- נכנסת רגילה, כפי שהראוט כותב אותה
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status, payload)
    values ('wamid.probe.1', 'in', '972501234567', 'text', 'היי, רוצה לקבוע הקלטה', 'received',
            '{"id":"wamid.probe.1","type":"text"}'::jsonb);

    -- נכנסת בלי body (סוג הודעה בלי תוכן קריא) — חייבת לעבור
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status)
    values ('wamid.probe.2', 'in', '972501234567', 'location', null, 'received');

    -- שולח שלא נורמל: הראוט נופל חזרה לערך גולמי, וה-CHECK הרפוי מתיר אותו.
    -- זו בדיוק הנקודה שבגללה ה-CHECK רפוי — ראה כותרת 0101.
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status)
    values ('wamid.probe.3', 'in', 'unknown', 'text', 'שולח שלא נורמל', 'received');

    -- יוצאת ב-dry_run (המצב הנפוץ, כלל 40) ויוצאת בתבנית
    insert into public.wa_messages (wamid, direction, wa_id, type, body, template_name, status)
    values ('wamid.probe.4', 'out', '972501234567', 'template', 'תוכן שהיה נשלח', 'booking_owner_notice', 'dry_run');
    insert into public.wa_messages (wamid, direction, wa_id, type, body, template_name, status)
    values ('wamid.probe.5', 'out', '972501234567', 'template', 'נשלח', 'booking_owner_notice', 'sent');

    -- body באורך המקסימום בדיוק — הגבול עצמו חייב לעבור
    v_long_body := repeat('א', 8000);
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status)
    values ('wamid.probe.6', 'in', '972501234567', 'text', v_long_body, 'received');

    select count(*) into v_n_rows from public.wa_messages;
    v_rep := v_rep || E'\n  rows accepted: nrows=' || v_n_rows::text || ' expected=6';

    -- ── 3. מנגנון ה-de-dup ────────────────────────────────────────────────
    -- 🔴 הבדיקה שהראוט נשען עליה. `on conflict do nothing` הוא בדיוק מה
    --    ש-supabase-js שולח כש-`ignoreDuplicates: true`.
    insert into public.wa_messages (wamid, direction, wa_id, type, body, status)
    values ('wamid.probe.1', 'in', '972501234567', 'text', 'אותה הודעה, מסירה חוזרת של Meta', 'received')
    on conflict (wamid) do nothing;

    select count(*) into v_n_stored from public.wa_messages;
    v_rep := v_rep || E'\n  dedup (on conflict do nothing): nrows=' || v_n_stored::text || ' expected=6';
    if v_n_stored <> 6 then
      raise exception 'de-dup לא תפס: nrows_after_redelivery=% expected=6', v_n_stored;
    end if;

    -- והמסירה החוזרת לא דרסה את התוכן המקורי
    if (select body from public.wa_messages where wamid = 'wamid.probe.1')
       <> 'היי, רוצה לקבוע הקלטה' then
      raise exception 'de-dup דרס את התוכן המקורי — do nothing אמור להשאיר את השורה הראשונה';
    end if;
    v_rep := v_rep || E'\n  dedup kept the original body: ok=true';

    -- ובלי `on conflict` זו שגיאה, כלומר האילוץ אמיתי ולא רק אינדקס
    begin
      insert into public.wa_messages (wamid, direction, wa_id, type, status)
      values ('wamid.probe.1', 'in', '972501234567', 'text', 'received');
      raise exception 'wamid כפול התקבל בלי on conflict — אין unique';
    exception when unique_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught unique_violation on wamid: caught=1';
    end;

    -- ── 4. כל CHECK, אחד אחד, בניסיון שחייב להיכשל ────────────────────────
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('wamid.bad.direction', 'sideways', '972501234567', 'received');
      raise exception 'direction לא חוקי התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_messages_direction_chk: caught=1';
    end;

    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('wamid.bad.status', 'in', '972501234567', 'delivered');
      raise exception 'status לא חוקי התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_messages_status_chk: caught=1';
    end;

    -- נכנסת עם סטטוס של יוצאת
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('wamid.bad.pair1', 'in', '972501234567', 'sent');
      raise exception 'נכנסת עם status=sent התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught direction_status (in+sent): caught=1';
    end;

    -- נכנסת עם תבנית — אין תבנית להודעה שלקוח שלח
    begin
      insert into public.wa_messages (wamid, direction, wa_id, template_name, status)
      values ('wamid.bad.pair2', 'in', '972501234567', 'booking_owner_notice', 'received');
      raise exception 'נכנסת עם template_name התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught direction_status (in+template): caught=1';
    end;

    -- יוצאת עם status=received
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('wamid.bad.pair3', 'out', '972501234567', 'received');
      raise exception 'יוצאת עם status=received התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught direction_status (out+received): caught=1';
    end;

    -- wa_id ארוך מדי (33 תווים)
    begin
      insert into public.wa_messages (wamid, direction, wa_id, status)
      values ('wamid.bad.waid', 'in', repeat('9', 33), 'received');
      raise exception 'wa_id באורך 33 התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_messages_wa_id_len_chk: caught=1';
    end;

    -- body באורך 8001 — תו אחד מעבר לגבול שעבר בשלב 2
    begin
      insert into public.wa_messages (wamid, direction, wa_id, body, status)
      values ('wamid.bad.body', 'in', '972501234567', repeat('א', 8001), 'received');
      raise exception 'body באורך 8001 התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_messages_body_len_chk: caught=1';
    end;

    -- template_name באורך 201 — האילוץ השישי, שהיה מוצהר ולא נוסה
    begin
      insert into public.wa_messages (wamid, direction, wa_id, template_name, status)
      values ('wamid.bad.template', 'out', '972501234567', repeat('t', 201), 'sent');
      raise exception 'template_name באורך 201 התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught wa_messages_template_len_chk: caught=1';
    end;

    -- template_name ריק: הגבול התחתון של אותו אילוץ
    begin
      insert into public.wa_messages (wamid, direction, wa_id, template_name, status)
      values ('wamid.bad.template2', 'out', '972501234567', '', 'sent');
      raise exception 'template_name ריק התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  caught template_len (empty): caught=1';
    end;

    v_rep := v_rep || E'\n  constraints caught: ncaught=' || v_caught::text
                   || ' expected=' || v_expected::text || ' (9 check attempts + 1 unique)';
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 5. הרשאות ו-RLS ───────────────────────────────────────────────────
    select relrowsecurity into v_rls from pg_class where oid = 'public.wa_messages'::regclass;
    v_anon_sel := has_table_privilege('anon',          'public.wa_messages', 'select');
    v_auth_sel := has_table_privilege('authenticated', 'public.wa_messages', 'select');
    v_auth_ins := has_table_privilege('authenticated', 'public.wa_messages', 'insert');
    select count(*) into v_n_policies from pg_policies
      where schemaname = 'public' and tablename = 'wa_messages';
    select exists (
      select 1 from pg_constraint
      where conrelid = 'public.wa_messages'::regclass and contype = 'u'
        and conname = 'wa_messages_wamid_key'
    ) into v_unique_ok;

    v_rep := v_rep || E'\n  rls_enabled=' || v_rls::text || ' expected=true';
    v_rep := v_rep || E'\n  anon_select=' || v_anon_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select=' || v_auth_sel::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_insert=' || v_auth_ins::text || ' expected=false';
    v_rep := v_rep || E'\n  npolicies=' || v_n_policies::text || ' expected=0';
    v_rep := v_rep || E'\n  unique_constraint_named_ok=' || v_unique_ok::text || ' expected=true';

    if v_rls is not true then raise exception 'RLS אינו דלוק'; end if;
    if v_anon_sel then raise exception 'ל-anon יש SELECT — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)'; end if;
    if v_auth_sel then raise exception 'ל-authenticated יש SELECT — הטבלה אמורה להיות בלתי קריאה מסשן'; end if;
    if v_auth_ins then raise exception 'ל-authenticated יש INSERT — כל כתיבה חייבת לעבור server-side'; end if;
    if v_n_policies <> 0 then raise exception 'נמצאה policy — הטבלה אמורה להיות בלי אף policy, npolicies=%', v_n_policies; end if;
    if not v_unique_ok then raise exception 'אין אילוץ unique בשם wa_messages_wamid_key'; end if;
    if v_n_cols <> 10 then raise exception 'ncols=% expected=10', v_n_cols; end if;

  exception when others then
    -- כשל: ה-subtransaction גלגל את הכתיבות. הדוח שרד ב-v_rep ונשלח יחד
    -- עם השגיאה המקורית, כדי שיהיה ברור עד לאן הגענו.
    v_msg := E'❌ 0101 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nאפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  -- ── ההצלחה, שגם היא exception ─────────────────────────────────────────────
  v_msg := E'✅ 0101 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · הטבלה נוצרת עם 10 עמודות, שלושה אינדקסים ו-RLS דלוק\n'
        || E'  · שש שורות חוקיות מתקבלות: נכנסת רגילה, נכנסת בלי body, שולח לא מנורמל, יוצאת ב-dry_run, יוצאת שנשלחה, ו-body באורך הגבול בדיוק\n'
        || E'  · מסירה חוזרת של אותו wamid אינה יוצרת שורה שנייה ואינה דורסת את הראשונה — זה מנגנון ה-de-dup שהראוט נשען עליו\n'
        || E'  · wamid כפול בלי on conflict נדחה, כלומר האילוץ אמיתי\n'
        || E'  · עשרה ניסיונות הפרה נוסו וכולם נדחו — ששת ה-CHECKים (ה-pair בשלוש צורות, template בשתיים) וה-unique\n'
        || E'  · אפס הרשאות לכל תפקיד של סשן, ואפס policy\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0101_wa_messages.sql';
  raise exception '%', v_msg;
end $dry$;
