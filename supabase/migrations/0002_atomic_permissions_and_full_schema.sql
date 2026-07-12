-- BIZI STUDIO · PODCLUB — v2 schema
-- Atomic per-user permissions, production→billing state machine,
-- contracts/milestones, invoices, events, archive schema.
-- Deliberately NOT done here (belongs to later steps):
--   - migrating jobs.invoice_biz/invoice_tax text into public.invoices
--   - archive population / kind classification of the 709 productions
--   - Yedioth Achronot client merge + Jaffa contract entry
--   - Morning integration (stays unbuilt until step 8)

-- ================= profiles: atomic permissions =================
alter table public.profiles
  add column if not exists email text,
  add column if not exists approved boolean not null default false,
  add column if not exists can_view_money boolean not null default false,
  add column if not exists can_edit_money boolean not null default false,
  add column if not exists can_view_stages boolean not null default false,
  add column if not exists can_edit_stages boolean not null default false,
  add column if not exists can_manage_users boolean not null default false,
  add column if not exists can_import boolean not null default false;

-- permission helper functions (all gate on approved=true first)
create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(approved, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_view_money()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_view_money, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_edit_money()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_edit_money, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_view_stages()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_view_stages, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_edit_stages()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_edit_stages, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_manage_users()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_manage_users, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.can_import()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and coalesce(can_import, false) from public.profiles where id = auth.uid();
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_approved() and role = 'owner' from public.profiles where id = auth.uid();
$$;

-- iron rule: nobody edits their own permissions, not even an admin
create or replace function public.prevent_self_permission_change()
returns trigger language plpgsql as $$
begin
  if new.id = auth.uid() then
    if new.approved is distinct from old.approved
       or new.can_view_money is distinct from old.can_view_money
       or new.can_edit_money is distinct from old.can_edit_money
       or new.can_view_stages is distinct from old.can_view_stages
       or new.can_edit_stages is distinct from old.can_edit_stages
       or new.can_manage_users is distinct from old.can_manage_users
       or new.can_import is distinct from old.can_import
       or new.role is distinct from old.role
    then
      raise exception 'אינך יכול לשנות את ההרשאות של עצמך';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_permission_change on public.profiles;
create trigger trg_prevent_self_permission_change
before update on public.profiles
for each row execute function public.prevent_self_permission_change();

-- new signups land as approved=false with zero permissions
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, approved)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', new.email), false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
after insert on auth.users
for each row execute function public.handle_new_user();

-- ================= clients: billing config =================
do $$ begin
  create type billing_mode as enum ('per_episode','retainer','package','none');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_terms as enum ('immediate','net_30','net_60','eom_30','eom_60','eom_90');
exception when duplicate_object then null; end $$;

alter table public.clients
  add column if not exists contact_name text,
  add column if not exists billing_mode billing_mode not null default 'per_episode',
  add column if not exists payment_terms payment_terms not null default 'immediate',
  add column if not exists default_rate numeric,
  add column if not exists morning_client_id text;

-- ================= contracts =================
create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  name text not null,
  total_amount numeric not null,
  start_date date,
  end_date date,
  status text not null default 'active' check (status in ('active','closed')),
  created_at timestamptz not null default now()
);

create table if not exists public.contract_milestones (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  name text not null,
  amount numeric not null,
  expected_date date,
  is_estimated boolean not null default false,
  status text not null default 'pending' check (status in ('pending','invoiced','paid')),
  job_id uuid references public.jobs(id),
  created_at timestamptz not null default now()
);

-- ================= productions: kind + derived status =================
do $$ begin
  create type production_kind as enum ('client','internal');
exception when duplicate_object then null; end $$;

do $$ begin
  create type production_status as enum
    ('ממתין_להתחלה','הוקלט','בעריכה','נערך','נשלח_ללקוח','אושר_ע"י_לקוח');
exception when duplicate_object then null; end $$;

alter table public.productions
  add column if not exists contract_id uuid references public.contracts(id),
  add column if not exists kind production_kind not null default 'internal',
  add column if not exists status production_status not null default 'ממתין_להתחלה';

alter table public.productions drop constraint if exists productions_client_kind_requires_client;
alter table public.productions
  add constraint productions_client_kind_requires_client
  check (kind <> 'client' or client_id is not null);

