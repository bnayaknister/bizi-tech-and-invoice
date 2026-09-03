-- 0068: restore the column-privilege layer (F6 follow-up, 2026-09-03).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHAT HAPPENED
-- ---------------------------------------------------------------------------
-- Every column-level GRANT in this schema was erased. 0022 (shows, 14 columns),
-- 0024 (internal_confirmed_*), 0028/0040 (productions), 0031 (the add-on price
-- columns) and 0055 (has_episode, reels_count) each granted SELECT column by
-- column; on 2026-09-03 exactly two column ACLs existed in the whole database,
-- and both belong to 0067. Meanwhile all 24 base tables carried
-- `arwdDxtm` — INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER,
-- MAINTAIN — for BOTH `authenticated` and `anon`. RLS was the only wall left.
--
-- HOW WE KNOW IT WAS AN ERASURE AND NOT A NON-EVENT. Four probes on throwaway
-- temp tables, run against this database:
--   • `grant select (col)` records an attacl entry EVEN when the role already
--     holds table-level SELECT — so a grant that ran always leaves a trace.
--   • `grant all on <table>` does NOT clear those entries.
--   • `revoke all on <table> from <role>` DOES clear them.
--   • so does `revoke select on <table> from <role>` — see the ORDER note below.
-- 0055 wrote its ledger row inside the same DO block as its grant, so its grant
-- provably executed; its attacl is gone. 0067 ran on 2026-09-02 and its two
-- survive. A schema-wide `revoke all … from authenticated` therefore ran
-- BETWEEN 2026-08-12 and 2026-09-02 — the shape of the standard Supabase
-- "reset permissions" snippet.
--
-- HOW IT SURFACED. Not by a person reading a screen — by the test that was
-- written for exactly this and had not been run since:
--     FAIL  M1. tech selecting shows.default_rate is denied (not returned)
--           status=200 [{"name":"ZTEST כסף","default_rate":4321}]
-- (scripts/test_permissions_and_approvals.py, 23 of 24 checks green.) The one
-- red check is the whole column-privilege layer; every RLS-based assertion in
-- that file still passes, which is what bounds the damage.
--
-- ---------------------------------------------------------------------------
-- ORDER IS LOAD-BEARING
-- ---------------------------------------------------------------------------
-- `revoke select on public.shows from authenticated` erases that role's column
-- SELECT entries on that table. So the revoke must come BEFORE the loop, and
-- nothing after it may re-revoke table-level SELECT on shows. The two broad
-- steps below were measured NOT to interfere: a partial revoke (TRUNCATE /
-- REFERENCES / TRIGGER) leaves attacl untouched, and revoking from `anon`
-- leaves `authenticated` untouched. That is why steps 1 and 2 may safely
-- precede step 3.
--
-- ---------------------------------------------------------------------------
-- DENY-LIST, NOT ALLOW-LIST — AND THE MAINTENANCE NOTE 0022 GOT WRONG
-- ---------------------------------------------------------------------------
-- 0022 wrote an explicit allow-list and left this note, which every migration
-- since has quoted:
--
--     "a NEW column added to public.shows in a future migration will NOT be
--      readable by stages users until it's added to a grant like the one below"
--
-- ★ THAT NOTE IS SUPERSEDED. Two reasons, and the second is the important one:
--
--   1. It has not been true since the erasure — every column added from 0023
--      onwards was readable by everyone, so the "secure by default" posture the
--      note promised never actually protected a single column.
--
--   2. Its failure mode is SILENT BREAKAGE. An allow-list forgets in the
--      direction of a blank screen: 0055 had to add `grant select (has_episode,
--      reels_count)` and says so in its own body — "בלי השורה הזו כרטיס
--      התוכנית נשבר". A forgotten column does not announce itself; it renders
--      as an empty card on somebody's phone.
--
-- So this migration grants dynamically: every column of `shows` EXCEPT the two
-- named in the deny-list. The trade is stated plainly rather than discovered
-- later:
--
--     WHAT WE GAIN  a new column can never break a screen by being forgotten.
--     WHAT WE LOSE  a new MONEY column is readable by default.
--
-- ★ THE NEW RULE, which replaces the quoted note above:
--
--     A new column on public.shows is readable by `authenticated` the moment it
--     exists. A new column that carries MONEY must be added to the deny-list in
--     a migration AND to the ACL manifest — and neither alone is enough.
--
-- ★ THIS MIGRATION IS NOT SELF-ENFORCING. A deny-list is only as good as the
-- thing that notices it drifted, and the erasure above is proof that nothing
-- noticed for three weeks. The manifest is NOT part of 0068 — it is a separate
-- piece of work, and until it exists this schema is protected by a convention
-- rather than by a check. Two layers are planned, in this order of value:
--   • run scripts/test_permissions_and_approvals.py in CI. It already catches
--     exactly this; it is red right now. Extend its M-block to hourly_rate,
--     price_override and production_addons.unit_price/total, and keep M2's
--     inverse assertion (a permitted column MUST still read) so an over-broad
--     revoke breaks a test instead of a screen.
--   • an expected-ACL manifest checked in prebuild against pg_class.relacl and
--     pg_attribute.attacl, so a wipe is caught before a sensitive value is ever
--     written to the exposed column — for hourly_rate that is the difference
--     between catching it on Monday and catching it after the first hourly show
--     goes live.
--
-- ---------------------------------------------------------------------------
-- SCOPE — 0068 IS THE REVERSIBLE HALF, ON PURPOSE
-- ---------------------------------------------------------------------------
-- Everything here was verified against every call site before it was written:
-- no read of default_rate, hourly_rate, price_override or the add-on price
-- columns goes through the user's client anywhere in src/ — all of them use the
-- service role (shows/page.tsx, projects/page.tsx, documents/enqueue.ts,
-- productions/price.ts, addons/route.ts). There is also no `select("*")` on a
-- user client in the codebase, which would break under column grants rather
-- than filter. So nothing below can blank a screen.
--
-- DML IS DELIBERATELY UNTOUCHED. `authenticated` keeps INSERT/UPDATE/DELETE on
-- every table, including the eight it never writes through. That is 0069, and
-- it is separate precisely because a missed write path fails at RUNTIME with a
-- 500 rather than at review — a different risk class from anything here.
-- productions.price_override stays readable for now: hiding it means enumerating
-- 43 columns, and that decision belongs with the manifest (0070).

