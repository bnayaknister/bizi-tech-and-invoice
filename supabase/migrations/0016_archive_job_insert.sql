-- 0016: one-off bridge to insert directly into archive.jobs.
--
-- C0050 (owner decision, 2026-07-16): a single historical job (אפרת לקט*4,
-- 8,000₪, paid='כן', invoice_tax already issued) was found missing from
-- both public.jobs and archive.jobs entirely. It meets the exact archiving
-- rule (spec §7: paid + tax invoice → archive) that already classified its
-- 106 siblings, so it belongs in archive.jobs directly, not live. archive
-- isn't in PostgREST's exposed schemas, hence the RPC bridge — same
-- service_role-only restriction as the rest of the archive functions (0005,
-- 0015).

create or replace function public.insert_archive_job(p_job jsonb)
returns uuid language plpgsql security definer set search_path = public, archive as $$
declare
  new_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'רק service_role יכול להוסיף רשומות ישירות לארכיון';
  end if;

  insert into archive.jobs (
    client_id, date, campaign, amount, invoice_biz, invoice_tax,
    paid, notes, external_id, legacy
  )
  values (
    (p_job->>'client_id')::uuid,
    (p_job->>'date')::date,
    p_job->>'campaign',
    (p_job->>'amount')::numeric,
    p_job->>'invoice_biz',
    p_job->>'invoice_tax',
    (p_job->>'paid')::paid_status,
    p_job->>'notes',
    p_job->>'external_id',
    true
  )
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.insert_archive_job(jsonb) from public;
revoke all on function public.insert_archive_job(jsonb) from anon;
revoke all on function public.insert_archive_job(jsonb) from authenticated;
