-- ============================================================================
-- 0119 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0119_tests.sql. הקובץ מחיל את 0119 בתוך הטרנזקציה, מעביר
-- את שירי ל-admin, ומוכיח את ההתנהגות בסשן אמיתי (RLS + טריגר). מסיים
-- ב-`raise exception` — אפס שינוי נשאר. **גם הצלחה היא exception.** השורה
-- האדומה בסוף היא הפלט הצפוי. Supabase SQL Editor אינו מציג NOTICE — כל
-- הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rep   text := '';
  v_msg   text;
  v_owner uuid;
  v_admin uuid;
  v_tech  uuid;
  v_n     bigint;
begin
  begin
    -- ════ גוף 0119, מילה במילה ════
    declare
      v_n   bigint;
      v_def text;
    begin
      -- ═══ 0. guards ═══
      if exists (select 1 from public.schema_ledger where version = '0119') then
        raise exception '0119 כבר רשומה בפנקס — אל תריץ שוב';
      end if;
      if not exists (select 1 from public.schema_ledger where version = '0118') then
        raise exception '0118 טרם הוחלה — הרץ אותה קודם';
      end if;
      select pg_get_constraintdef(oid) into v_def from pg_constraint
       where conrelid = 'public.profiles'::regclass and conname = 'profiles_role_check';
      if v_def is distinct from 'CHECK ((role = ANY (ARRAY[''owner''::text, ''tech''::text, ''bookkeeper''::text])))' then
        raise exception '0119: profiles_role_check אינו בצורה הצפויה: %', v_def;
      end if;
      if pg_get_functiondef('public.is_owner()'::regprocedure) not like '%role = ''owner''%' then
        raise exception '0119: is_owner() אינה בצורה הצפויה — עצור וברר';
      end if;
      if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('is_owner_strict', 'guard_profile_permissions')) then
        raise exception '0119: is_owner_strict / guard_profile_permissions כבר קיימות — עצור וברר';
      end if;
      select count(*) into v_n from pg_policies
       where schemaname = 'public' and tablename = 'profiles'
         and ((policyname = 'profiles_manager_update' and qual = 'can_manage_users()' and with_check = 'can_manage_users()')
           or (policyname = 'profiles_manager_delete' and qual = 'can_manage_users()'));
      if v_n <> 2 then
        raise exception '0119: מדיניות העדכון/מחיקה של profiles אינה בצורה הצפויה (%/2)', v_n;
      end if;

      -- ═══ 1. role check: + admin ═══
      alter table public.profiles drop constraint profiles_role_check;
      alter table public.profiles add constraint profiles_role_check
        check (role = any (array['owner', 'admin', 'tech', 'bookkeeper']));

      -- ═══ 2. is_owner_strict(): owner only ═══
      create function public.is_owner_strict()
       returns boolean
       language sql
       stable security definer
       set search_path to 'public'
      as $f$
        select public.is_approved() and role = 'owner' from public.profiles where id = auth.uid();
      $f$;
      revoke all on function public.is_owner_strict() from public;
      grant execute on function public.is_owner_strict() to anon, authenticated, service_role;
      comment on function public.is_owner_strict() is
        'U1-4 (0119): true only for an approved role=''owner''. Gates user management (profiles_manager_update / profiles_manager_delete, trg_guard_profile_permissions). For owner-level access that includes admin, use is_owner().';

      -- ═══ 3. is_owner(): owner OR admin ═══
      create or replace function public.is_owner()
       returns boolean
       language sql
       stable security definer
       set search_path to 'public'
      as $f$
        select public.is_approved() and role in ('owner', 'admin') from public.profiles where id = auth.uid();
      $f$;
      comment on function public.is_owner() is
        'U1-4 (0119): returns true for role=''owner'' AND role=''admin'' (owner-level access: app_settings, events, assistant_queries, stages_removed_snapshot, archive functions). For owner ONLY (user management), use is_owner_strict().';

      -- ═══ 4. user management: owner only ═══
      alter policy profiles_manager_update on public.profiles
        using (can_manage_users() and is_owner_strict())
        with check (can_manage_users() and is_owner_strict());
      alter policy profiles_manager_delete on public.profiles
        using (can_manage_users() and is_owner_strict());

      -- ═══ 5. no permission change by a non-owner session, own row included ═══
      create function public.guard_profile_permissions()
       returns trigger
       language plpgsql
       set search_path to 'public'
      as $f$
      begin
        if auth.uid() is not null and not coalesce(public.is_owner_strict(), false) then
          if new.role is distinct from old.role
             or new.approved is distinct from old.approved
             or new.can_view_money is distinct from old.can_view_money
             or new.can_edit_money is distinct from old.can_edit_money
             or new.can_view_stages is distinct from old.can_view_stages
             or new.can_edit_stages is distinct from old.can_edit_stages
             or new.can_manage_users is distinct from old.can_manage_users
             or new.can_import is distinct from old.can_import
          then
            raise exception 'רק בעלים יכול לשנות תפקיד, אישור או הרשאות';
          end if;
        end if;
        return new;
      end;
      $f$;
      revoke all on function public.guard_profile_permissions() from public;
      grant execute on function public.guard_profile_permissions() to authenticated, service_role;
      create trigger trg_guard_profile_permissions
        before update on public.profiles
        for each row execute function public.guard_profile_permissions();

      -- ═══ 6. canaries ═══
      select count(*) into v_n from pg_attribute
       where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
         and attname like 'can\_%' and attname not in
           ('can_view_money', 'can_edit_money', 'can_view_stages', 'can_edit_stages', 'can_manage_users', 'can_import');
      if v_n <> 0 then
        raise exception '0119 canary: ל-profiles יש עמודת can_* שהטריגר אינו מכסה (%)', v_n;
      end if;
      if pg_get_constraintdef((select oid from pg_constraint where conrelid = 'public.profiles'::regclass
                                and conname = 'profiles_role_check')) not like '%''admin''%' then
        raise exception '0119 canary: ה-check אינו מתיר admin';
      end if;
      select count(*) into v_n from pg_policies
       where schemaname = 'public' and tablename = 'profiles'
         and policyname in ('profiles_manager_update', 'profiles_manager_delete')
         and qual like '%is_owner_strict()%';
      if v_n <> 2 then
        raise exception '0119 canary: is_owner_strict אינה במדיניות העדכון/מחיקה (%/2)', v_n;
      end if;
      if not exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass
                      and tgname = 'trg_guard_profile_permissions' and tgenabled = 'O') then
        raise exception '0119 canary: הטריגר לא נוצר';
      end if;

      raise notice '0119 OK — admin ב-check, is_owner = owner|admin, is_owner_strict בניהול משתמשים, טריגר הרשאות';

      -- ═══ 7. ledger row, last ═══
      insert into public.schema_ledger (version, applied_at, applied_by, note)
      values ('0119', now(), current_user,
        'U1-4, הכרעות בעלים 19.10: תפקיד admin (הכול חוץ מניהול משתמשים והרשאות). '
        || 'profiles_role_check + admin; is_owner() = owner או admin (כל ה-policies והפונקציות של בעלים נפתחים ל-admin); '
        || 'is_owner_strict() = owner בלבד, נוספה ל-profiles_manager_update/delete; '
        || 'trg_guard_profile_permissions: סשן שאינו owner לא משנה role/approved/can_* בשום שורה, גם לא בשלו. '
        || 'אפס טבלאות, אפס עמודות, אפס שינוי נתונים. התפקיד של שירי מוחלף בנפרד, אחרי דחיפת הקוד.');
    end;
    v_rep := v_rep || E'\n  0. גוף 0119 רץ בתוך הטרנזקציה (guards + canaries עברו)';

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

    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0119 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0119 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
