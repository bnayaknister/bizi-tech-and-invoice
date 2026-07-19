-- 0025: no document reaches Morning without a human approving it
-- (owner spec 2026-07-19).
--
-- Documents are no longer issued as a side effect of something else
-- happening. A production arriving at 06:00 does not create a work order; a
-- client approval does not create a deal invoice. Both create a ROW HERE,
-- and a human with can_edit_money turns that row into a real document.
--
-- Why a separate table and not approval_requests (0021): that queue is for
-- destructive actions a technician may not perform, reviewed by a user
-- MANAGER. This is a money queue reviewed by a money user, it holds the
-- exact API payload, and its rows have a lifecycle after approval
-- (issued/failed, morning_doc_id, retries). Different reviewer, different
-- shape, different lifecycle — same spirit.
--
-- The queue is the leak-prevention device, so the queue itself must not be
-- able to leak: pending_documents_aging_idx below is what the 24h/72h
-- alerts read. A queue nobody empties is the failure this replaces.

do $$ begin
  create type pending_doc_type as enum ('work_order','deal_invoice','tax_invoice','tax_receipt');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pending_doc_status as enum ('pending','approved','rejected','issued','failed');
exception when duplicate_object then null; end $$;

-- Morning's client id for each of our clients. Without it we refuse to
-- issue — see the eligibility gate in the app. UNIQUE because two of our
-- clients pointing at one Morning client would silently merge their billing.
alter table public.clients
  add column if not exists morning_client_id text;

do $$ begin
  alter table public.clients add constraint clients_morning_client_id_key unique (morning_client_id);
exception when duplicate_object then null; end $$;

-- Why a production produced no document. Set when the eligibility gate
-- refuses (no client, client not mapped to Morning, billing_mode='none'…)
-- and cleared the moment it passes. This is the 🟡 the radar renders —
-- "nothing happened" must always carry its reason.
alter table public.productions
  add column if not exists billing_block_reason text;

create table if not exists public.pending_documents (
  id uuid primary key default gen_random_uuid(),
  doc_type pending_doc_type not null,
  production_id uuid references public.productions(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  client_id uuid references public.clients(id),
  amount numeric,
  -- exactly what will be sent to Morning, built at enqueue time and shown
  -- to the approver. What she sees is what goes out.
  payload jsonb not null default '{}'::jsonb,
  status pending_doc_status not null default 'pending',
  created_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  reject_reason text,
  -- filled only after a successful issuance
  morning_doc_id text unique,
  morning_doc_number text,
  pdf_url text,
  issued_at timestamptz,
  -- failure bookkeeping: the API call failed, nothing local was written,
  -- and this is why (iron rule 2 — all or nothing)
  last_error text,
  attempts integer not null default 0
);

-- A rejected row must say why; an issued row must carry its Morning id.
do $$ begin
  alter table public.pending_documents add constraint pending_doc_reject_has_reason
    check (status <> 'rejected' or length(trim(coalesce(reject_reason,''))) > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.pending_documents add constraint pending_doc_issued_has_morning_id
    check (status <> 'issued' or morning_doc_id is not null);
exception when duplicate_object then null; end $$;

-- Iron rule 1, enforced in the schema rather than trusted to the caller:
-- one live document of a given type per production. A rejected or failed
-- row does not block a fresh attempt; a pending/approved/issued one does.
-- This is what makes the 06:00 sync safe to re-run.
create unique index if not exists pending_documents_one_live_per_production
  on public.pending_documents (doc_type, production_id)
  where production_id is not null and status in ('pending','approved','issued');

-- the aging alerts (24h -> bookkeeper, 72h -> owner) scan exactly this
create index if not exists pending_documents_aging_idx
  on public.pending_documents (created_at)
  where status = 'pending';

create index if not exists pending_documents_client_idx
  on public.pending_documents (client_id);

alter table public.pending_documents enable row level security;

-- Money queue: money eyes only. Reading a pending document exposes client
-- names and amounts, so it sits behind can_view_money exactly like invoices.
drop policy if exists pending_documents_select on public.pending_documents;
create policy pending_documents_select on public.pending_documents
  for select using (public.can_view_money());

-- Approving/rejecting is a money action. Note the app performs the actual
-- issuance through the service role (it must write morning_doc_id and call
-- the API); this policy is defence in depth for a money user's own session.
drop policy if exists pending_documents_update on public.pending_documents;
create policy pending_documents_update on public.pending_documents
  for update using (public.can_edit_money()) with check (public.can_edit_money());

-- Rows are created by the server (calendar sync / approval hook) via the
-- service role. No client-side insert path exists, so no insert policy is
-- granted — RLS denies by default and that is the intent.
