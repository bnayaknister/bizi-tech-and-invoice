-- RPC functions to move rows into the archive schema. Needed because
-- `archive` isn't in PostgREST's exposed-schemas list (public only) —
-- these run server-side as security definer, so they can reach it directly.
--
-- Hardened per owner review: security definer bypasses RLS, so without an
-- explicit check any authenticated caller could empty out jobs/productions.
--   - allowed callers: owner, or the service_role key (used only by
--     migration scripts — it already bypasses RLS on these tables
--     directly, and this function is its only path into archive, so
--     allowing it here opens nothing that wasn't already open)
--   - delete only fires if the archive copy fully succeeded (row count
--     matches expected); otherwise it raises and the whole call rolls back
--   - EXECUTE revoked from anon, granted only to authenticated

create or replace function public.move_jobs_to_archive(job_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  moved integer;
  expected integer := coalesce(array_length(job_ids, 1), 0);
begin
  if not (public.is_owner() or auth.role() = 'service_role') then
    raise exception 'רק owner יכול להעביר רשומות לארכיון';
  end if;

  insert into archive.jobs select * from public.jobs where id = any(job_ids);
  get diagnostics moved = row_count;

  if moved is distinct from expected then
    raise exception 'ההעתקה לארכיון לא הושלמה במלואה (% מתוך %) — מבטל', moved, expected;
  end if;

  delete from public.jobs where id = any(job_ids);
  return moved;
end;
$$;

revoke all on function public.move_jobs_to_archive(uuid[]) from public;
revoke all on function public.move_jobs_to_archive(uuid[]) from anon;
grant execute on function public.move_jobs_to_archive(uuid[]) to authenticated;

create or replace function public.move_productions_to_archive(production_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  moved integer;
  expected integer := coalesce(array_length(production_ids, 1), 0);
begin
  if not (public.is_owner() or auth.role() = 'service_role') then
    raise exception 'רק owner יכול להעביר רשומות לארכיון';
  end if;

  insert into archive.productions select * from public.productions where id = any(production_ids);
  get diagnostics moved = row_count;

  if moved is distinct from expected then
    raise exception 'ההעתקה לארכיון לא הושלמה במלואה (% מתוך %) — מבטל', moved, expected;
  end if;

  delete from public.productions where id = any(production_ids);
  return moved;
end;
$$;

revoke all on function public.move_productions_to_archive(uuid[]) from public;
revoke all on function public.move_productions_to_archive(uuid[]) from anon;
grant execute on function public.move_productions_to_archive(uuid[]) to authenticated;
