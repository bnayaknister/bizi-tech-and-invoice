-- 0078 — the carry-forward markers: which round this material came from
--
-- WHAT THIS IS FOR. 0076 bound the transcript and the separate audio file to
-- the ROUND rather than to the production, and stated the cost in the same
-- breath: on a second round the episode's video arrives through the sticky
-- client_review_items row while the transcript does not arrive at all. The
-- closing step is a CARRY-FORWARD — createReviewLink copies last round's
-- transcript and audio onto the new round — and 0076 committed to making it
-- EXPLICIT rather than sticky: copied forward with a visible mark the
-- technician can see and correct, never invisible inheritance.
--
-- This migration is the mark. Two columns, both foreign keys to
-- client_review_links(id):
--
--   client_review_transcripts.carried_from_link_id
--   client_review_links.audio_carried_from
--
-- SCOPE: schema only. NOTHING writes them — the carry-forward inside
-- createReviewLink is the next step and a separate one, and the drawer badge is
-- the step after that. No existing column is touched, no row is written, no
-- behaviour changes.
--
-- ---------------------------------------------------------------------------
-- ⚠️ WHY TWO MARKERS AND NOT ONE — the reason, and the evidence for it
--
-- A single shared column on client_review_links ("this round's materials were
-- carried from round X") is the obvious economy and it is wrong, because the
-- two materials are EDITED INDEPENDENTLY and a shared marker can only describe
-- one of them at a time.
--
-- The failure, concretely: the technician keeps the carried transcript and
-- replaces the carried audio with a fresh file. The audio is no longer carried,
-- so the marker must be cleared — and clearing it silently un-marks the
-- TRANSCRIPT, which is still carried and now says so nowhere. The badge
-- disappears from a screen where its whole purpose is to make the technician
-- look twice at text that may describe a previous cut. Same class of silent
-- failure this codebase closed three times today, and the same one 0076's own
-- reasoning rests on: a transcript that follows a new cut does not become
-- stale, it becomes WRONG.
--
-- The independence is not hypothetical — it is the model
-- review-materials/route.ts was deliberately built on, and its own comment says
-- so at [:104-108]:
--
--     "`undefined` and `null` are different instructions here and the
--      difference is the whole editing model: absent = leave alone, null =
--      clear. A single `?? null` anywhere in this route would turn 'I only
--      changed the audio' into 'delete the transcript'."
--
-- The route then writes the two through two independent branches — `wantsAudio`
-- updates client_review_links.audio_link [:194-199], `wantsTranscript` upserts
-- or deletes the transcript row [:208-227] — and neither can reach the other. A
-- shared marker would be the single piece of state that couples them again,
-- reintroducing exactly the coupling the route was written to prevent.
--
-- THE PRINCIPLE, which is what makes this two columns rather than merely not
-- one: EACH MARKER LIVES EXACTLY AS LONG AS THE THING IT DESCRIBES.
--   · the audio's marker sits beside audio_link on client_review_links, so
--     clearing the audio and clearing its provenance are one row's business
--   · the transcript's marker sits INSIDE the transcript row, so it dies with
--     the transcript automatically — both through 0076's link_id CASCADE and
--     through the route's explicit `.delete().eq("link_id", …)` [:226]. A
--     marker parked on client_review_links would OUTLIVE the transcript it
--     describes and keep claiming provenance for a row that no longer exists.
--
-- ---------------------------------------------------------------------------
-- WHY A FOREIGN KEY AND NOT A BOOLEAN
--
-- A boolean answers "is this carried". The drawer has to answer "נגרר מסבב
-- 3.9", which is a different question and the one a technician can act on: it
-- names the round to go and compare against. The id is the only value that
-- answers both — `is not null` is the boolean, and the join is the date.
--
-- It is also the value that survives being right later. A boolean is a claim
-- nothing can check; an id can be joined back to the round and disproved.
--
-- ---------------------------------------------------------------------------
-- ⚠️ ON DELETE — DECIDED ON MEASUREMENT, NOT ON PREFERENCE
--
-- The question the brief asked: can the round a material was carried FROM be
-- deleted? Measured on the code, 2026-09-10:
--
--   THE APPLICATION NEVER DELETES A REVIEW LINK. Not once. There is no
--   `.delete()` against client_review_links anywhere in src/. The lifecycle is
--   `superseded = true` (links.ts) — a round is retired, never removed, which
--   is what lets 0072 reconstruct a nine-week sequence of rounds from the data
--   months after the fact.
--
--   THE ONLY DELETE PATH IN THE REPOSITORY IS TEST CLEANUP, and its shape is
--   what decides this: test_client_review_link.py:172, test_review_items_e2e
--   .py:170 and test_upsells_e2e.py:170 each issue
--   `DELETE client_review_links?production_id=eq.<id>` — every round of a test
--   production, in ONE statement. 17 productions in this database carry more
--   than one round, so a carried marker pointing at a sibling round inside the
--   deleted set is the ordinary case, not the corner.
--
-- Against that, the three options are not close:
--
--   CASCADE is wrong by MEANING, and it is the dangerous one. carried_from is a
--   CITATION, not ownership: round 2's transcript belongs to round 2 — that is
--   link_id, which 0076 already made CASCADE — and the citation merely says
--   where its text came from. Cascading would delete round 2's transcript, an
--   hour of real content the client is still being shown, because round 1 was
--   removed. Deleting a footnote must never delete the page.
--
--   RESTRICT turns provenance into a LOCK. It would forbid removing any round
--   another round ever cited, and it fires immediately — so it would break the
--   three cleanup scripts above even though they delete the citing row in the
--   same statement. A test suite that cannot clean up after itself leaves rows
--   in a live database, which is the failure the cleanup rule exists to prevent
--   — so this is not a theoretical cost.
--
--   SET NULL is the honest degradation and the choice here. The content
--   survives, and the row stops claiming a provenance it can no longer prove.
--   "This was carried from a round that no longer exists" and "we no longer
--   know which round this came from" are the same sentence, and NULL says it
--   correctly. The badge disappears; the transcript does not.
--
-- Both columns are nullable, which SET NULL requires and which is right on its
-- own terms: NOT carried is the normal state of a first round.
--
-- ---------------------------------------------------------------------------
-- TWO WALLS, AND ONE THAT IS DELIBERATELY NOT BUILT
--
-- Beyond the brief, reported as additions rather than smuggled in — the
-- precedent is 0067, which extended guard_production_stage_columns past the
-- owner's list and said so.
--
--   1. NO SELF-CITATION (CHECK, free). A round carried from itself is not a
--      degenerate case to interpret, it is a bug that would render as
--      "נגרר מסבב <this very round>". Two CHECK constraints, no subquery, no
--      trigger.
--
--   2. SAME PRODUCTION (trigger). A bare FK lets a marker point at ANY round in
--      the table, including another show's. There is no reading of that which
--      is legitimate — and the consequence is not cosmetic, because the badge
--      would send a technician to compare against a different client's episode.
--      The route already scopes its own lookups to the production
--      ([review-materials:59-65], and again at [:132-137] with the comment
--      "link_id is client-supplied, and without the production filter above it
--      would address any round in the table"); this makes the same rule a wall
--      instead of a habit, before the carry-forward code that must obey it is
--      written. Cheap: the trigger returns immediately when the marker is null,
--      which is every row today and most rows forever.
--
--   3. NOT BUILT — "the source round must be EARLIER". It is true of every
--      legitimate carry, and it is still not enforced here, because its failure
--      mode is worse than the bug it catches: it would be a wall whose only
--      realistic trigger is two rounds minted close together in time, i.e. it
--      would refuse a legitimate carry over clock ordering. The carry-forward
--      picks the previous round BY CONSTRUCTION — it reads the most recent
--      superseded round of the same production — so ordering is a property of
--      the caller, not a thing this schema has to police. Stated so the absence
--      reads as a decision rather than an oversight.
--
-- ---------------------------------------------------------------------------
-- ⚠️ NOT BORN EMPTY — 0076's canary cannot be copied
--
-- 0076 asserted client_review_transcripts held zero rows, and that assertion was
-- true when it ran on 2026-09-10 08:40. It is no longer: the routes, the drawer
-- tab and the public page shipped later the same day (2005595), and the table
-- holds ONE row — a 'pasted' transcript written 09:21 onto a round of
-- production 661c89a0, which carries three rounds. So this migration checks the
-- thing that is actually being asserted: the two NEW COLUMNS are born NULL on
-- every existing row. There is no backfill and nothing to carry backwards —
-- carry-forward is a property of a round at MINT time, and every round that
-- exists was already minted without it. Inventing provenance for 94 historical
-- rounds would be writing a fact nobody stated.
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS — STATED, NOT ASSUMED (rule 49)
--
-- Measured on this database, 2026-09-10:
--   has_table_privilege('authenticated','public.client_review_links','SELECT')       = TRUE
--   has_table_privilege('anon',         'public.client_review_links','SELECT')       = FALSE
--   has_table_privilege('authenticated','public.client_review_transcripts','SELECT') = FALSE
--
-- The two new columns therefore inherit OPPOSITE and CORRECT defaults, and
-- neither needs a GRANT:
--
--   · audio_carried_from is born readable to `authenticated`, because the
--     table-level grant on client_review_links stands and covers every column.
--     That is what the drawer needs — the badge is rendered for a user with
--     can_edit_stages — and a link id is the same class of fact as
--     production_id, which that role already reads on this table.
--
--   · carried_from_link_id is born UNREADABLE, because 0076 revoked
--     client_review_transcripts outright from public, anon and authenticated,
--     and a table with no relacl entry for a role grants that role nothing on a
--     column added later either. The drawer reaches it the way it reaches the
--     transcript itself: through review-materials' GET, which checks
--     can_edit_stages explicitly and reads via the service role.
--
-- THE HALF OF RULE 49 THAT BITES SILENTLY, and the reason this is written down
-- instead of inferred: on client_review_links a column-level REVOKE would be a
-- NO-OP. `revoke select (audio_carried_from) … from authenticated` removes only
-- column-level entries in pg_attribute.attacl; while `authenticated=r` sits in
-- relacl, has_column_privilege keeps returning true. The statement runs clean,
-- raises nothing, and changes nothing. That is how 0031 left production_addons'
-- prices readable to every technician, and why 0068 had to revoke the whole
-- table to undo it — a step far wider than 0031 ever intended. The shape that
-- works is the opposite order and it is the one 0076 already used on the
-- transcript table: revoke the table, then enumerate what is allowed.
--
-- No GRANT and no REVOKE is issued here. The canary asserts BOTH inherited
-- defaults rather than trusting either — the anon direction, which killed
-- 0071's first run when a privilege nobody granted was already there, and the
-- authenticated direction, which announces itself as a blank screen weeks later
-- (0055) and never as an error.
--
-- Row-level access is unchanged: client_review_links_select still gates on
-- can_view_stages(), and client_review_transcripts still has RLS on with ZERO
-- policies, service-role only. Write access is unchanged: no policy is added
-- and `authenticated` holds no UPDATE on either column.
--
-- ZERO DELETE. ZERO backfill. ZERO existing column touched. Two columns, two
-- CHECKs, two triggers.

do $mig$
declare
  v_links_cols   int;
  v_tr_cols      int;
  v_links_rows   bigint;
  v_tr_rows      bigint;
  v_carried_tr   bigint;
  v_carried_au   bigint;

  v_fk_tr_del    "char";
  v_fk_au_del    "char";
  v_fk_owner_del "char";

  v_anon_l       boolean;
  v_anon_t       boolean;
  v_anon_col     boolean;
  v_auth_audio   boolean;
  v_auth_tr      boolean;
  v_auth_write   boolean;
  v_rls_l        boolean;
  v_rls_t        boolean;
  v_policy_l     int;
  v_policy_t     int;
  v_trg          int;
begin
  -- ---------------------------------------------------------------------
  -- 0. GUARDS.
  -- ---------------------------------------------------------------------

  -- 0a. not re-runnable, and it says so.
  if exists (select 1 from public.schema_ledger where version = '0078') then
    raise exception '0078 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. the ledger is the sequence, not the filenames (migrations/README.md).
  --     0077 was applied 2026-09-10 20:22 UTC and this is the next number.
  if not exists (select 1 from public.schema_ledger where version = '0077') then
    raise exception '0078: 0077 אינה בפנקס — המספור נגזר מפנקס אחר, עצור ובדוק';
  end if;

  -- 0c. everything here hangs off what 0076 built. Without it there is no
  --     transcript table to add a column to, and audio_link — the column
  --     audio_carried_from exists to describe — is not there either.
  if not exists (select 1 from public.schema_ledger where version = '0076') then
    raise exception '0078: 0076 טרם הוחלה — אין טבלת תמלול ואין audio_link לתאר';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. the two markers.
  -- ---------------------------------------------------------------------

  -- SET NULL on both: the citation may lose its target, but the material it
  -- describes must survive losing it. See the ON DELETE section in the header.
  alter table public.client_review_transcripts
    add column if not exists carried_from_link_id uuid
      references public.client_review_links(id) on delete set null;

  alter table public.client_review_links
    add column if not exists audio_carried_from uuid
      references public.client_review_links(id) on delete set null;

  -- ---------------------------------------------------------------------
  -- 2. wall 1 — no self-citation. A row that cites itself would render as
  --    "נגרר מסבב <this very round>", which is not a state to interpret.
  -- ---------------------------------------------------------------------
  alter table public.client_review_transcripts
    drop constraint if exists client_review_transcripts_carry_not_self;
  alter table public.client_review_transcripts
    add constraint client_review_transcripts_carry_not_self
      check (carried_from_link_id is null or carried_from_link_id <> link_id);

  alter table public.client_review_links
    drop constraint if exists client_review_links_audio_carry_not_self;
  alter table public.client_review_links
    add constraint client_review_links_audio_carry_not_self
      check (audio_carried_from is null or audio_carried_from <> id);

  -- ---------------------------------------------------------------------
  -- 3. wall 2 — the source round must belong to the SAME production.
  --    A CHECK cannot ask this (it needs a lookup), so it is a trigger. Both
  --    return immediately when the marker is null, which is every row today.
  -- ---------------------------------------------------------------------
  create or replace function public.guard_transcript_carry_same_production()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  declare
    v_own uuid;
    v_src uuid;
  begin
    if new.carried_from_link_id is null then return new; end if;

    select production_id into v_own from public.client_review_links where id = new.link_id;
    select production_id into v_src from public.client_review_links where id = new.carried_from_link_id;

    if v_src is null then
      raise exception 'הסבב שממנו נגרר התמלול אינו קיים';
    end if;
    if v_src is distinct from v_own then
      raise exception 'תמלול יכול להיגרר רק מסבב של אותה הפקה (מקור: %, יעד: %)', v_src, v_own;
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_transcript_carry_same_production on public.client_review_transcripts;
  create trigger trg_transcript_carry_same_production
    before insert or update of carried_from_link_id, link_id
    on public.client_review_transcripts
    for each row execute function public.guard_transcript_carry_same_production();

  create or replace function public.guard_audio_carry_same_production()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  declare
    v_src uuid;
  begin
    if new.audio_carried_from is null then return new; end if;

    select production_id into v_src from public.client_review_links where id = new.audio_carried_from;

    if v_src is null then
      raise exception 'הסבב שממנו נגרר האודיו אינו קיים';
    end if;
    if v_src is distinct from new.production_id then
      raise exception 'אודיו יכול להיגרר רק מסבב של אותה הפקה (מקור: %, יעד: %)', v_src, new.production_id;
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_audio_carry_same_production on public.client_review_links;
  create trigger trg_audio_carry_same_production
    before insert or update of audio_carried_from, production_id
    on public.client_review_links
    for each row execute function public.guard_audio_carry_same_production();

  -- ---------------------------------------------------------------------
  -- 4. NO GRANT AND NO REVOKE — see the permissions section in the header.
  --    audio_carried_from is covered by the standing table grant on
  --    client_review_links; carried_from_link_id is born unreadable because
  --    0076 revoked its table outright. A column REVOKE on the links table
  --    would be a no-op (rule 49). The canary proves both instead of
  --    trusting either.
  -- ---------------------------------------------------------------------

  -- ---------------------------------------------------------------------
  -- 5. CANARY. All of it before the ledger row, so a failure rolls the whole
  --    migration back rather than recording a half-applied schema.
  -- ---------------------------------------------------------------------

  -- 5a. the ON DELETE actions actually landed. This is the decision of the
  --     file, and 'n' = SET NULL in pg_constraint.confdeltype. Asserting the
  --     FK merely EXISTS would pass with cascade — the one outcome that
  --     silently deletes a client's transcript.
  select confdeltype into v_fk_tr_del from pg_constraint
   where conrelid = 'public.client_review_transcripts'::regclass
     and contype = 'f'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.client_review_transcripts'::regclass
                            and attname = 'carried_from_link_id')];
  if v_fk_tr_del is distinct from 'n' then
    raise exception '0078 canary: ON DELETE של carried_from_link_id הוא % ולא SET NULL — cascade היה מוחק תמלול חי', coalesce(v_fk_tr_del::text, 'חסר');
  end if;

  select confdeltype into v_fk_au_del from pg_constraint
   where conrelid = 'public.client_review_links'::regclass
     and contype = 'f'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.client_review_links'::regclass
                            and attname = 'audio_carried_from')];
  if v_fk_au_del is distinct from 'n' then
    raise exception '0078 canary: ON DELETE של audio_carried_from הוא % ולא SET NULL', coalesce(v_fk_au_del::text, 'חסר');
  end if;

  -- 5b. and 0076's OWNERSHIP fk is still CASCADE ('c'). The two live on the
  --     same table and mean opposite things; a migration that confused them
  --     would show up here rather than the first time a round is deleted.
  select confdeltype into v_fk_owner_del from pg_constraint
   where conrelid = 'public.client_review_transcripts'::regclass
     and contype = 'f'
     and conkey = array[(select attnum from pg_attribute
                          where attrelid = 'public.client_review_transcripts'::regclass
                            and attname = 'link_id')];
  if v_fk_owner_del is distinct from 'c' then
    raise exception '0078 canary: ON DELETE של link_id (הבעלות מ-0076) אינו CASCADE — נגעו בעמודה הלא נכונה';
  end if;

  -- 5c. BORN NULL. Not "born empty" — the transcript table already holds a
  --     row (2005595 shipped the routes), and this is the assertion that
  --     actually matters: no backfill ran and nothing invented provenance.
  select count(*) into v_links_rows from public.client_review_links;
  select count(*) into v_tr_rows    from public.client_review_transcripts;
  select count(*) into v_carried_tr from public.client_review_transcripts
   where carried_from_link_id is not null;
  select count(*) into v_carried_au from public.client_review_links
   where audio_carried_from is not null;

  if v_carried_tr <> 0 or v_carried_au <> 0 then
    raise exception '0078 canary: % תמלולים ו-% לינקים כבר נושאים סמן גרירה — המיגרציה לא כתבה אותם, עצור וברר', v_carried_tr, v_carried_au;
  end if;

  -- 5d. the walls exist and are enforceable.
  select count(*) into v_trg from pg_trigger
   where not tgisinternal
     and tgname in ('trg_transcript_carry_same_production', 'trg_audio_carry_same_production');
  if v_trg <> 2 then
    raise exception '0078 canary: % טריגרים של גארד הגרירה במקום 2', v_trg;
  end if;

  if not exists (select 1 from pg_constraint
                  where conname = 'client_review_transcripts_carry_not_self')
     or not exists (select 1 from pg_constraint
                     where conname = 'client_review_links_audio_carry_not_self') then
    raise exception '0078 canary: אילוץ אי-הציטוט-העצמי חסר על אחת הטבלאות';
  end if;

  -- 5e. anon gets nothing, at table level, on either table.
  select has_table_privilege('anon','public.client_review_links','SELECT'),
         has_table_privilege('anon','public.client_review_transcripts','SELECT')
    into v_anon_l, v_anon_t;
  if v_anon_l or v_anon_t then
    raise exception '0078 canary: ל-anon יש SELECT על אחת מטבלאות הביקורת — בדוק pg_default_acl (0069)';
  end if;

  -- 5f. ...and at column level, which a table-level false does not imply.
  select has_column_privilege('anon','public.client_review_links','audio_carried_from','SELECT')
      or has_column_privilege('anon','public.client_review_transcripts','carried_from_link_id','SELECT')
    into v_anon_col;
  if coalesce(v_anon_col,false) then
    raise exception '0078 canary: ל-anon יש הרשאה עמודתית על אחד מסמני הגרירה';
  end if;

  -- 5g. authenticated MUST read the audio marker — the drawer badge is
  --     rendered for a can_edit_stages user, and a grant nobody noticed was
  --     missing announces itself as a blank screen weeks later (0055).
  select has_column_privilege('authenticated','public.client_review_links','audio_carried_from','SELECT')
    into v_auth_audio;
  if not v_auth_audio then
    raise exception '0078 canary: authenticated אינו קורא את audio_carried_from — גרנט הטבלה לא כיסה אותה, התג לא יירנדר';
  end if;

  -- 5h. ...and MUST NOT reach the transcript marker, because 0076 closed that
  --     table outright and a column added later inherits nothing.
  select has_column_privilege('authenticated','public.client_review_transcripts','carried_from_link_id','SELECT')
      or has_table_privilege('authenticated','public.client_review_transcripts','SELECT')
    into v_auth_tr;
  if coalesce(v_auth_tr,false) then
    raise exception '0078 canary: authenticated קורא את carried_from_link_id — ה-revoke של 0076 לא כיסה עמודה חדשה';
  end if;

  -- 5i. no write grant on either marker. Both are written server-side only.
  select has_column_privilege('authenticated','public.client_review_links','audio_carried_from','UPDATE')
      or has_column_privilege('authenticated','public.client_review_transcripts','carried_from_link_id','UPDATE')
      or has_table_privilege('authenticated','public.client_review_transcripts','INSERT')
    into v_auth_write;
  if v_auth_write then
    raise exception '0078 canary: ל-authenticated יש הרשאת כתיבה על סמן גרירה — הגרירה היא server-only דרך service role';
  end if;

  -- 5j. RLS untouched on both; the links read gate still there; the
  --     transcript table still deliberately policy-free.
  select relrowsecurity into v_rls_l from pg_class where oid = 'public.client_review_links'::regclass;
  select relrowsecurity into v_rls_t from pg_class where oid = 'public.client_review_transcripts'::regclass;
  if not (v_rls_l and v_rls_t) then
    raise exception '0078 canary: RLS כבוי על אחת מטבלאות הביקורת';
  end if;

  select count(*) into v_policy_l from pg_policies
   where tablename='client_review_links' and policyname='client_review_links_select';
  if v_policy_l <> 1 then
    raise exception '0078 canary: client_review_links_select חסר — שער can_view_stages נעלם';
  end if;

  select count(*) into v_policy_t from pg_policies where tablename='client_review_transcripts';
  if v_policy_t <> 0 then
    raise exception '0078 canary: נוצר policy על client_review_transcripts — הטבלה אמורה להישאר service-role בלבד';
  end if;

  -- 5k. structure, as literals: 20 -> 21 on the links, 6 -> 7 on the
  --     transcripts. A stray column added by something else surfaces here
  --     rather than on a screen.
  select count(*) into v_links_cols from information_schema.columns
   where table_schema='public' and table_name='client_review_links';
  if v_links_cols <> 21 then
    raise exception '0078: client_review_links נושאת % עמודות במקום 21', v_links_cols;
  end if;

  select count(*) into v_tr_cols from information_schema.columns
   where table_schema='public' and table_name='client_review_transcripts';
  if v_tr_cols <> 7 then
    raise exception '0078: client_review_transcripts נושאת % עמודות במקום 7', v_tr_cols;
  end if;

  raise notice '0078 OK — לינקים: % עמודות / % שורות · תמלולים: % עמודות / % שורות · אפס סמני גרירה בשתיהן · ON DELETE SET NULL על שניהם · 2 טריגרים',
    v_links_cols, v_links_rows, v_tr_cols, v_tr_rows;

  -- ---------------------------------------------------------------------
  -- 6. the ledger row, last.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0078', now(), 'bnaya',
    'סמני הגרירה — סכימה בלבד, אפס שינוי התנהגות: שום קוד עדיין לא כותב אותם, הגרירה עצמה ב-createReviewLink והתג בדרואר הם שני צעדים נפרדים אחרי זה, ואין באקפיל. שתי עמודות, שתיהן מפתח זר ל-client_review_links(id): client_review_transcripts.carried_from_link_id ו-client_review_links.audio_carried_from. הרקע: 0076 קשרה את התמלול ואת קובץ האודיו לסבב ולא להפקה, והצהירה על המחיר באותה נשימה — בסבב שני הווידאו מגיע דרך הפריט הדביק והתמלול אינו מגיע כלל — והתחייבה שהצעד הסוגר יהיה גרירה מפורשת עם סימון גלוי שהטכנאי רואה ויכול לתקן, ולא ירושה דביקה ובלתי נראית. המיגרציה הזאת היא הסימון. למה שני סמנים ולא אחד, וזו ההכרעה הנושאת: עמודה משותפת אחת על client_review_links היא החיסכון המתבקש והיא שגויה, כי שני החומרים נערכים בנפרד וסמן משותף יכול לתאר רק אחד מהם בכל רגע. הכשל הקונקרטי: הטכנאי משאיר את התמלול הנגרר ומחליף את האודיו הנגרר בקובץ חדש. האודיו כבר אינו נגרר ולכן הסמן חייב להתנקות — והניקוי הזה מסיר בשקט את הסימון מהתמלול, שעדיין נגרר ומעתה אינו אומר זאת בשום מקום. התג נעלם בדיוק מהמסך שכל תכליתו לגרום לטכנאי להסתכל פעמיים על טקסט שאולי מתאר עריכה קודמת. אותה מחלקת כשל שקט שנסגרה שלוש פעמים היום, ואותו נימוק ש-0076 עצמה נשענת עליו: תמלול שעוקב אחרי עריכה חדשה אינו מתיישן אלא הופך שגוי. האי-תלות אינה היפותטית אלא המודל ש-review-materials/route.ts נבנה עליו במכוון, וההערה שלו אומרת זאת בשורות 104-108 — undefined ו-null הן הוראות שונות, נעדר פירושו להשאיר כפי שהוא ו-null פירושו לנקות, ו-?? null אחד בראוט הזה היה הופך את שיניתי רק את האודיו ל-מחק את התמלול. הראוט כותב את השניים בשני ענפים בלתי תלויים — wantsAudio מעדכן את client_review_links.audio_link בשורות 194-199, ו-wantsTranscript עושה upsert או delete לשורת התמלול בשורות 208-227 — ואף אחד מהם אינו יכול להגיע לשני. סמן משותף היה פיסת המצב היחידה שמצמידה אותם מחדש ומחזירה בדיוק את הצימוד שהראוט נכתב כדי למנוע. העיקרון שהופך את זה לשתי עמודות ולא רק ללא-אחת: כל סמן חי בדיוק כל עוד הדבר שהוא מתאר. סמן האודיו יושב לצד audio_link על client_review_links, ולכן ניקוי האודיו וניקוי המקור שלו הם עניין של שורה אחת; סמן התמלול יושב בתוך שורת התמלול, ולכן הוא מת עם התמלול אוטומטית — גם דרך ה-CASCADE של link_id מ-0076 וגם דרך ה-delete המפורש של הראוט בשורה 226 — בעוד שסמן שהיה חונה על client_review_links היה שורד את התמלול שהוא מתאר וממשיך לטעון מקור לשורה שכבר אינה קיימת. למה מפתח זר ולא בוליאני: בוליאני עונה האם זה נגרר, והדרואר חייב לענות נגרר מסבב 3.9 — שאלה אחרת, וזו שהטכנאי יכול לפעול לפיה, כי היא נוקבת בסבב שאליו ילך להשוות. המזהה הוא הערך היחיד שעונה על שתיהן: is not null הוא הבוליאני וה-join הוא התאריך. הוא גם הערך שניתן להפריך — בוליאני הוא טענה שדבר אינו יכול לבדוק, ומזהה ניתן להצטרפות חזרה. ON DELETE הוכרע על מדידה ולא על העדפה. השאלה: האם הסבב שממנו נגרר עלול להימחק. נמדד על הקוד 10.9 — האפליקציה לעולם אינה מוחקת לינק ביקורת, אין ולו delete אחד על client_review_links בכל src, ומחזור החיים הוא superseded=true ב-links.ts: סבב נגנז ולא מוסר, וזה מה שאיפשר ל-0072 לשחזר רצף של תשעה שבועות של סבבים מהנתונים חודשים אחרי. מסלול המחיקה היחיד בריפו הוא ניקוי בדיקות, וצורתו היא שמכריעה: test_client_review_link.py:172, test_review_items_e2e.py:170 ו-test_upsells_e2e.py:170 מוציאים DELETE client_review_links?production_id=eq.X, כלומר כל הסבבים של הפקת בדיקה בהצהרה אחת — ו-17 הפקות במסד נושאות יותר מסבב אחד, כך שסמן שמצביע על סבב אח בתוך הקבוצה הנמחקת הוא המקרה הרגיל ולא הפינתי. מול זה שלוש האפשרויות אינן קרובות. CASCADE שגוי במשמעות והוא המסוכן: carried_from הוא ציטוט ולא בעלות — שורת התמלול שייכת לסבב שלה דרך link_id ש-0076 כבר עשתה CASCADE, והציטוט רק אומר מאיפה הגיע הטקסט — וקסקייד היה מוחק את התמלול של סבב 2, שעה של תוכן אמיתי שהלקוח עדיין רואה, משום שסבב 1 הוסר. מחיקת הערת שוליים לעולם לא תמחק את העמוד. RESTRICT הופך מקור ללולאת נעילה: הוא היה אוסר להסיר כל סבב שסבב אחר ציטט אי-פעם, והוא יורה מיד — ולכן היה שובר את שלושת סקריפטי הניקוי גם כשהם מוחקים את השורה המצטטת באותה הצהרה עצמה. מערך בדיקות שאינו יכול לנקות אחרי עצמו משאיר שורות במסד חי, וזה הכשל שכלל הניקוי קיים כדי למנוע, ולכן זו אינה עלות תיאורטית. SET NULL הוא ההידרדרות הכנה וזו הבחירה כאן: התוכן שורד, והשורה מפסיקה לטעון מקור שאינה יכולה עוד להוכיח — נגרר מסבב שכבר אינו קיים ו-לא ידוע עוד מאיזה סבב זה הגיע הם אותו משפט, ו-NULL אומר אותו נכון. התג נעלם, התמלול לא. שתי העמודות nullable, מה ש-SET NULL דורש וממילא נכון: לא-נגרר הוא המצב הרגיל של סבב ראשון. שני קירות מעבר לאפיון, מדווחים כתוספת ולא מוברחים, לפי תקדים 0067 שהרחיב את guard_production_stage_columns מעבר לרשימת הבעלים והצהיר על כך: ראשית, אילוץ CHECK בשתי הטבלאות שאוסר ציטוט עצמי — סבב שנגרר מעצמו אינו מקרה קצה לפרשנות אלא באג שהיה מרונדר כ-נגרר מסבב <הסבב הזה עצמו>, והבדיקה חינם ובלי תת-שאילתה. שנית, טריגר שדורש שסבב המקור יהיה של אותה הפקה: מפתח זר חשוף מתיר לסמן להצביע על כל סבב בטבלה כולל של תוכנית אחרת, אין לזה קריאה לגיטימית, וההשלכה אינה קוסמטית כי התג היה שולח טכנאי להשוות מול פרק של לקוח אחר. הראוט כבר מגביל את החיפושים שלו להפקה (שורות 59-65 ושוב 132-137 עם ההערה ש-link_id מגיע מהקליינט ובלי סינון ההפקה היה מכתובת כל סבב בטבלה), וזה הופך את אותו כלל לקיר במקום להרגל, לפני שנכתב קוד הגרירה שחייב לציית לו; הטריגר חוזר מיד כשהסמן ריק, וזה כל שורה היום ורוב השורות תמיד. מה שבמכוון לא נבנה: הדרישה שסבב המקור יהיה מוקדם יותר. היא נכונה בכל גרירה לגיטימית ובכל זאת אינה נאכפת, כי אופן הכשל שלה גרוע מהבאג שהיא תופסת — היא הייתה קיר שהטריגר הריאלי היחיד שלו הוא שני סבבים שהונפקו בסמיכות זמן, כלומר סירוב לגרירה לגיטימית על סמך סדר שעונים. הגרירה בוחרת את הסבב הקודם מעצם בנייתה, כי היא קוראת את הסבב הגנוז האחרון של אותה הפקה, ולכן הסדר הוא תכונה של הקורא ולא דבר שהסכימה צריכה לשטר. לא נולד ריק, ולכן ה-canary של 0076 אינו ניתן להעתקה: 0076 קבעה ש-client_review_transcripts מחזיקה אפס שורות וזה היה נכון כשהיא רצה ב-10.9 08:40, וזה כבר לא — הראוטים, הלשונית בדרואר והדף הציבורי עלו מאוחר יותר באותו יום (2005595), והטבלה מחזיקה שורה אחת: תמלול pasted שנכתב ב-09:21 על סבב של הפקה 661c89a0 שנושאת שלושה סבבים. לכן נבדק מה שבאמת נטען כאן — ששתי העמודות החדשות נולדות NULL בכל שורה קיימת. אין באקפיל ואין מה לגרור לאחור: גרירה היא תכונה של סבב ברגע ההנפקה, וכל סבב שקיים כבר הונפק בלעדיה, והמצאת מקור ל-94 סבבים היסטוריים הייתה כתיבת עובדה שאיש לא הצהיר עליה. ההרשאות מוצהרות לפי כלל 49, ושתי העמודות יורשות ברירות מחדל הפוכות ונכונות ואף אחת אינה זקוקה ל-GRANT: audio_carried_from נולדת קריאה ל-authenticated כי גרנט הטבלה על client_review_links עומד ומכסה כל עמודה, וזה מה שהדרואר צריך כי התג מרונדר למשתמש can_edit_stages, ומזהה סבב הוא מאותה מחלקה כמו production_id שהתפקיד הזה כבר קורא באותה טבלה; carried_from_link_id נולדת בלתי קריאה כי 0076 שללה את client_review_transcripts כליל מ-public, anon ו-authenticated, וטבלה בלי רשומת relacl לתפקיד אינה מעניקה לו דבר גם על עמודה שנוספת מאוחר יותר, והדרואר מגיע אליה כפי שהוא מגיע לתמלול עצמו — דרך ה-GET של review-materials שבודק can_edit_stages במפורש וקורא ב-service role. החצי של כלל 49 שמכה בשקט, וזו הסיבה שזה נכתב ולא הונח: על client_review_links שלילה עמודתית הייתה no-op — revoke select (audio_carried_from) מסיר רק רשומות ב-pg_attribute.attacl, וכל עוד authenticated=r יושב ב-relacl הפונקציה has_column_privilege ממשיכה להחזיר true, ההצהרה עוברת נקייה ולא משנה דבר; כך 0031 השאירה את המחירים ב-production_addons קריאים לכל טכנאי ולכן 0068 נאלצה לשלול את הטבלה כולה, צעד רחב בהרבה ממה ש-0031 התכוונה אליו. הצורה שעובדת היא הסדר ההפוך וזו שכבר ננקטה ב-0076 על טבלת התמלול: לשלול את הטבלה ואז למנות את המותר. לא הונפק GRANT ולא REVOKE, וה-canary מאמת את שתי ברירות המחדל במקום לסמוך על אחת מהן — כיוון ה-anon שהרג את ההרצה הראשונה של 0071 כשהרשאה שאיש לא העניק כבר הייתה שם, וכיוון ה-authenticated שמכריז על עצמו כמסך ריק שבועות אחר כך (0055) ולעולם לא כשגיאה. גישת שורה לא השתנתה: client_review_links_select עדיין can_view_stages ו-client_review_transcripts עדיין RLS דלוק עם אפס policies, service role בלבד; כתיבה לא השתנתה, לא נוסף policy ול-authenticated אין UPDATE על אף אחת מהעמודות. שלוש עשרה בדיקות canary לפני שורת הפנקס: confdeltype של שני המפתחות הזרים החדשים הוא n כלומר SET NULL — אימות ההכרעה עצמה, כי בדיקה שהמפתח הזר רק קיים הייתה עוברת גם עם cascade, התוצאה היחידה שמוחקת בשקט תמלול של לקוח; confdeltype של link_id מ-0076 הוא עדיין c, כי שני המפתחות יושבים על אותה טבלה ומשמעותם הפוכה ובלבול ביניהם היה מתגלה רק בפעם הראשונה שסבב נמחק; אפס סמני גרירה בשתי הטבלאות; שני הטריגרים קיימים ושני אילוצי אי-הציטוט-העצמי קיימים; anon אפס ברמת טבלה וברמת עמודה על שתי הטבלאות; authenticated קורא את audio_carried_from; authenticated אינו קורא את carried_from_link_id; אפס הרשאת כתיבה על שני הסמנים; RLS דלוק על שתיהן, client_review_links_select קיים ואפס policies על התמלולים; 21 עמודות בלינקים ו-7 בתמלולים. אפס DELETE, אפס באקפיל, אפס נגיעה בעמודה קיימת.');

  raise notice '0078 הוחלה ונרשמה. הסכימה מוכנה לגרירה; createReviewLink הוא הצעד הבא ואינו כלול כאן.';

end $mig$;
