-- 0028: cancel a production without erasing it (owner scenario 2026-07-21 —
-- "אוכלי סרטים" was booked, synced at 06:00, then the client cancelled the
-- morning of the recording).
--
-- Cancel is not delete: the row stays for search and history, the calendar
-- link stays so tomorrow's sync can recognise and SKIP the still-present
-- event instead of recreating the production, and any downstream document is
-- handled by state (a pending queue item is cancelled; an already-issued one
-- is flagged for manual closing in Morning — we never delete there).
--
-- 'בוטל' is added to the status enum. It needs no special handling in the
-- status-derivation trigger (0003): production_status_rank has no case for it
-- and returns NULL, so the "only ever advance" comparison leaves a cancelled
-- production untouched by any later stage edit. The move INTO 'בוטל' is a
-- normal status change — guard_production_stage_columns (0010) already
-- requires can_edit_stages for it, which is exactly who may cancel.

alter type production_status add value if not exists 'בוטל';

-- 'cancelled' for a queued document whose production was cancelled before the
-- document was ever issued — nothing went to Morning, so it's not 'rejected'
-- (a human choice) but cancelled by the production going away.
alter type pending_doc_status add value if not exists 'cancelled';

alter table public.productions
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.profiles(id),
  add column if not exists cancel_reason text;

-- expose the new columns to authenticated reads (0022 made shows' grant
-- column-explicit; productions isn't column-restricted, but be explicit that
-- these are readable — the board shows the cancel reason in history)
grant select (cancelled_at, cancelled_by, cancel_reason) on public.productions to authenticated;
