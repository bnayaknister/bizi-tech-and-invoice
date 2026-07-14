-- job_productions: many-to-many billing links (owner decision 2026-07-14).
-- jobs.production_id (single column) lied in both directions: one job can
-- cover several productions ("2 פרקים", "*4") and one production can carry
-- several jobs (episode + extra reels). A single-column link would leave
-- 3 of 4 productions "unbilled" and make the 🔵 alert cry wolf —
-- a system that lies is a system that gets abandoned.
--
-- Also adds jobs.manual_only: general/campaign jobs (radio campaigns,
-- studio hours, BEPO content) that are never per-episode. manual_only=true
-- means: the "unlinked job" alert must NEVER fire for this job.

-- ---------- 1. the link table ----------
create table if not exists public.job_productions (
  job_id uuid not null references public.jobs(id) on delete cascade,
  production_id uuid not null references public.productions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (job_id, production_id)
);
create index if not exists job_productions_production_idx
  on public.job_productions (production_id);

alter table public.jobs
  add column if not exists manual_only boolean not null default false;

-- ---------- 2. RLS ----------
-- Link rows reveal that billing exists for a production — that is money
-- information. Same visibility as jobs itself: can_view_money only.
-- No update policy: a link is immutable, re-linking = delete + insert.
alter table public.job_productions enable row level security;
create policy job_productions_view on public.job_productions
  for select using (public.can_view_money());
create policy job_productions_insert on public.job_productions
  for insert with check (public.can_edit_money());
create policy job_productions_delete on public.job_productions
  for delete using (public.can_edit_money());

-- ---------- 3. archive counterpart ----------
-- on delete cascade means archiving a job/production (which deletes the
-- public row) would silently destroy its links. Copy them to archive first
-- (done inside the move functions below). LIKE does not copy FKs — correct
-- here, since one side of an archived link usually stays in public.
create table if not exists archive.job_productions (like public.job_productions including all);
alter table archive.job_productions enable row level security;
create policy archive_job_productions_owner_select on archive.job_productions
  for select using (public.is_owner());

-- ---------- 4. migrate existing data, then drop the column ----------
-- Live jobs: all 51 have production_id null today, so this moves nothing —
-- kept so the migration is correct on any environment it runs against.
insert into public.job_productions (job_id, production_id)
  select id, production_id from public.jobs where production_id is not null
  on conflict do nothing;
insert into archive.job_productions (job_id, production_id)
  select id, production_id from archive.jobs where production_id is not null
  on conflict do nothing;

alter table public.jobs drop column if exists production_id;
-- archive.jobs must stay column-identical to public.jobs:
-- move_jobs_to_archive does `insert into archive.jobs select * from public.jobs`
alter table archive.jobs drop column if exists production_id;

-- ---------- 5. on_production_approved: write the link, not the column ----------
-- Also fixes a latent bug: the 0002 version inserted paid='לא ידוע' into a
-- boolean column, which would have crashed on the first client approval.
-- paid now takes its column default (false).
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_job_id uuid;
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' and new.kind = 'client' then
    insert into public.jobs (client_id, contract_id, date, campaign, notes)
    values (new.client_id, new.contract_id, current_date, new.podcast_name,
            'נוצר אוטומטית מאישור לקוח. יש להשלים סכום וחשבונית עסקה.')
    returning id into new_job_id;
    insert into public.job_productions (job_id, production_id)
    values (new_job_id, new.id);
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', new.id, 'client_id', new.client_id, 'job_id', new_job_id));
  end if;
  return new;
end;
$$;

-- ---------- 6. archive move functions: carry the links along ----------
create or replace function public.move_jobs_to_archive(job_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  moved integer;
  expected integer := coalesce(array_length(job_ids, 1), 0);
begin
  if not (public.is_owner() or auth.role() = 'service_role') then
    raise exception 'רק owner יכול להעביר רשומות לארכיון';
  end if;

  insert into archive.jobs select * from public.jobs where id = any(job_ids);
  get diagnostics moved = row_count;

  if moved is distinct from expected then
    raise exception 'ההעתקה לארכיון לא הושלמה במלואה (% מתוך %) — מבטל', moved, expected;
  end if;

  -- links die with the job (cascade) — preserve them in archive first
  insert into archive.job_productions
    select * from public.job_productions where job_id = any(job_ids)
    on conflict do nothing;

  delete from public.jobs where id = any(job_ids);
  return moved;
end;
$$;

create or replace function public.move_productions_to_archive(production_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  moved integer;
  expected integer := coalesce(array_length(production_ids, 1), 0);
begin
  if not (public.is_owner() or auth.role() = 'service_role') then
    raise exception 'רק owner יכול להעביר רשומות לארכיון';
  end if;

  insert into archive.productions select * from public.productions where id = any(production_ids);
  get diagnostics moved = row_count;

  if moved is distinct from expected then
    raise exception 'ההעתקה לארכיון לא הושלמה במלואה (% מתוך %) — מבטל', moved, expected;
  end if;

  insert into archive.job_productions
    select * from public.job_productions where production_id = any(production_ids)
    on conflict do nothing;

  delete from public.productions where id = any(production_ids);
  return moved;
end;
$$;
