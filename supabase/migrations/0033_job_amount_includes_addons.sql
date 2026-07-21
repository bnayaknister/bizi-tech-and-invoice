-- 0033: the job created on client approval carries the SAME total as the
-- deal invoice — effective price + approved add-ons (owner decision
-- 2026-07-21). Before this the job inherited only the base default_rate
-- (0030), so a 3,000 job could sit behind a 5,000 invoice: the finance
-- screen under-reported the debt and the Morning reconciliation broke. That
-- drift is exactly what this system exists to prevent.
--
-- Effective price = price_override ?? show.default_rate (the same rule the
-- enqueue eligibility uses). Add-on total = Σ total of this production's
-- 'approved' lines. TIMING: the review-response path now flips the add-ons
-- to 'approved' BEFORE it flips the production to client-approved, so by the
-- time this AFTER-UPDATE trigger runs the add-ons are already approved and
-- this sum sees them. The manual board-approval path sums whatever a money
-- editor had already approved by hand — same read, correct either way.
--
-- Security definer so it may read shows.default_rate / price_override /
-- production_addons prices (all money-restricted to authenticated), same as
-- 0030 — including the account-less client review response.
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_job_id uuid;
  base_amount numeric;
  addon_total numeric;
  job_amount numeric;
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' and new.kind = 'client' then
    if exists (select 1 from public.job_productions where production_id = new.id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', new.id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', new.id, 'client_id', new.client_id));
      return new;
    end if;

    -- effective base: the production's override wins over the show default
    select coalesce(new.price_override, s.default_rate) into base_amount
    from public.shows s where s.id = new.show_id;

    -- approved, priced add-ons on this production
    select coalesce(sum(total), 0) into addon_total
    from public.production_addons
    where production_id = new.id and status = 'approved' and total is not null;

    -- when there's no base price the deal invoice is blocked anyway, so leave
    -- the job amount null (the "fill in the amount" note applies); otherwise
    -- the job total is base + approved add-ons, to the shekel of the invoice
    if base_amount is not null then
      job_amount := base_amount + coalesce(addon_total, 0);
    else
      job_amount := null;
    end if;

    insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
    values (new.client_id, new.contract_id, current_date, new.podcast_name, job_amount,
            case when job_amount is not null
                 then 'נוצר אוטומטית מאישור לקוח. סכום = מחיר אפקטיבי + תוספות מאושרות — לאמת ולהנפיק חשבונית עסקה.'
                 else 'נוצר אוטומטית מאישור לקוח. יש להשלים סכום וחשבונית עסקה.' end)
    returning id into new_job_id;

    insert into public.job_productions (job_id, production_id)
    values (new_job_id, new.id);

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', new.id, 'client_id', new.client_id, 'job_id', new_job_id,
                               'base_amount', base_amount, 'addon_total', addon_total, 'job_amount', job_amount));
  end if;
  return new;
end;
$$;
