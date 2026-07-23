-- 0039: reconnect the top status cursor to the stages, forward-only.
--
-- 0013 decoupled status from the stages (drag-driven board). Owner 2026-07-24:
-- that was a mistake — the top cursor means "where the production is, roughly",
-- and it must move when the stages move, or a tech advances a step and sees
-- nothing change up top. This re-derives the cursor from the stages, but under
-- strict rules so it never fights a human or the billing gate:
--
--   1. FORWARD ONLY. It never pulls the cursor back.
--   2. HANDS OFF manual/terminal states. Once a production reaches
--      'נשלח_ללקוח' / 'ממתין_לתגובת_לקוח' / 'אושר_ע"י_לקוח' / 'הופץ' / 'בוטל',
--      or is frozen (on_hold), the trigger stops touching it — only a human
--      moves it out of there. This is what keeps 'אושר_ע"י_לקוח' (which fires
--      the deal invoice) purely manual/link-driven: the trigger can only ever
--      set the five auto states below, never the approval state.
--   3. The board drag and the drawer's exceptional-jump button still write
--      status directly and always win — a human overrides the trigger.
--   4. Every auto move is logged to events with source='stage_trigger'.
--
-- Reels has no 'record' step (0038); since reels are cut from the episode raw,
-- "recorded" collapses to the episode being recorded. When reels aren't
-- required for a production, they don't hold the cursor back.

-- rank of the AUTO-controlled cursor states. Manual/terminal states rank above
-- them all (99) so a forward-only comparison never re-enters them.
create or replace function public.prod_cursor_rank(s production_status)
returns int language sql immutable as $$
  select case s
    when 'עתיד_להתחיל' then 0
    when 'בהקלטה'      then 1
    when 'הוקלט'       then 2
    when 'בעריכה'      then 3
    when 'נערך'        then 4
    else 99
  end;
$$;

create or replace function public.derive_production_status()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cur       production_status;
  frozen    boolean;
  reels_req boolean;
  ep_rec    stage_status;
  ep_edit   stage_status;
  ep_del    stage_status;
  re_edit   stage_status;
  re_del    stage_status;
  derived   production_status;
  auto_states constant production_status[] := array[
    'עתיד_להתחיל','בהקלטה','הוקלט','בעריכה','נערך'
  ]::production_status[];
begin
  -- assignee-only stage edits must not move the cursor
  if new.status is not distinct from old.status then
    return new;
  end if;

  select status, on_hold, review_reels_required
    into cur, frozen, reels_req
    from public.productions where id = new.production_id;

  -- rule 2: hands off once the cursor left the auto-controlled band, or frozen.
  -- (a NULL cur — impossible in practice — also stops here, safely.)
  if coalesce(frozen, false) or cur is null or not (cur = any(auto_states)) then
    return new;
  end if;

  select status into ep_rec  from public.stages where production_id = new.production_id and track = 'episode' and step = 'record';
  select status into ep_edit from public.stages where production_id = new.production_id and track = 'episode' and step = 'edit';
  select status into ep_del  from public.stages where production_id = new.production_id and track = 'episode' and step = 'deliver';
  select status into re_edit from public.stages where production_id = new.production_id and track = 'reels'   and step = 'edit';
  select status into re_del  from public.stages where production_id = new.production_id and track = 'reels'   and step = 'deliver';

  -- reels out of scope → they don't hold the cursor (treated as absent)
  if not coalesce(reels_req, true) then
    re_edit := null;
    re_del  := null;
  end if;

  -- highest applicable cursor from the stage picture (forward-only enforced after)
  if ep_del = 'done' and coalesce(re_del, 'done') = 'done' then
    derived := 'נערך';                         -- both lines delivered
  elsif ep_edit in ('in_progress','done')
        or coalesce(re_edit, 'pending') in ('in_progress','done')
        or ep_del <> 'pending'
        or coalesce(re_del, 'pending') <> 'pending' then
    derived := 'בעריכה';                       -- a line is at/past editing
  elsif ep_rec = 'done' then
    derived := 'הוקלט';                         -- episode recorded
  elsif ep_rec = 'in_progress' then
    derived := 'בהקלטה';                        -- recording started
  else
    derived := 'עתיד_להתחיל';
  end if;

  -- rule 1: forward only
  if public.prod_cursor_rank(derived) > public.prod_cursor_rank(cur) then
    update public.productions set status = derived where id = new.production_id;
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', new.production_id, 'status_auto_advanced', auth.uid(),
              jsonb_build_object('from', cur, 'to', derived,
                                 'source', 'stage_trigger', 'stage_id', new.id));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_derive_production_status on public.stages;
create trigger trg_derive_production_status
after update of status on public.stages
for each row execute function public.derive_production_status();
