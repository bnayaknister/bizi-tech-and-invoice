-- ============================================================================
-- 0120 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- בלוק אחד שמסתיים תמיד ב-`raise exception`, כך שכל מה שנעשה בו מתבטל (כמו
-- ROLLBACK): בדיקות מבנה, הדוח שהבעלים ביקש (רשימת הכוננים עם מספר ההפניות,
-- 0 הפקות עם טקסט כונן שאין לו שורה, 0 שורות היסטוריה עם kong 3 / kong 3\ /
-- wd3), ואחריהם אותן בדיקות התנהגות של supabase/verify/_0120_tests.sql.
-- **גם הצלחה היא exception** — השורה האדומה עם ✅ היא הפלט הצפוי.
-- ============================================================================

do $ver$
declare
  v_rep        text := '';
  v_msg        text;
  v_n          bigint;
  v_p          uuid;
  v_q          uuid;
  v_d          uuid;
  v_d2         uuid;
  v_txt        text;
  v_log_before bigint;
  v_owner      uuid;
  v_tech       uuid;
  v_list       text;
begin
  begin
    -- ════ מבנה ════
    if not exists (select 1 from public.schema_ledger where version = '0120') then
      raise exception 'V: 0120 אינה רשומה בפנקס';
    end if;
    if to_regclass('public.storage_disks') is null then raise exception 'V: אין storage_disks'; end if;
    if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'storage_disks_key_uniq'
                    and indexdef like '%UNIQUE%storage_disk_key(name)%') then
      raise exception 'V: האינדקס הייחודי על המפתח חסר';
    end if;
    if public.storage_disk_key(' WD  3 ') <> 'wd3' then raise exception 'V: storage_disk_key שגויה'; end if;
    if not (select relrowsecurity from pg_class where oid = 'public.storage_disks'::regclass) then
      raise exception 'V: RLS כבוי על storage_disks';
    end if;
    select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'storage_disks';
    if v_n <> 4 then raise exception 'V: % מדיניות על storage_disks (צפוי 4)', v_n; end if;
    if has_table_privilege('anon', 'public.storage_disks', 'select') then raise exception 'V: anon קורא storage_disks'; end if;
    if not has_column_privilege('authenticated', 'public.productions', 'storage_disk_id', 'select') then
      raise exception 'V: authenticated אינו קורא storage_disk_id';
    end if;
    if (select confdeltype from pg_constraint where conrelid = 'public.productions'::regclass and contype = 'f'
         and confrelid = 'public.storage_disks'::regclass) is distinct from 'r' then
      raise exception 'V: המפתח הזר אינו ON DELETE RESTRICT';
    end if;
    select count(*) into v_n from pg_trigger
     where not tgisinternal and tgenabled = 'O'
       and ((tgrelid = 'public.productions'::regclass and tgname in ('trg_disk_sync', 'trg_log_disk_change'))
         or (tgrelid = 'public.storage_disks'::regclass and tgname = 'trg_disk_rename_cascade')
         or (tgrelid = 'public.production_log'::regclass and tgname = 'trg_guard_production_log_edit'));
    if v_n <> 4 then raise exception 'V: % מתוך 4 טריגרים קיימים ופעילים', v_n; end if;
    v_rep := v_rep || E'\n  מבנה: טבלה, אינדקס ייחודי, RLS (4), FK RESTRICT, 4 טריגרים פעילים, הרשאות';

    -- ════ הדוח שהבעלים ביקש ════
    select string_agg(format('%s%s — %s הפקות', d.name, case when d.hidden then ' (מוסתר)' else '' end,
                             (select count(*) from public.productions p where p.storage_disk_id = d.id)),
                      E'\n    ' order by lower(d.name))
      into v_list from public.storage_disks d;
    v_rep := v_rep || E'\n  רשימת הכוננים:\n    ' || coalesce(v_list, '(ריקה)');

    select count(*) into v_n from public.productions
     where storage_disk is not null
       and (storage_disk_id is null
            or storage_disk is distinct from (select d.name from public.storage_disks d where d.id = storage_disk_id));
    if v_n <> 0 then raise exception 'V: % הפקות עם טקסט כונן שאין לו שורה בטבלה', v_n; end if;
    v_rep := v_rep || E'\n  0 הפקות עם טקסט כונן שאין לו שורה בטבלה';

    select count(*) into v_n from public.production_log where kind = 'disk' and note in ('kong 3', 'kong 3\', 'wd3');
    if v_n <> 0 then raise exception 'V: % שורות יומן עם kong 3 / kong 3\ / wd3', v_n; end if;
    select count(*) into v_n from public.events
     where payload #>> '{changes,storage_disk,from}' in ('kong 3', 'kong 3\', 'wd3')
        or payload #>> '{changes,storage_disk,to}' in ('kong 3', 'kong 3\', 'wd3');
    if v_n <> 0 then raise exception 'V: % אירועים עם kong 3 / kong 3\ / wd3', v_n; end if;
    v_rep := v_rep || E'\n  0 שורות היסטוריה (יומן + אירועים) עם kong 3 / kong 3\\ / wd3';

    select count(*) into v_n from public.productions where storage_disk = '2';
    if v_n <> 0 then raise exception 'V: עדיין % הפקות עם "2"', v_n; end if;
    if (select storage_disk from public.productions where id = 'e72387e2-bf88-4ed0-8ee1-8234c266b1b0') is not null then
      raise exception 'V: ההפקה של סטימצקי (e72387e2) עדיין עם כונן';
    end if;
    if exists (select 1 from public.storage_disks where name in ('DESKTOP', 'kong 3', 'wd3', '2')) then
      raise exception 'V: DESKTOP / שם שאוחד / "2" ברשימה';
    end if;
    v_rep := v_rep || E'\n  "2" רוקן (סטימצקי e72387e2); DESKTOP, kong 3, wd3 אינם ברשימה';

    -- ════ _0120_tests.sql — behaviour, inside the caller's rolled-back block ════
    -- Needs (declared by the caller): v_rep text, v_n bigint, v_p uuid, v_q uuid,
    -- v_d uuid, v_d2 uuid, v_txt text, v_log_before bigint, v_owner uuid, v_tech uuid.

    -- two real productions that carry a disk (any two)
    select id into v_p from public.productions where storage_disk_id is not null order by id limit 1;
    select id into v_q from public.productions where storage_disk_id is not null and id <> v_p order by id limit 1;
    if v_p is null or v_q is null then raise exception 'T0: אין שתי הפקות עם כונן לבדיקה'; end if;

    -- T1. text written the old way, any spacing/case -> the canonical disk
    update public.productions set storage_disk = ' WD3 ' where id = v_p;
    select storage_disk into v_txt from public.productions where id = v_p;
    if v_txt is distinct from 'wd 3' or (select storage_disk_id from public.productions where id = v_p)
         is distinct from (select id from public.storage_disks where name = 'wd 3') then
      raise exception 'T1: " WD3 " לא תורגם ל-wd 3 (%)', v_txt;
    end if;
    v_rep := v_rep || E'\n  T1. טקסט " WD3 " (קוד ישן) → "wd 3" עם המזהה שלו';

    -- T2. a name not on the list is refused
    begin
      update public.productions set storage_disk = 'disk-that-does-not-exist' where id = v_p;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'T2: שם שאינו ברשימה התקבל'; end if;
      v_rep := v_rep || E'\n  T2. שם שאינו ברשימה נדחה: ' || sqlerrm;
    end;

    -- T3. a new disk, chosen by id: the name follows, the log records it
    insert into public.storage_disks (name) values ('בדיקה 0120') returning id into v_d;
    select count(*) into v_log_before from public.production_log where production_id = v_p and kind = 'disk';
    update public.productions set storage_disk_id = v_d where id = v_p;
    if (select storage_disk from public.productions where id = v_p) is distinct from 'בדיקה 0120' then
      raise exception 'T3: השם לא עקב אחרי המזהה';
    end if;
    select count(*) - v_log_before into v_n from public.production_log where production_id = v_p and kind = 'disk';
    if v_n <> 1 then raise exception 'T3: החלפת כונן רשמה % שורות יומן (צפוי 1)', v_n; end if;
    v_rep := v_rep || E'\n  T3. בחירה לפי מזהה: השם מתעדכן, שורת יומן אחת';

    -- T4. renaming the disk: the production follows, the log does NOT
    select count(*) into v_log_before from public.production_log where production_id = v_p and kind = 'disk';
    update public.storage_disks set name = 'בדיקה 0120 ב' where id = v_d;
    if (select storage_disk from public.productions where id = v_p) is distinct from 'בדיקה 0120 ב' then
      raise exception 'T4: שינוי שם לא הגיע להפקה';
    end if;
    select count(*) - v_log_before into v_n from public.production_log where production_id = v_p and kind = 'disk';
    if v_n <> 0 then raise exception 'T4: שינוי שם כתב % שורות יומן (צפוי 0)', v_n; end if;
    v_rep := v_rep || E'\n  T4. שינוי שם: ההפקה מתעדכנת, אפס שורות יומן (ההיסטוריה שומרת את השם הקודם)';

    -- T5. a duplicate by the key is refused (spaces / case)
    begin
      insert into public.storage_disks (name) values ('בדיקה0120ב');
      raise exception 'NOT_CAUGHT';
    exception when unique_violation then
      v_rep := v_rep || E'\n  T5. כפילות לפי המפתח ("בדיקה0120ב" מול "בדיקה 0120 ב") נדחתה';
    end;
    begin
      insert into public.storage_disks (name) values ('KONG');
      raise exception 'NOT_CAUGHT';
    exception when unique_violation then
      v_rep := v_rep || E'\n  T5ב. "KONG" מול "kong" נדחה';
    end;

    -- T6. hidden: not chosen anew; a production already on it stays and saves
    update public.storage_disks set hidden = true where id = v_d;
    begin
      update public.productions set storage_disk_id = v_d where id = v_q;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'T6: כונן מוסתר נבחר'; end if;
    end;
    begin
      update public.productions set storage_disk = 'בדיקה 0120 ב' where id = v_q;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'T6: כונן מוסתר נבחר בטקסט'; end if;
    end;
    update public.productions set storage_disk = 'בדיקה 0120 ב' where id = v_p;  -- same disk: allowed
    update public.storage_disks set name = 'בדיקה 0120 ג' where id = v_d;          -- rename while hidden
    if (select storage_disk from public.productions where id = v_p) is distinct from 'בדיקה 0120 ג' then
      raise exception 'T6: שינוי שם של כונן מוסתר לא הגיע להפקה שעליו';
    end if;
    v_rep := v_rep || E'\n  T6. מוסתר: לא נבחר מחדש (לפי מזהה וגם בטקסט); הפקה שכבר עליו נשמרת ומתעדכנת בשינוי שם';

    -- T7. delete: refused while a production points at it; allowed once free
    begin
      delete from public.storage_disks where id = v_d;
      raise exception 'NOT_CAUGHT';
    exception when foreign_key_violation then
      v_rep := v_rep || E'\n  T7. מחיקת כונן עם הפקה נחסמה (FK)';
    end;
    update public.productions set storage_disk_id = null where id = v_p;
    if (select storage_disk from public.productions where id = v_p) is not null then
      raise exception 'T7: ניקוי המזהה לא ניקה את השם';
    end if;
    delete from public.storage_disks where id = v_d;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'T7: מחיקת כונן פנוי נכשלה'; end if;
    v_rep := v_rep || E'\n  T7ב. בלי הפקות: נמחק; ניקוי הכונן מההפקה מנקה גם את השם';

    -- T8. a session: the technician reads the list but cannot write it; the owner can
    select id into v_tech from public.profiles
     where approved and coalesce(can_view_stages, false) and role is distinct from 'owner' and role is distinct from 'admin'
     order by id limit 1;
    select id into v_owner from public.profiles where approved and role = 'owner' order by id limit 1;
    if v_tech is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_tech, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_tech::text, true);
      execute 'set local role authenticated';
      select count(*) into v_n from public.storage_disks;
      if v_n = 0 then raise exception 'T8: טכנאי אינו רואה את רשימת הכוננים'; end if;
      begin
        insert into public.storage_disks (name) values ('טכנאי 0120');
        raise exception 'NOT_CAUGHT';
      exception when insufficient_privilege then null;
        when raise_exception then
          if sqlerrm = 'NOT_CAUGHT' then raise exception 'T8: טכנאי הוסיף כונן'; end if;
      end;
      select storage_disk_id into v_d2 from public.productions where id = v_q;  -- the column is readable
      execute 'reset role';
      v_rep := v_rep || E'\n  T8. טכנאי: רואה את הרשימה ואת storage_disk_id, לא מוסיף כונן';
    else
      v_rep := v_rep || E'\n  T8. (אין טכנאי מאושר במסד — דולג)';
    end if;
    if v_owner is not null then
      perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', v_owner::text, true);
      execute 'set local role authenticated';
      insert into public.storage_disks (name) values ('בעלים 0120');
      get diagnostics v_n = row_count;
      execute 'reset role';
      if v_n <> 1 then raise exception 'T8: בעלים לא הוסיף כונן'; end if;
      v_rep := v_rep || E'\n  T8ב. בעלים: מוסיף כונן';
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);

    raise exception 'VERIFY_PASS';
  exception when others then
    if sqlerrm = 'VERIFY_PASS' then
      v_msg := E'✅ 0120 verify עבר. אפס שינוי נשאר מהבדיקות — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0120 verify נכשל.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $ver$;
