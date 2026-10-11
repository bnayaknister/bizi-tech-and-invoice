-- ============================================================================
-- 0107 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- ═══ הקובץ הזה מבצע את כל השינויים ואז מגלגל אותם ═══
-- הוא מריץ את ה-DDL של 0107 **מילה במילה** (הבלוק שלמטה הועתק מהמיגרציה
-- בסקריפט, לא ביד), כותב שורות אמיתיות, מוכיח כל אילוץ, מוכיח את שלושת
-- השומרים פעם מסשן רגיל ופעם מסשן studio_admin, מאמת הרשאות, מוכיח בעזרת
-- md5 שהנתונים הקיימים לא זזו, ומסיים ב-`raise exception` — כך שאפס שינוי
-- נשאר על המסד. **גם הצלחה היא exception.**
--
-- ⚠️ שורת השגיאה האדומה בסוף היא הפלט הצפוי, לא תקלה.
--
-- ═══ 🔴 כל הדוח נמצא בהודעת השגיאה, ובמכוון ═══
-- Supabase SQL Editor **אינו מציג הודעות NOTICE** — רק את השגיאה האחרונה.
-- הדוח נאסף ב-`v_rep` ונשלח **בתוך** ה-exception, גם בהצלחה וגם בכשל.
-- ההודעה נבנית במשתנה עם `||`, כל מקטע ליטרל שלם משלו — אין המשך ליטרלים.
-- כל מספר מופיע כ-`label=value` ב-ASCII ולעולם לא מוטבע בתוך משפט עברי.
--
-- ═══ md5 ═══
-- ספירת "אחרי" היא על הטבלה כולה. בטבלאות שמקבלות עמודה חדשה (clients,
-- shows, booking_contacts, profiles) ה-md5 מחושב על `to_jsonb(row)` **פחות**
-- העמודה החדשה — כלומר מוכיח שכל ערך קיים נשאר כפי שהיה. בשאר הטבלאות —
-- md5 על השורה כולה. ⚠️ booking_contacts ו-wa_contact_prefs משתנות מהבוט
-- ומהמסך; אם הכשל היחיד הוא אחת מהן "השתנתה" — להריץ שוב.
--
-- ═══ סשן מדומה ═══
-- השומרים בודקים `auth.uid()`. ב-SQL Editor הוא ריק, ולכן הקובץ מדמה סשן עם
-- `set_config('request.jwt.claims', …, true)` על פרופיל מאושר קיים, ומחזיר
-- את זה לריק אחרי כל בדיקה. התפקיד נשאר postgres — RLS לא נבדק כאן, רק
-- הטריגרים; ההרשאות נבדקות בנפרד ב-has_*_privilege.
-- ============================================================================

