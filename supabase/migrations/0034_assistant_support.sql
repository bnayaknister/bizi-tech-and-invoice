-- 0034: support tables/functions for the AI business-question assistant
-- (owner spec 2026-07-21). The assistant itself runs entirely in the asking
-- user's own session — never service_role — so RLS is the real wall for
-- every ordinary table it reads. This migration adds only the two things
-- that need new server-side support:
--
--   1. assistant_queries — an audit log of every question the bot answered.
--      Not stored in `events`: entity_id there is NOT NULL uuid, and a Q&A
--      isn't tied to one entity. Owner-only select, matching `events`' own
--      visibility (0002). Writes are server-only via the admin client — the
--      SAME pattern every other audit write in this app already uses; this
--      is a legitimate admin-client use (logging), distinct from ever using
--      it to ANSWER a question (which always runs on the asking user's own
--      session client, so table RLS applies exactly as it does everywhere
--      else in the app).
--
--   2. assistant_archive_client_revenue — a narrow bridge into the archive
--      schema for "how much did we make from X historically" questions.
--      archive.* is NOT exposed over REST (see the comment in
--      scripts/backfill_archive_job_ids.py) — so a plain table query via the
--      user's session client can't reach it, RLS or not. This function is
--      the same bridge pattern as import_archive_ids (0014): SECURITY
--      DEFINER so it CAN read archive.jobs, but it re-checks
--      public.is_owner() explicitly inside the body — the real gate, since
--      table RLS can't do this job for a schema that isn't queryable
--      directly. Anyone else gets a clean exception.

create table if not exists public.assistant_queries (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  question text not null,
  answer text,
  tools_used jsonb not null default '[]'::jsonb,
  blocked boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.assistant_queries enable row level security;
drop policy if exists assistant_queries_owner_select on public.assistant_queries;
create policy assistant_queries_owner_select on public.assistant_queries
  for select using (public.is_owner());

create or replace function public.assistant_archive_client_revenue(p_client_id uuid)
returns table(total numeric, job_count bigint)
language plpgsql security definer set search_path = public, archive as $$
begin
  if not public.is_owner() then
    raise exception 'רק הבעלים יכול לשאול על נתוני ארכיון';
  end if;
  return query
    select coalesce(sum(amount), 0)::numeric, count(*)::bigint
    from archive.jobs
    where client_id = p_client_id;
end;
$$;

revoke all on function public.assistant_archive_client_revenue(uuid) from public;
grant execute on function public.assistant_archive_client_revenue(uuid) to authenticated;
