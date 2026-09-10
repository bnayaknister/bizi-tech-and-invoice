-- 0077 — an open work order carries the job it was billed for
--
-- WHAT THIS IS FOR. pending_documents.job_id has existed since 0025 and on a
-- work_order row it has never been written. All three work_order enqueue sites
-- call enqueueDocument without a jobId (calendar/sync/route.ts:352,
-- productions/route.ts:208, hours/route.ts:301), so the column arrives null and
-- stays null — and it stays null for a reason that is structural rather than
-- careless: the ORDER IS CREATED BEFORE THE JOB EXISTS. The 06:00 sync mints
-- the order when the episode is scheduled; the job is born later, at the move
-- to 'הוקלט' (0060). At enqueue time there is nothing to write.
--
-- So the write belongs at the other end — the moment the job comes into being.
-- That is ensure_job_for_production, and this migration teaches it to stamp its
-- own id onto the open order for the same production, then backfills the rows
-- that were created before it knew how.
--
-- Measured on live data 2026-09-10 20:10 UTC, and it is the finding that
-- settles the placement: of the 31 backfilled rows, 31 out of 31 were created
-- BEFORE their job. Zero were created after. The function is not one of two
-- plausible homes — it is the only point in time at which both halves exist.
--
-- ---------------------------------------------------------------------------
-- WHY IN THE DATABASE, AND WHY THIS IS NOT A BREACH OF 0025
--
-- WHY THE DB. Of the 42 job creations in this database, 12 came through the
-- application. The other 30 came through the trigger. A TypeScript-side fill
-- would cover under a third of the paths and would look finished — which is the
-- worst of the two failure modes, because the gap would only show up as a
-- registry row with an empty column months later, on exactly the documents
-- nobody thought to check. ensure_job_for_production is where every path
-- converges: the trigger fires it on 'הוקלט' and on client approval (0060:134,
-- 0060:136), and the retroactive backfill script reaches it through the same
-- RPC rather than through an INSERT of its own. One definition, every caller.
--
-- WHY IT IS NOT A BREACH OF 0025 — STATED HERE SO IT CANNOT LATER BE READ AS A
-- PRECEDENT. The rule 0025 wrote is precise, and it is about ISSUANCE:
--
--     "Documents are no longer issued as a side effect of something else
--      happening. A production arriving at 06:00 does not create a work order;
--      a client approval does not create a deal invoice. Both create a ROW
--      HERE, and a human with can_edit_money turns that row into a real
--      document."
--
-- What 0025 forbids is the DATABASE PRODUCING A DOCUMENT THAT REACHES MORNING
-- without a human in the loop. What this migration does is fill a foreign key
-- on a row that already exists. It creates no row. It changes no status. It
-- does not move a row toward 'approved', does not touch payload, does not touch
-- amount, and cannot cause a Morning call — the only code that calls Morning is
-- issue.ts, and it is reached only from the approval screen.
--
-- The distinction to carry forward: 0025 governs the LIFECYCLE COLUMNS of a
-- queue row (status, approved_by, approved_at, morning_doc_id). Those belong to
-- a human and the database must never write them. job_id is a LINK — a
-- statement about which work this row already described — and a link is the
-- kind of fact the layer that creates the work is best placed to state. A later
-- migration that wants to cite 0077 for writing a queue row's status is citing
-- the wrong half of it.
--
-- ---------------------------------------------------------------------------
-- THE PREDICATE — borrowed, not invented
--
--     doc_type = 'work_order'
--     production_id is not null
--     status not in ('rejected', 'failed', 'cancelled')
--     and job_id is null
--
-- The status list is copied from pending_documents_one_live_per_production as
-- 0063 left it, and that is deliberate: "open" already has exactly one
-- definition in this schema, the one the unique index enforces, and a second
-- definition written by hand here would be a second truth that drifts from the
-- first the next time either moves. It also buys the property that makes the
-- stamp safe without a lock — the index guarantees AT MOST ONE row can match
-- per production, so the UPDATE inside the function touches one row or none,
-- never a set it has to choose from.
--
-- `and job_id is null` is not part of the index predicate and is added here as
-- an anti-overwrite guard. Nothing today can put a value in that column on a
-- work_order row, so it is defence against a future writer rather than against
-- a present one — but it is what lets the canary below assert, as a fact and
-- not as a hope, that zero existing values were destroyed.
--
-- ---------------------------------------------------------------------------
-- A PRODUCTION WITH TWO JOBS — NOT TOUCHED, AND WHY THAT IS NOT A NO-OP CLAUSE
--
-- One exists. Production 8b4aabe5 ("דברים שלמדתי מנשים מצליחות") carries two
-- jobs — 2026-06-22 for 500 and 2026-06-29 for 250 — and it is the only such
-- production in the database. It carries ZERO pending_documents rows, so it is
-- not in the predicate and this migration cannot reach it. The briefing said
-- "no such row today", and in the sense that decides the backfill that is
-- correct: no row IN THE PREDICATE is ambiguous. The production itself is real,
-- and this note exists so the next reader does not conclude it was missed.
--
-- The backfill therefore filters on `exactly one job` rather than trusting the
-- count, and a two-job production is SKIPPED IN SILENCE rather than resolved by
-- a rule. That is the owner's decision and it is the right one: any rule that
-- picks one of two jobs — earliest, largest, most recent — would be invented
-- here, applied to zero rows, and inherited by whoever hits the case for real.
-- A row left null says "nobody has decided yet", which is true. A row filled by
-- a tiebreak says "this is the job", which nobody has established.
--
-- The same abstention is built into the function: the stamp runs only on the
-- job it just created, so the ambiguous case cannot arise there at all.
--
-- ---------------------------------------------------------------------------
-- WHAT WAKES UP — the honest half. This is not "zero behaviour change".
--
-- Every reader of pending_documents.job_id was checked. Three touch work_order
-- rows; two of the three are unreachable today and the third is a fix.
--
--   • findBilledEvidence (enqueue.ts:513) — UNAFFECTED. Rule b filters
--     `doc_type in (deal_invoice, tax_invoice, tax_receipt)`; work_order is not
--     in BILLING and never enters the query.
--
--   • createWorkOrderBundle's `claimed` set (bundle.ts:144) — UNAFFECTED, same
--     reason: `.eq("doc_type", "deal_invoice")`.
--
--   • resolveParentWorkOrderLink (issue.ts:235) — UNAFFECTED. It finds the
--     parent order by production_id, not by job_id, and this migration does not
--     touch production_id.
--
--   • jobPatchFor (issue.ts:99-106) — UNAFFECTED, and worth naming because it
--     is the one that would have mattered: work_order is absent from it, so
--     issuing a 100 stamps nothing on the job. Filling job_id does not create a
--     new path from a work order to invoice_biz / invoice_tax / paid.
--
--   • contracts/page.tsx:43 — READS work_order rows and keys them by job_id
--     into rowsForJob. Twenty of the 31 backfilled rows are 'issued' and would
--     now land in that map. It changes nothing TODAY: measured, the overlap
--     between the 31 backfilled jobs and contract_milestones.job_id is ZERO —
--     milestone jobs are contract jobs, these are production jobs. Recorded as
--     a live coupling rather than a dead one, because the day a milestone and a
--     production share a job, that screen starts seeing a 100 it never saw.
--
--   • documents/enqueue/route.ts:112 — CHANGES, and this is a fix rather than a
--     side effect. The manual "create a work order for this job" path in the
--     registry refuses to double-queue via
--     `.eq("job_id", job.id).eq("doc_type", docType).in("status", LIVE)`. With
--     job_id null on every work_order row that lookup has never matched
--     anything, and the insert it guards carries production_id NULL — so it
--     falls outside pending_documents_one_live_per_production too, and a second
--     work order for an already-ordered job could be created with nothing to
--     stop it. After the backfill the 20 'issued' rows are visible to that
--     lookup and the duplicate is refused with "כבר קיים". The other 11
--     (4 accrued, 9 consolidated) stay invisible to it, because its LIVE list
--     is pending/approved/issued — untouched here, and noted so the asymmetry
--     is a known one.
--
-- Measured too, because .maybeSingle() throws on more than one row: after this
-- runs, ZERO jobs carry two live work_order rows. Verified in the canary.
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS — STATED, NOT ASSUMED (rule 49)
--
-- This migration creates NO ACL-bearing object: no table, no column, no type,
-- no policy. There is nothing whose privileges could be born wrong, which is
-- the failure 0071 and 0074 were guarding against. No GRANT is issued and none
-- is needed.
--
-- The half of rule 49 that still applies is the half that bites silently.
-- Measured on this database 2026-09-10:
--
--   has_table_privilege('authenticated','public.pending_documents','SELECT') = TRUE
--   has_table_privilege('anon',         'public.pending_documents','SELECT') = FALSE
--   has_column_privilege('authenticated','…','job_id','UPDATE')             = FALSE
--
-- So job_id is already readable by `authenticated` — it has been since 0025 —
-- and this migration does not widen that by one row: the column existed and was
-- readable when it was null, and it is readable now that it has a value. What
-- would be tempting and wrong is to "protect" the newly-meaningful column with
-- `revoke select (job_id) on pending_documents from authenticated`. That
-- statement would run clean, raise nothing, and DO NOTHING — while
-- `authenticated=r` sits in relacl, has_column_privilege keeps returning true
-- for every column. That is how 0031 left production_addons' prices readable to
-- every technician and why 0068 had to revoke the whole table to undo it.
--
-- There is nothing to hide here in any case: a job id is an internal uuid of
-- the same class as production_id, which `authenticated` already reads on this
-- table. The amounts are the money and they are governed by RLS
-- (pending_documents_select USING can_view_money), which is unchanged. Write
-- access is unchanged and remains server-only: authenticated holds no UPDATE on
-- job_id, no policy is added, and the stamp inside the function runs SECURITY
-- DEFINER as it always has. The canary asserts all four directions.
--
-- ---------------------------------------------------------------------------
-- OUT OF SCOPE, DELIBERATELY — each is its own step, none is a leftover
--
--   1. THE SECOND BACKFILL. 322 rows in `documents` (the registry table, not
--      this queue) of type 100 carry an empty job_id. Different table,
--      different provenance — those arrived through the daily pull, not through
--      enqueueDocument — and therefore a different matching problem. Backlog.
--
--   2. THE forProduction LEAK. A job that links two productions would surface
--      P1's document in P2's drawer through forProduction.ts's job branch. Zero
--      rows today: the one two-job production has no documents at all, and no
--      job spans two productions. Dormant behaviour, recorded, not fixed here.
--
--   3. THE ORDER THAT ARRIVES AFTER ITS JOB. hours/route.ts:301 can enqueue a
--      work order for a production that already has a job; the function has
--      already run and will not run again (the 0060 duplicate guard returns
--      early), so that row is born null and stays null. Measured: zero such
--      rows exist today — 31 of 31 orders preceded their job. The fix is
--      app-side and one line at each of the three enqueue sites (pass jobId),
--      and it is a separate change from this one.
--
--   4. THE TWO SFI ORDERS. 10311 and 10312 (both 2026-08-17, status
--      'ממתין_לתגובת_לקוח') are issued work orders whose productions have NO
--      job at all — they were recorded on 17.8, seven days before 0060 created
--      the 'הוקלט' trigger on 24.8, and they never reached client approval, so
--      neither entry point ever fired. They are in the predicate and are
--      correctly left null: giving them a job would CREATE MONEY, which is an
--      owner decision and not a data fix — the same line 0072 drew when it
--      refused to flip Mali's production back to kind='client'.
--
-- ZERO DELETE. ZERO schema change. ZERO row inserted. One column, 31 rows.

