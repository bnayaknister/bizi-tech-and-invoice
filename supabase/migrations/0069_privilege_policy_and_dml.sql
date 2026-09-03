-- 0069: the privilege POLICY, then the snapshot (0068 follow-up, 2026-09-04).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE GREW A PART A.
-- ---------------------------------------------------------------------------
-- 0068 reserved this number for one job: take DML away from `authenticated`
-- on the tables the user client never writes. That job is still here, as
-- PART B. Part A is new, and it is the more important half.
--
-- 0071 tried to create a view on 2026-09-03 and died on its own canary:
--
--     0071 canary: anon קיבל SELECT על התצוגה
--
-- anon held SELECT on an object three statements old, in a file that never
-- names anon outside that check. 0068 had asserted the opposite — inside its
-- own transaction, and it committed — that anon held nothing on any table or
-- view in this schema (0068:298-306). Both statements are true. Together they
-- prove the grant was attached at CREATE time by the server, and the only
-- mechanism in PostgreSQL that does that without an explicit GRANT is
-- pg_default_acl.
--
-- Queried, not assumed. Schema public carries default-privilege entries for
-- TWO granting roles — postgres and supabase_admin — over all three object
-- classes (tables, sequences, functions), granting arwdDxtm to anon and to
-- authenticated, by name rather than through PUBLIC.
--
-- ★ SO 0068 CLOSED A SNAPSHOT AND CALLED IT A CLOSURE.
--   `revoke all privileges on all tables in schema public from anon`
--   (0068:180) expands at execution time over the objects that exist at that
--   moment. It is a statement about the present tense. The schema re-opened
--   itself the first time anybody created an object, which happened two days
--   later, and the only reason we know is that the new migration carried a
--   canary. Without that check the view would have gone live readable by
--   anon and nothing would have said so.
--
-- ORDER IS LOAD-BEARING: policy first, snapshot second. Reversed, the window
-- between them is a window in which a concurrent CREATE inherits the old
-- default.
--
-- ---------------------------------------------------------------------------
-- PART A COVERS postgres ONLY. WHY THAT IS COVERAGE AND NOT A COMPROMISE.
-- ---------------------------------------------------------------------------
-- Attempt one of THIS file (2026-09-04) stopped on its own membership guard:
--
--     0069: ל-postgres אין חברות ב-supabase_admin
--
-- That message is a measurement, not a deduction — it was built from
-- current_user. So, established rather than assumed:
--   • the SQL Editor runs as `postgres`;
--   • `supabase_admin` exists (the existence check passed first);
--   • `postgres` is NOT a member of it.
--
-- ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin is therefore IMPOSSIBLE
-- from a project role. The manual is explicit: "target_role — The name of an
-- existing role OF WHICH THE CURRENT ROLE IS A MEMBER." There is no phrasing
-- that gets around it; supabase_admin is platform infrastructure and a
-- project role is deliberately kept out of it.
--
-- ★ AND IT DOES NOT MATTER, FOR A REASON THAT IS EASY TO GET WRONG.
--   Default privileges are NOT a property of the schema. They are a property
--   of the CREATING ROLE: pg_default_acl is keyed on defaclrole, and a new
--   object draws only from the entry belonging to the role that created it.
--   The two entries never cross.
--
--     defaclrole = postgres        governs everything WE create — every
--                                  migration in this repo runs in the SQL
--                                  Editor, which is postgres (measured
--                                  above). This is the entry that granted
--                                  v_production_review_rounds to anon and
--                                  brought down 0071.
--     defaclrole = supabase_admin  governs what supabase_admin creates:
--                                  platform work. We create nothing in that
--                                  role and cannot.
--
--   So fixing postgres is complete coverage of our own creations.
--
-- ★ THAT PREMISE IS VERIFIED HERE, NOT ASSERTED. Narrowing to postgres and
--   then trusting that every object is postgres-owned would swap a guard for
--   an assumption — which is precisely how 0068 produced this incident. The
--   ownership guard below enumerates every relation and every function in
--   public and refuses to run, WITH THE NAMES, if any of them is owned by a
--   role whose defaults this migration does not fix. If that fires, the
--   premise is false and a human decides; it does not get discovered later
--   as an open object.
--
--   Objects belonging to an EXTENSION are excluded from that guard (pg_depend
--   deptype='e'). They are not created by our migrations, their ownership is
--   the platform's business, and failing on them would block this file for a
--   reason it has no power to fix. Five extensions are installed and none is
--   expected to place objects in public; the carve-out exists so that a
--   future one cannot wedge the migration.
--
-- ---------------------------------------------------------------------------
-- ★ THE RESIDUAL RISK, STATED PLAINLY AND NOT MITIGATED HERE.
-- ---------------------------------------------------------------------------
--     supabase_admin's default privileges in schema public REMAIN IN PLACE.
--     They grant arwdDxtm to anon on every object that role creates, and no
--     project role can revoke them. If Supabase ever creates an object in our
--     public schema, it is born readable by anon and 0069 will not stop it.
--
-- Three routes out were considered and none survives:
--   • an event trigger that scrubs every CREATE in public — requires
--     superuser, which we do not have;
--   • a nightly cron that finds and revokes — leaves a live exposure window
--     between creation and sweep, and builds new infrastructure for a case
--     that has never occurred;
--   • asking Supabase support to run the statement for a role in which we
--     create nothing — cost with no return.
--
-- ★ SO THE LAST WALL IS THE RULE 0071 ESTABLISHED, AND IT IS NOT REDUNDANT
--   WITH THIS FILE — it is the only thing covering the part this file cannot
--   reach:
--
--       A migration that creates an ACL-bearing object (table, view,
--       sequence, function) must DECLARE that object's privileges explicitly
--       AND ASSERT them before it writes its ledger row. Creation is not a
--       neutral act in this schema.
--
--   That rule is what caught this entire incident, before anyone knew
--   pg_default_acl was involved. 0071:5b and its two canaries are the
--   worked example. Part A removes the common case; the rule catches
--   everything else, including anything supabase_admin ever does.
--
-- ---------------------------------------------------------------------------
-- PART A — SCOPE, AND WHY THE PLATFORM IS NOT AT RISK.
-- ---------------------------------------------------------------------------
-- Every statement in part A is `IN SCHEMA public`. ALTER DEFAULT PRIVILEGES
-- is scoped to (granting role, schema, object class) and cannot reach outside
-- the schema it names. Supabase's own machinery lives in OTHER schemas —
-- auth, storage, realtime, graphql, graphql_public, extensions, vault,
-- supabase_migrations — and none is touched here, by construction rather
-- than by care. Re-verified in src/: the browser client is imported by four
-- files (login, welcome, reset-password, SignOutButton) and every one of them
-- touches GoTrue only, so no PostgREST call anywhere runs as anon.
--
-- ---------------------------------------------------------------------------
-- PART A — WHAT anon LOSES, AND WHAT authenticated LOSES.
-- ---------------------------------------------------------------------------
-- anon: EVERYTHING, on all three classes. It has no legitimate use in this
-- system — the public review page /r/[token] and its respond route both run
-- on the service role, which is why they are unaffected. USAGE on the schema
-- is not a default privilege and is untouched, exactly as 0068 decided:
-- anonymous requests keep failing loudly (42501) rather than silently.
--
-- authenticated: the FOUR privileges, not all of them.
--
--   REMOVED   TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — precisely the four
--             0068 stripped from every existing table (0068:193) and for the
--             same reasons: TRUNCATE is DELETE with no RLS filter and no
--             trigger pass, REFERENCES lets a role point a foreign key at our
--             rows, TRIGGER lets it attach code to them, MAINTAIN (PG17)
--             allows VACUUM/ANALYZE. None appears anywhere in src/.
--   KEPT      INSERT, SELECT, UPDATE, DELETE.
--
-- ★ WHY NOT REVOKE ALL FROM authenticated TOO. Considered and rejected, and
--   the reason is written here so it is not re-litigated as an oversight.
--   Deny-by-default means every future table needs a remembered GRANT, and a
--   forgotten GRANT does not announce itself — it renders as a blank screen
--   on somebody's phone. Not hypothetical: 0055 had to add `grant select
--   (has_episode, reels_count)` and recorded in its own body that without it
--   the show card broke. 0068 met this exact fork, abolished 0022's
--   allow-list, and wrote the rule — fail toward visible, never toward
--   silently broken. Part A keeps that rule.
--
--   The trade, stated rather than discovered later: a new table in public is
--   born with DML for authenticated, and RLS remains the wall that decides
--   who sees which rows. That is already true of all 24 existing tables.
--
--   FUNCTIONS are deliberately untouched for authenticated. can_view_stages()
--   and its siblings are called from inside RLS policies, by the querying
--   role — revoking default EXECUTE would break the next helper function the
--   moment somebody forgets to grant it.
--
-- ---------------------------------------------------------------------------
-- PART A — THE CANARY, AND WHY A TEMP TABLE WOULD PROVE NOTHING.
-- ---------------------------------------------------------------------------
-- ★ The obvious probe — create a temp table, check it was not born open — is
--   WRONG here, and quietly so. A temp table is created in pg_temp_NNN, not
--   in public. Default privileges are per-schema, so an `IN SCHEMA public`
--   change cannot affect it: the probe would pass identically before and
--   after this migration and would certify nothing. (0068's four temp-table
--   probes were sound because they measured column-ACL behaviour, which is
--   schema-independent.)
--
-- So the canary creates a REAL table in public, measures it, and drops it
-- inside this transaction. It is also the behavioural proof of the postgres
-- narrowing: the probe is created BY postgres, so a probe that comes out
-- clean proves the postgres entry is the one that governs our creations.
--
-- ---------------------------------------------------------------------------
-- PART B — THE SNAPSHOT, AND THE ONE PLACE 0068'S MAP IS WRONG.
-- ---------------------------------------------------------------------------
-- 0068's ledger names eight objects "not touched by the user client"
-- (assistant_queries, client_review_items, documents, production_addons,
-- schema_ledger, stages_removed_snapshot, and the two v_ views) and three
-- "read only" (events, pending_documents, client_review_links).
--
-- ★ `documents` IS TOUCHED BY THE USER CLIENT, and revoking SELECT on it
--   would have broken a live screen. The hub passes the USER client to every
--   module metric (app/page.tsx:16, `createClient()`), and the documents
--   registry module reads the table with it — modules/doc-registry.ts:23 and
--   :30, counting unassigned documents for the "מסמכים" card. Its RLS policy
--   is can_view_money() (0027:55) and the module's own gate is can_view_money,
--   so the read is real, deliberate and permitted. `documents` therefore moves
--   from the revoke-everything group to the read-only group.
--
--   Every other entry re-verified rather than inherited, by resolving the
--   receiver of each `.from()` call across src/ and tracing which client it
--   is:
--     assistant_queries        2 sites, all service role
--     client_review_items     10 sites, all service role
--     production_addons       12 sites, all service role
--     schema_ledger            0 sites
--     stages_removed_snapshot  0 sites
--     v_doc_count              0 sites
--     v_prev_job               0 sites
--     documents               38 sites — 35 service role, 3 USER (see above)
--     events                 111 sites — 109 service role, 2 USER reads
--                                        (settings/page.tsx:18, the radar)
--     pending_documents       63 sites —  60 service role, 3 USER reads
--                                        (api/documents/pending/route.ts:24,
--                                         modules/documents/index.ts:16)
--     client_review_links      5 sites —   4 service role, 1 USER read
--                                        (entity route:223 — the Q7 live-links
--                                         box, deliberately on the user client
--                                         because the policy is can_view_stages)
--   The radar's reads look like user-client reads in the file but are not:
--   computeRadar is called with createAdminClient() (radar/page.tsx:26).
--
-- SELECT is revoked from NOTHING, for a second reason beyond the four session
-- reads: `revoke select` at table level erases that role's COLUMN entries
-- (0068's ORDER note). It would silently undo the layer 0068 exists to
-- restore.
--
-- production_addons already lost everything to 0068; it is listed anyway so
-- the group is complete and the statement is idempotent.
--
-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION.
-- ---------------------------------------------------------------------------
-- • 0070 (hiding productions.price_override) is untouched and still reserved.
-- • No RLS policy is added, dropped or altered. Privileges and policies are
--   two different walls; this file moves one.
-- • No column-level grant is created or removed.
-- • Zero DELETE, zero data change, zero schema change beyond the probe table
--   created and dropped inside this transaction.

do $mig$
declare
  v_owner_role    constant name := 'postgres';
  v_class         text;
  v_pg17          constant boolean := current_setting('server_version_num')::int >= 170000;
  v_bad_rel       text;
  v_bad_fn        text;
  v_anon_defacl   int;
  v_auth_danger   int;
  v_residual      int;
  v_probe_anon    int;
  v_revoked_all   int := 0;
  v_revoked_dml   int := 0;
  v_tbl           text;
  -- no user-client access at all -> lose everything
  v_none          constant text[] := array[
                    'assistant_queries', 'client_review_items', 'production_addons',
                    'schema_ledger', 'stages_removed_snapshot', 'v_doc_count', 'v_prev_job'];
  -- read from a session -> lose writes, keep SELECT
  v_readonly      constant text[] := array[
                    'documents', 'events', 'pending_documents', 'client_review_links'];
begin

  -- ---------------------------------------------------------------------
  -- 0. guards.
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from public.schema_ledger where version = '0068') then
    raise exception '0068 טרם הוחלה — הרץ אותה קודם';
  end if;

  if not exists (select 1 from pg_roles where rolname = v_owner_role) then
    raise exception '0069: התפקיד % אינו קיים בשרת הזה — עצור וברר', v_owner_role;
  end if;

  -- ALTER DEFAULT PRIVILEGES FOR ROLE requires membership. Checked up front
  -- so the message says what to do rather than what failed.
  if not pg_has_role(current_user, v_owner_role, 'MEMBER') then
    raise exception '0069: ל-% אין חברות ב-% ולכן ALTER DEFAULT PRIVILEGES FOR ROLE ייכשל',
      current_user, v_owner_role;
  end if;

  -- ---------------------------------------------------------------------
  -- 1. THE OWNERSHIP GUARD — the premise, verified.
  --
  --    Part A fixes the defaults of ONE role. That is complete coverage if
  --    and only if every object in public is created by that role. Rather
  --    than assume it (the mistake that produced this whole incident), the
  --    schema is enumerated and any object owned by anybody else stops the
  --    migration BY NAME, before a single privilege is touched.
  --
  --    Extension-owned objects are excluded: they are not ours, their
  --    ownership is the platform's business, and failing on them would wedge
  --    this file on something it has no power to fix.
  -- ---------------------------------------------------------------------
  select string_agg(format('%s(%s, owner=%s)', c.relname, c.relkind, c.relowner::regrole),
                    ', ' order by c.relname)
    into v_bad_rel
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and c.relowner <> v_owner_role::regrole
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');

  select string_agg(format('%s(owner=%s)', p.proname, p.proowner::regrole), ', ' order by p.proname)
    into v_bad_fn
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proowner <> v_owner_role::regrole
    and not exists (
      select 1 from pg_depend d
      where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');

  if v_bad_rel is not null or v_bad_fn is not null then
    raise exception
      '0069: הפרמיסה של חלק א׳ שבורה — יש אובייקטים ב-public שאינם בבעלות %, ולכן תיקון ברירות המחדל שלו לבדו אינו כיסוי מלא. יחסים: [%]. פונקציות: [%]. אל תרחיב את המיגרציה בלי הכרעה אנושית — עמודה שנוצרת בתפקיד שלא תוקן תיוולד פתוחה ל-anon.',
      v_owner_role, coalesce(v_bad_rel, 'אין'), coalesce(v_bad_fn, 'אין');
  end if;

  -- =====================================================================
  -- PART A — THE POLICY, for postgres. See the header for why this is
  --          coverage, and for the supabase_admin residual it cannot reach.
  -- =====================================================================
  foreach v_class in array array['tables', 'sequences', 'functions'] loop

    execute format(
      'alter default privileges for role %I in schema public revoke all on %s from anon',
      v_owner_role, v_class);

    if v_class = 'tables' then
      execute format(
        'alter default privileges for role %I in schema public revoke truncate, references, trigger on tables from authenticated',
        v_owner_role);
      if v_pg17 then
        execute format(
          'alter default privileges for role %I in schema public revoke maintain on tables from authenticated',
          v_owner_role);
      end if;
    end if;

  end loop;

  -- ---------------------------------------------------------------------
  -- A-verify 1: the direct statement, SCOPED TO THE ROLE WE FIXED.
  --    Counting anon grants across every defaclrole would count
  --    supabase_admin's — which remain by design and cannot be removed —
  --    and this migration would fail its own check forever.
  -- ---------------------------------------------------------------------
  select count(*) into v_anon_defacl
  from pg_default_acl d, aclexplode(d.defaclacl) x
  where d.defaclnamespace = 'public'::regnamespace
    and d.defaclrole = v_owner_role::regrole
    and x.grantee = 'anon'::regrole;
  if v_anon_defacl <> 0 then
    raise exception '0069: נשארו % רשומות ברירת-מחדל של % שמעניקות ל-anon', v_anon_defacl, v_owner_role;
  end if;

  select count(*) into v_auth_danger
  from pg_default_acl d, aclexplode(d.defaclacl) x
  where d.defaclnamespace = 'public'::regnamespace
    and d.defaclrole = v_owner_role::regrole
    and d.defaclobjtype = 'r'
    and x.grantee = 'authenticated'::regrole
    and x.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN');
  if v_auth_danger <> 0 then
    raise exception '0069: ל-authenticated נשארו % הרשאות מסוכנות בברירת המחדל של %', v_auth_danger, v_owner_role;
  end if;

  -- the residual, MEASURED and reported rather than left to be rediscovered
  select count(*) into v_residual
  from pg_default_acl d, aclexplode(d.defaclacl) x
  where d.defaclnamespace = 'public'::regnamespace
    and d.defaclrole <> v_owner_role::regrole
    and x.grantee = 'anon'::regrole;

  -- ---------------------------------------------------------------------
  -- A-verify 2: the behavioural proof. A REAL table in public — see the
  --    header for why a temp table would certify nothing — created BY
  --    postgres, measured, and dropped inside this transaction.
  -- ---------------------------------------------------------------------
  create table public.zz_0069_acl_probe (x int);

  select count(*) into v_probe_anon
  from pg_class c, aclexplode(c.relacl) x
  where c.oid = 'public.zz_0069_acl_probe'::regclass
    and x.grantee = 'anon'::regrole;

  if v_probe_anon <> 0 then
    drop table public.zz_0069_acl_probe;
    raise exception '0069: טבלה חדשה בסכימה public עדיין נולדת עם % הרשאות ל-anon — המדיניות לא נתפסה', v_probe_anon;
  end if;

  if has_table_privilege('authenticated', 'public.zz_0069_acl_probe', 'TRUNCATE') then
    drop table public.zz_0069_acl_probe;
    raise exception '0069: טבלה חדשה עדיין נולדת עם TRUNCATE ל-authenticated';
  end if;

  -- and NOT over-revoked: the application still gets its DML on a new table
  if not has_table_privilege('authenticated', 'public.zz_0069_acl_probe', 'SELECT')
     or not has_table_privilege('authenticated', 'public.zz_0069_acl_probe', 'INSERT') then
    drop table public.zz_0069_acl_probe;
    raise exception '0069: טבלה חדשה נולדת בלי SELECT/INSERT ל-authenticated — נשללו יותר מדי';
  end if;

  drop table public.zz_0069_acl_probe;

  -- =====================================================================
  -- PART B — THE SNAPSHOT. The objects that exist today. See the header
  --          for the re-verified map and the `documents` correction.
  -- =====================================================================
  foreach v_tbl in array v_none loop
    if to_regclass('public.' || quote_ident(v_tbl)) is null then
      raise exception '0069: % אינה קיימת — המפה של 0068 אינה תואמת את הסכימה, עצור וברר', v_tbl;
    end if;
    execute format('revoke all privileges on public.%I from authenticated', v_tbl);
    v_revoked_all := v_revoked_all + 1;
  end loop;

  foreach v_tbl in array v_readonly loop
    if to_regclass('public.' || quote_ident(v_tbl)) is null then
      raise exception '0069: % אינה קיימת — עצור וברר', v_tbl;
    end if;
    execute format('revoke insert, update, delete on public.%I from authenticated', v_tbl);
    v_revoked_dml := v_revoked_dml + 1;
  end loop;

  -- ---------------------------------------------------------------------
  -- B-verify: the seven hold nothing; the four kept exactly SELECT.
  -- ---------------------------------------------------------------------
  foreach v_tbl in array v_none loop
    if exists (
      select 1 from pg_class c, aclexplode(c.relacl) x
      where c.oid = ('public.' || quote_ident(v_tbl))::regclass
        and x.grantee = 'authenticated'::regrole
    ) then
      raise exception '0069: ל-authenticated נשארו הרשאות על %', v_tbl;
    end if;
  end loop;

  foreach v_tbl in array v_readonly loop
    if not has_table_privilege('authenticated', 'public.' || quote_ident(v_tbl), 'SELECT') then
      raise exception '0069: authenticated איבד SELECT על % — מסך חי נשבר', v_tbl;
    end if;
    if has_table_privilege('authenticated', 'public.' || quote_ident(v_tbl), 'INSERT')
       or has_table_privilege('authenticated', 'public.' || quote_ident(v_tbl), 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || quote_ident(v_tbl), 'DELETE') then
      raise exception '0069: ל-authenticated נשארה כתיבה על %', v_tbl;
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- THE CANARY. 0068's lesson: an over-broad revoke must fail HERE, inside
  -- a transaction that can still roll back, and not on a live screen.
  -- ---------------------------------------------------------------------
  if not has_table_privilege('authenticated', 'public.productions', 'SELECT')
     or not has_table_privilege('authenticated', 'public.productions', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.shows', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.stages', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.production_log', 'INSERT')
     or not has_table_privilege('authenticated', 'public.profiles', 'SELECT') then
    raise exception '0069 canary: נשללו הרשאות שהאפליקציה נשענת עליהן — עצור ובדוק';
  end if;
  -- the shows column layer 0068 restored must be intact — proof that nothing
  -- above issued a table-level `revoke select` on it
  if has_table_privilege('authenticated', 'public.shows', 'SELECT') then
    raise exception '0069 canary: ל-shows חזר SELECT ברמת טבלה — שכבת ההרשאות העמודתיות של 0068 נמחקה';
  end if;

  -- ---------------------------------------------------------------------
  -- the ledger.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0069', now(), 'bnaya',
          'מדיניות הרשאות ואז תצלום. 0068 שמרה את המספר הזה למשימה אחת — שלילת DML מ-authenticated בטבלאות שקליינט המשתמש אינו כותב אליהן — והיא כאן כחלק ב׳. חלק א׳ חדש והוא החצי החשוב. מה שקרה: 0071 ניסתה ליצור תצוגה ב-3.9.26 ונעצרה על ה-canary של עצמה — anon החזיק SELECT על אובייקט בן שלוש הצהרות, בקובץ שאינו נוקב ב-anon מחוץ לבדיקה. 0068 הצהירה את ההפך בתוך הטרנזקציה שלה, והיא קומיטה: אין ל-anon דבר על אף טבלה או תצוגה בסכימה (0068:298-306). שתי ההצהרות נכונות, ויחד הן מוכיחות שהגרנט הוצמד ברגע ה-CREATE על ידי השרת — והמנגנון היחיד ב-PostgreSQL שעושה זאת בלי GRANT מפורש הוא pg_default_acl. נשאל ולא הונח: בסכימה public קיימות רשומות ברירת-מחדל לשני תפקידים מעניקים, postgres ו-supabase_admin, בשלושת סוגי האובייקטים, שמעניקות arwdDxtm ל-anon ול-authenticated בשמם המפורש ולא דרך PUBLIC. כלומר 0068 סגרה תצלום וקראה לזה סגירה: revoke all privileges on all tables in schema public (0068:180) נפרש בזמן הביצוע על האובייקטים הקיימים באותו רגע, זו אמירה בזמן הווה, והסכימה נפתחה מחדש ברגע שמישהו יצר אובייקט — יומיים אחר כך. הדבר היחיד שגרם לנו לדעת הוא שהמיגרציה החדשה נשאה canary. חלק א׳ מכסה את postgres בלבד, וזו אינה פשרה: ההרצה הראשונה של הקובץ הזה (4.9.26) נעצרה על גארד החברות שלו עצמו והדפיסה current_user, כלומר נמדד ולא הונח ש-ה-SQL Editor רץ כ-postgres, ש-supabase_admin קיים, ושאין ל-postgres חברות בו. ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin הוא אפוא בלתי אפשרי מתפקיד פרויקט — התיעוד מפורש שה-target_role חייב להיות תפקיד שהתפקיד הנוכחי חבר בו — ואין ניסוח שעוקף זאת. וזה גם לא משנה, מסיבה שקל לטעות בה: ברירות מחדל אינן תכונה של הסכימה אלא של התפקיד היוצר. pg_default_acl ממופתח על defaclrole, ואובייקט חדש שואב אך ורק מהרשומה של התפקיד שיצר אותו; השתיים לעולם לא מצטלבות. defaclrole=postgres שולטת בכל מה שאנחנו יוצרים, כי כל מיגרציה בריפו הזה רצה ב-SQL Editor שהוא postgres — וזו הרשומה שהעניקה ל-v_production_review_rounds את ההרשאה שהפילה את 0071; defaclrole=supabase_admin שולטת במה שאותו תפקיד יוצר, כלומר עבודת פלטפורמה, ואנחנו לא יוצרים בו דבר ואיננו יכולים. הפרמיסה הזו מאומתת כאן ולא מוצהרת: צמצום ל-postgres ואז אמון שכל אובייקט הוא בבעלותו היה מחליף גארד בהנחה — בדיוק כיצד 0068 ייצרה את התקלה הזו — ולכן גארד הבעלות מונה כל relation וכל פונקציה ב-public ומסרב לרוץ, עם השמות, אם מישהו מהם בבעלות תפקיד שהמיגרציה אינה מתקנת את ברירות המחדל שלו. אובייקטים ששייכים לתוסף מוחרגים (pg_depend deptype=e): הם אינם נוצרים במיגרציות שלנו, בעלותם היא עניין של הפלטפורמה, וכישלון עליהם היה תוקע את הקובץ מסיבה שאין לו כוח לתקן. הסיכון השיורי מוצהר ואינו ממותן כאן: ברירות המחדל של supabase_admin בסכימה public נשארות על כנן, הן מעניקות arwdDxtm ל-anon על כל אובייקט שאותו תפקיד יוצר, ואין דרך מתפקיד פרויקט לשלול אותן — אם Supabase תיצור אי-פעם אובייקט בסכימה שלנו הוא ייוולד קריא ל-anon ו-0069 לא תעצור זאת. שלושה מסלולי מוצא נשקלו ואף אחד לא שרד: event trigger שמנקה כל CREATE דורש superuser שאין לנו; קרון לילי משאיר חלון חשיפה חי בין היצירה לסריקה ובונה תשתית חדשה למקרה שלא קרה מעולם; ופנייה לתמיכה שתריץ את ההצהרה עבור תפקיד שאיננו יוצרים בו דבר היא עלות בלי תמורה. לכן הקיר האחרון הוא הכלל שנקבע ב-0071, והוא אינו כפילות של הקובץ הזה אלא הדבר היחיד שמכסה את מה שהקובץ הזה אינו יכול להגיע אליו: מיגרציה שיוצרת אובייקט נושא-ACL חייבת להצהיר על הרשאותיו במפורש ולאמת אותן לפני שורת הפנקס — יצירה אינה פעולה ניטרלית בסכימה הזו. הכלל הזה הוא שתפס את כל התקלה לפני שמישהו ידע ש-pg_default_acl מעורב, ו-0071:5ב ושני ה-canary שלו הם הדוגמה המפורשת. חלק א׳ מסיר את המקרה השכיח; הכלל תופס את השאר, כולל כל מה ש-supabase_admin יעשה אי-פעם. היקף חלק א׳: כל הצהרה היא IN SCHEMA public, ו-ALTER DEFAULT PRIVILEGES מוגבל לשלישייה (תפקיד מעניק, סכימה, סוג אובייקט) ואינו יכול לחרוג — auth, storage, realtime, graphql, graphql_public, extensions, vault ו-supabase_migrations אינן נגועות מעצם הבנייה. anon מאבד הכל בשלושת הסוגים: אין לו שימוש לגיטימי במערכת, הדף הציבורי /r/[token] וראוט התשובה שלו רצים על service role, ואומת מחדש שהקליינט הדפדפני מיובא בארבעה קבצים בלבד וכולם GoTrue בלבד. USAGE על הסכימה אינו הרשאת ברירת מחדל ולא נגע, כהחלטת 0068 — בקשה אנונימית ממשיכה להיכשל ברעש (42501) ולא בשקט. authenticated מאבד ארבע הרשאות ולא את כולן: TRUNCATE, REFERENCES, TRIGGER ו-MAINTAIN, בדיוק הארבע ש-0068 שללה מכל טבלה קיימת (0068:193) ומאותן סיבות, ונשמרות INSERT/SELECT/UPDATE/DELETE. שלילה מלאה נשקלה ונדחתה, והנימוק נרשם כדי שלא תיחשב השמטה: איסור-כברירת-מחדל פירושו שכל טבלה עתידית תלויה ב-GRANT שזוכרים, ו-GRANT שנשכח אינו מכריז על עצמו אלא מרונדר כמסך ריק — לא היפותטי, 0055 נאלצה להוסיף grant select על has_episode ו-reels_count ורשמה בגוף עצמה שבלעדיו כרטיס התוכנית נשבר; 0068 עמדה באותה צומת, ביטלה את רשימת ההיתר של 0022 וכתבה את הכלל להיכשל לכיוון הנראה ולא לכיוון השבור-בשקט. המחיר מוצהר: טבלה חדשה נולדת עם DML ל-authenticated ו-RLS נשאר הקיר שמכריע מי רואה אילו שורות, וזה כבר המצב בכל 24 הטבלאות. פונקציות לא נגעו עבור authenticated במכוון: can_view_stages וחברותיה נקראות מתוך policies של RLS על ידי התפקיד השואל, ושלילת EXECUTE כברירת מחדל הייתה שוברת את הפונקציה הבאה ברגע שמישהו ישכח grant. ה-canary של חלק א׳: הבדיקה המתבקשת — טבלה זמנית — שגויה כאן ובשקט, כי טבלה זמנית נוצרת ב-pg_temp_NNN ולא ב-public וברירות מחדל הן פר-סכימה, ולכן הבדיקה הייתה עוברת באופן זהה לפני ואחרי ולא מאשרת דבר (ארבעת ה-probes של 0068 על טבלאות temp היו תקפים כי מדדו ACL עמודתי, שאינו תלוי-סכימה). לכן נוצרת טבלה אמיתית ב-public על ידי postgres, נמדדת ונמחקת באותה טרנזקציה — וזו גם ההוכחה ההתנהגותית לצמצום, כי probe שיוצא נקי מוכיח שרשומת postgres היא זו ששולטת ביצירות שלנו. אימות ישיר נוסף על pg_default_acl מצומצם גם הוא ל-defaclrole=postgres: ספירת גרנטים ל-anon על פני כל התפקידים הייתה סופרת את אלה של supabase_admin, שנשארים בכוונה ואינם ניתנים להסרה, והמיגרציה הייתה נכשלת בבדיקת עצמה לנצח; השארית נמדדת ומדווחת ב-notice במקום להתגלות מחדש. חלק ב׳ — התצלום, ומקום אחד שבו המפה של 0068 שגויה: documents נמנתה שם כטבלה שקליינט המשתמש אינו נוגע בה והיא כן — הלוח מעביר את קליינט המשתמש לכל מטריקת מודול (app/page.tsx:16, createClient), ומודול מרשם המסמכים קורא אותה איתו ב-modules/doc-registry.ts:23 ו-:30 כדי לספור מסמכים לא-משויכים לכרטיס "מסמכים"; ה-RLS שלה הוא can_view_money (0027:55) והשער של המודול עצמו הוא can_view_money, כלומר הקריאה אמיתית מכוונת ומותרת, ושלילת SELECT ממנה הייתה שוברת מסך חי. היא הועברה לקבוצת הקריאה-בלבד. כל שאר הרשומות אומתו מחדש ולא נורשו, בפענוח מקבל ה-.from בכל src ואיתור סוג הקליינט: assistant_queries 2 אתרים כולם service role, client_review_items 10 כולם service role, production_addons 12 כולם service role, schema_ledger ו-stages_removed_snapshot ו-v_doc_count ו-v_prev_job אפס אתרים, documents 38 (35 service role, 3 משתמש), events 111 (109 service role, 2 קריאות משתמש — settings/page.tsx:18 והרדאר), pending_documents 63 (60 service role, 3 קריאות משתמש — api/documents/pending/route.ts:24 ו-modules/documents/index.ts:16), client_review_links 5 (4 service role, קריאת משתמש אחת ב-entity route:223, קופסת הלינקים החיים של Q7, במכוון על קליינט המשתמש כי ה-policy הוא can_view_stages). קריאות הרדאר נראות כקריאות משתמש בקובץ ואינן: computeRadar נקראת עם createAdminClient (radar/page.tsx:26). לכן שלילת ALL בשבעה שאין להם גישה מסשן, ושלילת INSERT/UPDATE/DELETE בלבד בארבעה שנקראים מסשן. SELECT אינו נשלל באף טבלה גם מסיבה שנייה: revoke select ברמת טבלה מוחק את הרשומות העמודתיות של אותו תפקיד (הערת הסדר של 0068), כלומר היה מבטל בשקט את השכבה ש-0068 קיימת כדי לשחזר. production_addons כבר איבדה הכל ב-0068 ונשארת ברשימה כדי שהקבוצה תהיה שלמה וההצהרה אידמפוטנטית. canary לסיום: productions קריאה וניתנת לעדכון, shows ניתנת לעדכון, stages ניתנת לעדכון, production_log ניתנת להוספה, profiles קריאה — וגם ההפך, ש-shows לא קיבלה בחזרה SELECT ברמת טבלה, כהוכחה שאף הצהרה כאן לא מחקה את שכבת ההרשאות העמודתיות. מחוץ להיקף: 0070 (הסתרת price_override) נשארת שמורה; אף policy של RLS לא נוסף, הוסר או שונה; ואף גרנט עמודתי לא נוצר ולא הוסר. אפס DELETE, אפס שינוי נתונים, ואפס שינוי סכימה מלבד טבלת ה-probe שנוצרת ונמחקת בתוך אותה טרנזקציה.');

  raise notice '0069 הוחלה. מדיניות (% בלבד): ברירות המחדל נוקו ל-anon בשלושת הסוגים, ו-authenticated איבד TRUNCATE/REFERENCES/TRIGGER%. תצלום: % אובייקטים ללא הרשאות, % לקריאה בלבד. שארית שלא ניתן להסיר מתפקיד פרויקט: % רשומות ברירת-מחדל של תפקידים אחרים שעדיין מעניקות ל-anon — הקיר עליהן הוא כלל ה-canary של 0071.',
               v_owner_role,
               case when v_pg17 then '/MAINTAIN' else '' end,
               v_revoked_all, v_revoked_dml, v_residual;

end
$mig$;
