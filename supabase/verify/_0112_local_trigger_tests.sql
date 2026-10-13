-- ============================================================================
-- 0112 — the trigger, end to end, on a THROWAWAY LOCAL Postgres (never prod).
--
-- Not for the SQL Editor. psql against an empty local cluster, from the repo root:
--   initdb -D <tmp> -U postgres && pg_ctl -D <tmp> -o "-p 55432 -c listen_addresses=localhost -c unix_socket_directories=''" start
--   psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -tA -f supabase/verify/_0112_local_trigger_tests.sql
-- Every line printed must end in |t.
--
-- Part 1 is a minimal Supabase-like stub (auth.uid() from jwt claims, 0070's
-- column-level SELECT shape, the ledger at 0111). Part 2 applies 0112 as-is.
-- Part 3 is what the owner asked for (13.10 #3): approval and correction from
-- the review link unarchive, an archived INSERT is refused, the board can read
-- the columns, anon cannot, and a sync-shaped lookup by calendar_uid still
-- finds an archived row.
-- ============================================================================
\set ON_ERROR_STOP 1

-- ── part 1: stub ────────────────────────────────────────────────────────────
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create table public.schema_ledger (version text primary key, applied_at timestamptz, applied_by text, note text);
insert into public.schema_ledger values ('0110', now(), 'x', ''), ('0111', now(), 'x', '');

create table public.profiles (id uuid primary key, approved boolean, can_edit_stages boolean, studio_admin boolean);
insert into public.profiles values ('11111111-1111-1111-1111-111111111111', true, true, true),
                                   ('22222222-2222-2222-2222-222222222222', true, true, false);

create table public.events (id uuid primary key default gen_random_uuid(), entity_type text not null, entity_id uuid not null,
  event_type text not null, actor_id uuid, payload jsonb, created_at timestamptz not null default now());

create type production_status as enum ('עתיד_להתחיל','בהקלטה','הוקלט','בעריכה','נערך','נשלח_ללקוח','ממתין_לתגובת_לקוח','אושר_ע"י_לקוח','הופץ','בוטל');
create table public.productions (id uuid primary key default gen_random_uuid(), status production_status not null,
  needs_attention boolean default false, price_override numeric, calendar_uid text);
insert into public.productions (id, status, calendar_uid) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'הופץ', 'uid-1'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'הופץ', 'uid-2'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'בעריכה', null),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'בוטל', null);

-- 0070's shape: no table-level SELECT for authenticated, column grants except price_override; UPDATE/INSERT table-level
grant insert, update on public.productions to authenticated;
grant select (id, status, needs_attention, calendar_uid) on public.productions to authenticated;
grant all on all tables in schema public to service_role;

-- ── part 2: the migration, unchanged ───────────────────────────────────────
\i supabase/migrations/0112_board_archive.sql

-- ── part 3: the tests ───────────────────────────────────────────────────────
-- archive both הופץ rows from "the server"
update public.productions set board_archived_at = now(), board_archived_by = '11111111-1111-1111-1111-111111111111'
 where status = 'הופץ';

-- T1: approval from the review link (applyResponse writes אושר_ע"י_לקוח) unarchives + logs
update public.productions set status = 'אושר_ע"י_לקוח' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select 'T1 approval clears' as t, (board_archived_at is null and board_archived_by is null) as ok from public.productions where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select 'T1 event' as t, count(*) = 1 as ok from public.events where entity_id = 'aaaaaaaa-0000-0000-0000-000000000001'
  and event_type = 'production_board_unarchived' and payload->>'to_status' = 'אושר_ע"י_לקוח' and actor_id is null;

-- T2: correction request (בעריכה) from a session — actor recorded
begin;
select 'T2 session claims set' as t, set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true) is not null as ok;
update public.productions set status = 'בעריכה' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
commit;
select 'T2 correction clears' as t, board_archived_at is null as ok from public.productions where id = 'aaaaaaaa-0000-0000-0000-000000000002';
select 'T2 event actor' as t, count(*) = 1 as ok from public.events where entity_id = 'aaaaaaaa-0000-0000-0000-000000000002'
  and event_type = 'production_board_unarchived' and actor_id = '22222222-2222-2222-2222-222222222222';

-- T3: INSERT cannot be born archived (even from the server)
do $$ begin
  begin
    insert into public.productions (status, board_archived_at) values ('הופץ', now());
    raise exception 'NOT_CAUGHT';
  exception when raise_exception then
    if sqlerrm = 'NOT_CAUGHT' then raise; end if;
  end;
end $$;
select 'T3 insert refused' as t, true as ok;

-- T4: the board (authenticated) can read the new columns; anon cannot
update public.productions set status = 'הופץ' where id = 'aaaaaaaa-0000-0000-0000-000000000002';
update public.productions set board_archived_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000002';
begin;
set local role authenticated;
select 'T4 session reads board_archived_at' as t, count(*) = 1 as ok from public.productions where board_archived_at is not null;
commit;
begin;
set local role anon;
do $$ begin
  begin perform board_archived_at from public.productions; raise exception 'NOT_CAUGHT';
  exception when insufficient_privilege then null; end;
end $$;
commit;
select 'T4 anon refused' as t, true as ok;

-- T5: a sync-shaped lookup by calendar_uid (no archive filter) still finds the archived row
select 'T5 sync finds archived by calendar_uid' as t, count(*) = 1 as ok from public.productions
 where calendar_uid = 'uid-2' and board_archived_at is not null;

