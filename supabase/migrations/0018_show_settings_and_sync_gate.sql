-- 0018: extended show settings + a global calendar-sync on/off switch
-- (owner decisions 2026-07-17).
--
-- shows gain camera_count/notes as proper typed columns (queryable), plus
-- a `settings jsonb` catch-all so future per-show settings don't need a
-- migration each time. productions gains camera_count to receive the
-- show's value at calendar-creation time (studio already worked this way).
--
-- app_settings is a one-row singleton (id is literally the boolean `true`,
-- enforced by the PK) holding calendar_sync_enabled, defaulting false. The
-- owner turns it on manually once show aliases are populated — until then
-- the real cron/manual sync must refuse to touch the live calendar at all.

alter table public.shows
  add column if not exists camera_count integer,
  add column if not exists notes text,
  add column if not exists settings jsonb not null default '{}'::jsonb;

alter table public.productions
  add column if not exists camera_count integer;

-- camera_count/notes/settings are stage-tier config, same as default_studio
-- — extend the existing money guard's sibling check isn't needed since
-- these aren't money fields; RLS (can_edit_stages or can_edit_money) already
-- covers writes to shows, no new trigger required here.

create table if not exists public.app_settings (
  id boolean primary key default true,
  calendar_sync_enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint app_settings_singleton check (id)
);
insert into public.app_settings (id, calendar_sync_enabled)
  values (true, false)
  on conflict (id) do nothing;

alter table public.app_settings enable row level security;

create policy app_settings_view on public.app_settings
  for select using (public.can_edit_stages() or public.can_view_stages());
-- only the owner flips the switch that lets the sync touch the real
-- calendar — deliberately narrower than the can_edit_stages who can run a
-- manual test sync with fake data
create policy app_settings_update on public.app_settings
  for update using (public.is_owner()) with check (public.is_owner());
