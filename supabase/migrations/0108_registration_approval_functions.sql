-- ============================================================================
-- 0108 — פונקציות אישור / חיבור / דחייה / מחיקה של הרשמות לקוח (E17-5).
--
-- **פונקציות בלבד.** אין טבלה חדשה, אין עמודה חדשה, אין backfill, ואף שורה
-- קיימת לא משתנה בהחלה. שום קוד עדיין לא קורא להן.
--
-- ═══ למה מיגרציה בכלל ═══
-- דרישת הבעלים ל-E17-5: האישור אצלנו הוא **טרנזקציה אחת** — הלקוח עובר ל-
-- active, נוצר פודקאסט, נוצרים אנשי הקשר, וההרשמה מסומנת approved; או שאף
-- אחד מאלה לא קורה. PostgREST מריץ כל קריאה בטרנזקציה משלה, ולכן ארבע קריאות
-- מהאפליקציה הן ארבע טרנזקציות, ונפילה באמצע משאירה חצי-מצב (לקוח active בלי
-- פודקאסט, או פודקאסט בלי מספרים). פונקציה אחת = טרנזקציה אחת.
--
-- ═══ ארבע הפונקציות ═══
--   1. approve_client_registration — הרשמה חדשה (status='pending').
--      🔴 מסרבת אם ללקוח הממתין אין morning_client_id, או שיש לו מזהה מדומה
--      של dry-run (B23). כך "אין לקוח active בלי מזהה מורנינג" אינו כלל של
--      האפליקציה אלא של המסד. האפליקציה כותבת את המזהה על הלקוח הממתין **לפני**
--      הקריאה (ראה סדר הפעולות בדוח), ולכן "נסה שוב" אחרי כישלון כאן לא פונה
--      שוב למורנינג.
--   2. attach_client_registration — הרשמה שהותאמה לכרטיס קיים
--      (status='duplicate'): מספרים לפודקאסט קיים של אותו לקוח, או פודקאסט
--      חדש תחתיו. בלי לקוח חדש ובלי מורנינג.
--   3. reject_client_registration — דחייה: ההרשמה rejected + rejected_at, הלקוח
--      הממתין rejected, הקישור נשרף. כלום לא נשלח ולא נוצר.
--   4. purge_rejected_registrations — המחיקה היומית: הרשמות שנדחו לפני
--      ה-cutoff, האירועים שלהן, גופי ההתראות שנשאו את פרטיהן, הקישור, ושורת
--      הלקוח הנדחה — **אלא אם יש לו קשרים** (הפקות, מסמכים וכו'): אז הלקוח
--      נשאר ונרשם אירוע בלי פרטים אישיים.
--
-- ═══ אידמפוטנטיות ═══
-- approve / attach על הרשמה שכבר approved מחזירות את התוצאה הקיימת
-- (`already: true`) ולא נכשלות — לחיצה כפולה או "נסה שוב" אחרי הצלחה שהתשובה
-- שלה אבדה. reject על הרשמה שכבר rejected — אותו דבר.
--
-- ═══ שגיאות ═══
-- כל סירוב מכוון נזרק עם הודעה שמתחילה ב-`E17:` ומילת קוד אחריה
-- (`E17:name_taken`, `E17:tax_id_taken`, `E17:no_morning_id`, …). האפליקציה
-- ממפה את המילה למשפט. הפרת ייחודיות על שם / ח.פ מתורגמת לאותה מילה.
--
-- ═══ הרשאות ═══
-- SECURITY INVOKER (ברירת המחדל), ו-EXECUTE ל-service_role בלבד. הראוטים
-- בודקים studio_admin לפני הקריאה; מסשן אי אפשר לקרוא להן בכלל. canary בסוף.
-- ⚠️ ב-service role `auth.uid()` ריק, ולכן guard_client_status ו-
--    guard_first_booking_flag (0107) מתירים — זה בדיוק המסלול ש-0107 תכנן.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. supabase/verify/0108_dryrun.sql — יוצר, מריץ את ארבע הפונקציות על נתונים
--      סינתטיים, ומגלגל. **מסיים ב-exception גם בהצלחה.**
--   2. הקובץ הזה.
--   3. supabase/verify/0108_verify.sql — שורה אחת, כל העמודות true.
--   4. npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts
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

  raise notice '✅ 0108: ארבע פונקציות ההרשמה נוצרו.';
end $mig$;
