-- 0070: hide productions.price_override from `authenticated` (0068 follow-up).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- The last of the three numbers 0068 reserved. 0069 (policy + DML) and 0071
-- (the review-ack schema) are applied; this closes the set.
--
-- ---------------------------------------------------------------------------
-- ★ FINDING, AND IT CHANGES WHAT THIS MIGRATION IS.
-- ---------------------------------------------------------------------------
-- 0032 already tried to hide this column, on the day it created it:
--
--     revoke select (price_override) on public.productions from authenticated;
--     revoke select (price_override) on public.productions from anon;
--                                      — 0032:17-18, 2026-07-21
--
-- 0068 assumed that statement had worked and was later erased along with every
-- other column ACL. Only the second half is true, and the first half was never
-- true at all:
--
--     ★ A COLUMN-LEVEL REVOKE CANNOT SUBTRACT FROM A TABLE-LEVEL GRANT.
--       In PostgreSQL, privileges are additive. SELECT on the table implies
--       SELECT on every column of it, and `revoke select (col)` does not and
--       cannot remove that. `authenticated` has held table-level SELECT on
--       public.productions continuously — 0068's own canary (0068:312) asserts
--       it — so 0032's two lines were a no-op from the moment they ran.
--
-- So price_override has been readable by every authenticated session for the
-- entire life of the column. Not since the erasure; since 2026-07-21. This
-- migration is the first thing that actually hides it, and the shape is not
-- optional: the ONLY way to hide a column is to revoke SELECT at table level
-- and re-grant every other column individually. That is what 0022 did for
-- shows, what 0068 rebuilt there, and what happens below.
--
-- The practical exposure was bounded and is worth stating rather than
-- implying: RLS still applied, so a technician only ever saw rows they were
-- entitled to see — but on those rows they could read the price. And nothing
-- in the app ever asked for the column through a user session (see the audit
-- below), so the exposure was reachable only by hand-crafting a PostgREST
-- request. Bounded is not the same as closed.
--
-- ---------------------------------------------------------------------------
-- THE LIST IS BUILT FROM THE CATALOGUE. NEVER TYPED OUT.
-- ---------------------------------------------------------------------------
-- 0068's ledger described this migration as "requiring the enumeration of 43
-- columns", and that framing is the trap. A hand-written allow-list is wrong
-- the instant a column is added — and six have been added since that sentence:
-- studio_hours (0067) and the three ack columns (0071), plus whatever comes
-- next. A forgotten column does not announce itself; it renders as a blank
-- card on somebody's phone (0068:64).
--
-- So the loop below reads pg_attribute and grants every live column EXCEPT the
-- deny-list — exactly the shape 0068 used for shows, and the reason it chose a
-- deny-list over an allow-list. The number 43 never appears in this file. What
-- gets granted is whatever the table actually has at the moment it runs.
--
-- ★ ORDER IS LOAD-BEARING, and it is the same trap 0068 flagged:
--   `revoke select on <table>` ERASES that role's existing column entries.
--   The revoke must come BEFORE the loop. Reversed, the table is left wide
--   open behind a migration that looks correct and whose verification would
--   still pass. It also means the column grants from 0067 (studio_hours) and
--   0071 (the three ack columns) are wiped by the revoke and re-created by the
--   loop — no action needed, but worth knowing when reading the ACL after.
--
-- ---------------------------------------------------------------------------
-- THE AUDIT — RE-RUN, NOT INHERITED. The code moved since 0068.
-- ---------------------------------------------------------------------------
-- 0068 stated no user-client read touches price_override. That was true then
-- and F6 has since added a whole route, so it was re-verified from scratch:
-- every `.from("productions")` in src/ was resolved to its receiver, and every
-- mention of price_override was traced to a client.
--
--   READS OF price_override — all seven, all SERVICE ROLE:
--     app/projects/page.tsx:195                    admin (created :243)
--     api/productions/[id]/route.ts:108            admin
--     api/productions/[id]/addons/route.ts:71      admin
--     api/productions/[id]/hours/route.ts:129      admin   ← the F6 route
--     lib/review/links.ts:181, :528                admin (service by contract)
--   WRITE OF price_override:
--     api/productions/[id]/addons/route.ts:231     admin
--
--   THE TWO PLACES THAT LOOK DANGEROUS AND ARE NOT:
--     • api/productions/[id]/hours/route.ts:199 IS on the user client — by
--       design, so guard_production_stage_columns actually fires (its own note
--       at :190-196 explains why the admin client would silently bypass the
--       wall 0067 added). It selects `id,studio_hours` and updates
--       studio_hours. It never names price_override.
--     • api/entity/[type]/[id]/route.ts:79 selects a RUNTIME column list —
--       `selectColumns(type, profile)` — through the user's client. A denied
--       column in a dynamic list fails the WHOLE query with 42501, exactly as
--       select("*") would, so this is the one place that could break the
--       drawer outright. It cannot: price_override is not in the field
--       registry (grep of src/lib/entities.ts returns nothing), and the
--       drawer gets the base price from /api/productions/[id]/addons, which is
--       service role end to end.
--
--   And the property 0068 relied on still holds: there is not one select("*")
--   on a user client anywhere in src/. Every user-client read of productions
--   names its columns, and none of them names this one — the board
--   (productions/page.tsx:147), the search route, the assistant tools, the
--   split / cancel / duplicate-group routes, /shows, /finance/link and
--   modules/projects.ts were each checked individually.
--
-- ---------------------------------------------------------------------------
-- WHAT THE CANARY MUST NOT USE — a trap this file walks straight past.
-- ---------------------------------------------------------------------------
-- ★ has_table_privilege('authenticated', 'public.productions', 'SELECT') is
--   FALSE after this migration, BY DESIGN. That is the point of the whole
--   exercise. 0068:312 and 0069 both assert that expression is TRUE, and both
--   were correct for their moment — but a canary here that copied them would
--   fail on success.
--
--   So the canary below uses has_COLUMN_privilege for the columns the screens
--   actually read, plus has_any_column_privilege to prove the table is still
--   readable in the aggregate. UPDATE is untouched and is still checked at
--   table level, because that is where it still lives.
--
-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION.
-- ---------------------------------------------------------------------------
-- • anon is named in the revoke for completeness, but 0069 already took every
--   privilege it had and removed the default that would have given it more.
--   The statement is idempotent and costs nothing; it is there so the file
--   reads as a complete statement about who may see this column.
-- • No RLS policy is touched. Privileges and policies are two different walls.
-- • No guard trigger is touched. Hiding a column from SELECT says nothing
--   about who may write it; the write path is service-role only (audited
--   above) and price_override has never been in guard_production_stage_columns.
-- • No data change, no DELETE, no schema change. Privileges only.

