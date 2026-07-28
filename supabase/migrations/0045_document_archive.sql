-- 0045: archive unassigned registry documents (owner spec). 277 of 314
-- "לא משויך" docs are pre-app / outside-pipeline history — a Morning client
-- that doesn't exist in the app, older than 90 days, no linked job. They clutter
-- the dashboard and the registry. Archiving hides them from the normal views
-- and the counters WITHOUT deleting: archived_at is the single flag, restore
-- clears it. Never touched by the daily pull. Same shape as cancellation (0043).
alter table public.documents
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.profiles(id),
  add column if not exists archive_reason text;
