-- 0040: storage disk on productions (§2) + the production log / journal (§3).

-- ===================== §2: storage disk =====================
-- Which physical disk the episode raw was recorded to. An operational field
-- (NOT money-gated); always visible at the top of the drawer, editable by
-- can_edit_stages, autocompleted from disks already entered, searchable
-- globally ("SSD-04" finds every production on that disk — critical for
-- locating old raw).
alter table public.productions
  add column if not exists storage_disk text;
-- productions is not column-restricted; be explicit anyway (mirrors 0028)
grant select (storage_disk) on public.productions to authenticated;

-- extend the stage-column guard (0010) so a change to storage_disk also needs
-- can_edit_stages — the same wall that already covers status/on_hold. A
-- money-only user (bookkeeper) can read it but not set it.
create or replace function public.guard_production_stage_columns()
returns trigger language plpgsql as $$
begin
  if new.on_hold is distinct from old.on_hold
     or new.storage_disk is distinct from old.storage_disk
     or (new.status is distinct from old.status and new.status <> 'אושר_ע"י_לקוח') then
    if not public.can_edit_stages() then
      raise exception 'רק בעל הרשאת עריכת שלבים יכול לשנות סטטוס, הקפאה או דיסק של הפקה';
    end if;
  end if;
  return new;
end;
$$;

-- ===================== §3: production log =====================
-- One append-mostly journal per production: every stage change (even with no
-- note), disk changes, tech notes, and the client's notes from the review link
-- — one full story, newest first.
--
-- `kind` is plain TEXT, not an enum, on purpose (owner 2026-07-24): future
-- kinds (price decision, approved add-on, issued document) must not require a
-- schema change, and an unknown kind must degrade to a default icon in the UI,
-- never crash. Known today: 'stage' | 'disk' | 'note' | 'client'.
create table if not exists public.production_log (
  id            uuid primary key default gen_random_uuid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  -- the stage this entry is about, if any. set null (not cascade) so the log
  -- survives a stage row being removed (e.g. the reels/record deletion in 0038)
  stage_id      uuid references public.stages(id) on delete set null,
  kind          text not null default 'note',
  track         stage_track,           -- denormalized: survives stage deletion
  step          stage_step,
  stage_status  stage_status,          -- the resulting status, for kind='stage'
  note          text,                  -- user/client text, or the disk name for 'disk'
  author_id     uuid references public.profiles(id),  -- null = system/client
  created_at    timestamptz not null default now(),
  edited_at     timestamptz
);
create index if not exists production_log_production_idx
  on public.production_log (production_id, created_at desc);

alter table public.production_log enable row level security;

-- read: anyone who can see the production (stage OR money viewers). service
-- role bypasses RLS (client-note inserts from the link, trigger inserts).
drop policy if exists production_log_select on public.production_log;
create policy production_log_select on public.production_log
  for select using (public.can_view_stages() or public.can_view_money());

-- write: can_edit_stages, and you may only author as yourself
drop policy if exists production_log_insert on public.production_log;
create policy production_log_insert on public.production_log
  for insert with check (public.can_edit_stages() and author_id = auth.uid());

-- edit: only the author, only within 5 minutes of creation. The guard trigger
-- below stamps edited_at and forbids touching anything but the note. NO delete
-- policy exists — entries are permanent.
drop policy if exists production_log_update on public.production_log;
create policy production_log_update on public.production_log
  for update using (author_id = auth.uid() and created_at > now() - interval '5 minutes')
  with check (author_id = auth.uid());

create or replace function public.guard_production_log_edit()
returns trigger language plpgsql as $$
begin
  if new.production_id is distinct from old.production_id
     or new.stage_id  is distinct from old.stage_id
     or new.kind      is distinct from old.kind
     or new.track     is distinct from old.track
     or new.step      is distinct from old.step
     or new.stage_status is distinct from old.stage_status
     or new.author_id is distinct from old.author_id
     or new.created_at is distinct from old.created_at then
    raise exception 'ניתן לערוך רק את תוכן ההערה';
  end if;
  new.edited_at := now();  -- mark "נערך"
  return new;
end;
$$;
drop trigger if exists trg_guard_production_log_edit on public.production_log;
create trigger trg_guard_production_log_edit
before update on public.production_log
for each row execute function public.guard_production_log_edit();

-- ---- auto-log every stage status change (from ANY entry point: board or
--      drawer) so the journal is complete regardless of where work happened.
--      Runs SECURITY DEFINER so it can write the log past RLS; author is the
--      acting user. Not fired on INSERT (new productions seed pending stages —
--      not events worth logging), only on a real status change.
create or replace function public.log_stage_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.production_log (production_id, stage_id, kind, track, step, stage_status, author_id)
  values (new.production_id, new.id, 'stage', new.track, new.step, new.status, auth.uid());
  return new;
end;
$$;
drop trigger if exists trg_log_stage_change on public.stages;
create trigger trg_log_stage_change
after update of status on public.stages
for each row when (new.status is distinct from old.status)
execute function public.log_stage_change();

-- ---- auto-log disk changes (set or edited from anywhere) ----
create or replace function public.log_disk_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.production_log (production_id, kind, note, author_id)
  values (new.id, 'disk', new.storage_disk, auth.uid());
  return new;
end;
$$;
drop trigger if exists trg_log_disk_change on public.productions;
create trigger trg_log_disk_change
after update of storage_disk on public.productions
for each row when (new.storage_disk is distinct from old.storage_disk)
execute function public.log_disk_change();
