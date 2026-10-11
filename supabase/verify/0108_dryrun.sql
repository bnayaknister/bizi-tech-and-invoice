-- ============================================================================
-- 0108 — DRYRUN. להריץ **לפני** קובץ המיגרציה, ב-SQL Editor.
--
-- בלוק DO אחד: יוצר את ארבע הפונקציות (גוף 0108 מילה במילה, נוצר אוטומטית
-- מקובץ המיגרציה), מריץ אותן על נתונים סינתטיים — אישור, סירובים שמתגלגלים,
-- חיבור לכרטיס קיים, דחייה, מחיקה אחרי 30 יום כולל לקוח עם קשרים — ובסוף
-- זורק exception כדי שהכול יתגלגל.
--
-- ✅ הצלחה = ERROR שמתחיל ב-"DRYRUN OK". כל הודעה אחרת = כישלון; הטקסט אומר
--    איזה שלב. אחרי ההרצה לא נשאר שום דבר במסד — גם לא הפונקציות.
--
-- ⚠️ שלב 6 מניח שאין במסד הרשמה שנדחתה לפני יותר מ-30 יום. היום זה נכון
--    (המתג כבוי, אין הרשמות). אם יש — הוא ייכשל ב-"purged a fresh rejection"
--    ולא ימחק כלום, כי הכול מתגלגל.
--
-- 🔴 נוצר מ-supabase/migrations/0108 + supabase/verify/_0108_dryrun_tests.sql.
--    לא לערוך ידנית: לשנות שם ולבנות מחדש.
-- ============================================================================

