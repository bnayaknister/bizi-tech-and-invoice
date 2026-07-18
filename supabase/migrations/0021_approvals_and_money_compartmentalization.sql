-- 0021: approval queue for destructive actions + hermetic money
-- compartmentalization (owner decisions 2026-07-18).
--
-- Three DB-level things here; the queue flow itself (create/list/review +
-- execute-on-approve) lives in the app routes, which run the actual
-- destructive op with the service role only after a manager approves.

-- ============================================================
-- 1. approval_requests — the queue
-- ============================================================
-- A stages user (technician) never performs a big destructive action
-- directly — they FILE a request that sits here until a user-manager
-- (owner/admin) approves or rejects. Approval executes the real op with
-- admin rights (in the app route); the row is kept forever as an audit log.
create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id),
  action_type text not null,      -- e.g. show_delete, show_archive, show_merge, production_delete, client_delete, bulk_*
  entity_type text not null,      -- show / production / client / ...
  entity_id uuid,                 -- null for bulk actions (ids live in payload)
  payload jsonb not null default '{}'::jsonb,  -- exactly what will happen
  reason text not null,           -- why — mandatory
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  constraint approval_reason_not_blank check (length(trim(reason)) > 0)
);

create index if not exists approval_requests_pending_idx
  on public.approval_requests (status, created_at) where status = 'pending';
create index if not exists approval_requests_entity_idx
  on public.approval_requests (entity_type, entity_id) where status = 'pending';

alter table public.approval_requests enable row level security;

-- a stages editor files a request, for themselves, always starting pending
create policy approvals_insert on public.approval_requests
  for insert with check (
    public.can_edit_stages() and requested_by = auth.uid() and status = 'pending'
  );
-- the requester sees their own; a user-manager (admin/owner) sees them all
create policy approvals_select on public.approval_requests
  for select using (requested_by = auth.uid() or public.can_manage_users());
-- only a user-manager may review. The app route does the review + execution
-- through the service role; this policy is defense in depth so a manager's
-- own session also can't touch a request they shouldn't.
create policy approvals_review on public.approval_requests
  for update using (public.can_manage_users()) with check (public.can_manage_users());

-- ============================================================
-- 2. destructive-op enforcement — tech can't do it directly
-- ============================================================
-- Deleting/merging a show is an admin action. A technician (can_edit_stages
-- but not can_manage_users) hitting the delete directly is denied at RLS;
-- their only path is the approval queue, which runs as the service role on
-- approve. (Undo-split / undo-merge of a production stay a plain tech action
-- per the multi-episode spec — not touched here.)
drop policy if exists shows_delete on public.shows;
create policy shows_delete on public.shows
  for delete using (public.can_manage_users());

-- ============================================================
-- 3. hermetic money compartmentalization
-- ============================================================
-- jobs / contracts / contract_milestones / invoices already return ZERO
-- rows to a non-can_view_money session (their SELECT policies are
-- can_view_money-only), so no money amount leaks there.
--
-- clients was readable by stages users too (for name lookups), but the row
-- carries money config (default_rate, billing_mode, payment_terms,
-- contact_name). Tighten it to can_view_money only — a technician now gets
-- zero client rows anywhere, including a raw PostgREST pull. Nothing a
-- stages user sees needs clients (the productions board and shows screen
-- both fetch client names only under can_view_money).
drop policy if exists clients_view on public.clients;
create policy clients_view on public.clients
  for select using (public.can_view_money());

-- shows MUST stay readable by stages users (aliases/studio/camera feed their
-- daily work), but it also carries money columns. RLS is row-level, not
-- column-level, and every logged-in user shares the `authenticated` role, so
-- the only way to keep the money AMOUNT off a technician's raw query is a
-- column privilege. Revoke the price column from authenticated/anon; money
-- users read it through the service-role path (app checks can_view_money
-- first). client_id/billing_mode are relational classification (not amounts)
-- and remain readable — relocating client_id would break the calendar-sync
-- creation path, and the app layer already hides them from stages users.
revoke select (default_rate) on public.shows from authenticated;
revoke select (default_rate) on public.shows from anon;
