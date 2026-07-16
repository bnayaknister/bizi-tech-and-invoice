-- 0014: import keys for the bidirectional CSV importer.
-- Re-imports match by a stable ID; that ID (CSV C0001/P0001) was never
-- stored, and there was no legacy flag. Add both, plus episode_no so the
-- ~157 same-show-same-day productions become individually addressable
-- (fingerprint alone can't separate identical episodes).

alter table public.productions
  add column if not exists external_id text,
  add column if not exists legacy boolean not null default false,
  add column if not exists episode_no integer;
create unique index if not exists productions_external_id_key
  on public.productions (external_id) where external_id is not null;

alter table public.jobs
  add column if not exists external_id text,
  add column if not exists legacy boolean not null default false;
create unique index if not exists jobs_external_id_key
  on public.jobs (external_id) where external_id is not null;

-- archive tables were cloned "like public..." in 0002, before these columns
-- existed — add them so archived rows keep their external_id (the importer
-- must be able to recognise a row that lives in the archive).
alter table archive.productions
  add column if not exists external_id text,
  add column if not exists legacy boolean not null default false,
  add column if not exists episode_no integer;
alter table archive.jobs
  add column if not exists external_id text,
  add column if not exists legacy boolean not null default false;

-- The archive schema is owner-only and not exposed over REST, but the
-- importer (running as the acting user) must still detect a row that lives
-- there so it can offer skip/restore instead of creating a duplicate.
-- This SECURITY DEFINER function returns which of the given external_ids
-- exist in archive for the given kind. Read-only; touches nothing.
create or replace function public.import_archive_ids(p_kind text, p_ids text[])
returns table(external_id text)
language plpgsql security definer set search_path = public, archive as $$
begin
  if p_kind = 'production' then
    return query select a.external_id from archive.productions a
      where a.external_id = any(p_ids);
  elsif p_kind = 'job' then
    return query select a.external_id from archive.jobs a
      where a.external_id = any(p_ids);
  end if;
end;
$$;

revoke all on function public.import_archive_ids(text, text[]) from public;
grant execute on function public.import_archive_ids(text, text[]) to authenticated;
