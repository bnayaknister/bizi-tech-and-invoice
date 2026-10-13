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
