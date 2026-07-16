-- 0015: support backfilling external_id on archive.jobs.
--
-- Root cause found (owner, 2026-07-16): step2_migrate.py already ran
-- move_jobs_to_archive for 106 jobs — archive.jobs genuinely holds them
-- (confirmed: archive_jobs_total=106, public.jobs=51, 106+51=157 matches
-- the source CSV exactly). But that move happened BEFORE migration 0014
-- added external_id, so all 106 archived rows have external_id=NULL.
-- import_archive_ids (0014) was already correct — it just had nothing to
-- match against. This is a data backfill, not a logic fix.
--
-- archive isn't in PostgREST's exposed schemas, so a Python backfill
-- script needs a bridge: read archive.jobs (with client name, for the same
-- fingerprint the live backfill used) and write external_id back.
-- service_role only — same restriction as move_jobs_to_archive (0005).

create or replace function public.archive_jobs_for_backfill()
returns table(id uuid, client_name text, campaign text, job_date date, amount numeric, external_id text)
language plpgsql security definer set search_path = public, archive as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'רק service_role יכול לקרוא את הארכיון לצורך backfill';
  end if;
  return query
    select a.id, c.name, a.campaign, a.date, a.amount, a.external_id
    from archive.jobs a
    left join public.clients c on c.id = a.client_id;
end;
$$;

revoke all on function public.archive_jobs_for_backfill() from public;
revoke all on function public.archive_jobs_for_backfill() from anon;
revoke all on function public.archive_jobs_for_backfill() from authenticated;

create or replace function public.backfill_archive_job_external_id(p_id uuid, p_external_id text)
returns void language plpgsql security definer set search_path = public, archive as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'רק service_role יכול לעדכן את הארכיון';
  end if;
  update archive.jobs set external_id = p_external_id, legacy = true where id = p_id;
end;
$$;

revoke all on function public.backfill_archive_job_external_id(uuid, text) from public;
revoke all on function public.backfill_archive_job_external_id(uuid, text) from anon;
revoke all on function public.backfill_archive_job_external_id(uuid, text) from authenticated;
