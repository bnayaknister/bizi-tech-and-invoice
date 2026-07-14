-- EntityDrawer groundwork (owner decision 2026-07-15): the drawer is a new
-- entry point into every entity, so the DB itself must be the wall — the
-- trg_guard_show_money pattern (0008) extended to every money column, plus
-- a stages-guard on productions. RLS already blocks most of these paths
-- (jobs/clients/contracts updates all require can_edit_money); the triggers
-- are defense in depth so a future RLS loosening can't silently open money.
--
-- Pattern note (same as 0008): service-role scripts have auth.uid() null →
-- can_edit_*() is null → `if not null` never raises → they pass through.

-- ---------- productions.on_hold (drawer: הקפאה) ----------
alter table public.productions
  add column if not exists on_hold boolean not null default false;

-- ---------- jobs: money columns ----------
create or replace function public.guard_job_money_columns()
returns trigger language plpgsql as $$
begin
  if new.amount is distinct from old.amount
     or new.paid is distinct from old.paid
     or new.invoice_biz is distinct from old.invoice_biz
     or new.invoice_tax is distinct from old.invoice_tax
     or new.client_id is distinct from old.client_id
     or new.contract_id is distinct from old.contract_id
     or new.manual_only is distinct from old.manual_only then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות שדות כספיים של חיוב';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_job_money on public.jobs;
create trigger trg_guard_job_money
before update on public.jobs
for each row execute function public.guard_job_money_columns();

-- ---------- clients: billing config ----------
create or replace function public.guard_client_money_columns()
returns trigger language plpgsql as $$
begin
  if new.default_rate is distinct from old.default_rate
     or new.payment_terms is distinct from old.payment_terms
     or new.billing_mode is distinct from old.billing_mode then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות הגדרות חיוב של לקוח';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_client_money on public.clients;
create trigger trg_guard_client_money
before update on public.clients
for each row execute function public.guard_client_money_columns();

-- ---------- contracts + milestones ----------
create or replace function public.guard_contract_money_columns()
returns trigger language plpgsql as $$
begin
  if new.total_amount is distinct from old.total_amount
     or new.client_id is distinct from old.client_id then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות סכום או לקוח של חוזה';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_contract_money on public.contracts;
create trigger trg_guard_contract_money
before update on public.contracts
for each row execute function public.guard_contract_money_columns();

create or replace function public.guard_milestone_money_columns()
returns trigger language plpgsql as $$
begin
  if new.amount is distinct from old.amount then
    if not public.can_edit_money() then
      raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות סכום של אבן דרך';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_milestone_money on public.contract_milestones;
create trigger trg_guard_milestone_money
before update on public.contract_milestones
for each row execute function public.guard_milestone_money_columns();

-- ---------- productions: stage columns need can_edit_stages ----------
-- Real gap being closed (not just depth): productions_update RLS allows
-- can_edit_money OR can_edit_stages, so until now a money-only user could
-- flip status/on_hold. Status here covers every transition EXCEPT into
-- 'אושר_ע"י_לקוח' — that one belongs to trg_guard_client_approval
-- (can_edit_money), and a money-only user must stay able to approve.
-- Derived-status updates (via stage edits) pass because the invoker holds
-- can_edit_stages; service-role scripts pass via the null pattern.
create or replace function public.guard_production_stage_columns()
returns trigger language plpgsql as $$
begin
  if new.on_hold is distinct from old.on_hold
     or (new.status is distinct from old.status and new.status <> 'אושר_ע"י_לקוח') then
    if not public.can_edit_stages() then
      raise exception 'רק בעל הרשאת עריכת שלבים יכול לשנות סטטוס או הקפאה של הפקה';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_production_stages on public.productions;
create trigger trg_guard_production_stages
before update on public.productions
for each row execute function public.guard_production_stage_columns();
