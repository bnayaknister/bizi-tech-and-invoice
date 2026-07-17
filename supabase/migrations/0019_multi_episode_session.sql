-- 0019: multi-episode session support on the productions board (owner
-- request 2026-07-17) — three related features, one migration:
--
--  1. record_time + guest extraction: a calendar-created production stores
--     the event's start time (Israel local "HH:MM") so two same-day
--     recordings of the same show read differently on the card. Guest
--     already existed (0001) but was never populated from the calendar —
--     app code now extracts it from the title text after the matched alias.
--  2. Calendar duplicate detection: two calendar events for the same show
--     on the same day already become two independent productions (each its
--     own calendar_uid) — nothing schema-wise is needed for that. What's
--     new is `calendar_dup_ack`, set by a technician who confirms "yes,
--     really N separate episodes" so the board stops flagging the group.
--  3. Manual split: a technician can split one production into N when the
--     calendar under-counted a session. Split siblings deliberately SHARE
--     one calendar_uid (screens-spec: "כולן מקושרות לאותו calendar_uid") —
--     the existing 0017 unique index is relaxed to exclude split families.
--
-- `merged_into` is the one soft-delete mechanism for both "iron rules"
-- undo cases (merge a calendar duplicate away, undo a split): this schema
-- never hard-deletes productions (shows/jobs already follow that
-- convention — active=false / archive schema, never DELETE), so a merged
-- or un-split production stays in the table, just hidden from the board.

alter table public.productions
  add column if not exists record_time text,
  add column if not exists split_index integer,
  add column if not exists split_count integer,
  add column if not exists merged_into uuid references public.productions(id),
  add column if not exists calendar_dup_ack boolean not null default false;

-- split siblings share one calendar_uid on purpose — the plain "one event
-- maps to one production" uniqueness only applies outside a split family
drop index if exists productions_calendar_uid_key;
create unique index if not exists productions_calendar_uid_key
  on public.productions (calendar_uid)
  where calendar_uid is not null and split_count is null;

-- split/merge/confirm are stages-tier actions (screens-spec iron rule:
-- "פיצול/מיזוג = פעולת stages, לא נוגע בכסף"), same guard pattern as 0017's
-- calendar columns. Service-role scripts pass through (auth.uid() null).
create or replace function public.guard_production_split_columns()
returns trigger language plpgsql as $$
begin
  if new.split_index is distinct from old.split_index
     or new.split_count is distinct from old.split_count
     or new.merged_into is distinct from old.merged_into
     or new.calendar_dup_ack is distinct from old.calendar_dup_ack then
    if not public.can_edit_stages() then
      raise exception 'רק בעל הרשאת עריכת שלבים יכול לפצל, למזג או לאשר הקלטות';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_production_split on public.productions;
create trigger trg_guard_production_split
before update on public.productions
for each row execute function public.guard_production_split_columns();
