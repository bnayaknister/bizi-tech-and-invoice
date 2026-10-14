-- ============================================================================
-- 0113 — T31 שלב א: RLS שמחושב לכל שורה — ארבע הטבלאות החמות.
--          stages · productions · shows · production_log
--
-- ═══ הבעיה (נמדד 14.10) ═══
-- כל policy קוראת לפונקציית הרשאה "חשופה": `can_view_stages()`, `can_view_money()`…
-- בתוך RLS התנאי הוא security-barrier qual, ולכן פונקציה כזו (SECURITY DEFINER,
-- STABLE, בלי ארגומנטים) רצה **פעם אחת לכל שורה** — וכל ריצה שולפת מ-profiles
-- פעמיים (is_approved() בתוכה). `(select fn())` הופך אותה ל-InitPlan שרץ פעם
-- אחת לשאילתה. pg_stat_statements: production_stage_rollup (4,061 שורות stages)
-- 1,203ms בממוצע, עד 3.1 שניות; אותה שאילתה עם `(select can_view_stages())` —
-- 3.2ms. שליפת ההפקות לקנבן ~380ms.
--
-- ═══ מה המיגרציה עושה — ורק את זה ═══
-- נבנית מ-pg_policies של ארבע הטבלאות **בזמן הריצה** — אף policy לא נכתבת כאן
-- ביד. לכל policy: DROP ו-CREATE מחדש עם אותו שם, אותו cmd, אותם roles, אותו
-- PERMISSIVE/RESTRICTIVE, ואותו USING / WITH CHECK, כשהשינוי היחיד הוא:
--   קריאה בלי ארגומנטים לפונקציית הרשאה — can_*() / is_*() / auth.uid() —
--   נעטפת ב-(SELECT fn()).
-- קריאה שמקבלת ארגומנט (ערך מהשורה) אינה תואמת את התבנית `\(\)` ולכן נשארת
-- כמו שהיא. גם now() אינה פונקציית הרשאה ונשארת (היא ממילא קבועה בתוך שאילתה).
-- auth.uid() נעטפת: היא בלי ארגומנטים, אינה תלויה בשורה, וזו ההמלצה של Supabase.
--
-- ═══ הוכחות בתוך הטרנזקציה (נכשל = הכול מתגלגל) ═══
--   1. **הגדרות:** לפני ואחרי — אותו מספר policies בכל טבלה, ולכל אחת אותו שם,
--      cmd, roles ו-permissive; וה-USING/WITH CHECK אחרי, כשמסירים מהם את
--      העטיפה `( SELECT fn() AS x)`, זהים תו-בתו למה שהיה לפני. ואחרי — אין אף
--      קריאה חשופה שנותרה.
--   2. **canary שורות:** לכל סוג משתמש שקיים ב-profiles (צירוף דגלים שונה) ועוד
--      משתמש שאין לו פרופיל — בתפקיד authenticated עם ה-claims שלו — ספירת
--      שורות בכל אחת מארבע הטבלאות לפני ואחרי. חייבת להיות זהה. מספרי ה"לפני"
--      נשמרים בשורת הפנקס, כדי ש-verify ישווה אליהם.
--
-- אפס שינוי נתונים, אפס עמודות (אין gen types), אפס grants.
-- סדר: supabase/verify/0113_dryrun.sql → הקובץ הזה → supabase/verify/0113_verify.sql
-- ============================================================================

do $mig$
declare
  c_tables constant text[] := array['stages', 'productions', 'shows', 'production_log'];
  -- a zero-argument call to an authorisation function. `\(\)` is what keeps a
  -- call with an argument (a column of the row) out of it.
  c_bare constant text := '((?:public\.)?(?:can_[a-z_]+|is_[a-z_]+)\(\)|auth\.uid\(\))';
  -- the deparsed wrapper, as pg_policies prints it back: "( SELECT fn() AS fn)"
  c_wrapped constant text := '\( SELECT ((?:public\.)?[a-z_]+(?:\.[a-z_]+)?\(\)) AS [a-z_]+\)';
  v_before jsonb;
  v_after jsonb;
  v_pol record;
  v_roles text;
  v_using text;
  v_check text;
  v_sql text;
  v_npol int := 0;
  v_nwrap int := 0;
  v_counts_before jsonb := '{}'::jsonb;
  v_counts_after jsonb := '{}'::jsonb;
  v_persona record;
  v_t text;
  v_n bigint;
  v_key text;
  v_uids jsonb := '{}'::jsonb;
  v_totals jsonb := '{}'::jsonb;
