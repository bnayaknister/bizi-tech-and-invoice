-- Fix: production.status must derive from track='episode' only (reels
-- must never move the status), and must only ever advance, never regress.

create or replace function public.production_status_rank(s production_status)
returns int language sql immutable as $$
  select case s
    when 'ממתין_להתחלה' then 0
    when 'הוקלט' then 1
    when 'בעריכה' then 2
    when 'נערך' then 3
    when 'נשלח_ללקוח' then 4
    when 'אושר_ע"י_לקוח' then 5
  end;
$$;

create or replace function public.derive_production_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cur_status production_status;
  ep_record_status stage_status;
  ep_edit_status stage_status;
  all_done boolean;
  new_status production_status;
begin
  select status into cur_status from public.productions where id = new.production_id;
  if cur_status = 'אושר_ע"י_לקוח' then
    return new; -- manual terminal state, never touched by derivation
  end if;

  select status into ep_record_status from public.stages
    where production_id = new.production_id and track = 'episode' and step = 'record';
  select status into ep_edit_status from public.stages
    where production_id = new.production_id and track = 'episode' and step = 'edit';
  select bool_and(status = 'done') into all_done
    from public.stages where production_id = new.production_id; -- all 6, both tracks

  if all_done then
    new_status := 'נשלח_ללקוח';
  elsif ep_edit_status = 'done' then
    new_status := 'נערך';
  elsif ep_edit_status = 'in_progress' then
    new_status := 'בעריכה';
  elsif ep_record_status = 'done' then
    new_status := 'הוקלט';
  else
    new_status := 'ממתין_להתחלה';
  end if;

  if public.production_status_rank(new_status) > public.production_status_rank(cur_status) then
    update public.productions set status = new_status where id = new.production_id;
    insert into public.events (entity_type, entity_id, event_type, payload)
      values ('production', new.production_id, 'status_advanced',
              jsonb_build_object('from', cur_status, 'to', new_status));
  elsif public.production_status_rank(new_status) < public.production_status_rank(cur_status) then
    -- a stage got reverted; log it but do NOT downgrade without owner approval
    insert into public.events (entity_type, entity_id, event_type, payload)
      values ('production', new.production_id, 'status_regression_blocked',
              jsonb_build_object('current', cur_status, 'would_be', new_status, 'stage_id', new.id));
  end if;

  return new;
end;
$$;
