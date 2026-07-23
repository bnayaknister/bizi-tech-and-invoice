-- 0038: the reels track loses its 'record' step.
--
-- Model fix (owner 2026-07-24): reels are never recorded separately — they are
-- cut from the SAME episode raw. The real flow is: client gets the episode raw
-- → gives notes + reel timecodes → we return a corrected episode + reels. Even
-- when the client gives a free hand and we pick the reels ourselves, the
-- process is identical, just without client notes. So the reels line is
-- edit → deliver only, two steps.
--
-- Why DELETE the 716 existing reels/record rows and not deprecate+hide them:
-- a phantom 'record' step nobody can ever complete means done<total forever for
-- every production, which permanently kills the 🔵 "produced but never billed"
-- radar alert (it fires on done===total). Deprecation would also force a
-- "hidden" flag to be special-cased out of the rollup and every consumer for
-- good — two sources of truth for "how many steps". The data itself is empty:
-- of the 716 rows, 711 were pending, 0 in_progress, 5 done, 0 ever assigned.
-- The 5 done rows are snapshotted below before deletion, for audit.

-- 1. audit snapshot of every non-pending / ever-assigned reels/record row (the
--    5 done ones — the only rows carrying any signal) BEFORE they are deleted.
create table if not exists public.stages_removed_snapshot (
  id            uuid,
  production_id uuid,
  track         stage_track,
  step          stage_step,
  status        stage_status,
  assignee_id   uuid,
  done_at       timestamptz,
  reason        text,
  snapshotted_at timestamptz not null default now()
);
alter table public.stages_removed_snapshot enable row level security;
-- owner-only readable (mirrors events); service role bypasses RLS
drop policy if exists stages_removed_snapshot_owner on public.stages_removed_snapshot;
create policy stages_removed_snapshot_owner on public.stages_removed_snapshot
  for select using (public.is_owner());

insert into public.stages_removed_snapshot
  (id, production_id, track, step, status, assignee_id, done_at, reason)
select id, production_id, track, step, status, assignee_id, done_at, 'reels_record_removed_0038'
from public.stages
where track = 'reels' and step = 'record'
  and (status <> 'pending' or assignee_id is not null);

-- 2. reels/edit becomes the FIRST step of the reels track. Without this,
--    enforce_stage_order() would look up the now-deleted 'record' predecessor,
--    get NULL, and (NULL is distinct from 'done') permanently block reels/edit
--    from ever leaving 'pending'. The predecessor is now track-aware.
create or replace function public.enforce_stage_order()
returns trigger language plpgsql as $$
declare
  prev_step   stage_step;
  prev_status stage_status;
begin
  if new.status = 'pending' then
    return new;
  end if;
  -- predecessor within THIS track. reels has no 'record' step (0038), so
  -- reels/edit is the first step and has no predecessor.
  prev_step := case
    when new.step = 'deliver' then 'edit'::stage_step
    when new.step = 'edit' and new.track = 'episode' then 'record'::stage_step
    else null
  end;
  if prev_step is null then
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

-- 3. new productions get 5 stages: episode record/edit/deliver + reels
--    edit/deliver (no reels/record). Stays SECURITY DEFINER (0020).
create or replace function public.create_default_stages()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
  select new.id, new.podcast_name, new.guest, new.record_date, v.track, v.step, 'pending'
  from (values
    ('episode'::stage_track, 'record'::stage_step),
    ('episode'::stage_track, 'edit'::stage_step),
    ('episode'::stage_track, 'deliver'::stage_step),
    ('reels'::stage_track,   'edit'::stage_step),
    ('reels'::stage_track,   'deliver'::stage_step)
  ) as v(track, step);
  return new;
end;
$$;

-- 4. drop the 716 existing reels/record rows. Deleting a stage fires no update
--    trigger; the 4 reels/edit rows already advanced past pending stay valid
--    because enforce_stage_order (above) no longer expects a reels predecessor.
delete from public.stages where track = 'reels' and step = 'record';