do $mig$
declare
  v_denied    constant text[] := array['price_override'];
  v_col       text;
  v_granted   int := 0;
  v_total     int;
  v_check     int;
begin

  -- ---------------------------------------------------------------------
  -- 0. guards.
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0070') then
    raise exception '0070 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from public.schema_ledger where version = '0068') then
    raise exception '0068 טרם הוחלה — הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — בלעדיה כל עמודה חדשה בסכימה נולדת פתוחה ל-anon. הרץ אותה קודם';
  end if;

  -- 0071 is required on THIS database because its three ack columns already
  -- exist and must land in the enumeration below. On a clean rebuild where
  -- 0070 runs first the columns do not exist yet — and that case is safe by a
  -- different route: 0071's own step 6 grants them explicitly, and its
  -- verification (amended 2026-09-04) asserts they are readable afterwards.
  if not exists (select 1 from public.schema_ledger where version = '0071') then
    raise exception '0071 טרם הוחלה — שלוש עמודות ה-ack לא תיכללנה במניה. הרץ אותה קודם';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.productions'::regclass
      and attname = 'price_override' and attnum > 0 and not attisdropped
  ) then
    raise exception '0070: העמודה price_override אינה קיימת — עצור וברר';
  end if;

  -- A sanity floor, not a formality (0068:155): if the table somehow holds
  -- fewer columns than the deny-list names, the loop would grant an empty set
  -- and lock every screen out of productions.
  select count(*) into v_total
  from pg_attribute
  where attrelid = 'public.productions'::regclass and attnum > 0 and not attisdropped;
  if v_total <= array_length(v_denied, 1) then
    raise exception '0070: public.productions נושאת % עמודות בלבד — עצור וברר', v_total;
  end if;

  -- ---------------------------------------------------------------------
  -- 1. THE REVOKE. Must precede the loop — see the header. This is also what
  --    erases the column grants 0067 and 0071 left; the loop re-creates them.
  -- ---------------------------------------------------------------------
  revoke select on public.productions from authenticated;
  revoke select on public.productions from anon;

  -- ---------------------------------------------------------------------
  -- 2. THE LOOP. Every live column except the deny-list, straight from the
  --    catalogue. %I and never concatenation: the name comes from pg_attribute,
  --    but a quoted identifier is the only form correct for every name the
  --    catalogue can hold.
  -- ---------------------------------------------------------------------
  for v_col in
    select a.attname
    from pg_attribute a
    where a.attrelid = 'public.productions'::regclass
      and a.attnum > 0
      and not a.attisdropped
      and a.attname <> all (v_denied)
    order by a.attnum
  loop
    execute format('grant select (%I) on public.productions to authenticated', v_col);
    v_granted := v_granted + 1;
  end loop;

  -- ---------------------------------------------------------------------
  -- 3. prove it, in the same transaction that did it.
  -- ---------------------------------------------------------------------

  -- 3a. no table-level SELECT for authenticated — without this the column
  --     grants are decoration, which is precisely 0032's mistake.
  select count(*) into v_check
  from pg_class c, aclexplode(c.relacl) x
  where c.oid = 'public.productions'::regclass
    and x.grantee = 'authenticated'::regrole
    and x.privilege_type = 'SELECT';
  if v_check <> 0 then
    raise exception '0070: ל-authenticated עדיין יש SELECT ברמת הטבלה על productions — הגרנט העמודתי חסר משמעות';
  end if;

  -- 3b. every permitted column carries a column-level SELECT
  select count(*) into v_check
  from pg_attribute a
  where a.attrelid = 'public.productions'::regclass
    and a.attnum > 0 and not a.attisdropped
    and a.attname <> all (v_denied)
    and not exists (
      select 1 from aclexplode(a.attacl) y
      where y.grantee = 'authenticated'::regrole and y.privilege_type = 'SELECT'
    );
  if v_check <> 0 then
    raise exception '0070: % עמודות מותרות לא קיבלו גרנט — מסך יישבר בשקט', v_check;
  end if;

  -- 3c. and the denied one did NOT
  if has_column_privilege('authenticated', 'public.productions', 'price_override', 'SELECT') then
    raise exception '0070: ל-authenticated עדיין יש SELECT על price_override — המיגרציה לא השיגה דבר';
  end if;

  -- 3d. anon holds nothing on this table
  select count(*) into v_check
  from pg_class c, aclexplode(c.relacl) x
  where c.oid = 'public.productions'::regclass and x.grantee = 'anon'::regrole;
  if v_check <> 0 then
    raise exception '0070: ל-anon נשארו % הרשאות על productions', v_check;
  end if;

  -- ---------------------------------------------------------------------
  -- 4. THE CANARY. productions is the table the board, the drawer and the
  --    hours route all stand on; an over-broad revoke must fail HERE, inside
  --    a transaction that can still roll back, and not on a live screen.
  --
  --    has_COLUMN_privilege, not has_table_privilege — see the header. The
  --    table-level SELECT is gone on purpose and checking for it would fail
  --    on success.
  -- ---------------------------------------------------------------------
  if not has_any_column_privilege('authenticated', 'public.productions', 'SELECT') then
    raise exception '0070 canary: productions אינה קריאה כלל ל-authenticated — נשלל יותר מדי';
  end if;

  -- the columns each live surface actually names
  foreach v_col in array array[
      'id', 'status', 'record_date', 'record_time', 'guest', 'studio',
      'on_hold', 'needs_attention', 'show_id', 'client_id', 'kind', 'legacy',
      'split_index', 'split_count', 'calendar_uid', 'calendar_dup_ack',
      'merged_into', 'storage_disk', 'studio_hours', 'has_episode',
      'reels_count', 'podcast_name', 'cancelled_at',
      'review_episode_approved', 'review_reels_approved', 'review_reels_required',
      'review_episode_note', 'review_reels_note',
      'review_ack_at', 'review_ack_by', 'review_ack_link_id']
  loop
    if not has_column_privilege('authenticated', 'public.productions', v_col, 'SELECT') then
      raise exception '0070 canary: authenticated איבד SELECT על העמודה % — מסך חי נשבר', v_col;
    end if;
  end loop;

  -- writes are untouched, and they still live at table level
  if not has_table_privilege('authenticated', 'public.productions', 'UPDATE')
     or not has_table_privilege('authenticated', 'public.productions', 'INSERT') then
    raise exception '0070 canary: authenticated איבד UPDATE או INSERT על productions';
  end if;

  -- and the layer 0068 restored on shows is still intact — proof that nothing
  -- here reached the wrong table
  if has_table_privilege('authenticated', 'public.shows', 'SELECT') then
    raise exception '0070 canary: ל-shows חזר SELECT ברמת טבלה';
  end if;

  -- ---------------------------------------------------------------------
  -- 5. the ledger.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0070', now(), 'bnaya',
          'הסתרת productions.price_override מ-authenticated — האחרונה משלושת המספרים ש-0068 שמרה, אחרי 0069 (מדיניות ו-DML) ו-0071 (סכימת ה-ack). ממצא שמשנה את מהות המיגרציה: 0032 כבר ניסתה להסתיר את העמודה ביום שבו יצרה אותה — revoke select (price_override) on public.productions from authenticated וגם from anon, ב-0032:17-18 מ-21.7.26 — ו-0068 הניחה שההצהרה הזו עבדה ונמחקה מאוחר יותר עם שאר ההרשאות העמודתיות. רק החצי השני נכון, והחצי הראשון מעולם לא היה: ב-PostgreSQL הרשאות הן מצטברות, SELECT ברמת הטבלה גורר SELECT על כל עמודה בה, ו-revoke select (col) אינו יכול לגרוע מכך. ל-authenticated היה SELECT ברמת טבלה על productions ברציפות — ה-canary של 0068 עצמה (0068:312) קובע זאת — ולכן שתי השורות של 0032 היו no-op מרגע שרצו. כלומר price_override הייתה קריאה לכל סשן מאומת לאורך כל חיי העמודה, לא מאז המחיקה אלא מ-21.7.26, והמיגרציה הזו היא הדבר הראשון שבאמת מסתיר אותה. הצורה אינה אופציונלית: הדרך היחידה להסתיר עמודה היא לשלול SELECT ברמת הטבלה ולהעניק מחדש כל עמודה אחרת בנפרד — מה ש-0022 עשתה ל-shows, מה ש-0068 שחזרה שם, ומה שנעשה כאן. החשיפה בפועל הייתה תחומה ומוצהרת ולא נרמזת: RLS המשיך לחול ולכן טכנאי ראה רק שורות שהיה זכאי לראות, אבל בשורות האלה יכול היה לקרוא את המחיר; ושום קוד באפליקציה לא ביקש את העמודה דרך סשן משתמש, ולכן החשיפה הייתה נגישה רק בבניית בקשת PostgREST ידנית. תחום אינו סגור. הרשימה נבנית מהקטלוג ולעולם לא נכתבת: 0068 תיארה את המיגרציה הזו כ"דורשת מניית 43 עמודות", וזו בדיוק המלכודת — רשימת היתר כתובה ביד שגויה ברגע שנוספת עמודה, ומאז המשפט ההוא נוספו שש: studio_hours ב-0067 ושלוש עמודות ה-ack ב-0071, ומה שיבוא. עמודה שנשכחה אינה מכריזה על עצמה אלא מרונדרת ככרטיס ריק בטלפון של מישהו (0068:64). לכן הלולאה קוראת את pg_attribute ומעניקה כל עמודה חיה למעט רשימת האיסור — בדיוק הצורה ש-0068 השתמשה בה ל-shows והסיבה שבחרה רשימת איסור על פני רשימת היתר. המספר 43 אינו מופיע בקובץ הזה; מה שמוענק הוא מה שיש לטבלה ברגע ההרצה. סדר ההצהרות נושא משקל, ואותה מלכודת ש-0068 סימנה: revoke select ברמת טבלה מוחק את הרשומות העמודתיות של אותו תפקיד, ולכן השלילה חייבת לקדום ללולאה — הפוך, הטבלה נשארת פתוחה לרווחה מאחורי מיגרציה שנראית תקינה ושהאימות שלה עדיין עובר. זה גם אומר שהגרנטים העמודתיים של 0067 (studio_hours) ושל 0071 (שלוש עמודות ה-ack) נמחקים על ידי השלילה ונוצרים מחדש בלולאה — לא נדרשת פעולה, אבל כדאי לדעת בקריאת ה-ACL אחר כך. הביקורת על הקוד הורצה מחדש ולא נורשה, כי הקוד זז מאז 0068 ו-F6 הוסיפה ראוט שלם: כל .from("productions") ב-src פוענח למקבל שלו, וכל אזכור של price_override נעקב לקליינט. שבע הקריאות של העמודה כולן service role — projects/page.tsx:195 (admin שנוצר ב-:243), api/productions/[id]/route.ts:108, addons/route.ts:71, hours/route.ts:129 שהוא ראוט F6 החדש, ו-links.ts:181 ו-:528 — והכתיבה היחידה, addons/route.ts:231, גם היא admin. שני מקומות נראים מסוכנים ואינם: hours/route.ts:199 אכן על קליינט המשתמש, במכוון כדי ש-guard_production_stage_columns יצית בפועל (ההערה שלו ב-:190-196 מסבירה שקליינט admin היה עוקף בשקט את הקיר ש-0067 הוסיפה), אבל הוא בוחר id,studio_hours ומעדכן studio_hours ואינו נוקב ב-price_override; ו-api/entity/[type]/[id]/route.ts:79 בוחר רשימת עמודות שנקבעת בזמן ריצה, selectColumns(type, profile), דרך קליינט המשתמש — ועמודה אסורה בתוך רשימה דינמית מפילה את השאילתה כולה ב-42501 בדיוק כמו select("*"), כלומר זה המקום היחיד שיכול היה לשבור את הדרואר לחלוטין. הוא אינו יכול: price_override אינה ברישום השדות (grep על src/lib/entities.ts מחזיר אפס), והדרואר מקבל את מחיר הבסיס מ-/api/productions/[id]/addons שהוא service role מקצה לקצה. התכונה ש-0068 נשענה עליה עדיין מתקיימת: אין ולו select("*") אחד על קליינט משתמש בכל src, כל קריאת משתמש של productions נוקבת בעמודותיה, ואף אחת אינה נוקבת בזו — הלוח (productions/page.tsx:147), ראוט החיפוש, כלי העוזר, ראוטי הפיצול והביטול וקבוצת הכפילויות, /shows, /finance/link ו-modules/projects.ts נבדקו אחד-אחד. מלכודת שהקובץ עוקף במפורש: has_table_privilege(authenticated, productions, SELECT) הוא FALSE אחרי המיגרציה הזו במכוון — זו כל מטרתה — ו-0068:312 וגם 0069 קובעים ששניהם שהביטוי הזה TRUE, ושניהם צדקו לרגע שלהם; canary שהיה מעתיק אותם היה נכשל דווקא בהצלחה. לכן ה-canary כאן משתמש ב-has_column_privilege על העמודות שהמסכים באמת קוראים, וב-has_any_column_privilege כדי להוכיח שהטבלה עדיין קריאה במצטבר, ובודק UPDATE ו-INSERT ברמת הטבלה כי שם הם עדיין יושבים ולא נגעו בהם. אימות בתוך אותה טרנזקציה: אין SELECT ברמת טבלה ל-authenticated, כל עמודה מותרת קיבלה גרנט עמודתי, price_override לא קיבלה, ול-anon אין דבר על הטבלה. canary: הטבלה קריאה במצטבר, 31 עמודות שהמסכים נוקבים בהן נבדקות אחת-אחת בשם, UPDATE ו-INSERT שרדו, ו-shows לא קיבלה בחזרה SELECT ברמת טבלה — הוכחה ששום הצהרה כאן לא הגיעה לטבלה הלא נכונה. מחוץ להיקף: אף policy של RLS לא נגע — הרשאות ו-policies הם שני קירות שונים; אף שומר לא נגע — הסתרת עמודה מקריאה אינה אומרת דבר על מי רשאי לכתוב אותה, ומסלול הכתיבה הוא service role בלבד; ו-anon נכלל בשלילה לשלמות ההצהרה בלבד, שכן 0069 כבר נטלה ממנו כל הרשאה והסירה את ברירת המחדל שהייתה מחזירה לו עוד. אפס שינוי נתונים, אפס DELETE, אפס שינוי סכימה — הרשאות בלבד.');

  raise notice '0070 הוחלה. price_override מוסתרת סוף-סוף מ-authenticated (0032 מעולם לא הצליחה — revoke עמודתי אינו גורע מגרנט ברמת טבלה). % מתוך % עמודות productions קיבלו גרנט עמודתי.',
               v_granted, v_total;

end
$mig$;
