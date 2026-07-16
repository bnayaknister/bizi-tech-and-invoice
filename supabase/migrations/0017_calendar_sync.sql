-- 0017: Google Calendar sync support (screens-spec §11, owner decisions
-- 2026-07-16).
--
-- productions.calendar_uid already exists (0001/0002) but was never
-- populated — the sync now owns it. Two new flags for the conflict cases
-- the owner specified: the calendar changed but the production was already
-- worked on (never silently overwrite), and the calendar event vanished
-- (never silently delete a production). Both are owner-decides flags, not
-- statuses — same pattern as on_hold (0010/0013).

alter table public.productions
  add column if not exists calendar_changed boolean not null default false,
  add column if not exists calendar_removed boolean not null default false,
  add column if not exists calendar_synced_at timestamptz;

-- calendar_uid should be unique when present (one calendar event maps to
-- exactly one production)
create unique index if not exists productions_calendar_uid_key
  on public.productions (calendar_uid) where calendar_uid is not null;

-- these three columns are sync-owned bookkeeping, same tier as on_hold/
-- status — technicians manage them via the sync + the board, not raw edits
create or replace function public.guard_production_calendar_columns()
returns trigger language plpgsql as $$
begin
  if new.calendar_uid is distinct from old.calendar_uid
     or new.calendar_changed is distinct from old.calendar_changed
     or new.calendar_removed is distinct from old.calendar_removed then
    if not public.can_edit_stages() then
      raise exception 'רק בעל הרשאת עריכת שלבים יכול לשנות שדות סנכרון יומן';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_production_calendar on public.productions;
create trigger trg_guard_production_calendar
before update on public.productions
for each row execute function public.guard_production_calendar_columns();
