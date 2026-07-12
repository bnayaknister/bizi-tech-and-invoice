-- The system must know what it doesn't know. amount_is_estimated defaults
-- true for every invoice until a real Morning sync (step 8) sets it false.
-- date_is_estimated defaults false; the 7 invoices with no dated job at
-- all get backfilled to true by a follow-up script (source: the original
-- CSV, since archiving already moved the underlying jobs).

alter table public.invoices
  add column if not exists date_is_estimated boolean not null default false,
  add column if not exists amount_is_estimated boolean not null default true;
