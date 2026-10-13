-- ============================================================================
-- 0112 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0112_dryrun_tests.sql. הקובץ מריץ את הגוף, מוכיח את הטריגר
-- ואת ה-CHECK על הפקות אמיתיות, ומסיים ב-`raise exception` — אפס שינוי נשאר.
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
  v_p uuid;
  v_q uuid;
  v_uid uuid;
  v_ev_before int;
  v_ev_after int;
  v_caught int := 0;
begin
  begin
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_b from public.productions t;

    -- ════ גוף 0112, מילה במילה ════
    if exists (select 1 from public.schema_ledger where version = '0112') then
      raise exception '0112 כבר הוחלה';
    end if;
    if not exists (select 1 from public.schema_ledger where version = '0111') then
      raise exception '0111 טרם הוחלה — הרץ אותה קודם';
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'productions'
                  and column_name in ('board_archived_at', 'board_archived_by')) then
      raise exception '0112: עמודות הארכוב כבר קיימות ב-productions — נוספו מחוץ לפנקס';
    end if;

    select count(*) into v_rows_before from public.productions;

    alter table public.productions
      add column board_archived_at timestamptz,
      add column board_archived_by uuid references public.profiles(id) on delete set null;

    alter table public.productions
      add constraint productions_board_archive_status_chk
      check (board_archived_at is null or status = 'הופץ');
    alter table public.productions
      add constraint productions_board_archive_by_chk
      check (board_archived_by is null or board_archived_at is not null);

    comment on column public.productions.board_archived_at is
      'Q10: מתי ההפקה הוסתרה מטור "הופץ" בקנבן. תצוגה בלבד — אינה משנה status, כסף או מסמכים, ושום מסך מלבד הקנבן אינו מסנן לפיה. מתנקה אוטומטית בכל שינוי status (trg_board_archive).';
    comment on column public.productions.board_archived_by is
      'Q10: מי ארכב (studio_admin, דרך השרת). NULL כשלא מאורכבת.';

    create or replace function public.board_archive_guard()
    returns trigger language plpgsql security definer set search_path = public as $fn$
    begin
      if tg_op = 'INSERT' then
        if new.board_archived_at is not null or new.board_archived_by is not null then
          raise exception 'Q10: הפקה חדשה אינה נולדת מאורכבת';
        end if;
        return new;
      end if;

      -- הכרעה 3: כל שינוי status מחזיר את ההפקה לקנבן, מכל מסלול שהוא
      if new.status is distinct from old.status then
        if old.board_archived_at is not null then
          insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
          values ('production', new.id, 'production_board_unarchived', auth.uid(),
                  jsonb_build_object('reason',      'status_change',
                                     'from_status', old.status::text,
                                     'to_status',   new.status::text,
                                     'archived_at', old.board_archived_at,
                                     'archived_by', old.board_archived_by,
                                     'fired_by',    'trigger'));
        end if;
        new.board_archived_at := null;
        new.board_archived_by := null;
        return new;
      end if;

      -- הכרעה 5: ארכוב ושליפה — רק השרת (service role / SQL Editor), לא סשן
      if (new.board_archived_at is distinct from old.board_archived_at
          or new.board_archived_by is distinct from old.board_archived_by)
         and auth.uid() is not null then
        raise exception 'Q10: ארכוב בקנבן נעשה רק דרך השרת (studio_admin)';
      end if;
      return new;
    end;
    $fn$;

    revoke all on function public.board_archive_guard() from public, anon, authenticated;

    drop trigger if exists trg_board_archive on public.productions;
    create trigger trg_board_archive
      before insert or update on public.productions
      for each row execute function public.board_archive_guard();

    -- הקנבן קורא את העמודות דרך קליינט המשתמש (0070: רשימת היתר עמודתית)
    grant select (board_archived_at, board_archived_by) on public.productions to authenticated;

    -- ── canary ────────────────────────────────────────────────────────────────
    select count(*) into v_rows_after from public.productions;
    if v_rows_after <> v_rows_before then
      raise exception '0112 canary: nrows before=% after=%', v_rows_before, v_rows_after;
    end if;
    if exists (select 1 from public.productions where board_archived_at is not null or board_archived_by is not null) then
      raise exception '0112 canary: עמודות חדשות אינן ריקות';
    end if;
    if not has_column_privilege('authenticated', 'public.productions', 'board_archived_at', 'SELECT')
       or not has_column_privilege('authenticated', 'public.productions', 'board_archived_by', 'SELECT') then
      raise exception '0112 canary: הקנבן לא יוכל לקרוא את עמודות הארכוב';
    end if;
    if has_column_privilege('anon', 'public.productions', 'board_archived_at', 'SELECT') then
      raise exception '0112 canary: anon קורא את עמודות הארכוב';
    end if;
    if has_table_privilege('authenticated', 'public.productions', 'SELECT') then
      raise exception '0112 canary: SELECT ברמת טבלה חזר ל-authenticated — 0070 נפתחה';
    end if;
    if has_column_privilege('authenticated', 'public.productions', 'price_override', 'SELECT') then
      raise exception '0112 canary: price_override קריאה לסשן — 0070 נפתחה';
    end if;
    if not exists (select 1 from pg_trigger where tgname = 'trg_board_archive'
                     and tgrelid = 'public.productions'::regclass and not tgisinternal) then
      raise exception '0112 canary: הטריגר חסר';
    end if;

    insert into public.schema_ledger (version, applied_at, applied_by, note)
    values ('0112', now(), 'bnaya',
      'Q10: ארכוב הפקות מטור "הופץ" בקנבן — תצוגה בלבד. productions.board_archived_at/_by (ריקות; ' || v_rows_before || ' שורות לא זזו). '
      'trg_board_archive (BEFORE INSERT/UPDATE, security definer): כל שינוי status מנקה את הארכוב ורושם production_board_unarchived — '
      'תופס את כל מסלולי הסטטוס כולל applyResponse של קישור הביקורת; שינוי העמודות מסשן מחובר נדחה (רק הראוט, studio_admin, ב-service role); '
      'הפקה חדשה אינה נולדת מאורכבת. CHECK: מאורכבת => status=הופץ; by => at. grant select לשתי העמודות ל-authenticated (0070 = רשימת היתר עמודתית). '
      'שום מסך מלבד הקנבן אינו מסנן לפיהן: לא הסנכרון, לא החיפוש, לא הרדאר, לא החיוב. אפס backfill, אפס DELETE.');

    -- ════ ההוכחות ════
    select md5(coalesce(string_agg((to_jsonb(t) - 'board_archived_at' - 'board_archived_by')::text, '|' order by t.id), ''))
      into v_md5_a from public.productions t;
    if v_md5_a <> v_md5_b then raise exception 'md5: שורה קיימת השתנתה'; end if;
    v_rep := v_rep || E'\n  nrows=' || v_rows_after || E'\n  md5 השורות הקיימות (בלי העמודות החדשות): ללא שינוי';

    select id into v_p from public.productions where status = 'הופץ' order by id limit 1;
    select id into v_q from public.productions where status not in ('הופץ', 'בוטל') order by id limit 1;
    select id into v_uid from public.profiles where approved and can_edit_stages order by id limit 1;
    if v_p is null or v_q is null or v_uid is null then
      raise exception 'אין נתוני בדיקה: הופץ=% אחר=% פרופיל=%', v_p, v_q, v_uid;
    end if;

    -- 1. השרת (auth.uid() ריק) מארכב הפקה ב"הופץ"
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    update public.productions set board_archived_at = now(), board_archived_by = v_uid where id = v_p;
    if not exists (select 1 from public.productions where id = v_p and board_archived_at is not null) then
      raise exception 'ארכוב מהשרת לא נשמר';
    end if;
    v_rep := v_rep || E'\n  1. ארכוב מהשרת: נשמר';

    -- 2. סשן מחובר אינו יכול לשלוף/לארכב בעצמו
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    begin
      update public.productions set board_archived_at = null, board_archived_by = null where id = v_p;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'סשן הצליח לשנות את הארכוב'; end if;
      v_caught := v_caught + 1;
    end;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    v_rep := v_rep || E'\n  2. שינוי העמודות מסשן: נדחה';

    -- 3. CHECK: הפקה שאינה ב"הופץ" אינה ניתנת לארכוב
    begin
      update public.productions set board_archived_at = now() where id = v_q;
      raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      update public.productions set board_archived_by = v_uid where id = v_q;
      raise exception 'NOT_CAUGHT';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  3. CHECK: ארכוב מחוץ ל"הופץ" ו-by בלי at נדחו';

    -- 4. בקשת תיקון מהקישור (applyResponse כותב 'בעריכה') מבטלת את הארכוב
    select count(*) into v_ev_before from public.events where entity_id = v_p and event_type = 'production_board_unarchived';
    update public.productions set status = 'בעריכה' where id = v_p;
    if exists (select 1 from public.productions where id = v_p and (board_archived_at is not null or board_archived_by is not null)) then
      raise exception 'שינוי status לא ניקה את הארכוב';
    end if;
    select count(*) into v_ev_after from public.events where entity_id = v_p and event_type = 'production_board_unarchived'
      and payload->>'from_status' = 'הופץ' and payload->>'to_status' = 'בעריכה';
    if v_ev_after <> v_ev_before + 1 then raise exception 'לא נרשם אירוע production_board_unarchived'; end if;
    v_rep := v_rep || E'\n  4. status הופץ→בעריכה: הארכוב נוקה ונרשם אירוע';

    -- 5. גרירה בקנבן מסשן (בעל can_edit_stages) בחזרה ל"הופץ" + ניסיון לארכב באותו UPDATE:
    --    שינוי status לעולם אינו משאיר הפקה מאורכבת
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    update public.productions set status = 'הופץ', board_archived_at = now(), board_archived_by = v_uid where id = v_p;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if exists (select 1 from public.productions where id = v_p and board_archived_at is not null) then
      raise exception 'שינוי status יחד עם ארכוב השאיר הפקה מאורכבת';
    end if;
    v_rep := v_rep || E'\n  5. שינוי status + ניסיון ארכוב באותו UPDATE: לא מאורכבת';

    -- 6. ארכוב מחדש, ואז מעבר לסטטוס אחר מהשרת (כמו ביטול / קישור) — מתנקה
    update public.productions set board_archived_at = now(), board_archived_by = v_uid where id = v_p;
    update public.productions set status = 'נשלח_ללקוח' where id = v_p;
    if exists (select 1 from public.productions where id = v_p and board_archived_at is not null) then
      raise exception 'שינוי status מהשרת לא ניקה את הארכוב';
    end if;
    v_rep := v_rep || E'\n  6. status מהשרת (הופץ→נשלח_ללקוח): הארכוב נוקה';

    -- 7. UPDATE שאינו נוגע בעמודות ובסטטוס — מסשן — עובר כרגיל
    update public.productions set status = 'הופץ' where id = v_p;
    update public.productions set board_archived_at = now() where id = v_p;
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    update public.productions set needs_attention = needs_attention where id = v_p;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if not exists (select 1 from public.productions where id = v_p and board_archived_at is not null) then
      raise exception 'עדכון לא קשור ניקה את הארכוב';
    end if;
    v_rep := v_rep || E'\n  7. עדכון לא קשור מסשן: עבר, הארכוב נשאר';

    v_rep := v_rep || E'\n  caught=' || v_caught;
    if v_caught <> 3 then raise exception 'נתפסו % מתוך 3 ניסיונות אסורים', v_caught; end if;

  exception when others then
    v_msg := E'❌ 0112 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm
          || E'\n\nהכול גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0112 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · העמודות נוספו ריקות; אף ערך קיים לא זז (md5)\n'
        || E'  · השרת מארכב; סשן מחובר אינו יכול לשנות את העמודות\n'
        || E'  · CHECK: רק "הופץ"; by בלי at נדחה\n'
        || E'  · כל שינוי status — מסשן או מהשרת, כולל בעריכה של בקשת תיקון — מנקה ורושם אירוע\n'
        || E'  · שינוי status יחד עם ניסיון ארכוב אינו משאיר הפקה מאורכבת\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0112_board_archive.sql';
  raise exception '%', v_msg;
end $dry$;