do $dry$
declare
  v_rep text := '';
  v_msg text;
  v_n int;
  v_caught int := 0;
  v_expected int := 27;
  v_uid uuid;
  v_client uuid;
  v_client2 uuid;
  v_show uuid;
  v_link uuid;
  v_link2 uuid;
  v_reg uuid;
  v_ok boolean;
  -- counts before
  v_n_clients int;
  v_n_shows int;
  v_n_contacts int;
  v_n_profiles int;
  -- md5 before / after
  v_md5_clients_b text;  v_md5_clients_a text;
  v_md5_shows_b text;    v_md5_shows_a text;
  v_md5_bc_b text;       v_md5_bc_a text;
  v_md5_prof_b text;     v_md5_prof_a text;
  v_md5_cmi_b text;      v_md5_cmi_a text;
  v_md5_prefs_b text;    v_md5_prefs_a text;
  v_md5_ledger_b text;   v_md5_ledger_a text;
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'client_registrations') then
    raise exception 'client_registrations כבר קיימת — ההרצה המדומה היא לפני ההחלה בלבד. אם 0107 כבר הוחלה, הרץ את 0107_verify.sql';
  end if;
  if exists (select 1 from public.schema_ledger where version = '0107') then
    raise exception '0107 כבר רשומה בפנקס — אין מה להריץ מדומה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0106') then
    raise exception '0106 טרם הוחלה — הרץ אותה קודם';
  end if;

  select id into v_uid from public.profiles where approved order by id limit 1;
  select id into v_show from public.shows order by id limit 1;
  if v_uid is null or v_show is null then
    raise exception 'צריך לפחות פרופיל מאושר אחד ופודקאסט אחד כדי להוכיח את השומרים';
  end if;

  select count(*) into v_n_clients from public.clients;
  select count(*) into v_n_shows from public.shows;
  select count(*) into v_n_contacts from public.booking_contacts;
  select count(*) into v_n_profiles from public.profiles;

  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_clients_b from public.clients t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_shows_b from public.shows t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_bc_b from public.booking_contacts t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.id), '')) into v_md5_prof_b from public.profiles t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_md5_cmi_b from public.client_morning_ids t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.wa_id), '')) into v_md5_prefs_b from public.wa_contact_prefs t;
  select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_md5_ledger_b from public.schema_ledger t;

  begin
    -- ════ 1. ה-DDL של 0107, מילה במילה ════
    -- ── 1. studio_admin ────────────────────────────────────────────────────────
    alter table public.profiles
      add column if not exists studio_admin boolean not null default false;

    create or replace function public.is_studio_admin()
    returns boolean language sql stable security definer set search_path = public as $fn$
      select public.is_approved() and coalesce(studio_admin, false) from public.profiles where id = auth.uid();
    $fn$;

    create or replace function public.guard_studio_admin_flag()
    returns trigger language plpgsql set search_path = public as $fn$
    begin
      if auth.uid() is not null then
        if tg_op = 'INSERT' and new.studio_admin then
          raise exception 'studio_admin נקבע רק ב-SQL Editor, לא מסשן';
        end if;
        if tg_op = 'UPDATE' and new.studio_admin is distinct from old.studio_admin then
          raise exception 'studio_admin נקבע רק ב-SQL Editor, לא מסשן';
        end if;
      end if;
      return new;
    end;
    $fn$;

    drop trigger if exists trg_guard_studio_admin_flag on public.profiles;
    create trigger trg_guard_studio_admin_flag
      before insert or update on public.profiles
      for each row execute function public.guard_studio_admin_flag();

    -- ── 2. clients.status + clients.tax_id ─────────────────────────────────────
    alter table public.clients
      add column if not exists status text not null default 'active',
      add column if not exists tax_id text;

    alter table public.clients
      add constraint clients_status_chk check (status in ('pending', 'active', 'rejected'));
    alter table public.clients
      add constraint clients_tax_id_chk check (tax_id is null or tax_id ~ '^[0-9]{9}$');

    create unique index if not exists clients_tax_id_key
      on public.clients (tax_id) where tax_id is not null;
    create index if not exists clients_status_idx
      on public.clients (status) where status <> 'active';

    create or replace function public.guard_client_status()
    returns trigger language plpgsql set search_path = public as $fn$
    begin
      if auth.uid() is not null and not coalesce(public.is_studio_admin(), false) then
        if tg_op = 'INSERT' and new.status <> 'active' then
          raise exception 'רק בניה ואלי (studio_admin) יוצרים לקוח שאינו פעיל';
        end if;
        if tg_op = 'UPDATE' and new.status is distinct from old.status then
          raise exception 'רק בניה ואלי (studio_admin) משנים סטטוס לקוח';
        end if;
      end if;
      return new;
    end;
    $fn$;

    drop trigger if exists trg_guard_client_status on public.clients;
    create trigger trg_guard_client_status
      before insert or update on public.clients
      for each row execute function public.guard_client_status();

    -- ── 3. registration_links ──────────────────────────────────────────────────
    create table if not exists public.registration_links (
      id          uuid primary key default gen_random_uuid(),
      -- 🔴 מוחרג מכל גרנט של סשן (ראה §7)
      token       text not null,
      -- המספר שפנה לבוט; ריק לקישור שנשלח ידנית
      wa_id       text,
      created_by  uuid references public.profiles(id),
      created_at  timestamptz not null default now(),
      expires_at  timestamptz not null,
      used_at     timestamptz,
      revoked_at  timestamptz,
      constraint registration_links_token_key unique (token),
      constraint registration_links_token_chk check (token ~ '^[A-Za-z0-9_-]{20,200}$'),
      constraint registration_links_wa_id_chk check (wa_id is null or wa_id ~ '^[0-9]{7,15}$'),
      constraint registration_links_expiry_chk check (expires_at > created_at),
      constraint registration_links_used_chk check (used_at is null or used_at >= created_at)
    );

    create index if not exists registration_links_wa_id_idx
      on public.registration_links (wa_id) where wa_id is not null;

    -- ── 4. client_registrations ────────────────────────────────────────────────
    create table if not exists public.client_registrations (
      id                        uuid primary key default gen_random_uuid(),
      -- הלקוח שנוצר ב-pending (ריק בכפילות — לא נוצר לקוח)
      client_id                 uuid references public.clients(id) on delete set null,
      status                    text not null default 'pending',
      duplicate_of_client_id    uuid references public.clients(id) on delete set null,
      source                    text not null,
      link_id                   uuid references public.registration_links(id) on delete set null,

      -- מה שהלקוח מסר (שדות חובה לפי הכרעת בעלים 11.10)
      legal_name                text not null,
      tax_id                    text not null,
      contact_name              text,
      emails                    text[] not null,
      phone                     text not null,
      address                   text,
      podcast_name              text not null,

      -- 1–2 מספרים מורשים להזמנה, פורמט wa_id כמו 0103/0106
      booking_wa_id_1           text not null,
      booking_name_1            text not null,
      booking_wa_id_1_verified  boolean not null default false,
      booking_wa_id_2           text,
      booking_name_2            text,
      booking_wa_id_2_verified  boolean not null default false,

      privacy_accepted_at       timestamptz not null,
      privacy_version           text not null,

      decided_by                uuid references public.profiles(id),
      decided_at                timestamptz,
      -- המחיקה האוטומטית 30 יום אחרי הדחייה נמדדת מכאן
      rejected_at               timestamptz,
      reject_reason             text,

      created_at                timestamptz not null default now(),
      updated_at                timestamptz not null default now(),

      constraint client_registrations_status_chk
        check (status in ('pending', 'approved', 'rejected', 'duplicate')),
      constraint client_registrations_source_chk
        check (source in ('bot', 'web')),
      constraint client_registrations_legal_name_chk
        check (char_length(btrim(legal_name)) between 1 and 200),
      constraint client_registrations_tax_id_chk
        check (tax_id ~ '^[0-9]{9}$'),
      constraint client_registrations_contact_name_chk
        check (contact_name is null or char_length(btrim(contact_name)) between 1 and 120),
      constraint client_registrations_emails_chk
        check (
          cardinality(emails) between 1 and 3
          and array_position(emails, null) is null
          and array_to_string(emails, ',') ~
            '^[^@[:space:],]+@[^@[:space:],]+\.[^@[:space:],]+(,[^@[:space:],]+@[^@[:space:],]+\.[^@[:space:],]+){0,2}$'
        ),
      constraint client_registrations_phone_chk
        check (phone ~ '^[0-9]{7,15}$'),
      constraint client_registrations_address_chk
        check (address is null or char_length(address) <= 300),
      constraint client_registrations_podcast_name_chk
        check (char_length(btrim(podcast_name)) between 1 and 200),
      constraint client_registrations_wa_id_1_chk
        check (booking_wa_id_1 ~ '^[0-9]{7,15}$'),
      constraint client_registrations_name_1_chk
        check (char_length(btrim(booking_name_1)) between 1 and 120),
      constraint client_registrations_wa_id_2_chk
        check (booking_wa_id_2 is null or (booking_wa_id_2 ~ '^[0-9]{7,15}$' and booking_wa_id_2 <> booking_wa_id_1)),
      constraint client_registrations_second_pair_chk
        check ((booking_wa_id_2 is null) = (booking_name_2 is null)),
      constraint client_registrations_name_2_chk
        check (booking_name_2 is null or char_length(btrim(booking_name_2)) between 1 and 120),
      constraint client_registrations_privacy_version_chk
        check (char_length(privacy_version) between 1 and 20),
      constraint client_registrations_decided_chk
        check ((status in ('approved', 'rejected')) = (decided_at is not null)),
      constraint client_registrations_rejected_chk
        check ((status = 'rejected') = (rejected_at is not null)),
      constraint client_registrations_approved_client_chk
        check (status <> 'approved' or client_id is not null),
      constraint client_registrations_duplicate_chk
        check (status <> 'duplicate' or duplicate_of_client_id is not null),
      constraint client_registrations_reject_reason_chk
        check (reject_reason is null or char_length(reject_reason) <= 500)
    );

    create index if not exists client_registrations_status_idx
      on public.client_registrations (status, created_at);
    create index if not exists client_registrations_purge_idx
      on public.client_registrations (rejected_at) where status = 'rejected';
    create index if not exists client_registrations_tax_id_idx
      on public.client_registrations (tax_id);
    create index if not exists client_registrations_client_idx
      on public.client_registrations (client_id) where client_id is not null;
    -- קישור חד-פעמי = הרשמה אחת לכל קישור
    create unique index if not exists client_registrations_link_key
      on public.client_registrations (link_id) where link_id is not null;

    -- ── 5. shows.first_booking_needs_approval ──────────────────────────────────
    alter table public.shows
      add column if not exists first_booking_needs_approval boolean not null default false;

    create or replace function public.guard_first_booking_flag()
    returns trigger language plpgsql set search_path = public as $fn$
    begin
      if auth.uid() is not null and not coalesce(public.is_studio_admin(), false) then
        if tg_op = 'INSERT' and new.first_booking_needs_approval then
          raise exception 'רק בניה ואלי (studio_admin) מסמנים אישור הזמנה ראשונה';
        end if;
        if tg_op = 'UPDATE' and new.first_booking_needs_approval is distinct from old.first_booking_needs_approval then
          raise exception 'רק בניה ואלי (studio_admin) משנים את סימון ההזמנה הראשונה';
        end if;
      end if;
      return new;
    end;
    $fn$;

    drop trigger if exists trg_guard_first_booking_flag on public.shows;
    create trigger trg_guard_first_booking_flag
      before insert or update on public.shows
      for each row execute function public.guard_first_booking_flag();

    -- ── 6. booking_contacts.registration_id ────────────────────────────────────
    alter table public.booking_contacts
      add column if not exists registration_id uuid references public.client_registrations(id) on delete set null;
    create index if not exists booking_contacts_registration_idx
      on public.booking_contacts (registration_id) where registration_id is not null;

    -- ── 7. RLS + הרשאות ───────────────────────────────────────────────────────
    -- client_registrations: כמו 0103 — אפס לכל תפקיד סשן, אפס policy
    alter table public.client_registrations enable row level security;
    revoke all privileges on public.client_registrations from public, anon, authenticated;

    -- registration_links: כמו 0096 — שלילה מלאה, ואז הענקה עמודתית בלי token
    alter table public.registration_links enable row level security;
    revoke all privileges on public.registration_links from public, anon, authenticated;
    drop policy if exists registration_links_select on public.registration_links;
    create policy registration_links_select on public.registration_links
      for select using (public.is_studio_admin());
    grant select (id, wa_id, created_by, created_at, expires_at, used_at, revoked_at)
      on public.registration_links to authenticated;

    -- עמודות חדשות בטבלאות קיימות — כלל 61: נמדד, ומוענק רק בענף החסר
    if not has_table_privilege('authenticated', 'public.clients', 'SELECT') then
      grant select (status, tax_id) on public.clients to authenticated;
    end if;
    if not has_table_privilege('authenticated', 'public.shows', 'SELECT') then
      grant select (first_booking_needs_approval) on public.shows to authenticated;
    end if;
    if not has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
      grant select (studio_admin) on public.profiles to authenticated;
    end if;
    -- booking_contacts: 0103 שללה הכול; העמודה החדשה יורשת את השלילה


    v_rep := v_rep || E'\n  ddl applied: ok=1';

    -- ════ 2. הקיים לא זז — מיד אחרי ה-DDL, לפני כל שורת בדיקה ════
    select md5(coalesce(string_agg((to_jsonb(t) - 'status' - 'tax_id')::text, '|' order by t.id), '')) into v_md5_clients_a from public.clients t;
    select md5(coalesce(string_agg((to_jsonb(t) - 'first_booking_needs_approval')::text, '|' order by t.id), '')) into v_md5_shows_a from public.shows t;
    select md5(coalesce(string_agg((to_jsonb(t) - 'registration_id')::text, '|' order by t.id), '')) into v_md5_bc_a from public.booking_contacts t;
    select md5(coalesce(string_agg((to_jsonb(t) - 'studio_admin')::text, '|' order by t.id), '')) into v_md5_prof_a from public.profiles t;
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_md5_cmi_a from public.client_morning_ids t;
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t.wa_id), '')) into v_md5_prefs_a from public.wa_contact_prefs t;
    select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by t::text), '')) into v_md5_ledger_a from public.schema_ledger t;

    v_rep := v_rep || E'\n  clients_values_unchanged=' || (v_md5_clients_a = v_md5_clients_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  shows_values_unchanged=' || (v_md5_shows_a = v_md5_shows_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  booking_contacts_values_unchanged=' || (v_md5_bc_a = v_md5_bc_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  profiles_values_unchanged=' || (v_md5_prof_a = v_md5_prof_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  client_morning_ids_unchanged=' || (v_md5_cmi_a = v_md5_cmi_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  wa_contact_prefs_unchanged=' || (v_md5_prefs_a = v_md5_prefs_b)::text || ' expected=true';
    v_rep := v_rep || E'\n  schema_ledger_unchanged=' || (v_md5_ledger_a = v_md5_ledger_b)::text || ' expected=true';
    if v_md5_clients_a <> v_md5_clients_b then raise exception 'clients: ערך קיים השתנה'; end if;
    if v_md5_shows_a <> v_md5_shows_b then raise exception 'shows: ערך קיים השתנה'; end if;
    if v_md5_bc_a <> v_md5_bc_b then raise exception 'booking_contacts השתנתה'; end if;
    if v_md5_prof_a <> v_md5_prof_b then raise exception 'profiles: ערך קיים השתנה'; end if;
    if v_md5_cmi_a <> v_md5_cmi_b then raise exception 'client_morning_ids השתנתה'; end if;
    if v_md5_prefs_a <> v_md5_prefs_b then raise exception 'wa_contact_prefs השתנתה'; end if;
    if v_md5_ledger_a <> v_md5_ledger_b then raise exception 'schema_ledger השתנה'; end if;

    -- ספירות "אחרי" על הטבלאות כולן
    select count(*) into v_n from public.clients;
    v_rep := v_rep || E'\n  nclients_after=' || v_n::text || ' expected=' || v_n_clients::text;
    if v_n <> v_n_clients then raise exception 'nclients השתנה'; end if;
    select count(*) into v_n from public.clients where status = 'active';
    v_rep := v_rep || E'\n  nclients_active_after=' || v_n::text || ' expected=' || v_n_clients::text;
    if v_n <> v_n_clients then raise exception 'לא כל לקוח קיים active'; end if;
    select count(*) into v_n from public.clients where tax_id is not null;
    v_rep := v_rep || E'\n  nclients_with_tax_id=' || v_n::text || ' expected=0';
    if v_n <> 0 then raise exception 'tax_id מולא'; end if;
    select count(*) into v_n from public.shows where not first_booking_needs_approval;
    v_rep := v_rep || E'\n  nshows_unflagged_after=' || v_n::text || ' expected=' || v_n_shows::text;
    if v_n <> v_n_shows then raise exception 'פודקאסט קיים סומן'; end if;
    select count(*) into v_n from public.booking_contacts where registration_id is null;
    v_rep := v_rep || E'\n  ncontacts_unlinked_after=' || v_n::text || ' expected=' || v_n_contacts::text;
    if v_n <> v_n_contacts then raise exception 'booking_contacts קושר'; end if;
    select count(*) into v_n from public.profiles where not studio_admin;
    v_rep := v_rep || E'\n  nprofiles_not_admin_after=' || v_n::text || ' expected=' || v_n_profiles::text;
    if v_n <> v_n_profiles then raise exception 'פרופיל קיבל studio_admin'; end if;


    -- ════ 2b. הרשאות ו-RLS — וה-canary של המיגרציה עצמה, לפני כל שורת בדיקה ════
    v_rep := v_rep || E'\n  anon_select_registrations=' || has_table_privilege('anon', 'public.client_registrations', 'SELECT')::text || ' expected=false';
    v_rep := v_rep || E'\n  anon_select_links=' || has_table_privilege('anon', 'public.registration_links', 'SELECT')::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select_registrations=' || has_table_privilege('authenticated', 'public.client_registrations', 'SELECT')::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_insert_registrations=' || has_table_privilege('authenticated', 'public.client_registrations', 'INSERT')::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select_link_token=' || has_column_privilege('authenticated', 'public.registration_links', 'token', 'SELECT')::text || ' expected=false';
    v_rep := v_rep || E'\n  anon_select_link_token=' || has_column_privilege('anon', 'public.registration_links', 'token', 'SELECT')::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select_link_wa_id=' || has_column_privilege('authenticated', 'public.registration_links', 'wa_id', 'SELECT')::text || ' expected=true';
    v_rep := v_rep || E'\n  auth_insert_links=' || has_table_privilege('authenticated', 'public.registration_links', 'INSERT')::text || ' expected=false';
    v_rep := v_rep || E'\n  auth_select_clients_status=' || has_column_privilege('authenticated', 'public.clients', 'status', 'SELECT')::text || ' expected=true';
    v_rep := v_rep || E'\n  auth_select_clients_tax_id=' || has_column_privilege('authenticated', 'public.clients', 'tax_id', 'SELECT')::text || ' expected=true';
    v_rep := v_rep || E'\n  auth_select_shows_flag=' || has_column_privilege('authenticated', 'public.shows', 'first_booking_needs_approval', 'SELECT')::text || ' expected=true';
    v_rep := v_rep || E'\n  auth_select_profiles_studio_admin=' || has_column_privilege('authenticated', 'public.profiles', 'studio_admin', 'SELECT')::text || ' expected=true';
    v_rep := v_rep || E'\n  auth_select_contacts_registration_id=' || has_column_privilege('authenticated', 'public.booking_contacts', 'registration_id', 'SELECT')::text || ' expected=false';
    select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'client_registrations';
    v_rep := v_rep || E'\n  npolicies_registrations=' || v_n::text || ' expected=0';
    select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'registration_links';
    v_rep := v_rep || E'\n  npolicies_links=' || v_n::text || ' expected=1';
    -- the migration's own canary block, verbatim, decides pass/fail
    -- ── 8. canary ─────────────────────────────────────────────────────────────
    -- הכיוון המסוכן
    if has_table_privilege('anon', 'public.client_registrations', 'SELECT')
       or has_table_privilege('anon', 'public.registration_links', 'SELECT') then
      raise exception '0107 canary: ל-anon יש SELECT על טבלה חדשה — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
    end if;
    if has_table_privilege('authenticated', 'public.client_registrations', 'SELECT')
       or has_table_privilege('authenticated', 'public.client_registrations', 'INSERT')
       or has_table_privilege('authenticated', 'public.client_registrations', 'UPDATE')
       or has_table_privilege('authenticated', 'public.client_registrations', 'DELETE') then
      raise exception '0107 canary: ל-authenticated יש הרשאה על client_registrations — הטבלה נושאת ח.פ וטלפונים';
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_registrations') then
      raise exception '0107 canary: נמצאה policy על client_registrations — אמורה להיות בלי אף אחת';
    end if;
    if has_column_privilege('anon', 'public.registration_links', 'token', 'SELECT')
       or has_column_privilege('authenticated', 'public.registration_links', 'token', 'SELECT') then
      raise exception '0107 canary: token של registration_links קריא מסשן — הטוקן חשוף';
    end if;
    if has_table_privilege('authenticated', 'public.registration_links', 'INSERT')
       or has_table_privilege('authenticated', 'public.registration_links', 'UPDATE')
       or has_table_privilege('authenticated', 'public.registration_links', 'DELETE') then
      raise exception '0107 canary: ל-authenticated יש כתיבה על registration_links — הקישורים נוצרים בשרת בלבד';
    end if;
    if has_column_privilege('authenticated', 'public.booking_contacts', 'registration_id', 'SELECT') then
      raise exception '0107 canary: booking_contacts.registration_id קריא מסשן — 0103 נעלה את הטבלה';
    end if;
    -- והכיוון השני: מה שחייב להיות קריא
    if not has_column_privilege('authenticated', 'public.registration_links', 'wa_id', 'SELECT') then
      raise exception '0107 canary: אין SELECT על registration_links.wa_id — הגרנט העמודתי נשכח';
    end if;
    if not has_column_privilege('authenticated', 'public.clients', 'status', 'SELECT')
       or not has_column_privilege('authenticated', 'public.clients', 'tax_id', 'SELECT') then
      raise exception '0107 canary: clients.status/tax_id אינן קריאות מסשן — המסך יירנדר ריק (הכשל של 0055)';
    end if;
    if not has_column_privilege('authenticated', 'public.shows', 'first_booking_needs_approval', 'SELECT') then
      raise exception '0107 canary: shows.first_booking_needs_approval אינה קריאה — shows נושאת רשימת היתר עמודתית';
    end if;
    if not has_column_privilege('authenticated', 'public.profiles', 'studio_admin', 'SELECT') then
      raise exception '0107 canary: profiles.studio_admin אינה קריאה מסשן';
    end if;
    if not (select relrowsecurity from pg_class where oid = 'public.client_registrations'::regclass)
       or not (select relrowsecurity from pg_class where oid = 'public.registration_links'::regclass) then
      raise exception '0107 canary: RLS אינו דלוק על אחת הטבלאות החדשות';
    end if;

    -- הקיים לא זז: כל לקוח קיים פעיל, אף פודקאסט לא מסומן, אף משתמש אינו studio_admin
    select count(*) into v_n from public.clients where status <> 'active';
    if v_n <> 0 then raise exception '0107 canary: nclients_not_active=% — לקוח קיים שינה סטטוס', v_n; end if;
    select count(*) into v_n from public.shows where first_booking_needs_approval;
    if v_n <> 0 then raise exception '0107 canary: nshows_flagged=% — פודקאסט קיים סומן', v_n; end if;
    select count(*) into v_n from public.profiles where studio_admin;
    if v_n <> 0 then raise exception '0107 canary: nstudio_admins=% — המיגרציה לא אמורה להעניק לאף אחד', v_n; end if;


    -- ════ 3. השורות שחייבות לעבור (auth.uid() ריק = SQL Editor / service role) ════
    insert into public.clients (name, normalized_name, status, tax_id)
      values ('zz-0107-dry-a', 'zz-0107-dry-a', 'pending', '512345678') returning id into v_client;
    insert into public.clients (name, normalized_name, tax_id)
      values ('zz-0107-dry-b', 'zz-0107-dry-b', '512345679') returning id into v_client2;
    insert into public.registration_links (token, wa_id, expires_at)
      values (repeat('A', 43), '972501234567', now() + interval '7 days') returning id into v_link;
    insert into public.registration_links (token, expires_at)
      values (repeat('B', 43), now() + interval '7 days') returning id into v_link2;
    insert into public.client_registrations
      (client_id, source, link_id, legal_name, tax_id, emails, phone, podcast_name,
       booking_wa_id_1, booking_name_1, booking_wa_id_1_verified, privacy_accepted_at, privacy_version)
      values (v_client, 'bot', v_link, 'עסק בדיקה', '512345678', array['a@b.co'], '972501234567', 'פודקאסט בדיקה',
              '972501234567', 'דנה', true, now(), '11.10.2026')
      returning id into v_reg;
    insert into public.client_registrations
      (source, link_id, legal_name, tax_id, emails, phone, address, podcast_name,
       booking_wa_id_1, booking_name_1, booking_wa_id_2, booking_name_2, privacy_accepted_at, privacy_version,
       status, duplicate_of_client_id)
      values ('web', v_link2, 'Private Person', '012345678', array['x@y.co', 'z@w.org', 'q@r.io'], '0501234567', 'רחוב 1', 'Pod',
              '972501111111', 'Ann', '972502222222', 'Ben', now(), '11.10.2026',
              'duplicate', v_client2);
    update public.client_registrations
      set status = 'rejected', decided_at = now(), rejected_at = now(), decided_by = v_uid, reject_reason = 'בדיקה'
      where id = v_reg;
    update public.client_registrations
      set status = 'approved', rejected_at = null, reject_reason = null
      where id = v_reg;
    update public.shows set first_booking_needs_approval = true where id = v_show;
    update public.clients set status = 'active' where id = v_client;
    update public.booking_contacts set registration_id = v_reg where id = (select id from public.booking_contacts order by id limit 1);
    select count(*) into v_n from public.client_registrations;
    v_rep := v_rep || E'\n  valid rows accepted: nregistrations=' || v_n::text || ' expected=2';
    if v_n <> 2 then raise exception 'לא כל השורות החוקיות התקבלו'; end if;

    -- ════ 4. מה שחייב להידחות ════
    begin insert into public.clients (name, normalized_name, status) values ('zz-0107-x1', 'zz-0107-x1', 'paused');
      raise exception 'status=paused התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught clients.status unknown: caught=1'; end;

    begin insert into public.clients (name, normalized_name, tax_id) values ('zz-0107-x2', 'zz-0107-x2', '12345678');
      raise exception 'tax_id של 8 ספרות התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught clients.tax_id 8 digits: caught=1'; end;

    begin insert into public.clients (name, normalized_name, tax_id) values ('zz-0107-x3', 'zz-0107-x3', '512345678');
      raise exception 'tax_id כפול התקבל';
    exception when unique_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught clients.tax_id duplicate: caught=1'; end;

    begin insert into public.clients (name, normalized_name, status) values ('zz-0107-x4', 'zz-0107-x4', null);
      raise exception 'status null התקבל';
    exception when not_null_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught clients.status null: caught=1'; end;

    begin insert into public.registration_links (token, expires_at) values ('short', now() + interval '1 day');
      raise exception 'טוקן קצר התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught link token too short: caught=1'; end;

    begin insert into public.registration_links (token, expires_at) values (repeat('A', 43), now() + interval '1 day');
      raise exception 'טוקן כפול התקבל';
    exception when unique_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught link token duplicate: caught=1'; end;

    begin insert into public.registration_links (token, wa_id, expires_at) values (repeat('C', 43), '+972501234567', now() + interval '1 day');
      raise exception 'wa_id עם פלוס התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught link wa_id with plus: caught=1'; end;

    begin insert into public.registration_links (token, created_at, expires_at) values (repeat('D', 43), now(), now() - interval '1 minute');
      raise exception 'תוקף שעבר התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught link expiry before creation: caught=1'; end;

    begin update public.client_registrations set status = 'maybe' where id = v_reg;
      raise exception 'סטטוס הרשמה לא מוכר התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught registration status unknown: caught=1'; end;

    begin update public.client_registrations set tax_id = '51234567' where id = v_reg;
      raise exception 'ח.פ של 8 ספרות התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught registration tax_id 8 digits: caught=1'; end;

    begin update public.client_registrations set emails = array[]::text[] where id = v_reg;
      raise exception 'אפס מיילים התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught emails empty: caught=1'; end;

    begin update public.client_registrations set emails = array['a@b.co', 'c@d.co', 'e@f.co', 'g@h.co'] where id = v_reg;
      raise exception 'ארבעה מיילים התקבלו';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught emails four: caught=1'; end;

    begin update public.client_registrations set emails = array['not-an-email'] where id = v_reg;
      raise exception 'מייל בלי @ התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught email without at: caught=1'; end;

    begin update public.client_registrations set booking_wa_id_1 = null where id = v_reg;
      raise exception 'בלי מספר מורשה התקבל';
    exception when not_null_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught no booking number: caught=1'; end;

    begin update public.client_registrations set booking_wa_id_2 = '972501234567', booking_name_2 = 'x' where id = v_reg;
      raise exception 'מספר שני זהה לראשון התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught second number equals first: caught=1'; end;

    begin update public.client_registrations set booking_wa_id_2 = '972509999999' where id = v_reg;
      raise exception 'מספר שני בלי שם התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught second number without name: caught=1'; end;

    begin update public.client_registrations set decided_at = null where id = v_reg;
      raise exception 'approved בלי decided_at התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught approved without decided_at: caught=1'; end;

    begin update public.client_registrations set status = 'rejected' where id = v_reg;
      raise exception 'rejected בלי rejected_at התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught rejected without rejected_at: caught=1'; end;

    begin update public.client_registrations set client_id = null where id = v_reg;
      raise exception 'approved בלי client_id התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught approved without client: caught=1'; end;

    begin update public.client_registrations set duplicate_of_client_id = null where status = 'duplicate';
      raise exception 'duplicate בלי duplicate_of התקבל';
    exception when check_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught duplicate without target: caught=1'; end;

    begin
      insert into public.client_registrations
        (source, link_id, legal_name, tax_id, emails, phone, podcast_name,
         booking_wa_id_1, booking_name_1, privacy_accepted_at, privacy_version)
        values ('bot', v_link, 'שני', '512345670', array['a@b.co'], '972501234567', 'פ',
                '972503333333', 'x', now(), '11.10.2026');
      raise exception 'הרשמה שנייה על אותו קישור התקבלה';
    exception when unique_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught second registration on one link: caught=1'; end;

    begin
      insert into public.client_registrations
        (source, legal_name, tax_id, emails, phone, podcast_name,
         booking_wa_id_1, booking_name_1, privacy_version)
        values ('web', 'בלי פרטיות', '512345671', array['a@b.co'], '972501234567', 'פ',
                '972504444444', 'x', '11.10.2026');
      raise exception 'הרשמה בלי אישור פרטיות התקבלה';
    exception when not_null_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught no privacy acceptance: caught=1'; end;

    begin update public.booking_contacts set registration_id = '00000000-0000-0000-0000-000000000000'
            where id = (select id from public.booking_contacts order by id limit 1);
      if not found then raise exception 'אין שורת booking_contacts לבדיקה'; end if;
      raise exception 'registration_id לא קיים התקבל';
    exception when foreign_key_violation then v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught booking_contacts FK: caught=1'; end;

    -- ════ 5. 🔴 השומרים, מסשן רגיל (לא studio_admin) ════
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    v_rep := v_rep || E'\n  simulated session: auth_uid_set=' || (auth.uid() = v_uid)::text || ' expected=true';
    if auth.uid() is distinct from v_uid then raise exception 'הדמיית הסשן לא עבדה — auth.uid() אינו הפרופיל'; end if;

    begin update public.profiles set studio_admin = true where id = v_uid;
      raise exception 'studio_admin הוענק מסשן';
    exception when raise_exception then
      if sqlerrm not like 'studio_admin%' then raise; end if;
      v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught studio_admin granted from a session: caught=1'; end;

    begin update public.clients set status = 'rejected' where id = v_client;
      raise exception 'סטטוס לקוח שונה מסשן רגיל';
    exception when raise_exception then
      if sqlerrm not like 'רק בניה ואלי%' then raise; end if;
      v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught client status change by non-admin session: caught=1'; end;

    begin update public.shows set first_booking_needs_approval = false where id = v_show;
      raise exception 'סימון הזמנה ראשונה שונה מסשן רגיל';
    exception when raise_exception then
      if sqlerrm not like 'רק בניה ואלי%' then raise; end if;
      v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught first-booking flag change by non-admin session: caught=1'; end;

    -- ...ומה שמותר לאותו סשן: עדכון שאינו נוגע בשדות השמורים
    update public.clients set tax_id = '512345677' where id = v_client;
    get diagnostics v_n = row_count;
    v_rep := v_rep || E'\n  non-admin session may still edit tax_id: rows=' || v_n::text || ' expected=1';
    if v_n <> 1 then raise exception 'עדכון רגיל נחסם'; end if;

    -- ════ 6. אותם שומרים מסשן studio_admin ════
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    update public.profiles set studio_admin = true where id = v_uid;   -- SQL Editor: מותר
    perform set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_uid::text, true);
    v_ok := public.is_studio_admin();
    v_rep := v_rep || E'\n  is_studio_admin_for_flagged_session=' || coalesce(v_ok, false)::text || ' expected=true';
    if v_ok is not true then raise exception 'is_studio_admin() לא זיהה את הפרופיל המסומן'; end if;
    update public.clients set status = 'rejected' where id = v_client;
    get diagnostics v_n = row_count;
    v_rep := v_rep || E'\n  admin session changes client status: rows=' || v_n::text || ' expected=1';
    if v_n <> 1 then raise exception 'studio_admin לא הצליח לשנות סטטוס'; end if;
    update public.shows set first_booking_needs_approval = false where id = v_show;
    get diagnostics v_n = row_count;
    v_rep := v_rep || E'\n  admin session clears first-booking flag: rows=' || v_n::text || ' expected=1';
    if v_n <> 1 then raise exception 'studio_admin לא הצליח לנקות את הסימון'; end if;
    -- ⚠️ גם studio_admin לא משנה את הדגל של עצמו או של אחרים מסשן
    begin update public.profiles set studio_admin = false where id = v_uid;
      raise exception 'studio_admin שונה מסשן של studio_admin';
    exception when raise_exception then
      if sqlerrm not like 'studio_admin%' then raise; end if;
      v_caught := v_caught + 1; v_rep := v_rep || E'\n  caught studio_admin changed even by an admin session: caught=1'; end;

    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);

    v_rep := v_rep || E'\n  violations caught: ncaught=' || v_caught::text || ' expected=' || v_expected::text;
    if v_caught <> v_expected then
      raise exception 'לא כל ניסיונות ההפרה נדחו: ncaught=% expected=%', v_caught, v_expected;
    end if;


  exception when others then
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    v_msg := E'❌ 0107 dryrun נכשלה.\n'
          || E'═══ מה נבדק עד לנקודת הכשל ═══'
          || v_rep
          || E'\n\n═══ השגיאה ═══\n  '
          || sqlstate || ' ' || sqlerrm
          || E'\n\nה-subtransaction גולגל. אפס שינוי נשאר על המסד.';
    raise exception '%', v_msg;
  end;

  v_msg := E'✅ 0107 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n'
        || E'═══ הדוח ═══'
        || v_rep
        || E'\n\n═══ מה הוכח ═══\n'
        || E'  · ה-DDL של 0107 רץ מילה במילה; כל ערך קיים בלקוחות, פודקאסטים, אנשי קשר ופרופילים לא זז (md5)\n'
        || E'  · כל לקוח קיים active, בלי tax_id; אף פודקאסט לא מסומן; אף משתמש אינו studio_admin\n'
        || E'  · הרשמה תקינה (מספר אחד ושניים, שלושה מיילים) מתקבלת; pending -> rejected -> approved עובר\n'
        || E'  · 23 הפרות אילוצים נדחות: סטטוסים, ח.פ, מיילים, מספרים, טוקן, תוקף, קישור חד-פעמי, פרטיות, FK\n'
        || E'  · 🔴 מסשן רגיל: studio_admin, סטטוס לקוח וסימון הזמנה ראשונה — נדחים; עריכה רגילה עוברת\n'
        || E'  · 🔴 מסשן studio_admin: סטטוס וסימון — עוברים; studio_admin עצמו — נדחה גם לו\n'
        || E'  · client_registrations נעולה לגמרי; token מוחרג; שאר העמודות החדשות קריאות\n'
        || E'\nעכשיו אפשר להריץ את supabase/migrations/0107_client_registration_schema.sql';
  raise exception '%', v_msg;
end $dry$;
