-- 0041: soft-dismissal of a finance record (owner spec 2026-07-26).
--
-- A money record is not a kanban card — removing a wrong/duplicate/irrelevant
-- job (a test, a cancellation) must NEVER hard-delete it. It is HIDDEN:
-- dismissed=true drops it from every table and counter (debt, overdue, VU),
-- but it is fully recoverable from the "מוסתרים" tab. Reason is mandatory,
-- and who/when are recorded; every dismiss/restore is also evented.
--
-- Permission: an admin only (can_manage_users) — a technician/bookkeeper never
-- sees the control. Enforced in the API route (service-role write after a
-- can_manage_users check) AND, defense-in-depth, by the guard below so a
-- can_edit_money user can't flip the flag straight through PostgREST.

alter table public.jobs
  add column if not exists dismissed boolean not null default false,
  add column if not exists dismiss_reason text,
  add column if not exists dismissed_by uuid references public.profiles(id),
  add column if not exists dismissed_at timestamptz;

create index if not exists jobs_dismissed_idx on public.jobs (dismissed) where dismissed = true;

-- archive.jobs must stay column-identical to public.jobs (move_jobs_to_archive
-- does `insert into archive.jobs select * from public.jobs`).
alter table archive.jobs
  add column if not exists dismissed boolean not null default false,
  add column if not exists dismiss_reason text,
  add column if not exists dismissed_by uuid,
  add column if not exists dismissed_at timestamptz;

-- only a user-manager may hide or restore a record. Mirrors the money-guard
-- pattern (0010): a service-role write has auth.uid() null, so the check is
-- null and never raises — the API route is the authorized path.
create or replace function public.guard_job_dismissal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.dismissed is distinct from old.dismissed
      or new.dismiss_reason is distinct from old.dismiss_reason) then
    if auth.uid() is not null and not public.can_manage_users() then
      raise exception 'רק מנהל משתמשים יכול להסתיר או לשחזר חיוב';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_job_dismissal on public.jobs;
create trigger trg_guard_job_dismissal
  before update on public.jobs
  for each row execute function public.guard_job_dismissal();
