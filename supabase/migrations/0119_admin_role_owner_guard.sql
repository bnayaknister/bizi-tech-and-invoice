-- ============================================================================
-- 0119 — U1-4: an "admin" role beside "owner", and user management for the
-- owner only.
--
-- Plan: docs/plans/U1-user-management.md §U1-4. Owner decisions 19.10:
-- Bnaya + Eli stay owner; Shiri becomes admin = everything except managing
-- users and permissions.
--
-- 1. profiles_role_check also allows 'admin' (today owner / tech / bookkeeper).
-- 2. is_owner() returns true for 'owner' AND 'admin'. It is the ONE gate for
--    the owner-level SQL: app_settings_update, events_owner_select,
--    assistant_queries_owner_select, stages_removed_snapshot_owner, and the
--    archive functions (move_productions_to_archive, move_jobs_to_archive,
--    assistant_archive_client_revenue). Widening it opens all of them to admin
--    without touching any of them.
-- 3. is_owner_strict() — 'owner' only. profiles_manager_update and
--    profiles_manager_delete now demand it on top of can_manage_users(), so an
--    admin (who keeps can_manage_users for the other admin actions: hiding a
--    charge, cancelling a production, tax documents, approvals, deleting a
--    show) cannot change or delete users. profiles_manager_select stays on
--    can_manage_users(): other screens show user names.
-- 4. trg_guard_profile_permissions (BEFORE UPDATE): a session that is not a
--    strict owner cannot change role, approved or any can_* column, on ANY
--    row — its own included. profiles_self_update lets everyone update their
--    own row (name etc.); trg_prevent_self_permission_change already blocks
--    permissions on one's own row for everyone, and this closes the rest for
--    non-owners. auth.uid() null (SQL Editor, service role) is not limited,
--    as in guard_studio_admin_flag. studio_admin keeps its own guard.
--
-- Protecting an owner row from another owner (demote / disable / delete) is
-- in the app (/api/users/[id]), by owner decision — not here.
--
-- No table, no column, no data change. Shiri's role is switched AFTER the
-- code is pushed, as a separate step.
-- database.types.ts gains is_owner_strict and guard_profile_permissions under
-- Functions: run gen types after applying.
-- ============================================================================

do $mig$
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
end $mig$;