-- status is derived from the 6 stages, never entered manually —
-- except the terminal 'אושר_ע"י_לקוח' which is a manual, guarded transition.
create or replace function public.derive_production_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cur_status production_status;
  ep_record_done boolean;
  ep_edit_done boolean;
  any_in_progress boolean;
  all_done boolean;
  new_status production_status;
begin
  select status into cur_status from public.productions where id = new.production_id;
  if cur_status = 'אושר_ע"י_לקוח' then
    return new; -- never auto-override the manual terminal state
  end if;

  select bool_or(status = 'done') into ep_record_done
    from public.stages where production_id = new.production_id and track = 'episode' and step = 'record';
  select bool_or(status = 'done') into ep_edit_done
    from public.stages where production_id = new.production_id and track = 'episode' and step = 'edit';
  select bool_and(status = 'done') into all_done
    from public.stages where production_id = new.production_id;
  select bool_or(status = 'in_progress') into any_in_progress
    from public.stages where production_id = new.production_id;

  if all_done then
    new_status := 'נשלח_ללקוח';
  elsif ep_edit_done then
    new_status := 'נערך';
  elsif any_in_progress then
    new_status := 'בעריכה';
  elsif ep_record_done then
    new_status := 'הוקלט';
  else
    new_status := 'ממתין_להתחלה';
  end if;

  update public.productions set status = new_status
    where id = new.production_id and status is distinct from new_status;
  return new;
end;
$$;

drop trigger if exists trg_derive_production_status on public.stages;
create trigger trg_derive_production_status
after insert or update of status on public.stages
for each row execute function public.derive_production_status();

-- only a can_edit_money() user may mark a production as client-approved
-- (this is what fires billing — technicians must never be able to trigger it)
create or replace function public.guard_client_approval_transition()
returns trigger language plpgsql as $$
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לסמן הפקה כמאושרת ע"י הלקוח';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_client_approval on public.productions;
create trigger trg_guard_client_approval
before update of status on public.productions
for each row execute function public.guard_client_approval_transition();

-- the chain's core automation: client-approved + kind='client' → job is born
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' and new.kind = 'client' then
    insert into public.jobs (production_id, client_id, contract_id, date, campaign, paid, notes)
    values (new.id, new.client_id, new.contract_id, current_date, new.podcast_name, 'לא ידוע',
            'נוצר אוטומטית מאישור לקוח. יש להשלים סכום וחשבונית עסקה.');
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', new.id, 'client_id', new.client_id));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_on_production_approved on public.productions;
create trigger trg_on_production_approved
after update of status on public.productions
for each row execute function public.on_production_approved();

-- ================= jobs: due_date + contract link =================
alter table public.jobs
  add column if not exists due_date date,
  add column if not exists contract_id uuid references public.contracts(id);

create or replace function public.compute_due_date()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  terms payment_terms;
  base date;
begin
  select payment_terms into terms from public.clients where id = new.client_id;
  base := coalesce(new.date, current_date);
  case terms
    when 'net_30' then new.due_date := base + 30;
    when 'net_60' then new.due_date := base + 60;
    when 'eom_30' then new.due_date := (date_trunc('month', base) + interval '1 month - 1 day')::date + 30;
    when 'eom_60' then new.due_date := (date_trunc('month', base) + interval '1 month - 1 day')::date + 60;
    when 'eom_90' then new.due_date := (date_trunc('month', base) + interval '1 month - 1 day')::date + 90;
    else new.due_date := base; -- immediate, or client/terms unknown
  end case;
  return new;
end;
$$;

drop trigger if exists trg_compute_due_date on public.jobs;
create trigger trg_compute_due_date
before insert or update of date, client_id on public.jobs
for each row execute function public.compute_due_date();

-- ================= invoices =================
do $$ begin
  create type invoice_type as enum ('עסקה','מס');
exception when duplicate_object then null; end $$;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  type invoice_type not null,
  morning_doc_id text unique,
  amount numeric not null,
  issued_at timestamptz not null default now(),
  status text not null default 'issued',
  pdf_url text,
  created_at timestamptz not null default now()
);