do $mig$
declare
  -- the exact predicate, so the thing the canary verifies is the thing that ran
  v_filled        int;
  v_expected      constant int := 31;

  -- before/after snapshots
  v_rows_pre      int;
  v_rows_post     int;
  v_jobs_pre      int;
  v_jobs_post     int;
  v_jp_pre        int;
  v_jp_post       int;
  v_pre_ids       uuid[];
  v_pre_digest    text;
  v_post_digest   text;
  v_shape_pre     text;
  v_shape_post    text;

  -- findings
  v_in_pred       int;
  v_ambiguous     int;
  v_left_null     int;
  v_mismatched    int;
  v_dup_live      int;
  v_fn_md5        text;

  -- permissions
  v_auth_sel      boolean;
  v_anon_sel      boolean;
  v_auth_upd      boolean;
  v_rls           boolean;
  v_policy        int;
begin
  -- ---------------------------------------------------------------------
  -- 0. GUARDS. Everything below assumes a specific starting state; each of
  --    these turns an assumption into a refusal.
  -- ---------------------------------------------------------------------

  -- 0a. not re-runnable, and it must say so rather than quietly do it twice.
  if exists (select 1 from public.schema_ledger where version = '0077') then
    raise exception '0077 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. the ledger is the sequence, not the filenames (migrations/README.md).
  --     0076 was applied 2026-09-10 and this is the next number. If it is
  --     absent, this file was numbered against the wrong ledger and every
  --     count below was measured against a different database.
  if not exists (select 1 from public.schema_ledger where version = '0076') then
    raise exception '0077: 0076 אינה בפנקס — המספור נגזר מפנקס אחר, עצור ומדוד מחדש';
  end if;

  -- 0c. the function about to be replaced is the one that was read. This is
  --     the guard that matters most in this file: `create or replace` is
  --     silent about what it destroyed, and 0067 is the fourth migration to
  --     rewrite this body (0060 -> 0061 -> 0064 -> 0067). If anything landed
  --     after 0067, replacing it here would revert that change without a
  --     word — the pricing logic 0067 added is inside this body.
  select md5(p.prosrc) into v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';

  if v_fn_md5 is distinct from 'cabbe844d67062705f49dd06143c47fe' then
    raise exception '0077: גוף ensure_job_for_production אינו זה של 0067 (md5=%) — מיגרציה מאוחרת יותר שינתה אותו, אל תדרוס', coalesce(v_fn_md5, 'לא קיימת');
  end if;

  -- ---------------------------------------------------------------------
  -- 1. SNAPSHOT, before anything moves.
  -- ---------------------------------------------------------------------

  select count(*) into v_rows_pre from public.pending_documents;
  select count(*) into v_jobs_pre from public.jobs;
  select count(*) into v_jp_pre   from public.job_productions;

  -- every row that ALREADY carries a job_id, and the value it carries. The
  -- anti-overwrite proof is this digest being byte-identical afterwards —
  -- not the WHERE clause promising it will be.
  select array_agg(id order by id) into v_pre_ids
    from public.pending_documents where job_id is not null;

  select md5(coalesce(string_agg(id::text || '>' || job_id::text, ',' order by id), ''))
    into v_pre_digest
    from public.pending_documents
   where id = any(coalesce(v_pre_ids, '{}'::uuid[]));

  -- the whole table MINUS job_id. If this digest changes, something other
  -- than the one column moved — that is the "zero rows outside the predicate
  -- were touched" check, and it covers rows inside the predicate too.
  select md5(string_agg(
           id::text || '|' || doc_type::text || '|' || status::text || '|' ||
           coalesce(production_id::text, '') || '|' || coalesce(client_id::text, '') || '|' ||
           coalesce(amount::text, '') || '|' || coalesce(morning_doc_id, '') || '|' ||
           coalesce(approved_by::text, '') || '|' || coalesce(approved_at::text, '') || '|' ||
           coalesce(issued_at::text, '') || '|' || attempts::text,
           ',' order by id))
    into v_shape_pre
    from public.pending_documents;

  -- what the predicate sees right now, split three ways. Reported in the
  -- notice so the run leaves a record of the shape it acted on.
  select count(*) into v_in_pred
    from public.pending_documents pd
   where pd.doc_type = 'work_order'
     and pd.production_id is not null
     and pd.job_id is null
     and pd.status not in ('rejected', 'failed', 'cancelled');

  select count(*) into v_ambiguous
    from public.pending_documents pd
   where pd.doc_type = 'work_order'
     and pd.production_id is not null
     and pd.job_id is null
     and pd.status not in ('rejected', 'failed', 'cancelled')
     and (select count(*) from public.job_productions x
           where x.production_id = pd.production_id) > 1;

  -- ---------------------------------------------------------------------
  -- 2. ensure_job_for_production (0060 -> 0061 -> 0064 -> 0067 -> here).
  --    0067's body VERBATIM. The only additions are the stamp block and the
  --    one event key that reports it.
  -- ---------------------------------------------------------------------
  create or replace function public.ensure_job_for_production(p_id uuid, p_reason text)
  returns uuid language plpgsql security definer set search_path = public as $fn$
  declare
    prod public.productions%rowtype;
    new_job_id uuid;
    base_amount numeric;
    addon_total numeric;
    job_amount numeric;
    v_model public.show_pricing_model;
    v_hourly numeric;
    -- 0077: the open work order this job pays for, if one is already queued.
    v_work_order uuid;
  begin
    select * into prod from public.productions where id = p_id;
    if not found then return null; end if;

    if prod.kind <> 'client' then return null; end if;
    if prod.cancelled_at is not null then return null; end if;
    if prod.merged_into is not null then return null; end if;

    -- 0061: the work has not been done yet. Named literally, never by enum
    -- order — 'בוטל' sorts last and would slip through a range test.
    if prod.status in ('עתיד_להתחיל', 'בהקלטה') then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'job_skipped_not_recorded', auth.uid(),
              jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                 'status', prod.status, 'fired_by', p_reason));
      return null;
    end if;

    -- THE DUPLICATE GUARD (0060). What makes הוקלט -> אושר safe, what makes a
    -- backfill safe to re-run, and what protects a status that moves backwards
    -- and forwards again.
    --
    -- 0077 NOTE: this early return is also the boundary of the stamp. A work
    -- order enqueued AFTER its job already exists is never seen by this
    -- function again, so it keeps job_id null. Measured 2026-09-10: zero such
    -- rows — 31 of 31 orders were created before their job. The fix for the
    -- case that has not happened yet is app-side (pass jobId at the three
    -- work_order enqueue sites) and deliberately not here.
    if exists (select 1 from public.job_productions where production_id = p_id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                 'fired_by', p_reason));
      return null;
    end if;

    -- 0067: the effective base, now across two pricing models.
    --   price_override      — the human said the number; it wins in both models
    --   per_hour            — hours × rate, rounded to agorot at the point of
    --                         derivation. The rounding is not cosmetic: the
    --                         balance gate added in c339215 compares
    --                         Σ(price × quantity) to the amount column with a
    --                         one-agora epsilon, and 1.5 × 333.33 = 499.995
    --                         would sit exactly on it.
    --   per_episode         — default_rate, unchanged
    -- A missing rate or missing hours leaves base_amount null, which lands on
    -- the existing "יש להשלים סכום" path below rather than inventing one.
    select s.pricing_model, s.hourly_rate into v_model, v_hourly
    from public.shows s where s.id = prod.show_id;

    if prod.price_override is not null then
      base_amount := prod.price_override;
    elsif v_model = 'per_hour' then
      if prod.studio_hours is not null and v_hourly is not null then
        base_amount := round(prod.studio_hours * v_hourly, 2);
      else
        base_amount := null;
      end if;
    else
      select s.default_rate into base_amount
      from public.shows s where s.id = prod.show_id;
    end if;

    select coalesce(sum(total), 0) into addon_total
    from public.production_addons
    where production_id = p_id and status = 'approved' and total is not null;

    if base_amount is not null then
      job_amount := base_amount + coalesce(addon_total, 0);
    else
      job_amount := null;
    end if;

    -- 0064: the work date. due_date and every ageing number downstream are
    -- derived from this column.
    insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
    values (prod.client_id, prod.contract_id,
            coalesce(prod.record_date, current_date),
            prod.podcast_name, job_amount,
            case when job_amount is not null
                 then 'נוצר אוטומטית (' || p_reason || '). סכום = מחיר אפקטיבי + תוספות מאושרות — לאמת ולהנפיק חשבונית עסקה.'
                 else 'נוצר אוטומטית (' || p_reason || '). יש להשלים סכום וחשבונית עסקה.' end)
    returning id into new_job_id;

    insert into public.job_productions (job_id, production_id)
    values (new_job_id, p_id);

    -- ---------------------------------------------------------------------
    -- 0077: STAMP THE OPEN WORK ORDER.
    --
    -- The link only — no status, no payload, no amount, nothing a human owns.
    -- 0025 forbids the database PRODUCING a document; this writes a foreign
    -- key on a row a human already queued and does not move it one step
    -- closer to Morning.
    --
    -- `job_id is null` is the anti-overwrite guard. The status list is the
    -- one pending_documents_one_live_per_production carries after 0063, which
    -- is also why no ordering or LIMIT is needed: that unique index makes at
    -- most one row per production able to match, so this updates one row or
    -- none — never a set it would have to choose from.
    -- ---------------------------------------------------------------------
    update public.pending_documents
       set job_id = new_job_id
     where doc_type = 'work_order'
       and production_id = p_id
       and job_id is null
       and status not in ('rejected', 'failed', 'cancelled')
    returning id into v_work_order;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', p_id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                               'job_id', new_job_id, 'base_amount', base_amount,
                               'addon_total', addon_total, 'job_amount', job_amount,
                               'fired_by', p_reason,
                               -- 0067: how the base was derived, not only what
                               -- it came out as
                               'pricing_model', v_model::text,
                               'studio_hours', prod.studio_hours,
                               'hourly_rate', v_hourly,
                               -- 0077: which order was stamped, or null if the
                               -- order had not been queued yet. A key addition
                               -- only — the 0067 precedent — and no reader
                               -- depends on the shape of this payload.
                               'work_order_stamped', v_work_order));
    return new_job_id;
  end;
  $fn$;

  -- ---------------------------------------------------------------------
  -- 3. BACKFILL — the rows created before the function knew how.
  --
  --    The join to job_productions supplies the value; the `= 1` subquery is
  --    what refuses to guess. A production with two jobs matches nothing here
  --    and is left null on purpose (see the header).
  -- ---------------------------------------------------------------------
  with target as (
    select pd.id as pd_id, jp.job_id
      from public.pending_documents pd
      join public.job_productions jp on jp.production_id = pd.production_id
     where pd.doc_type = 'work_order'
       and pd.production_id is not null
       and pd.job_id is null
       and pd.status not in ('rejected', 'failed', 'cancelled')
       and (select count(*) from public.job_productions x
             where x.production_id = pd.production_id) = 1
  )
  update public.pending_documents pd
     set job_id = t.job_id
    from target t
   where pd.id = t.pd_id;

  get diagnostics v_filled = row_count;

  -- ---------------------------------------------------------------------
  -- 4. CANARY. Every check runs BEFORE the ledger row, so a failure rolls
  --    the whole thing back rather than recording a half-applied change.
  -- ---------------------------------------------------------------------

  -- 4a. THE COUNT. 31, measured 2026-09-10 20:10 UTC.
  --
  --     This number AGES, and the failure message has to say how: the 06:00
  --     sync mints work orders daily, and a production recorded between the
  --     measurement and the run gains a job the same day. Two of the 31 —
  --     10331 and 10332 — were created at 06:00 on 2026-09-10 and became
  --     fillable that afternoon. So a mismatch here is far more likely to be
  --     drift than damage. It still stops: the right response is to re-run
  --     the measurement, confirm the delta is accounted for by new episodes,
  --     and update this constant — not to widen the assertion.
  if v_filled <> v_expected then
    raise exception '0077 canary: % שורות קיבלו job_id במקום % — כנראה סנכרון 06:00 הוסיף הזמנות מאז המדידה (10.9 20:10 UTC). מדוד מחדש, ודא שהפער הוא פרקים חדשים, ועדכן את הקבוע', v_filled, v_expected;
  end if;

  -- 4b. ZERO EXISTING VALUES WERE OVERWRITTEN. The digest over exactly the
  --     rows that already carried a job_id, unchanged to the byte.
  select md5(coalesce(string_agg(id::text || '>' || job_id::text, ',' order by id), ''))
    into v_post_digest
    from public.pending_documents
   where id = any(coalesce(v_pre_ids, '{}'::uuid[]));

  if v_post_digest is distinct from v_pre_digest then
    raise exception '0077 canary: job_id קיים נדרס — הטביעה של השורות שכבר החזיקו ערך השתנתה';
  end if;

  -- 4c. ZERO ROWS OUTSIDE THE PREDICATE WERE TOUCHED — and zero columns
  --     other than job_id were touched anywhere, including inside it.
  select md5(string_agg(
           id::text || '|' || doc_type::text || '|' || status::text || '|' ||
           coalesce(production_id::text, '') || '|' || coalesce(client_id::text, '') || '|' ||
           coalesce(amount::text, '') || '|' || coalesce(morning_doc_id, '') || '|' ||
           coalesce(approved_by::text, '') || '|' || coalesce(approved_at::text, '') || '|' ||
           coalesce(issued_at::text, '') || '|' || attempts::text,
           ',' order by id))
    into v_shape_post
    from public.pending_documents;

  if v_shape_post is distinct from v_shape_pre then
    raise exception '0077 canary: משהו מלבד job_id זז ב-pending_documents — סטטוס, סכום, אישור או מזהה מורנינג';
  end if;

  select count(*) into v_rows_post from public.pending_documents;
  if v_rows_post <> v_rows_pre then
    raise exception '0077 canary: מספר השורות ב-pending_documents % במקום % — נוספה או נמחקה שורה', v_rows_post, v_rows_pre;
  end if;

  -- 4d. THE JOB COUNT DID NOT MOVE. The load-bearing assertion of the whole
  --     file, and the one that separates it from a 0025 breach: filling a
  --     link created no work and no money.
  select count(*) into v_jobs_post from public.jobs;
  select count(*) into v_jp_post   from public.job_productions;

  if v_jobs_post <> v_jobs_pre then
    raise exception '0077 canary: מספר ה-jobs % במקום % — המיגרציה יצרה עבודה, וזה בדיוק מה שאסור לה', v_jobs_post, v_jobs_pre;
  end if;
  if v_jp_post <> v_jp_pre then
    raise exception '0077 canary: מספר קישורי job_productions % במקום % — נוצר או נמחק קישור', v_jp_post, v_jp_pre;
  end if;

  -- 4e. EVERY VALUE WRITTEN IS THE RIGHT ONE. Not "a job" — the job of that
  --     production. Checked by joining back, over the whole table rather
  --     than over the rows this migration wrote, so an older wrong value
  --     would surface here too.
  select count(*) into v_mismatched
    from public.pending_documents pd
   where pd.doc_type = 'work_order'
     and pd.job_id is not null
     and pd.production_id is not null
     and not exists (select 1 from public.job_productions jp
                      where jp.production_id = pd.production_id
                        and jp.job_id = pd.job_id);
  if v_mismatched <> 0 then
    raise exception '0077 canary: % הזמנות נושאות job שאינו של ההפקה שלהן', v_mismatched;
  end if;

  -- 4f. WHAT WAS DELIBERATELY LEFT NULL IS STILL NULL, and the arithmetic
  --     closes: rows still open and unlinked = rows that were open and
  --     unlinked, minus rows filled. Two are expected today — SFI 10311 and
  --     10312, productions with no job at all — plus any ambiguous row. A
  --     mismatch means a row entered or left the predicate mid-migration,
  --     which nothing here is allowed to cause.
  select count(*) into v_left_null
    from public.pending_documents pd
   where pd.doc_type = 'work_order'
     and pd.production_id is not null
     and pd.job_id is null
     and pd.status not in ('rejected', 'failed', 'cancelled');

  if v_left_null <> (v_in_pred - v_filled) then
    raise exception '0077 canary: % שורות נשארו ריקות בפרדיקט במקום % — הספירה לא מתיישבת', v_left_null, v_in_pred - v_filled;
  end if;

  -- 4g. NO JOB ENDED UP WITH TWO LIVE WORK ORDERS. documents/enqueue's
  --     dedup lookup uses .maybeSingle(), which THROWS on a second row —
  --     so this is not tidiness, it is the difference between that route
  --     refusing politely and it 500-ing.
  select count(*) into v_dup_live
    from (select pd.job_id
            from public.pending_documents pd
           where pd.doc_type = 'work_order'
             and pd.job_id is not null
             and pd.status in ('pending', 'approved', 'issued')
           group by pd.job_id having count(*) > 1) d;
  if v_dup_live <> 0 then
    raise exception '0077 canary: % jobs נושאים שתי הזמנות חיות — maybeSingle ב-documents/enqueue ייפול עליהן', v_dup_live;
  end if;

  -- 4h. PERMISSIONS, both directions (rule 49). No object was created here,
  --     so the only thing to prove is that nothing shifted: anon still holds
  --     nothing, authenticated still reads and still cannot write, and the
  --     row gate is still the money gate.
  select has_table_privilege('anon', 'public.pending_documents', 'SELECT') into v_anon_sel;
  if v_anon_sel then
    raise exception '0077 canary: ל-anon יש SELECT על pending_documents — לא היה אמור, בדוק pg_default_acl';
  end if;

  select has_column_privilege('authenticated', 'public.pending_documents', 'job_id', 'SELECT')
    into v_auth_sel;
  if not v_auth_sel then
    raise exception '0077 canary: authenticated אינו קורא את job_id — מסך התור יירנדר בלי הקישור';
  end if;

  select has_column_privilege('authenticated', 'public.pending_documents', 'job_id', 'UPDATE')
    into v_auth_upd;
  if v_auth_upd then
    raise exception '0077 canary: ל-authenticated יש הרשאת כתיבה על job_id — הכתיבה כאן חייבת להישאר server-only';
  end if;

  select relrowsecurity into v_rls from pg_class where oid = 'public.pending_documents'::regclass;
  if not v_rls then
    raise exception '0077 canary: RLS כבוי על pending_documents';
  end if;

  select count(*) into v_policy from pg_policies
   where tablename = 'pending_documents' and policyname = 'pending_documents_select';
  if v_policy <> 1 then
    raise exception '0077 canary: pending_documents_select חסר — שער can_view_money נעלם';
  end if;

  -- 4i. the function really did change, and to something that still parses.
  select md5(p.prosrc) into v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';
  if v_fn_md5 = 'cabbe844d67062705f49dd06143c47fe' then
    raise exception '0077 canary: גוף ensure_job_for_production לא השתנה — ההחלפה לא נתפסה';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ensure_job_for_production'
       and p.prosrc like '%work_order_stamped%'
  ) then
    raise exception '0077 canary: החתימה של החותמת אינה בגוף הפונקציה';
  end if;

  raise notice '0077 OK — מולאו: % · בפרדיקט: % · נשארו ריקות: % (מהן % דו-משמעיות) · jobs: % ללא שינוי · שורות תור: % ללא שינוי',
    v_filled, v_in_pred, v_left_null, v_ambiguous, v_jobs_post, v_rows_post;

  -- ---------------------------------------------------------------------
  -- 5. the ledger row, last.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0077', now(), 'bnaya',
    'הזמנת עבודה נושאת את ה-job שלה — מילוי pending_documents.job_id בתוך ensure_job_for_production, ובאקפיל של 31 שורות. אפס שינוי סכימה, אפס DELETE, אפס שורה שנוצרה. הבעיה: העמודה קיימת מ-0025 ומעולם לא נכתבה על שורת work_order, כי כל שלושת אתרי ה-enqueue קוראים ל-enqueueDocument בלי jobId (calendar/sync:352, productions/route:208, hours/route:301) — וזה מבני ולא רשלני: ההזמנה נוצרת לפני שה-job קיים. סנכרון 06:00 מנפיק אותה כשהפרק משובץ, וה-job נולד מאוחר יותר במעבר להוקלט (0060), כך שבזמן ה-enqueue אין מה לכתוב. לכן הכתיבה שייכת לקצה השני — לרגע שבו ה-job נולד. נמדד על נתונים חיים 10.9.26 20:10 UTC וזו הראיה שקבעה את המיקום: 31 מתוך 31 השורות שמולאו נוצרו לפני ה-job שלהן, אפס אחריו — הפונקציה אינה אחת משתי אפשרויות אלא הנקודה היחידה בזמן שבה שני הצדדים קיימים. למה ב-DB ולא באפליקציה: 12 מתוך 42 יצירות ה-job עוברות באפליקציה והשאר בטריגר, כך שמילוי ב-TypeScript היה מכסה פחות משליש מהמסלולים ונראה גמור — כשל גרוע יותר, כי הוא מתגלה כעמודה ריקה ברג׳יסטרי חודשים אחר כך. ensure_job_for_production היא נקודת ההתכנסות: הטריגר יורה אותה בהוקלט ובאישור לקוח, וגם סקריפט המילוי אחורה עובר דרך אותה RPC. למה זו אינה שבירת 0025, ונכתב במפורש כדי שלא ייקרא כתקדים: 0025 אוסרת שהמסד יפיק מסמך שיגיע למורנינג בלי אדם בלולאה. כאן ממולא מפתח זר על שורה שכבר קיימת — לא נוצרת שורה, לא משתנה סטטוס, לא נגעו payload, amount, approved_by או morning_doc_id, ואין מסלול לקריאת מורנינג (issue.ts הוא הקורא היחיד והוא מגיע רק ממסך האישור). ההבחנה לעתיד: 0025 שולטת בעמודות מחזור החיים של שורת תור, שהן של אדם והמסד לעולם לא יכתוב אותן; job_id הוא קישור — אמירה על איזו עבודה השורה כבר תיארה — והשכבה שיוצרת את העבודה היא המתאימה ביותר להצהיר עליו. מיגרציה עתידית שתצטט את 0077 כדי לכתוב סטטוס של שורת תור מצטטת את החצי הלא נכון. הפרדיקט שאול ולא מומצא: doc_type=work_order, production_id לא ריק, status not in (rejected,failed,cancelled) — הרשימה מ-pending_documents_one_live_per_production כפי ש-0063 הותירה אותה, כי ל"פתוחה" כבר יש הגדרה אחת בסכימה והגדרה שנייה שנכתבת ביד היא אמת שנייה שנסחפת מהראשונה. זה גם מה שקונה את התכונה שמייתרת נעילה: האינדקס הייחודי מבטיח שלכל היותר שורה אחת להפקה יכולה להתאים, ולכן ה-UPDATE בתוך הפונקציה נוגע בשורה אחת או באפס ולעולם לא בקבוצה שעליו לבחור ממנה. and job_id is null אינו חלק מפרדיקט האינדקס ונוסף כהגנה מדריסה — היום דבר אינו יכול לכתוב לעמודה הזאת על שורת work_order, ולכן זו הגנה מפני כותב עתידי, אבל היא מה שמאפשר ל-canary לקבוע כעובדה שאפס ערכים קיימים נהרסו. הפקה עם שני jobs לא נגעה, וההימנעות אינה סעיף ריק: קיימת בדיוק אחת — 8b4aabe5, דברים שלמדתי מנשים מצליחות, 22.6 ב-500 ו-29.6 ב-250 — והיא נושאת אפס שורות pending_documents ולכן אינה בפרדיקט ואינה ניתנת להשגה מכאן. הבאקפיל מסנן על exactly one job במקום לסמוך על הספירה, ושורה דו-משמעית מדולגת בשקט במקום להיפתר בכלל: כל כלל הכרעה — המוקדם, הגדול, האחרון — היה מומצא כאן, מוחל על אפס שורות, ומורש למי שייתקל במקרה באמת. שורה ריקה אומרת שאיש טרם הכריע, וזו האמת; שורה שמולאה בשובר-שוויון אומרת שזה ה-job, ואיש לא קבע זאת. מה שמתעורר, החצי הכן: findBilledEvidence לא מושפעת כי כלל b מסנן doc_type ל-deal_invoice/tax_invoice/tax_receipt ו-work_order אינו נכנס לשאילתה; claimed ב-bundle.ts לא מושפעת מאותה סיבה; resolveParentWorkOrderLink מוצאת את ההזמנה לפי production_id ולא לפי job_id; jobPatchFor אינה כוללת work_order ולכן הנפקת 100 אינה חותמת דבר על ה-job ומילוי job_id אינו יוצר מסלול חדש ל-invoice_biz או invoice_tax. contracts/page.tsx כן קוראת שורות work_order וממפה אותן לפי job_id, ו-20 מהשורות שמולאו הן issued ויגיעו למפה — נמדד שהחפיפה בין 31 ה-jobs לבין contract_milestones.job_id היא אפס, ולכן אפס שינוי היום, ומתועד כצימוד חי ולא מת. documents/enqueue/route.ts:112 כן משתנה, וזה תיקון: בדיקת הכפילות שם היא eq(job_id).eq(doc_type).in(status,LIVE), ועם job_id ריק היא מעולם לא התאימה דבר — וה-INSERT שהיא שומרת נושא production_id ריק ולכן נופל גם מחוץ ל-pending_documents_one_live_per_production, כך שהזמנה שנייה ל-job שכבר הוזמן יכלה להיווצר בלי שדבר יעצור אותה. אחרי הבאקפיל 20 השורות ה-issued נראות לבדיקה והכפילות נדחית; 11 הנותרות (4 accrued, 9 consolidated) נשארות בלתי נראות לה כי רשימת ה-LIVE שלה היא pending/approved/issued — לא נגעה כאן, ומדווחת כדי שהאסימטריה תהיה ידועה. הרשאות מוצהרות לפי כלל 49: המיגרציה אינה יוצרת שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא policy — ולכן אין דבר שהרשאותיו יכולות להיוולד שגויות ולא הונפק GRANT. החצי של כלל 49 שכן חל הוא זה שמכה בשקט: job_id כבר קריא ל-authenticated מאז 0025, והפיתוי השגוי היה להגן על העמודה שזה עתה קיבלה משמעות עם revoke select (job_id) — הצהרה שהייתה עוברת נקייה ולא עושה דבר, כי כל עוד authenticated=r יושב ב-relacl הפונקציה has_column_privilege מחזירה true על כל עמודה; כך 0031 השאירה את המחירים ב-production_addons קריאים לכל טכנאי ולכן 0068 נאלצה לשלול את הטבלה כולה. ממילא אין כאן מה להסתיר: מזהה job הוא uuid פנימי מאותה מחלקה כמו production_id שה-authenticated כבר קורא באותה טבלה, והכסף מוגן ב-RLS דרך pending_documents_select ו-can_view_money שלא נגעו. כתיבה נשארה server-only: ל-authenticated אין UPDATE על job_id, לא נוסף policy, והחותמת בתוך הפונקציה רצה SECURITY DEFINER כמו תמיד. שומרים לפני הכתיבה: הפנקס אינו מכיל 0077, הפנקס כן מכיל 0076 (הפנקס הוא הרצף ולא שמות הקבצים, ואם 0076 חסרה אז המספור נגזר מפנקס אחר וכל הספירות נמדדו מול מסד אחר), ו-md5 של גוף ensure_job_for_production זהה לזה של 0067 — השומר החשוב ביותר בקובץ, כי create or replace שותק לגבי מה שהרס, זו המיגרציה החמישית שכותבת את הגוף הזה (0060 אל 0061 אל 0064 אל 0067 אל כאן), ולוגיקת התמחור של 0067 יושבת בתוכו. שלוש עשרה בדיקות canary לפני שורת הפנקס: 31 שורות קיבלו ערך; טביעת md5 על בדיוק השורות שכבר החזיקו job_id זהה לחלוטין לפני ואחרי, וזו ההוכחה לאפס דריסה ולא ה-WHERE שמבטיח אותה; טביעת md5 על כל הטבלה מלבד job_id זהה, וזו הבדיקה שאפס שורות מחוץ לפרדיקט נגעו והיא מכסה גם עמודות אחרות בתוך הפרדיקט; מספר השורות בתור לא השתנה; מספר ה-jobs לא השתנה ומספר קישורי job_productions לא השתנה — האמירה הנושאת של הקובץ וזו שמפרידה אותו משבירת 0025, שמילוי קישור לא ייצר עבודה ולא ייצר כסף; כל ערך שנכתב אומת בהצטרפות חזרה שהוא ה-job של אותה הפקה ולא סתם job, על פני כל הטבלה ולא רק על השורות שנכתבו; מה שהושאר ריק במכוון עדיין ריק והספירה מתיישבת; אפס jobs נושאים שתי הזמנות חיות, וזו אינה קפדנות אלא ההבדל בין דחייה מנומסת לבין 500, כי הבדיקה ב-documents/enqueue משתמשת ב-maybeSingle שנופל על שורה שנייה; anon אפס, authenticated קורא, authenticated אינו כותב, RLS דלוק ו-pending_documents_select קיים; והפונקציה באמת התחלפה ונושאת את המפתח work_order_stamped. אירוע client_approved_job_created קיבל מפתח אחד נוסף, work_order_stamped, לפי תקדים 0067 — תוספת מפתח בלבד, שום קורא אינו תלוי בצורה — כדי ששאלת "איזו הזמנה נסגרה על ה-job הזה" תיענה מהלוג ולא משחזור. גבול החותמת מוצהר: הזמנה שנוצרת אחרי שה-job כבר קיים לא תיראה שוב על ידי הפונקציה, כי גארד הכפילות של 0060 מחזיר מוקדם, והיא תישאר ריקה — נמדד אפס שורות כאלה היום, והתיקון למקרה שטרם קרה הוא שורה אחת בכל אחד משלושת אתרי ה-enqueue והוא צעד נפרד. מחוץ להיקף במכוון וכל אחד הוא צעד בפני עצמו: 322 שורות מסוג 100 בטבלת documents עם job_id ריק — טבלה אחרת, מקור אחר (משיכה יומית ולא enqueueDocument) ובעיית התאמה אחרת, לבקלוג; דליפת forProduction שבה job המקשר שתי הפקות היה חושף מסמך של P1 בדרואר של P2 — אפס שורות היום, ההפקה הדו-job היחידה נושאת אפס מסמכים ואף job אינו פורש על שתי הפקות, התנהגות רדומה שמתועדת ולא מתוקנת כאן; ושתי הזמנות SFI 10311 ו-10312 מ-17.8, הזמנות שהונפקו להפקות שאין להן job כלל — הן הוקלטו שבעה ימים לפני ש-0060 יצרה את טריגר ההוקלט ב-24.8 ומעולם לא הגיעו לאישור לקוח, כך ששתי נקודות הכניסה מעולם לא ירו. הן בפרדיקט ונשארו ריקות בצדק: מתן job להן הוא יצירת כסף, הכרעה עסקית של הבעלים ולא תיקון נתונים — אותו קו ש-0072 מתחה כשסירבה להחזיר את ההפקה של מלי ל-kind=client.');

  raise notice '0077 הוחלה ונרשמה. הזמנה פתוחה נושאת מעכשיו את ה-job שלה; % שורות היסטוריות מולאו.', v_filled;

end $mig$;
