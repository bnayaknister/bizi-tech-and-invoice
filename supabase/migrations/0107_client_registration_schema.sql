-- ============================================================================
-- 0107 — סכימת הרשמת לקוח (E17-2). סכימה בלבד.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: אין backfill, אין DELETE, ואף שורה קיימת
-- לא משתנה. כל העמודות החדשות נולדות עם ברירת מחדל שמשאירה את הקיים כפי
-- שהוא: לקוח קיים = `active`, פודקאסט קיים = בלי אישור ראשון, אף משתמש אינו
-- `studio_admin`. שום קוד עדיין לא קורא את מה שנוסף כאן.
--
-- ═══ מה נוסף ═══
--   1. `profiles.studio_admin` + `is_studio_admin()` — מי מאשר הרשמות ומי
--      עורך את "הרשאות הזמנת חדרים" (הכרעת בעלים 11.10: בניה ואלי בלבד).
--   2. `clients.status` (pending / active / rejected) + `clients.tax_id`.
--   3. `registration_links` — קישור חד-פעמי לדף ההרשמה.
--   4. `client_registrations` — מה שהלקוח מסר.
--   5. `shows.first_booking_needs_approval`.
--   6. `booking_contacts.registration_id`.
--
-- ═══ 🔴 למה דגל חדש ולא can_edit_money / can_manage_users / role ═══
-- נמדד בקוד (0001, 0002): בניה, אלי ושירי הם שלושתם `role='owner'` עם
-- `can_edit_money` ו-`can_manage_users`. אין היום שום עמודה, תפקיד או רשימה
-- שמבדילים בין בניה ואלי לבין שירי. לכן דגל חדש.
--
-- ⚠️ והדגל חייב להיות נעול **מכל סשן**, כולל של מנהל משתמשים:
--   · `profiles_self_update` (0002) מתיר לכל משתמש לעדכן את השורה **שלו**,
--     והטריגר `prevent_self_permission_change` מגן רק על רשימה סגורה של
--     עמודות — דגל חדש שלא נוסף אליה היה ניתן להענקה עצמית דרך REST;
--   · `profiles_manager_update` מתיר לכל `can_manage_users` (גם שירי) לעדכן
--     שורות של אחרים.
-- ולכן `guard_studio_admin_flag` דוחה **כל** שינוי של `studio_admin` כשיש
-- `auth.uid()` — כלומר מכל סשן מחובר, יהיו ההרשאות שלו אשר יהיו. נשאר נתיב
-- אחד: ה-SQL Editor (postgres, `auth.uid()` ריק). שם הבעלים קובע את הדגל,
-- אחרי ההחלה, בפקודה שבדוח — **המיגרציה לא נוקבת באף משתמש**.
--
-- ═══ שני שומרים נוספים, מאותה סיבה ═══
--   · `guard_client_status` — מעבר סטטוס של לקוח (ובפרט pending → active,
--     שהוא "אישור הרשמה") מסשן מחובר דורש `is_studio_admin()`. בלעדיו
--     `clients_update` (can_edit_money) היה מתיר לכל בעל הרשאת כספים לאשר.
--   · `guard_first_booking_flag` — הורדת הדגל ידנית שקולה לאישור ההזמנה
--     הראשונה, שהוכרעה לבניה ואלי. מסשן: רק `is_studio_admin()`.
-- נתיבי service role (`auth.uid()` ריק) אינם נחסמים — האישור ייעשה בראוט
-- שבודק את הדגל בעצמו, כמו כל ראוט אחר במערכת.
--
-- ═══ הרשאות ═══
--   · `client_registrations` — כמו 0103: RLS בלי policy, `revoke all` מכל
--     תפקיד סשן. service role בלבד. הטבלה נושאת ח.פ, מיילים וטלפונים.
--   · `registration_links` — כמו 0096: `revoke all`, ואז הענקה עמודה-עמודה
--     **בלי** `token`. policy קריאה ל-`is_studio_admin()` בלבד (wa_id הוא
--     מספר טלפון).
--   · עמודות חדשות בטבלאות קיימות — כלל 61: **נמדד**. `shows` נושאת רשימת
--     היתר עמודתית (0022/0068), ולכן בלי גרנט מפורש העמודה הייתה בלתי
--     קריאה. הגרנט ניתן רק בענף שבו גרנט הטבלה חסר, וה-canary דורש
--     קריאוּת בפועל בשני הענפים.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0107_dryrun.sql` — יוצר באמת, מוכיח כל אילוץ ושומר,
--      מאמת הרשאות, md5 על הקיים, ומגלגל. **מסיים ב-exception גם בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0107_verify.sql` — שורה אחת, כל עמודות הבדיקה true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--   5. הדגל לבניה ולאלי — בפקודה שבדוח, ב-SQL Editor.
--
-- אפס DELETE, אפס שינוי נתונים קיימים.
-- ============================================================================

do $mig$
declare
  v_n int;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0107') then
    raise exception '0107 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — בלעדיה טבלה חדשה נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0096') then
    raise exception '0096 טרם הוחלה — דפוס הטוקן נשען עליה. הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0103') then
    raise exception '0103 טרם הוחלה — booking_contacts אינה קיימת. הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0106') then
    raise exception '0106 טרם הוחלה — 0107 באה אחריה. הרץ אותה קודם';
  end if;

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

  -- ── 9. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0107', now(), 'bnaya',
    'הרשמת לקוח, E17-2 — סכימה בלבד, אפס שינוי התנהגות, אפס backfill ואפס DELETE. '
    'profiles.studio_admin + is_studio_admin(): מי מאשר הרשמות ועורך את הרשאות הזמנת החדרים (הכרעת בעלים 11.10: בניה ואלי). דגל חדש כי בניה, אלי ושירי שלושתם owner עם can_edit_money ו-can_manage_users. הטריגר guard_studio_admin_flag דוחה כל שינוי בו מסשן מחובר — כולל עדכון עצמי דרך profiles_self_update ועדכון של מנהל משתמשים — ולכן הוא נקבע רק ב-SQL Editor. אף משתמש לא קיבל אותו כאן. '
    'clients.status (pending/active/rejected, ברירת מחדל active) ו-clients.tax_id (9 ספרות, ייחודי חלקי); guard_client_status: שינוי סטטוס מסשן דורש studio_admin. '
    'registration_links: טוקן חד-פעמי, wa_id רשות, תוקף, used_at; token מוחרג מכל גרנט של סשן כמו 0096, קריאה לשאר העמודות ל-studio_admin בלבד. '
    'client_registrations: פרטי הלקוח, שם הפודקאסט, 1-2 מספרים מורשים בפורמט wa_id, אישור פרטיות וגרסה, סטטוס, rejected_at למחיקה אחרי 30 יום, מי הכריע ומתי; RLS נעול כמו 0103. '
    'shows.first_booking_needs_approval (ברירת מחדל false; שינוי מסשן דורש studio_admin) ו-booking_contacts.registration_id. '
    'עמודות חדשות בטבלאות קיימות נמדדו לפי כלל 61 והוענקו רק בענף החסר.');

  raise notice '✅ 0107: סכימת הרשמת לקוח נוצרה.';
end $mig$;
