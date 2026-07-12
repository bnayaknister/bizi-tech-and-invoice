-- BIZI STUDIO · PODCLUB — schema + RLS
-- Money-blindness is the critical requirement: tech gets stages only,
-- zero access (no policy at all = default deny) to jobs/clients/productions.

create extension if not exists pgcrypto;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null check (role in ('owner','tech','bookkeeper')),
  created_at timestamptz not null default now()
);

create or replace function public.current_role()
returns text
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ---------- clients ----------
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now()
);
create unique index clients_normalized_name_idx on public.clients (normalized_name);

-- ---------- productions ----------
create table public.productions (
  id uuid primary key default gen_random_uuid(),
  podcast_name text not null,
  client_id uuid references public.clients(id),
  guest text,
  record_date date,
  studio text,
  calendar_uid text,
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- stages ----------
create type stage_track as enum ('episode','reels');
create type stage_step as enum ('record','edit','deliver');
create type stage_status as enum ('pending','in_progress','done');

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  -- denormalized so 'tech' (stages-only access) can render a usable kanban
  -- board without ever touching productions/clients/jobs
  podcast_name text not null,
  guest text,
  record_date date,
  track stage_track not null,
  step stage_step not null,
  status stage_status not null default 'pending',
  assignee_id uuid references public.profiles(id),
  done_at timestamptz,
  created_at timestamptz not null default now(),
  unique (production_id, track, step)
);

create or replace function public.create_default_stages()
returns trigger language plpgsql as $$
begin
  insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
  select new.id, new.podcast_name, new.guest, new.record_date, t, s, 'pending'
  from unnest(array['episode','reels']::stage_track[]) as t
  cross join unnest(array['record','edit','deliver']::stage_step[]) as s;
  return new;
end;
$$;

create trigger trg_create_default_stages
after insert on public.productions
for each row execute function public.create_default_stages();

-- a stage can only move off 'pending' once the previous step in its track is done
create or replace function public.enforce_stage_order()
returns trigger language plpgsql as $$
declare
  step_order int := case new.step when 'record' then 1 when 'edit' then 2 when 'deliver' then 3 end;
  prev_step stage_step := case step_order when 2 then 'record' when 3 then 'edit' else null end;
  prev_status stage_status;
begin
  if new.status = 'pending' or prev_step is null then
    return new;
  end if;
  select status into prev_status from public.stages
    where production_id = new.production_id and track = new.track and step = prev_step;
  if prev_status is distinct from 'done' then
    raise exception 'לא ניתן לפתוח את השלב % לפני שהשלב % הושלם', new.step, prev_step;
  end if;
  return new;
end;
$$;

create trigger trg_enforce_stage_order
before update on public.stages
for each row execute function public.enforce_stage_order();

create or replace function public.set_done_at()
returns trigger language plpgsql as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    new.done_at := now();
  elsif new.status <> 'done' then
    new.done_at := null;
  end if;
  return new;
end;
$$;

create trigger trg_set_done_at
before update on public.stages
for each row execute function public.set_done_at();

-- ---------- jobs ----------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  production_id uuid references public.productions(id),
  client_id uuid references public.clients(id),
  date date,
  campaign text,
  amount numeric,
  invoice_biz text,
  invoice_tax text,
  paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);

-- ================= RLS =================
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.productions enable row level security;
alter table public.stages enable row level security;
alter table public.jobs enable row level security;

-- profiles: everyone reads their own row (needed to resolve current_role()); owner reads/writes all
create policy profiles_self_select on public.profiles
  for select using (id = auth.uid());
create policy profiles_owner_all on public.profiles
  for all using (public.current_role() = 'owner') with check (public.current_role() = 'owner');

-- owner: unrestricted on everything
create policy clients_owner_all on public.clients
  for all using (public.current_role() = 'owner') with check (public.current_role() = 'owner');
create policy productions_owner_all on public.productions
  for all using (public.current_role() = 'owner') with check (public.current_role() = 'owner');
create policy stages_owner_all on public.stages
  for all using (public.current_role() = 'owner') with check (public.current_role() = 'owner');
create policy jobs_owner_all on public.jobs
  for all using (public.current_role() = 'owner') with check (public.current_role() = 'owner');

-- tech: stages only (select + update). No policy at all on clients/productions/jobs => default deny.
create policy stages_tech_select on public.stages
  for select using (public.current_role() = 'tech');
create policy stages_tech_update on public.stages
  for update using (public.current_role() = 'tech') with check (public.current_role() = 'tech');

-- bookkeeper: jobs + clients select/update, productions read-only. No stages access.
create policy jobs_bookkeeper_select on public.jobs
  for select using (public.current_role() = 'bookkeeper');
create policy jobs_bookkeeper_update on public.jobs
  for update using (public.current_role() = 'bookkeeper') with check (public.current_role() = 'bookkeeper');
create policy clients_bookkeeper_select on public.clients
  for select using (public.current_role() = 'bookkeeper');
create policy clients_bookkeeper_update on public.clients
  for update using (public.current_role() = 'bookkeeper') with check (public.current_role() = 'bookkeeper');
create policy productions_bookkeeper_select on public.productions
  for select using (public.current_role() = 'bookkeeper');
