-- 0027: the documents registry — every Morning document we know about, from
-- either direction (owner spec 2026-07-19/20).
--
-- Two sources feed it:
--   source='app'  — issued through our approval queue (issue.ts writes here
--                   the moment it issues, so app-issued docs appear at once,
--                   not only after the next pull)
--   source='pull' — found by the daily pull of Morning /documents/search,
--                   i.e. issued directly in Morning by the bookkeeper
-- morning_doc_id is the shared key and is UNIQUE, so the same document can
-- never be recorded twice regardless of which path saw it first — the pull
-- upserts on it.
--
-- Why a separate table and not `invoices`: invoices is the finance-pipeline
-- registry and means exactly two things (חשבון עסקה / חשבונית מס). This
-- holds ALL Morning document types (work orders, receipts, credit notes…)
-- and rows with no client match yet, so it must not constrain type or
-- require a client. The finance screen keeps reading invoices unchanged.
--
-- client_id is NULLABLE on purpose: a document whose Morning client isn't
-- mapped to any of ours is "unmatched" — it lands here with a null client
-- and its own tab, never dropped (owner: "מסמך שלא מזוהה → לשונית לא משויך").

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  morning_doc_id text not null unique,
  morning_doc_number text,
  type integer not null,                 -- Morning type code (100/300/305/320/400/…)
  status integer,                        -- Morning status code
  client_id uuid references public.clients(id),   -- our client; null = unmatched
  morning_client_id text,                -- the Morning client id on the document
  morning_client_name text,
  amount numeric,
  currency text not null default 'ILS',
  document_date date,
  pdf_url text,
  source text not null check (source in ('app', 'pull', 'manual')),
  production_id uuid references public.productions(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_type_idx on public.documents (type);
create index if not exists documents_client_idx on public.documents (client_id);
create index if not exists documents_unmatched_idx on public.documents (id) where client_id is null;
create index if not exists documents_date_idx on public.documents (document_date);

alter table public.documents enable row level security;

-- money eyes only, same as invoices/pending_documents — a document row
-- exposes client names and amounts
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (public.can_view_money());

-- written only by the server (issuance write-through + the daily pull), both
-- via the service role — no client-side insert/update path, RLS denies by
-- default and that's intended.

-- when the daily pull last ran, so the next run only asks Morning for what's
-- new (kept in app_settings, the existing singleton settings row)
alter table public.app_settings
  add column if not exists documents_pulled_at timestamptz;