do $mig$
begin
  if exists (select 1 from public.schema_ledger where version = '0108') then
    raise exception '0108 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0107') then
    raise exception '0107 טרם הוחלה — הטבלאות שהפונקציות כותבות אינן קיימות';
  end if;

  -- ── 1. אישור הרשמה חדשה ────────────────────────────────────────────────────
  create or replace function public.approve_client_registration(
    p_registration_id uuid,
    p_actor uuid,
    p_client_name text,
    p_normalized_name text,
    p_tax_id text,
    p_show jsonb,
    p_contacts jsonb
  ) returns jsonb
  language plpgsql
  set search_path = public
  as $fn$
  declare
    r public.client_registrations%rowtype;
    c public.clients%rowtype;
    v_show uuid;
    v_c jsonb;
    v_n int := 0;
    v_constraint text;
  begin
    select * into r from public.client_registrations where id = p_registration_id for update;
    if not found then raise exception 'E17:not_found'; end if;

    if r.status = 'approved' then
      select bc.show_id into v_show from public.booking_contacts bc
       where bc.registration_id = r.id limit 1;
      return jsonb_build_object('already', true, 'client_id', r.client_id, 'show_id', v_show);
    end if;
    if r.status <> 'pending' then raise exception 'E17:not_pending'; end if;

    select * into c from public.clients where id = r.client_id for update;
    if not found then raise exception 'E17:client_missing'; end if;
    if c.status <> 'pending' then raise exception 'E17:client_not_pending'; end if;
    -- 🔴 אין לקוח active בלי מזהה מורנינג אמיתי
    if c.morning_client_id is null or c.morning_client_id like 'dry-%' then
      raise exception 'E17:no_morning_id';
    end if;

    if p_client_name is null or char_length(btrim(p_client_name)) = 0 then raise exception 'E17:bad_name'; end if;
    if p_normalized_name is null or char_length(btrim(p_normalized_name)) = 0 then raise exception 'E17:bad_name'; end if;
    if p_tax_id is null or p_tax_id !~ '^[0-9]{9}$' then raise exception 'E17:bad_tax_id'; end if;
    if p_show is null or char_length(btrim(coalesce(p_show->>'name', ''))) = 0 then raise exception 'E17:bad_show'; end if;
    if jsonb_typeof(p_show->'aliases') is distinct from 'array' or jsonb_array_length(p_show->'aliases') = 0 then
      raise exception 'E17:alias_required';
    end if;
    if jsonb_typeof(p_contacts) is distinct from 'array' or jsonb_array_length(p_contacts) not between 1 and 2 then
      raise exception 'E17:bad_contacts';
    end if;

    begin
      update public.clients
         set name = btrim(p_client_name),
             normalized_name = p_normalized_name,
             tax_id = p_tax_id,
             status = 'active'
       where id = c.id;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'clients_tax_id_key' then raise exception 'E17:tax_id_taken'; end if;
      raise exception 'E17:name_taken';
    end;

    insert into public.shows (
      name, client_id, aliases, billing_mode, pricing_model, default_rate, hourly_rate,
      default_studio, first_booking_needs_approval, active
    ) values (
      btrim(p_show->>'name'),
      c.id,
      array(select jsonb_array_elements_text(p_show->'aliases')),
      coalesce((p_show->>'billing_mode')::public.show_billing_mode, 'per_episode'),
      coalesce((p_show->>'pricing_model')::public.show_pricing_model, 'per_episode'),
      nullif(p_show->>'default_rate', '')::numeric,
      nullif(p_show->>'hourly_rate', '')::numeric,
      nullif(btrim(coalesce(p_show->>'default_studio', '')), ''),
      true,
      true
    ) returning id into v_show;

    for v_c in select * from jsonb_array_elements(p_contacts) loop
      insert into public.booking_contacts (show_id, name, wa_id, created_by, registration_id)
      values (v_show, btrim(v_c->>'name'), v_c->>'wa_id', p_actor, r.id)
      on conflict (show_id, wa_id) do nothing;
      v_n := v_n + 1;
    end loop;

    update public.client_registrations
       set status = 'approved', decided_by = p_actor, decided_at = now(), updated_at = now()
     where id = r.id;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('client_registration', r.id, 'client_registration_approved', p_actor,
            jsonb_build_object('client_id', c.id, 'show_id', v_show, 'contacts', v_n,
                               'morning_client_id', c.morning_client_id));

    return jsonb_build_object('already', false, 'client_id', c.id, 'show_id', v_show);
  end;
  $fn$;

  -- ── 2. חיבור הרשמה שהותאמה לכרטיס קיים ─────────────────────────────────────
  create or replace function public.attach_client_registration(
    p_registration_id uuid,
    p_actor uuid,
    p_show_id uuid,
    p_show jsonb,
    p_contacts jsonb
  ) returns jsonb
  language plpgsql
  set search_path = public
  as $fn$
  declare
    r public.client_registrations%rowtype;
    v_card public.clients%rowtype;
    v_show uuid;
    v_c jsonb;
    v_n int := 0;
  begin
    select * into r from public.client_registrations where id = p_registration_id for update;
    if not found then raise exception 'E17:not_found'; end if;

    if r.status = 'approved' then
      select bc.show_id into v_show from public.booking_contacts bc
       where bc.registration_id = r.id limit 1;
      return jsonb_build_object('already', true, 'client_id', r.client_id, 'show_id', v_show);
    end if;
    if r.status <> 'duplicate' then raise exception 'E17:not_duplicate'; end if;

    select * into v_card from public.clients where id = r.duplicate_of_client_id;
    if not found or v_card.status <> 'active' or v_card.merged_into is not null then
      raise exception 'E17:card_not_active';
    end if;
    if jsonb_typeof(p_contacts) is distinct from 'array' or jsonb_array_length(p_contacts) not between 1 and 2 then
      raise exception 'E17:bad_contacts';
    end if;

    if p_show_id is not null then
      -- פודקאסט קיים — חייב להיות של אותו לקוח. הדגל שלו לא משתנה: פודקאסטים
      -- קיימים לא מושפעים (הכרעת בעלים 11.10).
      perform 1 from public.shows where id = p_show_id and client_id = v_card.id;
      if not found then raise exception 'E17:show_not_of_client'; end if;
      v_show := p_show_id;
    else
      if p_show is null or char_length(btrim(coalesce(p_show->>'name', ''))) = 0 then raise exception 'E17:bad_show'; end if;
      if jsonb_typeof(p_show->'aliases') is distinct from 'array' or jsonb_array_length(p_show->'aliases') = 0 then
        raise exception 'E17:alias_required';
      end if;
      insert into public.shows (
        name, client_id, aliases, billing_mode, pricing_model, default_rate, hourly_rate,
        default_studio, first_booking_needs_approval, active
      ) values (
        btrim(p_show->>'name'),
        v_card.id,
        array(select jsonb_array_elements_text(p_show->'aliases')),
        coalesce((p_show->>'billing_mode')::public.show_billing_mode, 'per_episode'),
        coalesce((p_show->>'pricing_model')::public.show_pricing_model, 'per_episode'),
        nullif(p_show->>'default_rate', '')::numeric,
        nullif(p_show->>'hourly_rate', '')::numeric,
        nullif(btrim(coalesce(p_show->>'default_studio', '')), ''),
        true,
        true
      ) returning id into v_show;
    end if;

    for v_c in select * from jsonb_array_elements(p_contacts) loop
      insert into public.booking_contacts (show_id, name, wa_id, created_by, registration_id)
      values (v_show, btrim(v_c->>'name'), v_c->>'wa_id', p_actor, r.id)
      on conflict (show_id, wa_id) do nothing;
      v_n := v_n + 1;
    end loop;

    update public.client_registrations
       set status = 'approved', client_id = v_card.id, decided_by = p_actor,
           decided_at = now(), updated_at = now()
     where id = r.id;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('client_registration', r.id, 'client_registration_attached', p_actor,
            jsonb_build_object('client_id', v_card.id, 'show_id', v_show,
                               'new_show', p_show_id is null, 'contacts', v_n));

    return jsonb_build_object('already', false, 'client_id', v_card.id, 'show_id', v_show);
  end;
  $fn$;

  -- ── 3. דחייה ───────────────────────────────────────────────────────────────
  create or replace function public.reject_client_registration(
    p_registration_id uuid,
    p_actor uuid,
    p_reason text
  ) returns jsonb
  language plpgsql
  set search_path = public
  as $fn$
  declare
    r public.client_registrations%rowtype;
  begin
    select * into r from public.client_registrations where id = p_registration_id for update;
    if not found then raise exception 'E17:not_found'; end if;
    if r.status = 'rejected' then return jsonb_build_object('already', true); end if;
    if r.status = 'approved' then raise exception 'E17:already_approved'; end if;
    if p_reason is not null and char_length(p_reason) > 500 then raise exception 'E17:bad_reason'; end if;

    update public.client_registrations
       set status = 'rejected', rejected_at = now(), decided_at = now(), decided_by = p_actor,
           reject_reason = nullif(btrim(coalesce(p_reason, '')), ''), updated_at = now()
     where id = r.id;

    -- רק לקוח שנולד ממתין בהרשמה הזו. כרטיס קיים (כפילות) לא נוגעים בו.
    if r.client_id is not null then
      update public.clients set status = 'rejected'
       where id = r.client_id and status = 'pending';
    end if;

    if r.link_id is not null then
      update public.registration_links
         set revoked_at = coalesce(revoked_at, now()), used_at = coalesce(used_at, now())
       where id = r.link_id;
    end if;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('client_registration', r.id, 'client_registration_rejected', p_actor,
            jsonb_build_object('was', r.status));

    return jsonb_build_object('already', false);
  end;
  $fn$;

  -- ── 4. המחיקה אחרי 30 יום ─────────────────────────────────────────────────
  create or replace function public.purge_rejected_registrations(p_cutoff timestamptz)
  returns jsonb
  language plpgsql
  set search_path = public
  as $fn$
  declare
    r record;
    v_regs int := 0;
    v_clients int := 0;
    v_kept int := 0;
    v_links boolean;
  begin
    if p_cutoff is null or p_cutoff > now() - interval '29 days' then
      -- מגן מפני קריאה שגויה שמוחקת מוקדם מדי (הכרעת בעלים: 30 יום)
      raise exception 'E17:bad_cutoff';
    end if;

    for r in
      select id, client_id, link_id from public.client_registrations
       where status = 'rejected' and rejected_at < p_cutoff
       for update
    loop
      delete from public.events where entity_type = 'client_registration' and entity_id = r.id;
      -- התראות שנשאו את השם/הפודקאסט/הטלפון: הגוף והמשתנים נמחקים, השורה נשארת
      update public.wa_messages
         set body = '[נמחק — הרשמה שנדחתה]',
             payload = jsonb_build_object('kind', payload->'kind', 'template', payload->'template', 'redacted', true)
       where payload->>'subject_id' = r.id::text;

      delete from public.client_registrations where id = r.id;
      v_regs := v_regs + 1;

      if r.link_id is not null then
        delete from public.registration_links where id = r.link_id;
      end if;

      if r.client_id is not null
         and exists (select 1 from public.clients where id = r.client_id and status = 'rejected') then
        v_links :=
             exists (select 1 from public.productions        where client_id = r.client_id)
          or exists (select 1 from public.documents          where client_id = r.client_id)
          or exists (select 1 from public.jobs               where client_id = r.client_id)
          or exists (select 1 from public.shows              where client_id = r.client_id)
          or exists (select 1 from public.contracts          where client_id = r.client_id)
          or exists (select 1 from public.invoices           where client_id = r.client_id)
          or exists (select 1 from public.pending_documents  where client_id = r.client_id)
          or exists (select 1 from public.misc_productions   where client_id = r.client_id)
          or exists (select 1 from public.client_registrations
                      where client_id = r.client_id or duplicate_of_client_id = r.client_id)
          or exists (select 1 from public.clients where merged_into = r.client_id);
        if v_links then
          v_kept := v_kept + 1;
          insert into public.events (entity_type, entity_id, event_type, payload)
          values ('client', r.client_id, 'rejected_client_kept_has_links', jsonb_build_object('reason', 'has_links'));
        else
          delete from public.clients where id = r.client_id;
          v_clients := v_clients + 1;
        end if;
      end if;
    end loop;

    return jsonb_build_object('registrations', v_regs, 'clients', v_clients, 'kept_with_links', v_kept);
  end;
  $fn$;

  -- ── 5. הרשאות: service_role בלבד ──────────────────────────────────────────
  revoke all on function public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
  revoke all on function public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
  revoke all on function public.reject_client_registration(uuid, uuid, text) from public, anon, authenticated;
  revoke all on function public.purge_rejected_registrations(timestamptz) from public, anon, authenticated;
  grant execute on function public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb) to service_role;
  grant execute on function public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb) to service_role;
  grant execute on function public.reject_client_registration(uuid, uuid, text) to service_role;
  grant execute on function public.purge_rejected_registrations(timestamptz) to service_role;

  -- ── 6. canary ─────────────────────────────────────────────────────────────
  if has_function_privilege('anon', 'public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.reject_client_registration(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.reject_client_registration(uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.purge_rejected_registrations(timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.purge_rejected_registrations(timestamptz)', 'EXECUTE') then
    raise exception '0108 canary: פונקציית הרשמה ניתנת להרצה מסשן — ה-revoke לא תפס (בדוק pg_default_acl)';
  end if;
  if not has_function_privilege('service_role', 'public.approve_client_registration(uuid, uuid, text, text, text, jsonb, jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.attach_client_registration(uuid, uuid, uuid, jsonb, jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.reject_client_registration(uuid, uuid, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.purge_rejected_registrations(timestamptz)', 'EXECUTE') then
    raise exception '0108 canary: ל-service_role אין EXECUTE — הראוטים לא יוכלו לקרוא';
  end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0108', now(), 'bnaya',
    'E17-5: ארבע פונקציות, אפס טבלאות ואפס שינוי נתונים. approve_client_registration — האישור כטרנזקציה אחת (לקוח active עם שם, normalized_name ו-tax_id; פודקאסט עם כינוי ו-first_booking_needs_approval=true; booking_contacts עם registration_id; ההרשמה approved עם מי ומתי); מסרבת בלי morning_client_id אמיתי (לא null ולא dry-). attach_client_registration — הרשמה שהותאמה לכרטיס קיים: מספרים לפודקאסט קיים של הלקוח או פודקאסט חדש תחתיו. reject_client_registration — rejected + rejected_at, לקוח ממתין rejected, קישור נשרף. purge_rejected_registrations — מחיקה אחרי 30 יום: ההרשמה, האירועים שלה, גופי ההתראות, הקישור, ושורת הלקוח הנדחה אם אין לה קשרים. approve/attach/reject אידמפוטנטיות. EXECUTE ל-service_role בלבד, canary בשני הכיוונים.');

  -- ═══════════════════════ DRYRUN — הבדיקות ═══════════════════════
  -- נתונים סינתטיים בלבד, הכול מתגלגל בסוף (exception גם בהצלחה).
  declare
    t_link1 uuid; t_link2 uuid; t_link3 uuid; t_link4 uuid; t_link5 uuid;
    t_c1 uuid; t_c2 uuid; t_c3 uuid; t_c4 uuid; t_card uuid; t_other uuid;
    t_r1 uuid := gen_random_uuid(); t_r2 uuid := gen_random_uuid(); t_r3 uuid := gen_random_uuid();
    t_r4 uuid := gen_random_uuid(); t_r5 uuid := gen_random_uuid();
    t_show_card uuid; t_show_other uuid;
    t_res jsonb; t_err text; t_n int; t_rep text := '';
    t_show jsonb := '{"name":"פודקאסט בדיקה 0108","aliases":["בדיקה0108"],"billing_mode":"per_episode","pricing_model":"per_episode","default_rate":"900","default_studio":"גבעון"}';
    t_contacts jsonb := '[{"name":"איש קשר","wa_id":"972500001081"},{"name":"שני","wa_id":"972500001082"}]';
    t_pre_clients int; t_pre_shows int; t_pre_contacts int;
  begin
    select count(*) into t_pre_clients from public.clients;
    select count(*) into t_pre_shows from public.shows;
    select count(*) into t_pre_contacts from public.booking_contacts;

    -- ── fixtures ──
    insert into public.clients (name, normalized_name, status) values ('כרטיס קיים 0108', 'כרטיס קיים 0108', 'active') returning id into t_card;
    update public.clients set tax_id = '999000108' where id = t_card;
    insert into public.clients (name, normalized_name, status) values ('לקוח אחר 0108', 'לקוח אחר 0108', 'active') returning id into t_other;
    insert into public.shows (name, client_id, aliases) values ('פודקאסט קיים 0108', t_card, array['קיים0108']) returning id into t_show_card;
    insert into public.shows (name, client_id, aliases) values ('פודקאסט זר 0108', t_other, array['זר0108']) returning id into t_show_other;

    insert into public.registration_links (token, expires_at, used_at) values (repeat('a', 43), now() + interval '7 days', now()) returning id into t_link1;
    insert into public.registration_links (token, expires_at, used_at) values (repeat('b', 43), now() + interval '7 days', now()) returning id into t_link2;
    insert into public.registration_links (token, expires_at, used_at) values (repeat('c', 43), now() + interval '7 days', now()) returning id into t_link3;
    insert into public.registration_links (token, expires_at, used_at) values (repeat('d', 43), now() + interval '7 days', now()) returning id into t_link4;
    insert into public.registration_links (token, expires_at, used_at) values (repeat('e', 43), now() + interval '7 days', now()) returning id into t_link5;

    insert into public.clients (name, normalized_name, status) values ('נרשם 1', 'pending:' || t_r1, 'pending') returning id into t_c1;
    insert into public.clients (name, normalized_name, status) values ('נרשם 2', 'pending:' || t_r2, 'pending') returning id into t_c2;
    insert into public.clients (name, normalized_name, status) values ('נרשם 4', 'pending:' || t_r4, 'pending') returning id into t_c4;

    insert into public.client_registrations (id, client_id, status, source, link_id, legal_name, tax_id, emails, phone, podcast_name,
      booking_wa_id_1, booking_name_1, privacy_accepted_at, privacy_version)
    values
      (t_r1, t_c1, 'pending', 'bot', t_link1, 'נרשם 1', '111000108', array['a@b.co'], '972500001081', 'פוד 1', '972500001081', 'א', now(), '11.10.2026'),
      (t_r2, t_c2, 'pending', 'web', t_link2, 'נרשם 2', '222000108', array['a@b.co'], '972500001083', 'פוד 2', '972500001083', 'ב', now(), '11.10.2026'),
      (t_r4, t_c4, 'pending', 'web', t_link4, 'נרשם 4', '444000108', array['a@b.co'], '972500001084', 'פוד 4', '972500001084', 'ד', now(), '11.10.2026');
    insert into public.client_registrations (id, client_id, status, duplicate_of_client_id, source, link_id, legal_name, tax_id, emails, phone, podcast_name,
      booking_wa_id_1, booking_name_1, privacy_accepted_at, privacy_version)
    values
      (t_r3, null, 'duplicate', t_card, 'web', t_link3, 'כפילות', '999000108', array['a@b.co'], '972500001085', 'פוד 3', '972500001085', 'ג', now(), '11.10.2026'),
      (t_r5, null, 'duplicate', t_card, 'web', t_link5, 'כפילות 2', '999000108', array['a@b.co'], '972500001086', 'פוד 5', '972500001086', 'ה', now(), '11.10.2026');

    -- ── 1. בלי מזהה מורנינג → סירוב, ושום דבר לא זז ──
    begin
      perform public.approve_client_registration(t_r1, null, 'לקוח מאושר 0108', 'לקוח מאושר 0108', '111000108', t_show, t_contacts);
      raise exception 'DRYRUN FAIL: approve without morning id passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:no_morning_id' then raise exception 'DRYRUN FAIL 1: %', t_err; end if;
    end;
    -- מזהה מדומה של dry-run (B23) → אותו סירוב
    update public.clients set morning_client_id = 'dry-client-0108' where id = t_c1;
    begin
      perform public.approve_client_registration(t_r1, null, 'לקוח מאושר 0108', 'לקוח מאושר 0108', '111000108', t_show, t_contacts);
      raise exception 'DRYRUN FAIL: approve with dry- id passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:no_morning_id' then raise exception 'DRYRUN FAIL 1b: %', t_err; end if;
    end;
    t_rep := t_rep || E'\n  no_morning_id refused (null + dry-)=true';

    -- ── 2. אישור תקין ──
    update public.clients set morning_client_id = 'morning-0108-real' where id = t_c1;
    t_res := public.approve_client_registration(t_r1, null, 'לקוח מאושר 0108', 'לקוח מאושר 0108', '111000108', t_show, t_contacts);
    if (t_res->>'already')::boolean then raise exception 'DRYRUN FAIL 2: already on first approve'; end if;
    perform 1 from public.clients where id = t_c1 and status = 'active' and tax_id = '111000108'
      and name = 'לקוח מאושר 0108' and normalized_name = 'לקוח מאושר 0108' and morning_client_id = 'morning-0108-real';
    if not found then raise exception 'DRYRUN FAIL 2: client not activated as expected'; end if;
    perform 1 from public.shows where id = (t_res->>'show_id')::uuid and client_id = t_c1
      and first_booking_needs_approval and aliases = array['בדיקה0108'] and default_rate = 900 and default_studio = 'גבעון';
    if not found then raise exception 'DRYRUN FAIL 2: show not as expected'; end if;
    select count(*) into t_n from public.booking_contacts where registration_id = t_r1 and show_id = (t_res->>'show_id')::uuid;
    if t_n <> 2 then raise exception 'DRYRUN FAIL 2: contacts=% expected 2', t_n; end if;
    perform 1 from public.client_registrations where id = t_r1 and status = 'approved' and decided_at is not null;
    if not found then raise exception 'DRYRUN FAIL 2: registration not approved'; end if;
    -- שוב → already, בלי שורה נוספת
    t_res := public.approve_client_registration(t_r1, null, 'x', 'x', '111000108', t_show, t_contacts);
    if not (t_res->>'already')::boolean then raise exception 'DRYRUN FAIL 2b: second approve not idempotent'; end if;
    select count(*) into t_n from public.shows where client_id = t_c1;
    if t_n <> 1 then raise exception 'DRYRUN FAIL 2b: shows for client=% expected 1', t_n; end if;
    t_rep := t_rep || E'\n  approve ok + idempotent=true';

    -- ── 3. שם תפוס → סירוב, והכול מתגלגל (הלקוח עדיין pending, בלי פודקאסט) ──
    update public.clients set morning_client_id = 'morning-0108-two' where id = t_c2;
    begin
      perform public.approve_client_registration(t_r2, null, 'כרטיס קיים 0108', 'כרטיס קיים 0108', '222000108', t_show, t_contacts);
      raise exception 'DRYRUN FAIL: name taken passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:name_taken' then raise exception 'DRYRUN FAIL 3: %', t_err; end if;
    end;
    perform 1 from public.clients where id = t_c2 and status = 'pending' and tax_id is null;
    if not found then raise exception 'DRYRUN FAIL 3: client changed after a refused approve'; end if;
    select count(*) into t_n from public.shows where client_id = t_c2;
    if t_n <> 0 then raise exception 'DRYRUN FAIL 3: a show survived a refused approve'; end if;
    -- ח.פ תפוס
    begin
      perform public.approve_client_registration(t_r2, null, 'שם חדש 0108', 'שם חדש 0108', '999000108', t_show, t_contacts);
      raise exception 'DRYRUN FAIL: tax id taken passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:tax_id_taken' then raise exception 'DRYRUN FAIL 3b: %', t_err; end if;
    end;
    -- כינוי חסר
    begin
      perform public.approve_client_registration(t_r2, null, 'שם חדש 0108', 'שם חדש 0108', '222000108', t_show - 'aliases', t_contacts);
      raise exception 'DRYRUN FAIL: no alias passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:alias_required' then raise exception 'DRYRUN FAIL 3c: %', t_err; end if;
    end;
    t_rep := t_rep || E'\n  name/tax/alias refusals roll back=true';

    -- ── 4. חיבור לכרטיס קיים ──
    begin
      perform public.attach_client_registration(t_r3, null, t_show_other, null, t_contacts);
      raise exception 'DRYRUN FAIL: attach to another client show passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:show_not_of_client' then raise exception 'DRYRUN FAIL 4: %', t_err; end if;
    end;
    t_res := public.attach_client_registration(t_r3, null, t_show_card, null, '[{"name":"ג","wa_id":"972500001085"}]');
    perform 1 from public.client_registrations where id = t_r3 and status = 'approved' and client_id = t_card;
    if not found then raise exception 'DRYRUN FAIL 4: attach (existing) not approved'; end if;
    perform 1 from public.shows where id = t_show_card and not first_booking_needs_approval;
    if not found then raise exception 'DRYRUN FAIL 4: existing show flag changed'; end if;
    t_res := public.attach_client_registration(t_r5, null, null, t_show, '[{"name":"ה","wa_id":"972500001086"}]');
    perform 1 from public.shows where id = (t_res->>'show_id')::uuid and client_id = t_card and first_booking_needs_approval;
    if not found then raise exception 'DRYRUN FAIL 4: attach (new show) not as expected'; end if;
    t_rep := t_rep || E'\n  attach existing/new show + foreign show refused=true';

    -- ── 5. דחייה ──
    t_res := public.reject_client_registration(t_r4, null, 'בדיקה');
    perform 1 from public.client_registrations where id = t_r4 and status = 'rejected' and rejected_at is not null and decided_at is not null;
    if not found then raise exception 'DRYRUN FAIL 5: registration not rejected'; end if;
    perform 1 from public.clients where id = t_c4 and status = 'rejected';
    if not found then raise exception 'DRYRUN FAIL 5: pending client not rejected'; end if;
    perform 1 from public.registration_links where id = t_link4 and revoked_at is not null;
    if not found then raise exception 'DRYRUN FAIL 5: link not burnt'; end if;
    t_res := public.reject_client_registration(t_r4, null, null);
    if not (t_res->>'already')::boolean then raise exception 'DRYRUN FAIL 5b: reject not idempotent'; end if;
    begin
      perform public.reject_client_registration(t_r1, null, null);
      raise exception 'DRYRUN FAIL: rejecting an approved registration passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:already_approved' then raise exception 'DRYRUN FAIL 5c: %', t_err; end if;
    end;
    t_rep := t_rep || E'\n  reject + idempotent + approved refused=true';

    -- ── 6. מחיקה אחרי 30 יום ──
    begin
      perform public.purge_rejected_registrations(now() - interval '1 day');
      raise exception 'DRYRUN FAIL: purge with a recent cutoff passed';
    exception when others then
      get stacked diagnostics t_err = message_text;
      if t_err <> 'E17:bad_cutoff' then raise exception 'DRYRUN FAIL 6: %', t_err; end if;
    end;
    -- עדיין לא 30 יום → כלום
    t_res := public.purge_rejected_registrations(now() - interval '30 days');
    if (t_res->>'registrations')::int <> 0 then raise exception 'DRYRUN FAIL 6: purged a fresh rejection'; end if;
    -- 31 יום: בלי קשרים → נמחקים ההרשמה, הקישור והלקוח
    update public.client_registrations set rejected_at = now() - interval '31 days' where id = t_r4;
    t_res := public.purge_rejected_registrations(now() - interval '30 days');
    if (t_res->>'registrations')::int <> 1 or (t_res->>'clients')::int <> 1 then
      raise exception 'DRYRUN FAIL 6b: %', t_res;
    end if;
    perform 1 from public.clients where id = t_c4;
    if found then raise exception 'DRYRUN FAIL 6b: rejected client survived'; end if;
    perform 1 from public.registration_links where id = t_link4;
    if found then raise exception 'DRYRUN FAIL 6b: link survived'; end if;
    -- עם קשרים → ההרשמה נמחקת, הלקוח נשאר ונרשם אירוע
    insert into public.clients (name, normalized_name, status) values ('נרשם 6', 'pending:dry6', 'pending') returning id into t_c3;
    insert into public.client_registrations (client_id, status, source, legal_name, tax_id, emails, phone, podcast_name,
      booking_wa_id_1, booking_name_1, privacy_accepted_at, privacy_version)
    values (t_c3, 'pending', 'web', 'נרשם 6', '666000108', array['a@b.co'], '972500001087', 'פוד 6', '972500001087', 'ו', now(), '11.10.2026')
    returning id into t_r5;
    perform public.reject_client_registration(t_r5, null, null);
    insert into public.shows (name, client_id, aliases) values ('קשר 0108', t_c3, array['קשר0108']);
    update public.client_registrations set rejected_at = now() - interval '31 days' where id = t_r5;
    t_res := public.purge_rejected_registrations(now() - interval '30 days');
    if (t_res->>'registrations')::int <> 1 or (t_res->>'kept_with_links')::int <> 1 or (t_res->>'clients')::int <> 0 then
      raise exception 'DRYRUN FAIL 6c: %', t_res;
    end if;
    perform 1 from public.clients where id = t_c3;
    if not found then raise exception 'DRYRUN FAIL 6c: a client with links was deleted'; end if;
    perform 1 from public.events where entity_id = t_c3 and event_type = 'rejected_client_kept_has_links';
    if not found then raise exception 'DRYRUN FAIL 6c: no event for the kept client'; end if;
    t_rep := t_rep || E'\n  purge: cutoff guard, 30-day boundary, delete, keep-with-links=true';

    raise exception E'DRYRUN OK — הכול עבר ומתגלגל. (לפני: clients=% shows=% contacts=%)%',
      t_pre_clients, t_pre_shows, t_pre_contacts, t_rep;
  end;
end $mig$;
