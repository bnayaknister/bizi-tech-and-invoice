-- 0044: bundle several jobs onto ONE deal invoice (owner spec — a podcast that
-- records N episodes and pays at the end, e.g. חתונמיות = 6 episodes → one
-- חשבון עסקה with a line per episode, not six invoices).
--
-- The authoritative grouping is jobs.invoice_biz: every job in a bundle carries
-- the SAME deal-invoice number, which is what lets one payment mark them all
-- paid. bundle_job_ids records the membership explicitly on the queue row (so
-- issuance knows which jobs to flip, before a number exists) and on the
-- document (traceability + "bundle of N" in the registry). Not FK-enforced —
-- it is metadata; the shared invoice_biz is the real link.
alter table public.pending_documents
  add column if not exists bundle_job_ids uuid[];

alter table public.documents
  add column if not exists bundle_job_ids uuid[];
