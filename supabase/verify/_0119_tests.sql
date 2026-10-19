    -- ════ 0119 tests — shared by 0119_dryrun.sql and 0119_verify.sql ════
    -- Runs as postgres inside a block that always ends in an exception, so
    -- nothing here survives. Real users: the owner (bnayaknister), Shiri
    -- (switched to admin INSIDE this transaction) and one tech.
    select id into v_owner from public.profiles where email = 'bnayaknister@gmail.com';
    select id into v_admin from public.profiles where email = 'shiri.ab@gmail.com';
    select id into v_tech  from public.profiles where email = 'manor.hila@gmail.com';
    if v_owner is null or v_admin is null or v_tech is null then
      raise exception 'tests: חסר אחד המשתמשים (owner/shiri/tech)';
    end if;

    -- T1. the check allows admin (as postgres: no session, the triggers skip)
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    update public.profiles set role = 'admin' where id = v_admin;
    if (select role from public.profiles where id = v_admin) <> 'admin' then
      raise exception 'T1: role=admin לא נשמר';
    end if;
    begin
      update public.profiles set role = 'superuser' where id = v_tech;
      raise exception 'NOT_CAUGHT';
    exception when check_violation then null;
    end;
    v_rep := v_rep || E'\n  T1. ה-check מתיר admin, ודוחה ערך לא מוכר';

    -- T2. is_owner / is_owner_strict per role
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_owner::text, true);
    if not (coalesce(public.is_owner(), false) and coalesce(public.is_owner_strict(), false)) then
      raise exception 'T2: owner — is_owner/is_owner_strict אינן true';
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    if not coalesce(public.is_owner(), false) or coalesce(public.is_owner_strict(), false) then
      raise exception 'T2: admin — צפוי is_owner=true, is_owner_strict=false';
    end if;
    perform set_config('request.jwt.claims', json_build_object('sub', v_tech, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_tech::text, true);
    if coalesce(public.is_owner(), false) or coalesce(public.is_owner_strict(), false) then
      raise exception 'T2: tech — צפוי false בשתיהן';
    end if;
    v_rep := v_rep || E'\n  T2. is_owner: owner ✓ admin ✓ tech ✗ · is_owner_strict: owner ✓ admin ✗ tech ✗';

    -- T3. Shiri as admin, a real authenticated session under RLS
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_admin::text, true);
    execute 'set local role authenticated';

    -- (א) reads events and app_settings, and may update app_settings (is_owner)
    select count(*) into v_n from public.events;
    if v_n = 0 then raise exception 'T3א: admin אינה רואה events'; end if;
    v_rep := v_rep || E'\n  T3א. admin קוראת events (' || v_n || ' שורות)';
    select count(*) into v_n from public.app_settings;
    if v_n = 0 then raise exception 'T3א: admin אינה רואה app_settings'; end if;
    update public.app_settings set updated_at = updated_at;
    get diagnostics v_n = row_count;
    if v_n = 0 then raise exception 'T3א: admin אינה יכולה לעדכן app_settings'; end if;
    v_rep := v_rep || E'\n  T3א. admin קוראת app_settings ומעדכנת אותה (' || v_n || ' שורה)';

    -- (ב) UPDATE on another user's profile: RLS hides it from UPDATE, 0 rows
    update public.profiles set name = name || ' x' where id = v_tech;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'T3ב: admin עדכנה פרופיל של tech (% שורות)', v_n; end if;
    update public.profiles set can_view_money = not can_view_money where id = v_owner;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'T3ב: admin עדכנה פרופיל של owner (% שורות)', v_n; end if;
    delete from public.profiles where id = v_tech;
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'T3ב: admin מחקה פרופיל (% שורות)', v_n; end if;
    v_rep := v_rep || E'\n  T3ב. admin: UPDATE על tech ועל owner ו-DELETE — 0 שורות';

    -- (ג) role / permissions on her own row: the trigger raises
    begin
      update public.profiles set role = 'owner' where id = v_admin;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'T3ג: admin שינתה את ה-role של עצמה'; end if;
      v_rep := v_rep || E'\n  T3ג. admin: שינוי role בשורה של עצמה נדחה: ' || sqlerrm;
    end;
    begin
      update public.profiles set can_import = not can_import where id = v_admin;
      raise exception 'NOT_CAUGHT';
    exception when raise_exception then
      if sqlerrm = 'NOT_CAUGHT' then raise exception 'T3ג: admin שינתה הרשאה של עצמה'; end if;
    end;
    -- her own name still saves (profiles_self_update untouched)
    update public.profiles set name = name where id = v_admin;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'T3ג: admin אינה יכולה לעדכן את השם של עצמה'; end if;
    v_rep := v_rep || E'\n  T3ג. גם can_import של עצמה נדחה; עדכון השם של עצמה עובד';
    execute 'reset role';

    -- T4. the owner still manages users
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_owner::text, true);
    execute 'set local role authenticated';
    update public.profiles set can_import = not can_import where id = v_tech;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'T4: owner אינו יכול לשנות הרשאה של tech (% שורות)', v_n; end if;
    execute 'reset role';
    v_rep := v_rep || E'\n  T4. owner משנה הרשאה של tech (1 שורה)';

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