-- ================= events =================
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  event_type text not null,
  actor_id uuid references public.profiles(id),
  payload jsonb,
  created_at timestamptz not null default now()
);

-- ================= archive schema (owner-only, structure now, data in step 2) =================
create schema if not exists archive;
create table if not exists archive.jobs (like public.jobs including all);
create table if not exists archive.productions (like public.productions including all);

-- ================= RLS: drop old role-based policies =================
drop policy if exists profiles_owner_all on public.profiles;
drop policy if exists clients_owner_all on public.clients;
drop policy if exists clients_bookkeeper_select on public.clients;
drop policy if exists clients_bookkeeper_update on public.clients;
drop policy if exists productions_owner_all on public.productions;
drop policy if exists productions_bookkeeper_select on public.productions;
drop policy if exists stages_owner_all on public.stages;
drop policy if exists stages_tech_select on public.stages;
drop policy if exists stages_tech_update on public.stages;
drop policy if exists jobs_owner_all on public.jobs;
drop policy if exists jobs_bookkeeper_select on public.jobs;
drop policy if exists jobs_bookkeeper_update on public.jobs;
drop function if exists public.current_role();

-- ================= RLS: new atomic-permission policies =================
alter table public.contracts enable row level security;
alter table public.contract_milestones enable row level security;
alter table public.invoices enable row level security;
alter table public.events enable row level security;
alter table archive.jobs enable row level security;
alter table archive.productions enable row level security;

-- profiles
create policy profiles_manager_select on public.profiles
  for select using (public.can_manage_users());
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_manager_update on public.profiles
  for update using (public.can_manage_users()) with check (public.can_manage_users());
create policy profiles_manager_delete on public.profiles
  for delete using (public.can_manage_users());

-- clients
create policy clients_view on public.clients
  for select using (public.can_view_money() or public.can_view_stages());
create policy clients_insert on public.clients
  for insert with check (public.can_edit_money() or public.can_import());
create policy clients_update on public.clients
  for update using (public.can_edit_money()) with check (public.can_edit_money());

-- contracts / contract_milestones / invoices (money)
create policy contracts_view on public.contracts for select using (public.can_view_money());
create policy contracts_write on public.contracts for insert with check (public.can_edit_money());
create policy contracts_update on public.contracts for update using (public.can_edit_money()) with check (public.can_edit_money());
create policy contracts_delete on public.contracts for delete using (public.can_edit_money());

create policy milestones_view on public.contract_milestones for select using (public.can_view_money());
create policy milestones_write on public.contract_milestones for insert with check (public.can_edit_money());
create policy milestones_update on public.contract_milestones for update using (public.can_edit_money()) with check (public.can_edit_money());
create policy milestones_delete on public.contract_milestones for delete using (public.can_edit_money());

create policy invoices_view on public.invoices for select using (public.can_view_money());
create policy invoices_write on public.invoices for insert with check (public.can_edit_money());
create policy invoices_update on public.invoices for update using (public.can_edit_money()) with check (public.can_edit_money());

-- productions
create policy productions_view on public.productions
  for select using (public.can_view_stages() or public.can_view_money());
create policy productions_insert on public.productions
  for insert with check (public.can_edit_stages() or public.can_import());
create policy productions_update on public.productions
  for update using (public.can_edit_stages() or public.can_edit_money())
  with check (public.can_edit_stages() or public.can_edit_money());

-- stages
create policy stages_view on public.stages
  for select using (public.can_view_stages());
create policy stages_update on public.stages
  for update using (public.can_edit_stages()) with check (public.can_edit_stages());

-- jobs
create policy jobs_view on public.jobs for select using (public.can_view_money());
create policy jobs_insert on public.jobs for insert with check (public.can_edit_money());
create policy jobs_update on public.jobs for update using (public.can_edit_money()) with check (public.can_edit_money());
create policy jobs_delete on public.jobs for delete using (public.can_edit_money());

-- events: owner-only for now
create policy events_owner_select on public.events for select using (public.is_owner());

-- archive: owner-only, read-only
create policy archive_jobs_owner_select on archive.jobs for select using (public.is_owner());
create policy archive_productions_owner_select on archive.productions for select using (public.is_owner());
