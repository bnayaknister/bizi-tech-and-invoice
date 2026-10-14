-- ============================================================================
-- 0113 — אימות. להריץ **אחרי** קובץ המיגרציה.
--
-- קורא בלבד מהמסד. כותב רק לטבלה זמנית של הסשן (_v0113), שממנה נבנית הטבלה
-- שמוצגת בסוף. **כל השורות בעמודה ok חייבות להיות true.**
--
--   · policies — ההגדרות החיות, בלי העטיפה ( SELECT fn() AS x), זהות למה שהיה
--     לפני 0113 (נשמר בשורת הפנקס); אין קריאה חשופה שנותרה.
--   · canary — לכל סוג משתמש שנשמר בפנקס, בתפקיד authenticated: מי שראה את
--     כל השורות לפני 0113 רואה את כל השורות עכשיו, ומי שראה 0 רואה 0. (ההשוואה
--     היא לסוג — "הכול" או "כלום" — ולא למספר, כי שורות נוספו מאז ההחלה.)
--   · EXPLAIN ANALYZE — זמני "אחרי" של production_stage_rollup, שליפת ההפקות
--     לקנבן ו-shows, בתפקיד authenticated. לפני 0113: ~700–1,200ms ל-rollup.
--     ok = מתחת ל-250ms.
-- ============================================================================

create temp table if not exists _v0113 (ord int, check_name text, ok boolean, detail text);
truncate _v0113;

do $v$
declare
  c_tables constant text[] := array['stages', 'productions', 'shows', 'production_log'];
  c_bare constant text := '((?:public\.)?(?:can_[a-z_]+|is_[a-z_]+)\(\)|auth\.uid\(\))';
  c_wrapped constant text := '\( SELECT ((?:public\.)?[a-z_]+(?:\.[a-z_]+)?\(\)) AS [a-z_]+\)';
  v_ledger jsonb;
  v_now jsonb;
  v_key text;
  v_t text;
  v_n bigint;
  v_total bigint;
  v_before bigint;
  v_before_total bigint;
  v_rows jsonb := '[]'::jsonb;
  v_ord int := 0;
  v_owner uuid;
  v_line text;
  v_ms numeric;
  v_ok boolean;
begin
  select substring(note from '##json## (.*)$')::jsonb into v_ledger
    from public.schema_ledger where version = '0113';
  v_ord := v_ord + 1;
  v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'ledger_row_present', 'ok', v_ledger is not null,
                                         'detail', case when v_ledger is null then 'שורת הפנקס 0113 חסרה או בלי ##json##' end);
  if v_ledger is null then
    insert into _v0113 select (r->>'ord')::int, r->>'check_name', (r->>'ok')::boolean, r->>'detail' from jsonb_array_elements(v_rows) r;
    return;
  end if;

  -- ── policies: same definitions, only the wrapping ───────────────────────
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', tablename, 'name', policyname, 'cmd', cmd, 'roles', roles::text,
           'permissive', permissive,
           'qual', case when qual is null then null else regexp_replace(qual, c_wrapped, '\1', 'g') end,
           'with_check', case when with_check is null then null else regexp_replace(with_check, c_wrapped, '\1', 'g') end)
         order by tablename, policyname), '[]'::jsonb)
    into v_now
    from pg_policies where schemaname = 'public' and tablename = any (c_tables);
  v_ord := v_ord + 1;
  v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'policies_same_except_wrapping',
    'ok', v_now = (v_ledger -> 'policies_before'),
    'detail', jsonb_array_length(v_now) || ' policies עכשיו · ' || jsonb_array_length(v_ledger -> 'policies_before') || ' לפני');
  foreach v_t in array c_tables loop
    v_ord := v_ord + 1;
    v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'policy_count_' || v_t,
      'ok', (select count(*) from pg_policies where schemaname = 'public' and tablename = v_t)
            = (select count(*) from jsonb_array_elements(v_ledger -> 'policies_before') p where p->>'table' = v_t),
      'detail', (select count(*) from pg_policies where schemaname = 'public' and tablename = v_t)::text);
  end loop;
  v_ord := v_ord + 1;
  v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'no_bare_auth_call_left',
    'ok', not exists (select 1 from pg_policies
                       where schemaname = 'public' and tablename = any (c_tables)
                         and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''), c_wrapped, '', 'g') ~ c_bare),
    'detail', null);
  v_ord := v_ord + 1;
  v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'rls_still_enabled',
    'ok', (select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relname = any (c_tables)),
    'detail', null);

  -- ── canary: every kind of user sees what it saw ─────────────────────────
  for v_key in select jsonb_object_keys(v_ledger -> 'personas') loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_ledger -> 'personas' ->> v_key, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_ledger -> 'personas' ->> v_key, true);
    foreach v_t in array c_tables loop
      set local role authenticated;
      execute format('select count(id) from public.%I', v_t) into v_n;
      reset role;
      execute format('select count(id) from public.%I', v_t) into v_total;
      v_before := (v_ledger -> 'canary_before' -> v_key ->> v_t)::bigint;
      v_before_total := (v_ledger -> 'totals_before' ->> v_t)::bigint;
      v_ok := case when v_before = 0 then v_n = 0
                   when v_before = v_before_total then v_n = v_total
                   else v_n = v_before end;
      v_ord := v_ord + 1;
      v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', 'canary ' || v_key || ' · ' || v_t, 'ok', v_ok,
        'detail', 'עכשיו ' || v_n || '/' || v_total || ' · לפני 0113 ' || v_before || '/' || v_before_total);
    end loop;
  end loop;

  -- ── EXPLAIN ANALYZE "after", as an approved owner ───────────────────────
  select id into v_owner from public.profiles where approved and role = 'owner' order by studio_admin desc, id limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  for v_key, v_line in
    select * from (values
      ('explain production_stage_rollup', 'select production_id,total,done,in_progress_stages,assignee_ids from public.production_stage_rollup'),
      ('explain שליפת ההפקות לקנבן', 'select id,status,record_date,record_time,guest,studio,on_hold,on_hold_reason,on_hold_since,needs_attention,show_id,calendar_uid,split_index,split_count,calendar_dup_ack,merged_into,legacy,studio_hours,board_archived_at,client_id from public.productions order by id limit 1000'),
      ('explain shows', 'select id,name,color,active,pricing_model from public.shows')
    ) q(k, sql)
  loop
    set local role authenticated;
    v_ms := null;
    declare v_plan text; begin
      for v_plan in execute 'explain (analyze, timing off, summary on) ' || v_line loop
        if v_plan like 'Execution Time%' then v_ms := substring(v_plan from '([0-9.]+) ms')::numeric; end if;
      end loop;
    end;
    reset role;
    v_ord := v_ord + 1;
    v_rows := v_rows || jsonb_build_object('ord', v_ord, 'check_name', v_key, 'ok', v_ms is not null and v_ms < 250,
      'detail', 'Execution Time: ' || coalesce(v_ms::text, '?') || ' ms (authenticated, owner)');
  end loop;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);

  insert into _v0113 select (r->>'ord')::int, r->>'check_name', (r->>'ok')::boolean, r->>'detail' from jsonb_array_elements(v_rows) r;
end $v$;

select check_name, ok, detail from _v0113 order by ord;
