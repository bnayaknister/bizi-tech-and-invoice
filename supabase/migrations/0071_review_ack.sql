-- 0071: closing the client-review loop — SCHEMA ONLY (owner spec 2026-09-03).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHAT THIS IS. A client's correction note raises productions.needs_attention
-- (links.ts:407) and NOTHING can lower it except that same client returning to
-- a live link and approving everything (links.ts:403). There is no way for a
-- technician to say "received, working on it". The one route that writes the
-- flag by hand — api/productions/[id]/route.ts:60-63 — has zero callers in the
-- entire client bundle. So a production sits red forever, and one does: מלי
-- אלקובי / "ואם נחיה לנצח" 29.7 has been flagged since 30.7, was approved by
-- hand on 9.8, and is still red today. 0072 repairs that row; THIS migration
-- lays the columns so it cannot happen again.
--
-- This migration changes NO behaviour. No code reads the new columns yet, no
-- existing column changes meaning, no row is touched. The route, the button,
-- the popup and the print view are a separate step, deliberately after this
-- one has been applied and verified.
--
-- ---------------------------------------------------------------------------
-- THE ACK LIVES ON productions, NOT ON THE LINK AND NOT ON THE ITEM.
-- ---------------------------------------------------------------------------
-- Three homes were possible and only one survives the board.
--
--   • client_review_links — the natural home for "this ROUND was received",
--     and rejected because the board card renders from ONE production row
--     (productions/page.tsx:147). An ack that lives on the link turns the red
--     dot into a join on every card, on a screen that already fought to
--     collapse a 4.3k-row stage scan into one round-trip (0035).
--   • client_review_items — wrong granularity. A note can be per-reel, but
--     "received, working on it" is a statement about the ROUND, not about reel
--     number 2. Three items would carry three acks that can never disagree.
--   • productions — one row, zero joins, and review_ack_link_id restores the
--     per-round precision the other two were reaching for.
--
-- ---------------------------------------------------------------------------
-- THE RESET IS EXPLICIT, NOT DERIVED. This is the load-bearing decision.
-- ---------------------------------------------------------------------------
-- A new correction round must clear the ack, or the second note arrives to a
-- production that still claims someone is handling the first. Two ways to get
-- there:
--
--   DERIVED — leave the columns alone and compute "unacked" as
--   `review_ack_link_id <> (latest responded revisions link)`. Elegant, and
--   rejected: it makes every board read a correlated subquery, and any bug in
--   the derivation renders "nothing to handle" while a client waits. It fails
--   SILENTLY, in the direction of a missed note.
--
--   EXPLICIT — applyResponse nulls all three columns in the same patch that
--   sets needs_attention = true (links.ts:404-408). That patch is already the
--   one atomic UPDATE the function is allowed to throw on (links.ts:439-442),
--   so the flag and its mirror can never disagree: either both landed or
--   neither did. A forgotten reset shows up as a red dot next to a stale ack —
--   loud, visible, and in the direction of doing the work twice rather than
--   not at all.
--
-- Explicit wins. review_ack_link_id then earns its keep a second time as the
-- stale-tab guard: the ack route refuses to acknowledge a round that is not
-- the latest, so a tab left open yesterday cannot extinguish a dot that was
-- lit this morning.
--
-- ---------------------------------------------------------------------------
-- WHY needs_attention SURVIVES AS A SEPARATE COLUMN.
-- ---------------------------------------------------------------------------
-- review_ack_at could have replaced it: today the two always move together.
-- They are kept apart because they mean different things. needs_attention is a
-- generic board flag — the manual route above stays valid for reasons that
-- have nothing to do with a client note — while review_ack_at is an assertion
-- about a client's correction round specifically. Merging them would weld the
-- board's only "look at this" mechanism to one feature forever.
--
-- ---------------------------------------------------------------------------
-- opened_at IS EVIDENCE. IT IS NEVER A GATE.
-- ---------------------------------------------------------------------------
-- ★ THE RULE, and it is written here because a later reader will be tempted:
--
--     first_opened_at / last_opened_at / open_count may be DISPLAYED and may
--     be REPORTED ON. They must never gate, trigger, expire, supersede, or
--     change a status. No branch anywhere may read "the client did not open
--     it" and act.
--
-- The reason is not caution, it is a measurement we already paid for. Mail
-- scanners open links: one-time invite and recovery links in this system were
-- burned by scanners before a human ever clicked, which is why /welcome grew a
-- resend path. A single boolean-shaped timestamp would therefore report "the
-- client saw it" when an antivirus appliance saw it. Three columns instead of
-- one is the whole defence: open_count separates a lone suspicious fetch from
-- seven genuine visits, and first/last show whether they came back.
--
-- STAMPED IN ONE PLACE ONLY — the GET of src/app/r/[token]/page.tsx. NOT in
-- resolveLink (links.ts:168), which also runs from the response POST
-- (respond/route.ts:30): answering is not opening, and stamping there would
-- make open_count a proxy for "responded" on exactly the rows where the
-- distinction matters most.
--
-- What this would have told us about מלי: five links minted after her only
-- response, none ever answered. Nobody can say today whether she opened one of
-- them and walked away or never received a single one — and those are
-- different problems with different fixes.
--
-- ---------------------------------------------------------------------------
-- ROUNDS: A VIEW, NOT A COUNTER COLUMN.
-- ---------------------------------------------------------------------------
-- The owner needs "how many rounds did this client cost us" for pricing and
-- for showing a client their own history. The source is client_review_links:
-- one row per round, responded_at not null, carrying its own decision. That
-- table is append-only and immutable after the response (respond/route.ts
-- locks it), which is exactly when a view beats a denormalized counter — a
-- counter needs a trigger, and a trigger-maintained tally drifts. Nothing
-- here can drift: the count IS the rows.
--
-- revision_rounds vs total_rounds is a real distinction, not decoration. The
-- approving round is a round too; what pricing wants is the number of times
-- the work was redone, which is the rounds carrying 'revisions'.
--
-- security_invoker = on, following 0035. Without it the view runs as its owner
-- and hands every reader the whole table, silently bypassing the
-- can_view_stages() policy on client_review_links (0029:51). With it, the
-- board can read the view through the USER's client and the wall still stands.
-- Not granted to anon: 0068 stripped anon of every privilege in the schema
-- after verifying no PostgREST read anywhere runs in that role, and a new view
-- must not be the exception that reopens it (0035 predates that decision and
-- granted anon; it is a leftover, not a precedent to copy).
--
-- ---------------------------------------------------------------------------
-- WHAT THE FIRST RUN OF THIS FILE DISCOVERED (2026-09-03).
-- ---------------------------------------------------------------------------
-- Attempt one aborted on its own canary:
--
--     0071 canary: anon קיבל SELECT על התצוגה
--
-- anon held SELECT on a view three statements old, in a file that never
-- names anon outside that check. 0068 had asserted — inside its own
-- transaction, and it committed — that anon held nothing on any table or
-- view in this schema (0068:298-306). Both facts are true, and together they
-- identify the mechanism: the privilege was attached at CREATE time by the
-- server, and the only thing in PostgreSQL that does that without an
-- explicit GRANT is pg_default_acl.
--
-- Confirmed by querying it: schema public carries default-privilege entries
-- for TWO granting roles — postgres and supabase_admin — across all three
-- object classes (tables, sequences, functions), granting arwdDxtm to anon
-- and to authenticated by name.
--
-- ★ THE LESSON, and it is bigger than this file: 0068 closed a SNAPSHOT, not
--   a POLICY. `revoke all on all tables in schema public` (0068:180) expands
--   at execution time over the objects that exist then; it says nothing about
--   the next one. So the schema re-opened itself the first time anybody
--   created an object — which was here, two days later. 0069 removes the
--   policy; step 5b below defends this file regardless.
--
-- ★ THE RULE THIS ESTABLISHES: a migration that creates an ACL-bearing object
--   (table, view, sequence, function) must declare that object's privileges
--   explicitly AND assert them before it writes its ledger row. Creation is
--   not a neutral act in this schema. This file now does both; every future
--   one must.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THIS FILE WAS AMENDED AFTER IT WAS APPLIED (2026-09-04).
-- ---------------------------------------------------------------------------
-- Applied to production on 2026-09-03 and recorded in the ledger. On
-- 2026-09-04, while writing 0070, its ordering guard was found to be a
-- rebuild-blocker: it refused to run whenever 0070 was already in the ledger,
-- which is exactly the order a clean rebuild produces. The guard is replaced
-- below by an assertion of the condition it was standing in for. Nothing about
-- the applied database changes — this edit only matters to a database rebuilt
-- from this directory. The section that follows describes the ORIGINAL
-- reasoning and is kept because the hazard it names is real; only the remedy
-- moved.
--
-- ---------------------------------------------------------------------------
-- THE 0070 ORDERING GUARD — the hazard, and why the guard no longer blocks.
-- ---------------------------------------------------------------------------
-- 0068's ledger row reserves two numbers that are not written yet: 0069
-- (revoke DML from authenticated on the tables the user client never writes)
-- and 0070 (hide productions.price_override, "which requires enumerating 43
-- columns"). That enumeration is the hazard. 0070 will revoke table-level
-- SELECT on productions and re-grant it column by column — and the three
-- columns added below would not be in a list written before they existed.
-- The result is the exact failure 0068 warns about at :64: a forgotten column
-- does not announce itself, it renders as a blank card on somebody's phone.
--
-- So the guard is deliberately inverted from the usual "the previous migration
-- must be applied": 0071 requires 0068 (the last one actually applied) and
-- REFUSES to run if 0070 is already in the ledger. If someone hits that
-- exception, the fix is not to delete the guard — it is to add
-- review_ack_at, review_ack_by and review_ack_link_id to 0070's grant list
-- and then run this.
--
-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION, ON PURPOSE — and one of them is a real exposure.
-- ---------------------------------------------------------------------------
-- ★ guard_production_stage_columns (0010 → 0040 → 0067) is NOT extended to the
--   ack columns, and that is a scope decision the owner approved, not an
--   oversight. Stated plainly so it is not discovered later:
--
--     needs_attention itself has never been in that guard. Any authenticated
--     user can clear it through PostgREST directly today, with or without
--     can_edit_stages, because RLS on productions is the only wall and it
--     permits the update. The ack columns inherit exactly that exposure — no
--     more, no less, and no regression. The app-level wall (can_edit_stages in
--     the ack route) is real for anyone using the app.
--
--   Adding the three columns AND needs_attention to that guard is safe and
--   should be a follow-up: can_edit_stages() returns NULL under the service
--   role (0002:42-45 — no profiles row for a null auth.uid()), `not NULL` is
--   NULL, and `if NULL then` does not fire, so applyResponse's service-role
--   reset would pass straight through an extended guard. It is left out here
--   only because a shared guard function touched in a schema migration that
--   nothing yet reads is a change with no test to catch it.
--
-- • No constraint tying review_ack_at to review_ack_link_id. 0072 sets an ack
--   with a null actor (a migration did it, not a person), and a note raised by
--   the manual route has no round to point at — both are legitimate shapes.
-- • No FK-style check that review_ack_link_id belongs to the same production;
--   that is a cross-row assertion the ack route makes and a constraint cannot.
-- • No backfill. 0072 repairs the single affected row, explicitly, by id.
-- • Zero DELETE, zero data change, zero row touched.

do $mig$
declare
  v_prod_cols      int;
  v_link_cols      int;
  v_rows_view      int;
  v_rows_direct    int;
  v_rev_view       int;
  v_rev_direct     int;
  v_preexisting    int;
  v_invoker        text;
begin

  -- ---------------------------------------------------------------------
  -- 0. re-run guard. Loud, never idempotent-by-silence: a second run that
  --    did nothing would still add a second ledger row (0053's precedent).
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0071') then
    raise exception '0071 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. ordering guards. See the header — the second one is inverted on
  --    purpose and must not be deleted to make this run.
  -- ---------------------------------------------------------------------
  if not exists (select 1 from public.schema_ledger where version = '0068') then
    raise exception '0068 טרם הוחלה — הרץ אותה קודם';
  end if;

  -- ★ AMENDED 2026-09-04, AFTER 0070 WAS WRITTEN. The version that RAN on
  --   2026-09-03 raised here if 0070 was already in the ledger. That guard was
  --   right about the hazard and wrong about the remedy, and on a clean rebuild
  --   — 0068, 0069, 0070, 0071 in order — it would have blocked this migration
  --   permanently.
  --
  --   The hazard was: 0070 re-grants productions column by column, and a list
  --   written before these three columns existed would omit them. 0070 does not
  --   write a list; it reads pg_attribute (0070 §2). So a column that does not
  --   exist when 0070 runs is not "forgotten" — it is simply granted by
  --   whoever creates it, which is step 6 of this file.
  --
  --   The proxy is therefore replaced by the real condition, asserted in §7
  --   after the grant lands: the three columns must be readable by
  --   authenticated whether or not productions still carries table-level
  --   SELECT. That check is correct in both orders and on both databases.

  -- ---------------------------------------------------------------------
  -- 2. the ack columns on productions.
  --    All three nullable: "never acknowledged" is the correct state for
  --    every existing row and for every production that never had a note.
  -- ---------------------------------------------------------------------
  --    review_ack_by follows the convention of its two siblings —
  --    client_review_links.created_by (0029:23) and production_log.author_id
  --    (0040:51) — and carries no ON DELETE clause.
  --    review_ack_link_id DOES: client_review_links cascades from productions
  --    (0029:20), so a link row can legitimately disappear. ON DELETE SET NULL
  --    means the acknowledgement survives with a null pointer instead of the
  --    pointer blocking the delete — "someone received this, the round it was
  --    about is gone" is a true statement; a failed DELETE is not a better one.
  alter table public.productions
    add column if not exists review_ack_at      timestamptz,
    add column if not exists review_ack_by      uuid references public.profiles(id),
    add column if not exists review_ack_link_id uuid references public.client_review_links(id) on delete set null;

  -- ---------------------------------------------------------------------
  -- 3. the open-tracking columns on client_review_links.
  --    EVIDENCE ONLY — see the rule in the header. open_count is NOT NULL
  --    DEFAULT 0 so "never opened" and "opened zero times" are the same
  --    statement rather than two; first/last are null until a real GET.
  -- ---------------------------------------------------------------------
  alter table public.client_review_links
    add column if not exists first_opened_at timestamptz,
    add column if not exists last_opened_at  timestamptz,
    add column if not exists open_count      int not null default 0;

  begin
    alter table public.client_review_links
      add constraint client_review_links_open_count_nonneg check (open_count >= 0);
  exception when duplicate_object then
    raise notice '0071: client_review_links_open_count_nonneg כבר קיים';
  end;

  -- ---------------------------------------------------------------------
  -- 4. the index the view groups on. Partial, because an unanswered link is
  --    not a round and the view never looks at one — today that is 3 of the
  --    live rows out of every link ever minted.
  -- ---------------------------------------------------------------------
  create index if not exists client_review_links_responded_idx
    on public.client_review_links (production_id)
    where responded_at is not null;

  -- ---------------------------------------------------------------------
  -- 5. the rounds view. See the header for security_invoker.
  -- ---------------------------------------------------------------------
  create or replace view public.v_production_review_rounds
    with (security_invoker = on)
  as
  select
    production_id,
    -- what pricing wants: how many times the work was sent back
    count(*) filter (
      where episode_response = 'revisions' or reels_response = 'revisions'
    )::int                     as revision_rounds,
    -- every answered round, including the approving one
    count(*)::int              as total_rounds,
    min(created_at)            as first_sent_at,
    max(responded_at)          as last_response_at
  from public.client_review_links
  where responded_at is not null
  group by production_id;

  -- ---------------------------------------------------------------------
  -- 5b. THE VIEW'S ACL IS DECLARED, NOT INHERITED.
  --
  --     The first run of this migration died on its own canary at step 8:
  --     anon held SELECT on a view created three statements earlier, in a
  --     file that never names anon outside that check. The cause is
  --     pg_default_acl — schema public carries ALTER DEFAULT PRIVILEGES
  --     entries for TWO granting roles (postgres and supabase_admin) that
  --     hand arwdDxtm on tables, sequences and functions to anon AND to
  --     authenticated. Every new object in this schema is therefore born
  --     wide open, and 0068 never saw it because 0068 revoked a SNAPSHOT
  --     (`revoke ... on all tables in schema public`, 0068:180) and left the
  --     POLICY untouched. 0069 removes the policy.
  --
  --     These two statements stay even after 0069 lands. A migration that is
  --     only correct because a global default happens to be right is a
  --     migration that breaks silently the day it isn't — which is precisely
  --     the failure being repaired. After them the view's ACL is exactly
  --     what this file says it is, in any order, on any database.
  --
  --     `from public` as well as `from anon`: the diagnosis showed named
  --     grants rather than PUBLIC, but a revoke that also covers the shape we
  --     did NOT find costs nothing and removes the need to have been right.
  --     `authenticated` is revoked and then re-granted deliberately — the
  --     default hands it ALL, including INSERT/UPDATE/DELETE. On an aggregate
  --     view those are not executable anyway, and "not executable anyway" is
  --     exactly the reasoning that leaves ACLs untidy.
  --
  --     service_role is left as the platform sets it, like every other table
  --     in this schema — it is the trusted role by construction, and singling
  --     this view out would be a local exception with no rule behind it.
  -- ---------------------------------------------------------------------
  revoke all privileges on public.v_production_review_rounds
    from public, anon, authenticated;

  -- ---------------------------------------------------------------------
  -- 6. grants.
  --    productions is not column-restricted, but 0028/0040/0055/0067 name
  --    new columns explicitly and this follows that convention.
  --    client_review_links deliberately gets NO column grant: it still holds
  --    table-level SELECT, a column grant there would record an ACL entry
  --    that restricts nothing (0068 measured exactly this), and 0069 is
  --    already scheduled to take DML on that table away from authenticated.
  --    anon gets nothing — see the header.
  -- ---------------------------------------------------------------------
  grant select (review_ack_at, review_ack_by, review_ack_link_id)
    on public.productions to authenticated;

  grant select on public.v_production_review_rounds to authenticated, service_role;

  -- ---------------------------------------------------------------------
  -- 7. verification, inside the same transaction. A migration that reports
  --    success without checking is a migration nobody can trust later.
  -- ---------------------------------------------------------------------
  select count(*) into v_prod_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'productions'
    and column_name in ('review_ack_at', 'review_ack_by', 'review_ack_link_id');
  if v_prod_cols <> 3 then
    raise exception '0071: נמצאו % מתוך 3 עמודות ה-ack על productions', v_prod_cols;
  end if;

  select count(*) into v_link_cols
  from information_schema.columns
  where table_schema = 'public' and table_name = 'client_review_links'
    and column_name in ('first_opened_at', 'last_opened_at', 'open_count');
  if v_link_cols <> 3 then
    raise exception '0071: נמצאו % מתוך 3 עמודות הפתיחה על client_review_links', v_link_cols;
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'client_review_links_responded_idx'
  ) then
    raise exception '0071: האינדקס client_review_links_responded_idx לא נוצר';
  end if;

  -- the view exists AND actually carries security_invoker. Creating it with
  -- the option and then not checking would be the one failure that looks
  -- identical to success while handing every reader the whole table.
  select coalesce(
           (select o
              from pg_class c, unnest(c.reloptions) as o
             where c.oid = 'public.v_production_review_rounds'::regclass
               and o like 'security_invoker=%'
             limit 1),
           'MISSING')
    into v_invoker;
  if v_invoker not in ('security_invoker=on', 'security_invoker=true') then
    raise exception '0071: ל-v_production_review_rounds אין security_invoker (נמצא: %)', v_invoker;
  end if;

  -- self-consistency: the view must agree with the table it summarises. No
  -- hardcoded numbers — a count that is right today and wrong next month is
  -- a check that teaches the next reader to ignore it.
  select count(*) into v_rows_view   from public.v_production_review_rounds;
  select count(distinct production_id) into v_rows_direct
    from public.client_review_links where responded_at is not null;
  if v_rows_view <> v_rows_direct then
    raise exception '0071: התצוגה מחזירה % שורות מול % הפקות בטבלה', v_rows_view, v_rows_direct;
  end if;

  select coalesce(sum(revision_rounds), 0) into v_rev_view
    from public.v_production_review_rounds;
  select count(*) into v_rev_direct
    from public.client_review_links
    where responded_at is not null
      and (episode_response = 'revisions' or reels_response = 'revisions');
  if v_rev_view <> v_rev_direct then
    raise exception '0071: סכום סבבי התיקונים בתצוגה % מול % בטבלה', v_rev_view, v_rev_direct;
  end if;

  -- the three ack columns are READABLE — the real condition the 0070 guard
  -- used to approximate (see §1). has_COLUMN_privilege, never
  -- has_table_privilege: once 0070 has run, productions carries no table-level
  -- SELECT at all and the table-level form would report a failure that is the
  -- intended state. This holds in both orders — before 0070 the table grant
  -- supplies it, after 0070 the column grant in §6 does.
  if not has_column_privilege('authenticated', 'public.productions', 'review_ack_at', 'SELECT')
     or not has_column_privilege('authenticated', 'public.productions', 'review_ack_by', 'SELECT')
     or not has_column_privilege('authenticated', 'public.productions', 'review_ack_link_id', 'SELECT') then
    raise exception '0071: עמודות ה-ack אינן קריאות ל-authenticated — הגרנט בשלב 6 לא תפס, והכרטיס בלוח יישבר בשקט';
  end if;

  -- nobody may already be acknowledged — the columns were just born
  select count(*) into v_preexisting
  from public.productions
  where review_ack_at is not null or review_ack_by is not null
     or review_ack_link_id is not null;
  if v_preexisting <> 0 then
    raise exception '0071: % הפקות כבר נושאות ack לפני שהמיגרציה רצה — עצור וברר', v_preexisting;
  end if;

  -- ---------------------------------------------------------------------
  -- 8. canary. 0068's lesson: an over-broad privilege change fails HERE,
  --    inside a transaction that can still roll back, and not on a live
  --    screen. productions must remain readable and writable; the review
  --    tables must remain readable.
  -- ---------------------------------------------------------------------
  if not has_table_privilege('authenticated', 'public.productions', 'SELECT')
     or not has_table_privilege('authenticated', 'public.productions', 'UPDATE') then
    raise exception '0071 canary: authenticated איבד SELECT או UPDATE על productions';
  end if;
  if not has_table_privilege('authenticated', 'public.client_review_links', 'SELECT') then
    raise exception '0071 canary: authenticated איבד SELECT על client_review_links';
  end if;
  if not has_table_privilege('authenticated', 'public.v_production_review_rounds', 'SELECT') then
    raise exception '0071 canary: authenticated לא קיבל SELECT על התצוגה';
  end if;

  -- The check that caught pg_default_acl on the first run. It stays, and it
  -- stays as an exception rather than a notice: a view that reaches the API
  -- readable by anon is not a warning, it is the incident.
  if has_table_privilege('anon', 'public.v_production_review_rounds', 'SELECT') then
    raise exception '0071 canary: anon קיבל SELECT על התצוגה — ה-revoke בשלב 5ב לא תפס. בדוק pg_default_acl והרץ 0069';
  end if;

  -- and the revoke of the write privileges actually landed, not merely the
  -- anon one — proof that step 5b ran as written and not by luck
  if has_table_privilege('authenticated', 'public.v_production_review_rounds', 'INSERT') then
    raise exception '0071 canary: ל-authenticated נשאר INSERT על התצוגה — ברירת המחדל של הסכימה גברה על ה-revoke';
  end if;

  -- ---------------------------------------------------------------------
  -- 9. the ledger, inside the same block — a schema change that is not
  --    recorded is a schema change nobody can find later (0052).
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0071', now(), 'bnaya',
          'סגירת מעגל הערות הלקוח — סכימה בלבד, אפס שינוי התנהגות: שום קוד עדיין לא קורא את העמודות החדשות, אין backfill ואף שורה לא נגעה. הבעיה: הערת תיקונים של לקוח מדליקה את productions.needs_attention ב-links.ts:407, והדבר היחיד שמכבה אותה הוא אותו לקוח שחוזר ללינק חי ומאשר הכל ב-links.ts:403. אין לטכנאי דרך לומר "קיבלתי ומטפל". הראוט היחיד שכותב את הדגל ידנית, api/productions/[id]/route.ts:60-63, חסר קוראים בכל חבילת הלקוח — grep על כל src מחזיר רק הגדרות וקריאת תצוגה. התוצאה היא הפקה שנשארת אדומה לנצח, ויש אחת כזו: מלי אלקובי / "ואם נחיה לנצח" 29.7, מסומנת מ-30.7, אושרה ידנית ב-9.8 ועדיין אדומה. 0072 מתקנת את השורה; כאן מונחות העמודות שמונעות הישנות. שלוש עמודות ack על productions ולא על client_review_links ולא על client_review_items: הכרטיס בלוח מצויר משורת הפקה אחת (productions/page.tsx:147), ו-ack שיושב על הלינק היה הופך את הנקודה האדומה ל-join בכל כרטיס — במסך שכבר נלחם לכווץ סריקת 4,300 שלבים לגישה אחת (0035); ו-items הם רזולוציה שגויה, כי "קיבלתי ומטפל" היא אמירה על הסבב ולא על ריל מספר 2, ושלושה פריטים היו נושאים שלושה ack שלעולם לא יוכלו לחלוק. review_ack_link_id מחזיר את הדיוק הפר-סבבי ששתי החלופות חיפשו. האיפוס מפורש ולא נגזר, וזו ההכרעה הנושאת: applyResponse תאפס את שלוש העמודות באותו patch שמדליק את needs_attention (links.ts:404-408), שהוא ה-UPDATE האטומי היחיד שהפונקציה מרשה לעצמה לזרוק עליו (links.ts:439-442) — ולכן הדגל והמראה שלו לא יכולים לסתור, או ששניהם נחתו או ששניהם לא. הגזירה (ack_link_id מול הלינק האחרון שנענה) נדחתה כי היא הופכת כל קריאת לוח לתת-שאילתה מתואמת, וכל באג בה מציג "אין מה לטפל" בזמן שלקוח ממתין — כישלון שקט בכיוון של הערה שהוחמצה, בעוד איפוס שנשכח מתגלה כנקודה אדומה ליד ack ישן, כלומר בכיוון של עבודה כפולה. needs_attention נשמרת כעמודה נפרדת ולא מוזגה לתוך review_ack_at אף שהיום השתיים נעות יחד: הראשונה היא דגל לוח כללי שהראוט הידני ימשיך לשרת מסיבות שאינן הערות לקוח, השנייה היא הצהרה על סבב תיקונים של לקוח, ומיזוג היה מרתך את מנגנון ה"שים לב" היחיד של הלוח לפיצ׳ר אחד לתמיד. שלוש עמודות פתיחה על client_review_links (first_opened_at, last_opened_at, open_count) עם כלל שנכתב בגוף המיגרציה במפורש: הן עדות בלבד, לעולם לא שער — מותר להציג ולדווח, אסור לחסום, להפעיל, להשהות, לדרוס או לשנות סטטוס על בסיסן. הסיבה אינה זהירות אלא מדידה ששילמנו עליה: סורקי דואר פותחים לינקים, ולינקי הזמנה ושחזור חד-פעמיים כאן כבר נשרפו על ידי סורקים לפני שאדם לחץ — זו הסיבה ש-/welcome קיבל מסלול שליחה מחדש. חותם בודד היה מדווח "הלקוח ראה" כשמכשיר אנטי-וירוס ראה, ושלוש עמודות במקום אחת הן ההגנה כולה: open_count מפריד בין פתיחה בודדת חשודה לשבע אמיתיות, ו-first/last מראים אם חזר. ההטבעה במקום אחד בלבד — ה-GET של r/[token]/page.tsx ולא ב-resolveLink (links.ts:168), שרצה גם מ-POST התשובה (respond/route.ts:30): מענה אינו פתיחה, והטבעה שם הייתה הופכת את open_count לפרוקסי של "ענה" בדיוק בשורות שבהן ההבחנה חשובה. מה זה היה אומר לנו על מלי: חמישה לינקים הונפקו אחרי תשובתה היחידה ואף אחד לא נענה, ואיש אינו יכול לומר היום אם פתחה אחד מהם והלכה או שמעולם לא קיבלה אף אחד — שתי בעיות שונות עם תיקונים שונים. ספירת סבבים כתצוגה v_production_review_rounds ולא כעמודת מונה: המקור הוא client_review_links, שורה לסבב, אימיוטבילית אחרי התשובה, append-only — בדיוק המצב שבו תצוגה מנצחת מונה מנורמל, כי מונה דורש טריגר וטריגר-מונה סוטה, ואילו כאן הספירה היא השורות עצמן. ההפרדה בין revision_rounds ל-total_rounds מהותית ולא קישוטית: הסבב המאשר גם הוא סבב, ומה שהתמחור צריך הוא כמה פעמים העבודה נעשתה שוב. security_invoker=on בעקבות 0035 — בלעדיו התצוגה רצה בהרשאות הבעלים ומוסרת לכל קורא את הטבלה כולה, ועוקפת בשקט את policy can_view_stages של 0029:51; איתו הלוח קורא אותה בקליינט המשתמש והקיר עומד. לא הוענקה ל-anon: 0068 שללה מ-anon כל הרשאה בסכימה אחרי אימות שאין ולו קריאת PostgREST אחת בתפקיד הזה, ותצוגה חדשה לא תהיה החריג שפותח מחדש (0035 קדמה להחלטה והעניקה ל-anon — שריד, לא תקדים). אינדקס חלקי client_review_links_responded_idx על production_id where responded_at is not null, כי לינק שלא נענה אינו סבב והתצוגה לעולם לא מסתכלת עליו. גארד סדר הפוך במכוון: 0071 דורשת ש-0068 הוחלה ומסרבת לרוץ אם 0070 כבר בפנקס. 0068 שמרה במפורש את 0069 (שלילת DML) ואת 0070 (הסתרת price_override, "דורשת מניית 43 עמודות"), והמניה הזו היא הסכנה — 0070 תשלול SELECT ברמת טבלה על productions ותעניק מחדש עמודה-עמודה, ושלוש העמודות שנוספות כאן לא יהיו ברשימה שנכתבה לפני שהן קיימות. זהו בדיוק הכישלון ש-0068:64 מזהירה ממנו: עמודה שנשכחה אינה מכריזה על עצמה, היא מרונדרת ככרטיס ריק בטלפון של מישהו. מי שנתקל בחריגה הזו לא ימחק את הגארד אלא יוסיף את שלוש העמודות לרשימת הגרנט של 0070. חשיפה מוצהרת ולא מכוסה כאן, באישור הבעלים ולא כהשמטה: guard_production_stage_columns (0010→0040→0067) לא הורחבה לעמודות ה-ack, כי needs_attention עצמה מעולם לא הייתה בה — כל משתמש מאומת יכול לכבות אותה דרך PostgREST ישירות היום, עם can_edit_stages או בלעדיו, כי ה-RLS על productions הוא הקיר היחיד והוא מתיר את העדכון. עמודות ה-ack יורשות בדיוק את החשיפה הזו, לא יותר, ואין כאן רגרסיה; הקיר ברמת האפליקציה (can_edit_stages בראוט ה-ack) אמיתי לכל מי שעובר דרך המערכת. הרחבת השומר לשלוש העמודות וגם ל-needs_attention היא המשך מומלץ והיא בטוחה: can_edit_stages() מחזירה NULL תחת service role (0002:42-45, אין שורת profiles ל-auth.uid ריק), not NULL הוא NULL, ו-if NULL אינו מצית — ולכן איפוס ה-service-role של applyResponse היה עובר דרך שומר מורחב בלי להיחסם. הושמטה כאן רק משום שנגיעה בפונקציית שומר משותפת במיגרציה שדבר עדיין לא קורא היא שינוי בלי בדיקה שתתפוס אותו. לא נוספו: אילוץ שקושר את review_ack_at ל-review_ack_link_id (0072 כותבת ack עם actor ריק כי מיגרציה עשתה זאת ולא אדם, ולהערה שהודלקה בראוט הידני אין סבב להצביע עליו — שתי צורות לגיטימיות), ובדיקה שה-link שייך לאותה הפקה (טענה חוצת-שורות שהראוט עושה ואילוץ לא יכול). אימות בתוך אותה טרנזקציה: שש העמודות קיימות, האינדקס קיים, לתצוגה יש security_invoker בפועל ולא רק בהצהרה, התצוגה מסכימה עם הטבלה שהיא מסכמת בשתי מדידות בלי מספרים קשיחים, ואף הפקה אינה נושאת ack מראש; canary לקריאה ולכתיבה על productions, לקריאה על client_review_links ועל התצוגה, ולכך ש-anon לא קיבל דבר. מה שההרצה הראשונה גילתה (3.9.26): הניסיון הראשון נעצר על ה-canary של עצמו — anon החזיק SELECT על תצוגה בת שלוש הצהרות, בקובץ שאינו נוקב ב-anon מחוץ לבדיקה הזו. 0068 הצהירה בתוך הטרנזקציה שלה, והיא קומיטה, שאין ל-anon דבר על אף טבלה או תצוגה בסכימה (0068:298-306). שתי העובדות נכונות, ויחד הן מזהות את המנגנון: ההרשאה הוצמדה ברגע ה-CREATE על ידי השרת, והדבר היחיד ב-PostgreSQL שעושה זאת בלי GRANT מפורש הוא pg_default_acl. אומת בשאילתה: בסכימה public יש רשומות ברירת-מחדל לשני תפקידים מעניקים — postgres ו-supabase_admin — בשלושת סוגי האובייקטים (tables, sequences, functions), שמעניקות arwdDxtm ל-anon ול-authenticated בשמם המפורש. הלקח גדול מהקובץ הזה: 0068 סגרה תצלום ולא מדיניות. revoke all on all tables in schema public (0068:180) נפרש בזמן הביצוע על האובייקטים שקיימים אז ואינו אומר דבר על הבא בתור, ולכן הסכימה נפתחה מחדש ברגע שמישהו יצר אובייקט — וזה קרה כאן, יומיים אחרי. 0069 מסירה את המדיניות; שלב 5ב כאן מגן על הקובץ הזה בלי תלות בה, ונשאר גם אחרי 0069 — מיגרציה שנכונה רק משום שברירת מחדל גלובלית במקרה תקינה היא מיגרציה שנשברת בשקט ביום שבו היא לא, וזה בדיוק הכשל שמתוקן כאן. שלב 5ב שולל את כל ההרשאות על התצוגה מ-public, מ-anon ומ-authenticated ואז מעניק SELECT מחדש ל-authenticated ול-service_role: from public נכלל אף שהאבחון הראה גרנטים בשם ולא PUBLIC, כי שלילה שמכסה גם את הצורה שלא נמצאה אינה עולה דבר ומייתרת את הצורך לצדוק; ו-authenticated נשלל ומוענק מחדש במכוון, כי ברירת המחדל מעניקה לו ALL כולל INSERT/UPDATE/DELETE — על תצוגה מצרפית הם ממילא אינם ניתנים לביצוע, ו"ממילא לא עובד" היא בדיוק ההנמקה שמשאירה ACL מרושל. service_role נשאר כפי שהפלטפורמה קובעת, כמו בכל טבלה אחרת בסכימה. נוסף canary שני שמאמת שאין ל-authenticated INSERT על התצוגה — הוכחה ששלב 5ב רץ כפי שנכתב ולא במקרה. הכלל שנקבע מכאן ואילך: מיגרציה שיוצרת אובייקט נושא-ACL (טבלה, תצוגה, סדרה, פונקציה) חייבת להצהיר על הרשאותיו במפורש וגם לאמת אותן לפני שהיא כותבת את שורת הפנקס — יצירה אינה פעולה ניטרלית בסכימה הזו. אפס DELETE, אפס שינוי נתונים, אפס שורה שנגעה.');

  raise notice '0071 הוחלה. התצוגה מסכמת % הפקות ובהן % סבבי תיקונים. הצעד הבא: 0072 (תיקון מלי), ואחריו database.types.ts — ורק אז הלוגיקה.',
               v_rows_view, v_rev_view;

end
$mig$;