begin
  -- >>> BODY
  if exists (select 1 from public.schema_ledger where version = '0113') then
    raise exception '0113 כבר הוחלה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0112') then
    raise exception '0112 טרם הוחלה — הרץ אותה קודם';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = any (c_tables)
                and (coalesce(qual, '') || coalesce(with_check, '')) ~* 'select') then
    raise exception '0113: policy על אחת מארבע הטבלאות כבר מכילה SELECT — עטיפה נעשתה מחוץ לפנקס';
  end if;

  -- ── snapshot "before" ────────────────────────────────────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles::text,
           'permissive', permissive, 'qual', qual, 'with_check', with_check)
         order by tablename, policyname), '[]'::jsonb)
    into v_before
    from pg_policies where schemaname = 'public' and tablename = any (c_tables);

  -- ── canary "before": every kind of user, as authenticated ────────────────
  -- the totals as the owner of the tables sees them (RLS does not apply to
  -- the owner) — verify uses them to tell "sees everything" from "sees nothing"
  foreach v_t in array c_tables loop
    execute format('select count(id) from public.%I', v_t) into v_n;
    v_totals := v_totals || jsonb_build_object(v_t, v_n);
  end loop;
  for v_persona in
    select key, uid from (
      select distinct on (role, approved, studio_admin, can_view_stages, can_view_money,
                          can_edit_stages, can_edit_money, can_manage_users, can_import)
             concat_ws('/', coalesce(role::text, 'no-role'),
                       case when approved then 'approved' else 'unapproved' end,
                       case when studio_admin then 'studio_admin' end,
                       case when can_view_stages then 'vs' end, case when can_view_money then 'vm' end,
                       case when can_edit_stages then 'es' end, case when can_edit_money then 'em' end,
                       case when can_manage_users then 'mu' end) as key,
             id as uid
        from public.profiles
       order by role, approved, studio_admin, can_view_stages, can_view_money,
                can_edit_stages, can_edit_money, can_manage_users, can_import, id
    ) p
    union all
    select 'no-profile', '00000000-0000-0000-0000-000000000000'::uuid
  loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_persona.uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_persona.uid::text, true);
    v_uids := v_uids || jsonb_build_object(v_persona.key, v_persona.uid);
    set local role authenticated;
    foreach v_t in array c_tables loop
      execute format('select count(id) from public.%I', v_t) into v_n;
      v_counts_before := jsonb_set(v_counts_before, array[v_persona.key], coalesce(v_counts_before -> v_persona.key, '{}'::jsonb) || jsonb_build_object(v_t, v_n));
    end loop;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  -- ── the rewrite, from the catalog ────────────────────────────────────────
  for v_pol in
    select tablename, policyname, cmd, permissive, roles, qual, with_check
      from pg_policies where schemaname = 'public' and tablename = any (c_tables)
     order by tablename, policyname
  loop
    select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ' order by r)
      into v_roles from unnest(v_pol.roles) r;
    v_using := case when v_pol.qual is null then null else regexp_replace(v_pol.qual, c_bare, '(SELECT \1)', 'g') end;
    v_check := case when v_pol.with_check is null then null else regexp_replace(v_pol.with_check, c_bare, '(SELECT \1)', 'g') end;

    v_nwrap := v_nwrap
      + coalesce((select count(*) from regexp_matches(coalesce(v_pol.qual, ''), c_bare, 'g')), 0)
      + coalesce((select count(*) from regexp_matches(coalesce(v_pol.with_check, ''), c_bare, 'g')), 0);

    execute format('drop policy %I on public.%I', v_pol.policyname, v_pol.tablename);
    v_sql := format('create policy %I on public.%I as %s for %s to %s',
                    v_pol.policyname, v_pol.tablename, v_pol.permissive, v_pol.cmd, v_roles);
    if v_using is not null then v_sql := v_sql || format(' using (%s)', v_using); end if;
    if v_check is not null then v_sql := v_sql || format(' with check (%s)', v_check); end if;
    execute v_sql;
    v_npol := v_npol + 1;
  end loop;

  -- ── proof 1: the definitions — only the wrapping changed ────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles::text,
           'permissive', permissive,
           'qual', case when qual is null then null else regexp_replace(qual, c_wrapped, '\1', 'g') end,
           'with_check', case when with_check is null then null else regexp_replace(with_check, c_wrapped, '\1', 'g') end)
         order by tablename, policyname), '[]'::jsonb)
    into v_after
    from pg_policies where schemaname = 'public' and tablename = any (c_tables);
  if v_after is distinct from v_before then
    raise exception '0113: ההגדרות אחרי (בלי העטיפה) שונות מלפני. לפני: % · אחרי: %', v_before, v_after;
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = any (c_tables)
                and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''), c_wrapped, '', 'g') ~ c_bare) then
    raise exception '0113: נותרה קריאה חשופה לפונקציית הרשאה';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = any (c_tables)) <> v_npol then
    raise exception '0113: מספר ה-policies השתנה';
  end if;

  -- ── proof 2: canary "after" — the same rows for every kind of user ──────
  for v_key in select jsonb_object_keys(v_uids) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_uids ->> v_key, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uids ->> v_key, true);
    set local role authenticated;
    foreach v_t in array c_tables loop
      execute format('select count(id) from public.%I', v_t) into v_n;
      v_counts_after := jsonb_set(v_counts_after, array[v_key], coalesce(v_counts_after -> v_key, '{}'::jsonb) || jsonb_build_object(v_t, v_n));
    end loop;
    reset role;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  if v_counts_after is distinct from v_counts_before then
    raise exception '0113 canary: ספירת השורות לפי סוג משתמש השתנתה. לפני: % · אחרי: %', v_counts_before, v_counts_after;
  end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0113', now(), 'bnaya',
    'T31 שלב א: RLS — עטיפת קריאות בלי ארגומנטים לפונקציות הרשאה ב-(SELECT fn()) על stages, productions, shows, production_log, '
    || 'כדי שירוצו פעם אחת לשאילתה ולא לכל שורה (rollup 1,203ms -> ~3ms במדידה). ' || v_npol || ' policies נבנו מחדש מ-pg_policies, '
    || v_nwrap || ' קריאות נעטפו; שם/cmd/roles/permissive/לוגיקה זהים (הוכח בטרנזקציה). אפס שינוי נתונים. '
    || '##json## ' || jsonb_build_object('policies_before', v_before, 'canary_before', v_counts_before,
                                         'totals_before', v_totals, 'personas', v_uids)::text);
  -- <<< BODY

  raise notice '✅ 0113: % policies, % קריאות נעטפו', v_npol, v_nwrap;
end $mig$;