do $mig$
declare
  -- The whole policy of this migration, in one place.
  v_denied      text[] := array['default_rate', 'hourly_rate'];
  v_col         text;
  v_granted     int := 0;
  v_total_cols  int;
  v_tables      int;
  v_anon_before int;
  v_check       int;
begin

  -- ---------------------------------------------------------------------
  -- 0. re-run guard. Loud, never idempotent-by-silence: a second run that
  --    did nothing would still add a second ledger row (0053 / 0067).
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0068') then
    raise exception '0068 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. what we are walking into, recorded before we change it. These
  --    numbers go into the ledger note, so the state this migration found
  --    is readable in two years without re-deriving it.
  -- ---------------------------------------------------------------------
  select count(*) into v_tables
  from pg_class
  where relnamespace = 'public'::regnamespace and relkind = 'r';

  select count(distinct c.oid) into v_anon_before
  from pg_class c, aclexplode(c.relacl) x
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'v')
    and x.grantee = 'anon'::regrole;

  select count(*) into v_total_cols
  from pg_attribute
  where attrelid = 'public.shows'::regclass and attnum > 0 and not attisdropped;

  -- A sanity floor, not a formality: if shows has fewer columns than the
  -- deny-list names, something is very wrong and the loop below would grant
  -- an empty set — i.e. lock every stages user out of the shows screen.
  if v_total_cols <= array_length(v_denied, 1) then
    raise exception '0068: public.shows נושאת % עמודות בלבד — עצור וברר', v_total_cols;
  end if;

  -- ---------------------------------------------------------------------
  -- 2. anon loses everything on tables.
  --
  --    Verified 2026-09-03 across all of src/: there is not one PostgREST
  --    call on the anon role. login / welcome / reset-password /
  --    SignOutButton touch GoTrue only (auth.*, not public.*), the
  --    middleware only calls getUser(), and the public client-review page
  --    /r/[token] plus /api/r/[token]/respond both run on the SERVICE role.
  --    handle_new_user is SECURITY DEFINER and is unaffected.
  --
  --    USAGE ON SCHEMA IS DELIBERATELY KEPT. Removing it changes how
  --    PostgREST answers rather than what it answers, and we are not
  --    reshaping the API here.
  --
  --    Behaviour change, stated: an anonymous request that used to get an
  --    empty array now gets 42501. That is the loud direction — an empty
  --    array reads as "no data", a permission error reads as "no access".
  -- ---------------------------------------------------------------------
  revoke all privileges on all tables in schema public from anon;

  -- ---------------------------------------------------------------------
  -- 3. authenticated loses the four privileges an application role has no
  --    use for: arwdDxtm -> arwd.
  --
  --    TRUNCATE empties a table with no RLS filter and no trigger pass —
  --    it is DELETE without any of the walls this system relies on.
  --    REFERENCES lets a role point a foreign key at our rows. TRIGGER lets
  --    it attach code to our tables. MAINTAIN (PG17) allows VACUUM/ANALYZE
  --    and friends. None appears anywhere in src/.
  --
  --    Measured safe to run BEFORE step 4: a partial revoke leaves column
  --    ACLs intact (only ALL and SELECT clear them).
  -- ---------------------------------------------------------------------
  revoke truncate, references, trigger on all tables in schema public from authenticated;

  -- MAINTAIN exists from PG17. Guarded so this file stays runnable against
  -- an older server rather than dying on a syntax error.
  if current_setting('server_version_num')::int >= 170000 then
    execute 'revoke maintain on all tables in schema public from authenticated';
  end if;

  -- ---------------------------------------------------------------------
  -- 4. shows: the deny-list, applied.
  --
  --    THE REVOKE MUST PRECEDE THE LOOP. `revoke select on <table>` erases
  --    the same role's column entries — measured, and it is the mechanism
  --    that produced this whole incident. Reversing these two statements
  --    would leave the table wide open with a clean-looking migration.
  -- ---------------------------------------------------------------------
  revoke select on public.shows from authenticated;

  for v_col in
    select a.attname
    from pg_attribute a
    where a.attrelid = 'public.shows'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and a.attname <> all (v_denied)
    order by a.attnum
  loop
    -- %I, never string concatenation: the column name comes from the
    -- catalogue, but a quoted identifier is the only form that is correct
    -- for every name the catalogue can hold.
    execute format('grant select (%I) on public.shows to authenticated', v_col);
    v_granted := v_granted + 1;
  end loop;

  -- ---------------------------------------------------------------------
  -- 5. production_addons: authenticated loses the table outright.
  --
  --    0031 revoked SELECT on (unit_price, total) and that revoke was erased
  --    with the rest — while this table's RLS policy is `can_view_stages()`,
  --    i.e. EVERY technician, not "the rows that concern them". It reads as
  --    harmless today only because the table holds zero rows; the first
  --    priced add-on would have been visible to the whole studio.
  --
  --    Revoked whole rather than column-by-column because nothing reads this
  --    table through the user's client at all — addons/route.ts is service
  --    role from top to bottom, by its own design note (0031). A table that
  --    is never touched by a user session needs no privileges for one, and
  --    that is a far more durable statement than a two-column deny-list.
  -- ---------------------------------------------------------------------
  revoke all privileges on public.production_addons from authenticated;

  -- ---------------------------------------------------------------------
  -- 6. prove it, in the same transaction that did it. A permissions
  --    migration that cannot demonstrate its own effect is how we got here.
  -- ---------------------------------------------------------------------

  -- 6a. no table-level SELECT on shows for authenticated
  select count(*) into v_check
  from pg_class c, aclexplode(c.relacl) x
  where c.oid = 'public.shows'::regclass
    and x.grantee = 'authenticated'::regrole
    and x.privilege_type = 'SELECT';
  if v_check <> 0 then
    raise exception '0068: ל-authenticated עדיין יש SELECT ברמת הטבלה על shows — הגרנט העמודתי חסר משמעות';
  end if;

  -- 6b. every permitted column carries a column-level SELECT
  select count(*) into v_check
  from pg_attribute a
  where a.attrelid = 'public.shows'::regclass
    and a.attnum > 0 and not a.attisdropped
    and a.attname <> all (v_denied)
    and not exists (
      select 1 from aclexplode(a.attacl) y
      where y.grantee = 'authenticated'::regrole and y.privilege_type = 'SELECT'
    );
  if v_check <> 0 then
    raise exception '0068: % עמודות מותרות ב-shows לא קיבלו גרנט — מסך התוכניות יישבר', v_check;
  end if;

  -- 6c. neither denied column carries one. The whole point, asserted.
  select count(*) into v_check
  from pg_attribute a
  where a.attrelid = 'public.shows'::regclass
    and a.attname = any (v_denied)
    and exists (
      select 1 from aclexplode(a.attacl) y
      where y.grantee = 'authenticated'::regrole
    );
  if v_check <> 0 then
    raise exception '0068: עמודה ברשימת האיסור עדיין מוענקת ל-authenticated — עצור';
  end if;

  -- 6d. production_addons carries nothing for authenticated
  select count(*) into v_check
  from pg_class c, aclexplode(c.relacl) x
  where c.oid = 'public.production_addons'::regclass
    and x.grantee = 'authenticated'::regrole;
  if v_check <> 0 then
    raise exception '0068: ל-authenticated נשארו הרשאות על production_addons';
  end if;

  -- 6e. anon holds nothing, anywhere
  select count(distinct c.oid) into v_check
  from pg_class c, aclexplode(c.relacl) x
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'v')
    and x.grantee = 'anon'::regrole;
  if v_check <> 0 then
    raise exception '0068: ל-anon נשארו הרשאות על % טבלאות', v_check;
  end if;

  -- 6f. THE CANARY. Everything above removes; this proves we did not remove
  --     too much. productions must still be fully readable and writable by
  --     authenticated — it is the table the board, the drawer and the hours
  --     route all depend on, and 0069 (not this file) is where its DML is
  --     reconsidered.
  if not has_table_privilege('authenticated', 'public.productions', 'SELECT')
     or not has_table_privilege('authenticated', 'public.productions', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.shows', 'UPDATE') then
    raise exception '0068: נשללו הרשאות שנדרשות לאפליקציה — עצור ובדוק';
  end if;

  -- ---------------------------------------------------------------------
  -- 7. the ledger, inside the same block — a schema change that is not
  --    recorded is a schema change nobody can find later (0052). Note that
  --    0021, 0022, 0024, 0028 and 0040 carry ledger rows reading 'backfill'
  --    with one identical timestamp, because none of those FILES writes to
  --    the ledger at all; that is why the ledger could not answer whether
  --    they had run, and why this one writes its own row here.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0068', now(), 'bnaya',
          'שחזור שכבת ההרשאות העמודתיות. מה שנמצא לפני ההרצה: ' || v_tables || ' טבלאות בסכימה public, כולן מעניקות arwdDxtm (INSERT/SELECT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN) גם ל-authenticated וגם ל-anon, ובכל הסכימה שתי הרשאות עמודתיות בלבד — shows.pricing_model ו-productions.studio_hours, שתיהן של 0067. כלומר כל הגרנטים העמודתיים של 0022 (14 עמודות ב-shows), 0024 (internal_confirmed_at/by), 0028 ו-0040 (productions), 0031 (unit_price, total ב-production_addons) ו-0055 (has_episode, reels_count) נמחקו, ו-RLS נשאר הקיר היחיד. מתי: בין 12.8.26 ל-2.9.26. ההוכחה לחלון: 0055 כותבת את שורת הפנקס שלה באותו בלוק DO שבו היא מריצה את הגרנט שלה — כלומר הגרנט רץ בוודאות — וה-attacl שלו נעדר; ואילו שני הגרנטים של 0067, שרצה ב-2.9, שרדו. איך: ארבעה probes על טבלאות temp בבסיס הנתונים הזה הראו ש-grant עמודתי רושם attacl גם כשלתפקיד כבר יש SELECT ברמת הטבלה (כלומר גרנט שרץ תמיד משאיר עקבה), ש-grant all ברמת טבלה אינו מוחק אותה, ושrevoke all ו-revoke select ברמת טבלה כן מוחקים — כלומר רץ כאן revoke-all-ואז-grant-all ברמת סכימה, בצורת סניפט איפוס ההרשאות הסטנדרטי של Supabase. איך התגלה: לא מקריאת מסך אלא מהבדיקה שנכתבה בדיוק בשביל זה ולא הורצה מאז — M1 ב-scripts/test_permissions_and_approvals.py נכשלת עם status=200 ומחזירה default_rate 4321 לטכנאי בלי can_view_money, בעוד M2 עוברת מיד אחריה ומוכיחה שהשורה נראית והקריאה אמיתית; 23 מתוך 24 הבדיקות בקובץ ירוקות, והאדומה היחידה היא בדיוק שכבת ההרשאות העמודתיות — מה שתוחם את הנזק. מה נעשה כאן: (1) anon איבד כל הרשאה על כל הטבלאות (' || v_anon_before || ' טבלאות ותצוגות לפני), אחרי אימות בכל src/ שאין ולו קריאת PostgREST אחת בתפקיד הזה — מסכי ההתחברות נוגעים ב-GoTrue בלבד, ה-middleware רק ב-getUser, והדף הציבורי /r/[token] וגם /api/r/[token]/respond רצים על service role; USAGE על הסכימה נשמר במכוון, ושינוי ההתנהגות היחיד הוא ש-anon מקבל 42501 במקום מערך ריק, כלומר כישלון רועש במקום שקט. (2) authenticated איבד TRUNCATE, REFERENCES, TRIGGER ו-MAINTAIN בכל הטבלאות — ארבע הרשאות שאין להן אזכור בקוד, ו-TRUNCATE בפרט הוא מחיקה שעוקפת גם RLS וגם טריגרים. DML נשאר בכוונה: הוא 0069. (3) shows — revoke select ברמת הטבלה ואז גרנט עמודתי דינמי על ' || v_granted || ' מתוך ' || v_total_cols || ' עמודות, רשימת איסור על default_rate ו-hourly_rate בלבד. סדר שתי ההצהרות האלה נושא משקל: revoke select ברמת טבלה מוחק את הרשומות העמודתיות של אותו תפקיד, ולכן היפוך הסדר היה משאיר את הטבלה פתוחה לרווחה עם מיגרציה שנראית תקינה. (4) production_addons — revoke all מ-authenticated, לא רשימת איסור עמודתית: ה-RLS שלה הוא can_view_stages כלומר כל טכנאי, 0031 הסתירה שם מחירים והשלילה נמחקה, ואף קריאה בקוד אינה עוברת דרך קליינט המשתמש (addons/route.ts הוא service role מקצה לקצה). טבלה שאין בה שום נגיעה מסשן משתמש אינה צריכה הרשאות לסשן משתמש, וזו הצהרה עמידה יותר מאיסור על שתי עמודות. מדיניות שהשתנתה: רשימת ההיתר של 0022 הוחלפה ברשימת איסור, וההערה שלה שמצוטטת מאז בכל מיגרציה — עמודה חדשה ב-shows לא תיקרא עד שתתווסף לגרנט — מבוטלת. היא לא הייתה נכונה מאז המחיקה (כל עמודה שנוספה מ-0023 ואילך הייתה קריאה לכולם), ומצב הכשל שלה הוא שבירה שקטה: 0055 נאלצה להוסיף גרנט ורשמה בגוף עצמה שבלעדיו כרטיס התוכנית נשבר. הכלל החדש: עמודה חדשה ב-shows קריאה מרגע היווצרה, ועמודה כספית חדשה חייבת להתווסף לרשימת האיסור במיגרציה וגם למניפסט ה-ACL — אחת מהן לבדה אינה מספיקה. המחיר מוצהר: עמודה כספית חדשה חשופה כברירת מחדל, ולכן המניפסט אינו אופציונלי. המיגרציה הזו אינה אוכפת את עצמה: המניפסט אינו חלק מ-0068, ועד שייכתב הסכימה מוגנת במוסכמה ולא בבדיקה. אימות בתוך אותה טרנזקציה: אין SELECT ברמת טבלה על shows, כל עמודה מותרת קיבלה גרנט, אף עמודה אסורה לא, ל-production_addons אין הרשאות, ל-anon אין הרשאות באף טבלה, ו-canary שמוודא ש-productions עדיין קריאה וניתנת לעדכון ו-shows עדיין ניתנת לעדכון — כדי שגם שלילת-יתר תיפול כאן ולא על מסך חי. הוחלט לפני הכתיבה, מול כל אתר קריאה ב-src: אף קריאה של default_rate, hourly_rate, price_override או מחירי התוספות אינה עוברת דרך קליינט המשתמש — כולן service role (shows/page.tsx, projects/page.tsx, documents/enqueue.ts, productions/price.ts, addons/route.ts) — ואין בקוד ולו select("*") אחד על קליינט משתמש, שהיה נכשל ב-42501 תחת גרנט עמודתי במקום להסתנן. אפס DELETE, אפס שינוי נתונים, אפס שינוי סכימה. נשאר מחוץ להיקף: 0069 — שלילת DML מ-authenticated בשמונה הטבלאות שאינן נוגעות בקליינט המשתמש (assistant_queries, client_review_items, documents, production_addons, schema_ledger, stages_removed_snapshot ושתי תצוגות v_) ובשלוש שנקראות בלבד (events, pending_documents, client_review_links), בנפרד כי כתיבה שהוחמצה נכשלת בזמן ריצה ולא בסקירה; 0070 — הסתרת productions.price_override, שדורשת מניית 43 עמודות ולכן קשורה להכרעת המניפסט.');

  raise notice '0068 הוחלה. shows: % מתוך % עמודות מוענקות ל-authenticated (חסומות: %). anon אופס על % טבלאות. production_addons נשללה. DML לא נגע — הוא 0069.',
               v_granted, v_total_cols, array_to_string(v_denied, ', '), v_anon_before;
  raise notice 'הצעד הבא: הרץ scripts/test_permissions_and_approvals.py — M1 חייבת להתהפך לירוקה ו-M2 חייבת להישאר ירוקה.';
end $mig$;
