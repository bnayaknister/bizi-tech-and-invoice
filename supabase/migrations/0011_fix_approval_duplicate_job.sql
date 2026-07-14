-- 🔴 Fix (owner, 2026-07-15): on_production_approved created a DUPLICATE
-- job when the production was already billed — proven live by the אפרת לקט
-- reconciliation close-out (the auto-job had to be deleted by hand,
-- events: auto_job_removed_duplicate). Root cause: the trigger never
-- checked job_productions.
--
-- New behavior: approval of an already-linked production creates nothing;
-- it logs client_approved_already_billed and exits quietly.
create or replace function public.on_production_approved()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_job_id uuid;
begin
  if new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' and new.kind = 'client' then
    if exists (select 1 from public.job_productions where production_id = new.id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', new.id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', new.id, 'client_id', new.client_id));
      return new;
    end if;
    insert into public.jobs (client_id, contract_id, date, campaign, notes)
    values (new.client_id, new.contract_id, current_date, new.podcast_name,
            'נוצר אוטומטית מאישור לקוח. יש להשלים סכום וחשבונית עסקה.')
    returning id into new_job_id;
    insert into public.job_productions (job_id, production_id)
    values (new_job_id, new.id);
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', new.id, 'client_id', new.client_id, 'job_id', new_job_id));
  end if;
  return new;
end;
$$;
