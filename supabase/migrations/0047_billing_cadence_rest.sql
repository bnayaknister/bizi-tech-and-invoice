-- 0047: the rest of consolidated-billing-by-rhythm (owner spec 2026-07-28).
-- Everything that DEPENDS on the enum values 0046 committed. Run AFTER 0046.
--
-- Most clients bill per episode; a few bill in bulk (monthly, or every N
-- episodes). For those the per-episode chain must FREEZE — the work order does
-- not issue, the deal invoice is never enqueued — until the bookkeeper redeems
-- the client, producing ONE consolidated work order + ONE consolidated deal
-- invoice (the existing bundle mechanism, 0044). The brake itself lives in the
-- app; on_production_approved (which only ever creates the internal job) is
-- untouched. SAFE TO RE-RUN.

-- 1. billing_cadence on the CLIENT (a default only — the bookkeeper always
--    overrides per row in the queue). Distinct axis from clients.billing_mode
--    (the billing STYLE: per_episode/retainer/package/none); this is the
--    FREQUENCY of consolidation. billing_cadence is a brand-new type, so it is
--    usable in this same migration (the 55P04 rule is only about ADD VALUE to
--    an EXISTING enum).
do $$ begin
  create type billing_cadence as enum ('per_episode','monthly','every_n');
exception when duplicate_object then null; end $$;

alter table public.clients
  add column if not exists billing_cadence billing_cadence not null default 'per_episode',
  add column if not exists billing_every_n integer;

do $$ begin
  alter table public.clients add constraint clients_every_n_requires_n
    check (billing_cadence <> 'every_n' or (billing_every_n is not null and billing_every_n > 0));
exception when duplicate_object then null; end $$;

-- which consolidated document a folded row was rolled into (traceability)
alter table public.pending_documents
  add column if not exists consolidated_into uuid references public.pending_documents(id);

-- 2. THE idempotency fix (feasibility Q2/Q6): the one-live-row-per-production
--    index covered only ('pending','approved','issued'). An 'accrued' row was
--    invisible to it, so a repeated 06:00 sync could double-queue. Recast the
--    predicate as "anything that isn't a dead end" — this now covers accrued
--    and consolidated too. rejected/failed still allow a fresh attempt.
drop index if exists pending_documents_one_live_per_production;
create unique index if not exists pending_documents_one_live_per_production
  on public.pending_documents (doc_type, production_id)
  where production_id is not null and status not in ('rejected','failed');

-- index the accrued queue so the redemption screen and the radar aging alert
-- scan it cheaply, grouped by client. (References 'accrued' — safe now that
-- 0046 committed it.)
create index if not exists pending_documents_accrued_idx
  on public.pending_documents (client_id, created_at)
  where status = 'accrued';

-- 3. the client-money guard must cover the new billing columns, so a
--    stages-only user can't change a client's cadence (feasibility Q5).
create or replace function public.guard_client_money_columns()
returns trigger language plpgsql as $$
begin
  if new.default_rate is distinct from old.default_rate
     or new.payment_terms is distinct from old.payment_terms
     or new.billing_mode is distinct from old.billing_mode
     or new.billing_cadence is distinct from old.billing_cadence
     or new.billing_every_n is distinct from old.billing_every_n then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות הגדרות חיוב של לקוח';
    end if;
  end if;
  return new;
end;
$$;
