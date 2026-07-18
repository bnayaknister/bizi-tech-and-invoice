-- 0023: turn invoices into the full document registry the finance screen
-- needs (owner spec 2026-07-18). Every issued document — business invoice
-- ('עסקה') or tax invoice ('מס') — gets one row, whether it came from the
-- Morning API or was entered by hand.
--
-- What's added:
--   source     — morning_api | manual (NEW; the key distinction so that once
--                Morning is live I know at a glance what's synced vs. what a
--                human typed and may need verifying)
--   job_id     — link to the job it settles (was client-only before)
--   doc_number — the human invoice number (morning_doc_id stays the Morning
--                system id + stays UNIQUE so a doc can never be recorded twice)
--   issued_by  — who issued it (null for the historical CSV import)
--
-- The per-job quick flags jobs.invoice_biz / jobs.invoice_tax stay as-is —
-- they're what the tab state derives from and what the historical import
-- populated; a new issuance writes BOTH an invoices row here and the job's
-- flag, so state moves and the document is fully recorded.

do $$ begin
  create type invoice_source as enum ('morning_api', 'manual');
exception when duplicate_object then null; end $$;

alter table public.invoices
  add column if not exists source invoice_source not null default 'manual',
  add column if not exists job_id uuid references public.jobs(id),
  add column if not exists doc_number text,
  add column if not exists issued_by uuid references public.profiles(id);

create index if not exists invoices_job_id_idx on public.invoices (job_id) where job_id is not null;

-- historical rows (the CSV import) are, by definition, not Morning-synced —
-- they keep the default source='manual'; seed doc_number from the morning id
-- we already had so the number shows even before Morning is wired.
update public.invoices
  set doc_number = coalesce(doc_number, morning_doc_id)
  where doc_number is null;
