-- Per-production stage rollup — collapses the ~4.3k-row stages scan (5 paged
-- REST round-trips) that the productions board and the radar each do into ONE
-- round-trip of ~713 rows. Correctness of the board was already fixed in app
-- code by paging through every stage row; this view is the perf follow-up.
--
-- security_invoker = on: the view runs with the CALLER's RLS on stages, not
-- the view owner's — so a stages-only technician sees exactly the stages they
-- always could, and the service-role radar keeps bypassing RLS as before.
-- (Requires Postgres 15+, which Supabase is.)
create or replace view public.production_stage_rollup
  with (security_invoker = on)
as
select
  production_id,
  count(*)::int                                   as total,
  count(*) filter (where status = 'done')::int    as done,
  count(*) filter (where status = 'in_progress')::int as in_progress,
  -- in-progress stage detail the board needs to render "who's on what"
  coalesce(
    jsonb_agg(
      jsonb_build_object('track', track, 'step', step, 'assignee_id', assignee_id)
    ) filter (where status = 'in_progress'),
    '[]'::jsonb
  )                                               as in_progress_stages,
  -- every distinct assignee across the production's stages — powers the
  -- board's "mine" flag and the assignee-name lookup
  coalesce(
    array_agg(distinct assignee_id) filter (where assignee_id is not null),
    '{}'::uuid[]
  )                                               as assignee_ids
from public.stages
group by production_id;

grant select on public.production_stage_rollup to anon, authenticated, service_role;
