-- 0020: fix create_default_stages() to run as SECURITY DEFINER.
--
-- Found while building the manual split feature (0019): productions had
-- only ever been inserted via the service-role admin client (calendar
-- sync, CSV importer, seed scripts) — never through a plain user session.
-- The split route is the first place that inserts a production through
-- the *technician's own* session (RLS-as-the-real-gate, same pattern as
-- every other write in this app), which exposed a pre-existing gap: there
-- is no stages_insert RLS policy at all, and create_default_stages() (the
-- AFTER INSERT trigger on productions that creates the 6 stage rows) was
-- never marked SECURITY DEFINER — so it ran with the invoker's own rights
-- and hit stages' default-deny, even though productions_insert itself
-- correctly allowed the insert (can_edit_stages() or can_import()).
--
-- Same fix already applied to on_production_approved()/derive_production_status
-- (0002) and handle_new_user() (0002) for the identical reason: a trigger's
-- internal bookkeeping insert must not be gated by the calling session's
-- own table permissions.
create or replace function public.create_default_stages()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
  select new.id, new.podcast_name, new.guest, new.record_date, t, s, 'pending'
  from unnest(array['episode','reels']::stage_track[]) as t
  cross join unnest(array['record','edit','deliver']::stage_step[]) as s;
  return new;
end;
$$;
