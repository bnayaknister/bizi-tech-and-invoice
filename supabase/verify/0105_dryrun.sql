-- ============================================================================
-- 0105 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- מוסיף את העמודות והפונקציות באמת, כותב בקשות אמיתיות בשנת 2099 (שבה אין
-- אף הקלטה אמיתית, כך שה-EXCLUDE לא פוגש נתונים קיימים), מוכיח את ההחלפה,
-- את ההחלפה החופפת, כשל שמגלגל את שני הצדדים, וחזרה לאחור — ומסיים ב-`raise
-- exception`, כך שאפס שינוי נשאר על המסד. **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor אינו מציג NOTICE. הדוח נאסף ב-`v_rep` ונשלח בתוך
-- ה-exception. כל מקטע ליטרל שלם משלו, מחובר ב-`||` — אין המשך ליטרלים.
-- כל מספר כ-`label=value`.
-- ============================================================================

do $dry$
declare
  v_rep    text := '';
  v_msg    text;
  v_show   uuid;
  v_link   uuid;
  v_t      timestamptz := '2099-03-02 06:00:00+00';
  v_old    uuid; v_new uuid;
  v_c      uuid; v_d   uuid;
  v_e      uuid; v_f   uuid;
  v_g      uuid;
  v_res    text;
  v_st_a   text; v_st_b text;
  v_dec_before timestamptz; v_dec_after timestamptz;
  v_caught int := 0;
  v_expected int := 5;
  v_anon_exec boolean; v_auth_exec boolean; v_auth_col boolean;
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'booking_requests'
               and column_name = 'replaces_request_id') then
    raise exception 'replaces_request_id כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0105 כבר הוחלה, הרץ את 0105_verify.sql';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0105') then
    raise exception '0105 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;

  select l.id, l.show_id into v_link, v_show from public.booking_links l order by l.created_at limit 1;
  if v_link is null then
    raise exception 'צריך לפחות קישור הזמנה אחד (booking_links) כדי לכתוב בקשות לבדיקה';
  end if;
  if exists (select 1 from public.booking_requests where start_at >= '2099-01-01') then
    raise exception 'יש בקשות בשנת 2099 — ההרצה המדומה מניחה שהשנה ריקה';
  end if;

  begin
    -- ── 1. העמודות והפונקציות, מילה במילה כמו ב-0105 ─────────────────────
    alter table public.booking_requests
      add column replaces_request_id uuid null references public.booking_requests(id) on delete set null,
      add column calendar_delete_status text null,
      add column calendar_delete_error  text null;
    alter table public.booking_requests
      add constraint booking_requests_replaces_not_self_chk
        check (replaces_request_id is null or replaces_request_id <> id),
      add constraint booking_requests_calendar_delete_status_chk
        check (calendar_delete_status is null
               or calendar_delete_status in ('deleted', 'failed', 'not_ours', 'dry_run'));

    create function public.booking_approve_replacing(p_new uuid, p_old uuid, p_now timestamptz, p_actor uuid)
    returns text language plpgsql set search_path = public as $fn$
    declare v_o int; v_n int;
    begin
      update public.booking_requests set status = 'cancelled' where id = p_old and status = 'approved';
      get diagnostics v_o = row_count;
      update public.booking_requests set status = 'approved', decided_at = p_now, decided_by = p_actor
        where id = p_new and status = 'pending';
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'booking_approve_replacing: הבקשה החדשה אינה ממתינה' using errcode = 'P0002';
      end if;
      return case when v_o = 1 then 'swapped' else 'approved-only' end;
    end; $fn$;

    create function public.booking_revert_replacing(p_new uuid, p_old uuid)
    returns text language plpgsql set search_path = public as $fn$
    declare v_n int; v_o int;
    begin
      update public.booking_requests set status = 'pending', decided_at = null, decided_by = null
        where id = p_new and status = 'approved';
      get diagnostics v_n = row_count;
      if v_n = 0 then
        raise exception 'booking_revert_replacing: הבקשה החדשה אינה מאושרת' using errcode = 'P0002';
      end if;
      update public.booking_requests set status = 'approved' where id = p_old and status = 'cancelled';
      get diagnostics v_o = row_count;
      return case when v_o = 1 then 'reverted' else 'new-only' end;
    end; $fn$;

    revoke all on function public.booking_approve_replacing(uuid, uuid, timestamptz, uuid) from public, anon, authenticated;
    revoke all on function public.booking_revert_replacing(uuid, uuid) from public, anon, authenticated;
    grant execute on function public.booking_approve_replacing(uuid, uuid, timestamptz, uuid) to service_role;
    grant execute on function public.booking_revert_replacing(uuid, uuid) to service_role;
    alter table public.wa_conversations drop constraint if exists wa_conversations_step_chk;
    alter table public.wa_conversations add constraint wa_conversations_step_chk
      check (step in ('menu', 'duration', 'studio-default', 'studio', 'day', 'hour',
                    'guest', 'note', 'summary', 'submitting', 'done',
                    'mine', 'manage', 'cancel-confirm'));
    v_rep := v_rep || E'\n  columns and functions created: ok=1';

    -- שלבי השיחה: שלב חדש נכנס, שלב לא מוכר עדיין נדחה
    insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
      values ('999000111222', v_show, 'cancel-confirm', '{}'::jsonb, now() + interval '30 minutes');
    begin
      insert into public.wa_conversations (wa_id, show_id, step, state, expires_at)
        values ('999000111223', v_show, 'paying', '{}'::jsonb, now() + interval '30 minutes');
      raise exception 'שלב לא מוכר התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  conversation steps: new_step_accepted=1 unknown_step_caught=1';

    -- ── 2. החלפה רגילה: יום אחר ───────────────────────────────────────────
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'גבעון', v_t, v_t + interval '90 minutes', 'approved', v_t - interval '30 days')
      returning id into v_old;
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, replaces_request_id)
      values (v_show, v_link, 'גבעון', v_t + interval '1 day', v_t + interval '1 day 90 minutes', v_old)
      returning id into v_new;
    select decided_at into v_dec_before from public.booking_requests where id = v_old;
    v_res := public.booking_approve_replacing(v_new, v_old, now(), null);
    select status, decided_at into v_st_a, v_dec_after from public.booking_requests where id = v_old;
    select status into v_st_b from public.booking_requests where id = v_new;
    v_rep := v_rep || E'\n  swap: result=' || v_res || ' expected=swapped'
                   || ' old=' || v_st_a || ' expected=cancelled'
                   || ' new=' || v_st_b || ' expected=approved'
                   || ' old_decided_at_kept=' || (v_dec_after = v_dec_before)::text || ' expected=true';
    if v_res <> 'swapped' or v_st_a <> 'cancelled' or v_st_b <> 'approved' or v_dec_after <> v_dec_before then
      raise exception 'ההחלפה הרגילה לא עבדה';
    end if;

    -- 🔴 3. החלפה חופפת באותו אולפן: 09:00 → 09:30 (ה-EXCLUDE לא חוסם)
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'גבעון גדול', v_t + interval '7 days', v_t + interval '7 days 90 minutes', 'approved', now())
      returning id into v_c;
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, replaces_request_id)
      values (v_show, v_link, 'גבעון גדול', v_t + interval '7 days 30 minutes', v_t + interval '7 days 120 minutes', v_c)
      returning id into v_d;
    v_res := public.booking_approve_replacing(v_d, v_c, now(), null);
    select status into v_st_a from public.booking_requests where id = v_c;
    select status into v_st_b from public.booking_requests where id = v_d;
    v_rep := v_rep || E'\n  overlapping swap: result=' || v_res || ' expected=swapped'
                   || ' old=' || v_st_a || ' expected=cancelled'
                   || ' new=' || v_st_b || ' expected=approved';
    if v_res <> 'swapped' or v_st_a <> 'cancelled' or v_st_b <> 'approved' then
      raise exception 'ההחלפה החופפת לא עבדה';
    end if;

    -- 4. חזרה לאחור על ההחלפה החופפת
    v_res := public.booking_revert_replacing(v_d, v_c);
    select status into v_st_a from public.booking_requests where id = v_c;
    select status into v_st_b from public.booking_requests where id = v_d;
    v_rep := v_rep || E'\n  revert: result=' || v_res || ' expected=reverted'
                   || ' old=' || v_st_a || ' expected=approved'
                   || ' new=' || v_st_b || ' expected=pending';
    if v_res <> 'reverted' or v_st_a <> 'approved' or v_st_b <> 'pending' then
      raise exception 'החזרה לאחור לא עבדה';
    end if;

    -- ── 5. מה שחייב להיכשל ────────────────────────────────────────────────
    -- 🔴 החדשה אינה ממתינה → גם ביטול הישנה מתגלגל
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'חשמונאים', v_t + interval '14 days', v_t + interval '14 days 90 minutes', 'approved', now())
      returning id into v_f;
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at, status, decided_at)
      values (v_show, v_link, 'חשמונאים', v_t + interval '15 days', v_t + interval '15 days 90 minutes', 'declined', now())
      returning id into v_e;
    begin
      v_res := public.booking_approve_replacing(v_e, v_f, now(), null);
      raise exception 'החלפה עם בקשה חדשה שאינה ממתינה עברה';
    exception when sqlstate 'P0002' then
      v_caught := v_caught + 1;
    end;
    select status into v_st_a from public.booking_requests where id = v_f;
    v_rep := v_rep || E'\n  failed swap rolls back: old=' || v_st_a || ' expected=approved';
    if v_st_a <> 'approved' then
      raise exception 'כשל בהחלפה השאיר את הישנה מבוטלת — אסור ששתיהן יהיו מבוטלות';
    end if;

    -- ה-EXCLUDE עדיין שומר: אישור רגיל של בקשה חופפת להקלטה מאושרת
    insert into public.booking_requests (show_id, link_id, studio, start_at, end_at)
      values (v_show, v_link, 'גבעון גדול', v_t + interval '7 days 30 minutes', v_t + interval '7 days 120 minutes')
      returning id into v_g;
    begin
      update public.booking_requests set status = 'approved', decided_at = now() where id = v_g;
      raise exception 'שתי הקלטות מאושרות חופפות התקבלו';
    exception when exclusion_violation then
      v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  exclusion still guards plain approval: caught=1';

    begin
      update public.booking_requests set replaces_request_id = id where id = v_g;
      raise exception 'בקשה שמחליפה את עצמה התקבלה';
    exception when check_violation then
      v_caught := v_caught + 1;
    end;
    begin
      update public.booking_requests set calendar_delete_status = 'gone' where id = v_g;
      raise exception 'calendar_delete_status לא מוכר התקבל';
    exception when check_violation then
      v_caught := v_caught + 1;
    end;

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'ncaught=% expected=%', v_caught, v_expected;
    end if;

    -- ── 6. הרשאות ─────────────────────────────────────────────────────────
    v_anon_exec := has_function_privilege('anon', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
                or has_function_privilege('anon', 'public.booking_revert_replacing(uuid, uuid)', 'execute');
    v_auth_exec := has_function_privilege('authenticated', 'public.booking_approve_replacing(uuid, uuid, timestamptz, uuid)', 'execute')
                or has_function_privilege('authenticated', 'public.booking_revert_replacing(uuid, uuid)', 'execute');
    v_auth_col  := has_column_privilege('authenticated', 'public.booking_requests', 'replaces_request_id', 'select')
                or has_column_privilege('authenticated', 'public.booking_requests', 'calendar_delete_error', 'select');
    v_rep := v_rep || E'\n  anon_execute=' || v_anon_exec::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_execute=' || v_auth_exec::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select_new_columns=' || v_auth_col::text || ' expected=false';
    if v_anon_exec or v_auth_exec then raise exception 'לתפקיד של סשן יש execute על פונקציית ההחלפה'; end if;
    if v_auth_col then raise exception 'ל-authenticated יש SELECT על עמודה חדשה'; end if;

  exception when others then
    v_msg := E'❌ 0105 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0105 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · החלפה: הישנה בוטלה והחדשה אושרה באותה פעולה, והחותמת של הישנה נשמרה\n'
        || E'  · 🔴 הזזה חופפת באותו אולפן עוברת — ה-EXCLUDE אינו חוסם את ההקלטה מול עצמה\n'
        || E'  · חזרה לאחור משחזרת את שתיהן\n'
        || E'  · 🔴 כשל בהחלפה מגלגל גם את ביטול הישנה — אין מצב ששתיהן מבוטלות\n'
        || E'  · ה-EXCLUDE עדיין חוסם שתי הקלטות מאושרות חופפות באישור רגיל\n'
        || E'  · CHECK על replaces_request_id ועל calendar_delete_status תופסים\n'
        || E'  · שלבי השיחה: cancel-confirm נכנס, שלב לא מוכר עדיין נדחה\n'
        || E'  · execute על הפונקציות ל-service_role בלבד, והעמודות החדשות אינן קריאות מסשן\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0105_booking_move_and_calendar_delete.sql';
  raise exception '%', v_msg;
end $dry$;
