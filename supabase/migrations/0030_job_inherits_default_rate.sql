-- 0030: the job created on client approval inherits the show's default_rate
-- as its amount (owner backlog item, 2026-07-21).
--
-- Until now on_production_approved created the job with a null amount and a
-- "fill in the amount" note, even when the show had a default_rate — so the
-- bookkeeper retyped a number the system already knew. The deal invoice
-- already used default_rate (via the enqueue eligibility); this brings the
-- job in line so both carry the same inherited price.
--
-- Runs security definer, so it may read shows.default_rate (money-restricted
-- to authenticated by 0022) regardless of who triggered the approval —
-- including the account-less client review response.
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_job_id uuid;
  rate numeric;
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' and new.kind = 'client' then
    if exists (select 1 from public.job_productions where production_id = new.id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', new.id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', new.id, 'client_id', new.client_id));
      return new;
    end if;

    select default_rate into rate from public.shows where id = new.show_id;

    insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
    values (new.client_id, new.contract_id, current_date, new.podcast_name, rate,
            case when rate is not null
                 then 'נוצר אוטומטית מאישור לקוח. מחיר יורש מהתוכנית — לאמת ולהנפיק חשבונית עסקה.'
                 else 'נוצר אוטומטית מאישור לקוח. יש להשלים סכום וחשבונית עסקה.' end)
    returning id into new_job_id;

    insert into public.job_productions (job_id, production_id)
    values (new_job_id, new.id);

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', new.id, 'client_id', new.client_id, 'job_id', new_job_id,
                               'inherited_rate', rate));
  end if;
  return new;
end;
$$;
