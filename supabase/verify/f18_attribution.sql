-- F18 · attribution check — READ ONLY.
-- Nothing here inserts, updates or deletes. Paste into the SQL Editor and run.
--
-- ═══ WHAT THIS ANSWERS ═══
-- Some scripts used to create a temp user, act as it, re-point what it did to
-- the owner, and delete it. This finds what that left behind. It is NOT a
-- migration and must never become one — it is a question, asked repeatedly,
-- not a change.
--
-- ═══ LAST RUN: 2026-09-22 ═══
-- A2's falsifiable prediction came back 2·1·1·2·2 = 8, exactly as the ledger
-- had written it. The result is recorded in docs/TICKETS.md (F18) and in the
-- A2 comment below. Nothing was corrected in the database — the F18 ruling
-- stands: the history is recorded, never rewritten.
--
-- ⚠️ TIMEZONE. created_at is timestamptz and the SQL Editor renders UTC. The
-- dates recorded in F18's ledger are UTC for that reason. Israel local is
-- UTC+3 in summer — a run logged at 21:49 UTC is 00:49 the NEXT DAY locally,
-- which is exactly how the 2026-07-26 burst comes to sit beside a commit dated
-- the 27th. Add `at time zone 'Asia/Jerusalem'` if you want local.
--
-- ⚠️ SECTION C IS NOT A DETECTOR AT THIS THRESHOLD. `> 5 events in a minute`
-- is ordinary human work — approving a queue, walking a board. It was run on
-- 2026-09-22 and came back almost entirely legitimate. It is kept because it
-- DID surface the one real burst (2026-07-26 21:49), but read it as a list to
-- skim, never as a list of findings. Raising the threshold to find "the bad
-- ones" would be fitting the test to the answer; the honest use is to scan it
-- with your own memory of what you were doing.

-- ── sanity: is section A even looking at a populated table? ──────────────
-- If this returns 0 the feed below is empty because nothing logs pulls, not
-- because nothing is wrong. 113 rows on 2026-09-22.
select 'sanity · documents_pull rows' as section,
       count(*)::text                 as detail,
       null::timestamptz              as at,
       null::text                     as who,
       null::bigint                   as how_many
from public.events
where entity_type = 'documents_pull'

union all

-- ── A. THE ONE FINGERPRINT THAT SURVIVES THE REWRITE ────────────────────
-- POST /api/documents/sync is the only writer that puts `actor` in the
-- payload (the cron path has no such key), and it leaves actor_id NULL. The
-- re-attribution patched `actor_id=eq.<temp uuid>`, so it never matched these
-- rows and the temp user's uuid is still sitting in the payload. A payload
-- actor with no profile row = a manual pull by a user who was deleted after.
--
-- 8 rows / 5 distinct actors on 2026-09-22.
select 'A · manual pull by a deleted user',
       e.event_type || ' · trigger=' || coalesce(e.payload->>'trigger', '?'),
       e.created_at,
       e.payload->>'actor',
       1::bigint
from public.events e
where e.entity_type = 'documents_pull'
  and e.payload ? 'actor'
  and e.payload->>'actor' ~ '^[0-9a-fA-F-]{36}$'
  and not exists (
    select 1 from public.profiles p
    where p.id = (e.payload->>'actor')::uuid
  )

union all

-- ── A2. HOW MANY PULLS EACH DELETED USER MADE ───────────────────────────
-- ⚠️ THIS IS THE DISCRIMINATING CHECK, and it is the reason A2 exists at all.
-- test_documents_pull.py POSTs /api/documents/sync TWICE under ONE temp user;
-- the one-off scripts POST once. So the count per actor separates them:
--
--   2 pulls  -> test_documents_pull.py (a test, run against the live DB)
--   1 pull   -> a one-off script
--
-- F18's ledger predicted, from the git timestamps alone:
--   53b2e790 (20.7) = 2 · 67b846a6 (26.7) = 1 · 9d09382d (27.7) = 1
--   dad68133 (23.8) = 2 · 502f1b04 (23.8) = 2      → 8 total
--
-- ✅ RUN AGAINST THE DATABASE 2026-09-22: 2 · 1 · 1 · 2 · 2, exactly as
-- written above. The prediction was published before the counts were read,
-- and it held. So the attribution is no longer an inference from timing
-- alone — the SHAPE of each run corroborates which tool made it:
--   2 pulls -> 20.7 · 23.8 14:09 · 23.8 14:23 — tests, run against the live
--              DB (test_documents_pull.py pulls twice per run)
--   1 pull  -> 26.7 = close_certain_matches.py · 27.7 = run_full_pull_now.py
-- A future run that returns a different count means either something new has
-- pulled under a since-deleted user, or the ledger needs correcting.
select 'A2 · pulls per deleted user',
       'first ' || to_char(min(e.created_at), 'DD.MM HH24:MI') ||
       ' · last ' || to_char(max(e.created_at), 'DD.MM HH24:MI'),
       min(e.created_at),
       e.payload->>'actor',
       count(*)
from public.events e
where e.entity_type = 'documents_pull'
  and e.payload ? 'actor'
  and e.payload->>'actor' ~ '^[0-9a-fA-F-]{36}$'
  and not exists (
    select 1 from public.profiles p
    where p.id = (e.payload->>'actor')::uuid
  )
group by e.payload->>'actor'

union all

-- ── B. BULK WRITES WEARING A PERSON'S NAME ──────────────────────────────
-- The bulk archive route stamps ONE timestamp across every row it touches.
-- Nobody archives hundreds of documents in the same instant by hand.
-- Known: 277 documents, 2026-07-28 11:10, on the owner's name — his decision,
-- a script's execution. Recorded in F18, not corrected.
select 'B · bulk archive in one instant',
       coalesce(d.archive_reason, '(no reason)'),
       d.archived_at,
       coalesce(p.name, '(deleted user)'),
       count(*)
from public.documents d
left join public.profiles p on p.id = d.archived_by
where d.archived_at is not null
group by d.archived_at, p.name, d.archive_reason
having count(*) > 5

union all

-- ── C. EVENT BURSTS ON ONE NAME ─────────────────────────────────────────
-- After the rewrite an event is byte-identical to a real click, so rate is
-- the only handle left. ⚠️ See the warning at the top: at `> 5` this is mostly
-- ordinary work. The one burst that mattered was 2026-07-26 21:49 — 12
-- document_reconciled + job_marked_paid events in a minute, which git dates to
-- the first and only run of the old reconcile_payments_now.py.
-- 12 events = 6 payment links (each link writes two), from that single run in
-- its ORIGINAL version, against the old endpoint that linked everything in a
-- loop. Explained, not a mystery — see F18's ledger.
select 'C · event burst on one name (SKIM, not a finding)',
       array_to_string(array_agg(distinct e.event_type), ', '),
       date_trunc('minute', e.created_at),
       coalesce(p.name, '(deleted user)'),
       count(*)
from public.events e
left join public.profiles p on p.id = e.actor_id
where e.actor_id is not null
group by date_trunc('minute', e.created_at), p.name
having count(*) > 5

union all

-- ── D. A CLEANUP THAT FAILED ────────────────────────────────────────────
-- Every script names its temp user ZTEST*, and deleting it only succeeds once
-- nothing references the profile. A row here is a run that never finished
-- tidying up — and a live account with money permissions.
select 'D · leftover temp profile',
       'role=' || coalesce(p.role, '?'),
       p.created_at,
       p.name,
       1::bigint
from public.profiles p
where p.name like 'ZTEST%'

order by 1, 3 desc;
