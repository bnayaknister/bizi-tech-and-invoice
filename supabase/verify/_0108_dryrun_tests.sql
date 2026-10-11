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
