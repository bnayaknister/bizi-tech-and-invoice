-- Cumulative document pull: track when the last FULL (unbounded) scan ran, so
-- the daily pull can stay light (a rolling window) while a weekly full scan
-- guarantees no document is ever permanently missed.
--
-- Background: the original pull used a hard 90-day-first-run + 1-day-overlap
-- incremental window on documentDate. Any document dated before the first
-- run's window was NEVER reachable (762 of the owner's ~1008 Morning documents
-- were invisible). This column drives the weekly full-scan safety net.
alter table app_settings
  add column if not exists documents_last_full_scan_at timestamptz;
