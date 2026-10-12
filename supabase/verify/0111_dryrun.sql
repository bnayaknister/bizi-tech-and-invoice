-- ============================================================================
-- 0111 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד). הקובץ מריץ אותו,
-- מוכיח את התוצאה, ומסיים ב-`raise exception` — אפס שינוי נשאר על המסד.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
-- Supabase SQL Editor אינו מציג NOTICE — כל הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rows_before int;
  v_rows_after int;
  v_rep text := '';
  v_msg text;
  v_md5_b text;
  v_md5_a text;
  v_show uuid;
  v_ok int := 0;
  v_caught int := 0;
begin
  begin
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_b from public.booking_contacts t;

    -- ════ גוף 0111, מילה במילה ════
    if exists (select 1 from public.schema_ledger where version = '0111') then
      raise exception '0111 כבר הוחלה';
    end if;
    if not exists (select 1 from public.schema_ledger where version = '0110') then
      raise exception '0110 טרם הוחלה — הרץ אותה קודם';
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'booking_contacts' and column_name = 'email') then
      raise exception '0111: booking_contacts.email כבר קיימת — נוספה מחוץ לפנקס';
    end if;

    select count(*) into v_rows_before from public.booking_contacts;

    alter table public.booking_contacts add column email text;

    alter table public.booking_contacts
      add constraint booking_contacts_email_chk
      check (
        email is null
        or (
          email = lower(btrim(email))
          and char_length(email) between 3 and 254
          and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        )
      );

    comment on column public.booking_contacts.email is
      'E22: מייל של המורשה לקבוע הקלטות — אופציונלי. מקבל זימון ליומן גוגל להקלטה שנקבעה (B26). trim+lowercase, NULL כשאין.';

    -- ── canary ────────────────────────────────────────────────────────────────
    select count(*) into v_rows_after from public.booking_contacts;
    if v_rows_after <> v_rows_before then
      raise exception '0111 canary: nrows before=% after=%', v_rows_before, v_rows_after;
    end if;
    if exists (select 1 from public.booking_contacts where email is not null) then
      raise exception '0111 canary: עמודה חדשה אינה ריקה';
    end if;
    if has_column_privilege('anon', 'public.booking_contacts', 'email', 'SELECT')
       or has_column_privilege('authenticated', 'public.booking_contacts', 'email', 'SELECT') then
      raise exception '0111 canary: booking_contacts.email קריא מסשן — 0103 נעלה את הטבלה';
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_contacts') then
      raise exception '0111 canary: נמצאה policy על booking_contacts';
    end if;

    insert into public.schema_ledger (version, applied_at, applied_by, note)
    values ('0111', now(), 'bnaya',
      'E22: booking_contacts.email — מייל אופציונלי למורשה לקבוע הקלטות, לזימון ליומן גוגל (B26). '
      'עמודה במבנה הקיים (0103: show_id, name, wa_id), לא טבלה חדשה; ' || v_rows_before || ' שורות קיימות נשארו כמו שהן עם email ריק. '
      'CHECK: NULL, או trim+lowercase בצורה בסיסית תקינה, 3-254 תווים. נעולה מסשן כמו הטבלה. אפס backfill, אפס DELETE.');

    -- ════ ההוכחות ════
    select md5(coalesce(string_agg((to_jsonb(t) - 'email')::text, '|' order by t.id), '')) into v_md5_a from public.booking_contacts t;
    if v_md5_a <> v_md5_b then raise exception 'md5: שורה קיימת השתנתה'; end if;
    v_rep := v_rep || E'\n  nrows=' || v_rows_after || E'\n  md5 השורות הקיימות (בלי email): ללא שינוי';

    select id into v_show from public.shows order by id limit 1;
    -- ערכים תקינים נכנסים
    insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'בדיקה 1', '972500000101', 'host@example.co.il');
    v_ok := v_ok + 1;
    insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'בדיקה 2', '972500000102', null);
    v_ok := v_ok + 1;
    -- ערכים לא קנוניים / לא תקינים נדחים
    begin insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'x', '972500000103', 'Host@Example.com'); raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1; end;
    begin insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'x', '972500000104', ' host@example.com'); raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1; end;
    begin insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'x', '972500000105', 'not-an-email'); raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1; end;
    begin insert into public.booking_contacts (show_id, name, wa_id, email) values (v_show, 'x', '972500000106', ''); raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1; end;
    v_rep := v_rep || E'\n  valid_inserted=' || v_ok || ' invalid_rejected=' || v_caught;
    if v_caught <> 4 then raise exception 'נדחו % מתוך 4 ערכים לא תקינים', v_caught; end if;

  exception when others then
    v_msg := E'❌ 0111 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm
          || E'\n\nהכול גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0111 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · העמודה נוספה ריקה; אף ערך קיים לא זז (md5)\n'
        || E'  · מייל קנוני ו-NULL נכנסים; אותיות גדולות, רווח מוביל, צורה שגויה ומחרוזת ריקה נדחים\n'
        || E'  · email אינו קריא מסשן\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0111_booking_contacts_email.sql';
  raise exception '%', v_msg;
end $dry$;
