-- 0075 — document -> parent-document links, parsed once out of Morning's remarks
--
-- WHAT THIS IS FOR. A document issued by hand in Morning arrives through the
-- daily pull as an isolated row: it carries a client and an amount, and nothing
-- that says which document it was raised against. 1,015 of the 1,035 pulled rows
-- have no job_id, and job_id is the ONLY grouping this table has ever had
-- (production_id is null on every pulled row; bundle_job_ids is job-anchored).
-- So the accounting chain that Morning itself knows — order -> deal invoice ->
-- tax invoice / receipt — is invisible to us the moment a human raises one of
-- the links outside the app.
--
-- Morning does record it, in exactly one place: the `remarks` line it generates
-- on the child, in the same shape our own sourceRemark() writes
-- (morning/types.ts:113) — "<self> עבור <source> <number>". That string is
-- already in this table, inside `raw`, on every pulled row. Nothing has ever
-- read it back.
--
-- WHY A COLUMN AND NOT A VIEW (owner, 2026-09-09). `remarks` is free text that
-- Morning may reword, and the parse should happen once at write time rather
-- than on every screen load. A stored column is also what lets a later
-- consumer JOIN on it.
--
-- SCOPE: schema + one backfill. NOTHING reads these columns yet — the parser in
-- registry.ts and the registry chip are two separate steps after this. No
-- existing column is touched, no row is deleted, no behaviour changes.
--
-- ---------------------------------------------------------------------------
-- WHY text[] AND NOT A FOREIGN KEY — the finding that set the shape
--
-- The relation is N:M, measured, not assumed. 23 rows already carry more than
-- one parent, and document 50027 carries NINE:
--   "חשבונית מס עבור חשבון עסקה 40128, 40129, 40127, 40133, 40126, 40136,
--    40135, 40130, 40131"
-- — a consolidated tax invoice. A single parent_document_id would silently keep
-- one of those nine and drop eight, on exactly the documents where the money is
-- largest. So the column is an ARRAY.
--
-- And it holds NUMBERS, not uuids, for a reason that outlives convenience: the
-- child can be pulled BEFORE its parent. searchDocuments() pages by
-- documentDate (morning/client.ts:280), and a child may carry an earlier date
-- than its parent or simply land on another page. A uuid[] with a foreign key
-- would turn PULL ORDER into a referential-integrity constraint, and the pull
-- would start failing on ordering rather than on data. The number is the fact
-- Morning stated; the uuid is the result of a lookup. We store the fact and
-- resolve it in a join at read time — one truth, not two.
--
-- Today the lookup happens to be total and unambiguous (measured 2026-09-09):
-- all 1,094 morning_doc_number values are distinct, zero nulls, and every
-- referenced parent already exists locally. Both facts are true in hindsight,
-- after a full backfill; neither is guaranteed in real time, and neither is
-- relied on here.
--
-- NO INDEX IN THIS MIGRATION, deliberately. The only consumer planned — a chip
-- on the registry row — reads parent_doc_numbers off a row it already has, and
-- needs no index. A GIN index is the obvious addition the day something asks
-- the REVERSE question ("which documents were raised against me"), and that is
-- a one-line migration when a caller exists. Building it now would be an index
-- nothing reads.
--
-- ---------------------------------------------------------------------------
-- WHY parent_relation — "ביטול" is a reference, not a parent
--
-- Five rows read "ביטול חשבונית מס / קבלה 60162": a receipt that CANCELS a
-- tax receipt. They carry a document number at the end of the line exactly like
-- a derivation does, and a parser that grabbed the trailing number would file a
-- cancellation as a parent — inverting the meaning of the link on the five rows
-- where being wrong matters most.
--
-- Both are stored, and parent_relation is what tells them apart. The number is
-- kept for the cancellation too — a cancellation whose target is unrecorded is
-- useless — so ANY consumer joining on parent_doc_numbers MUST filter on
-- parent_relation first. That is the whole reason the second column exists.
--
-- ---------------------------------------------------------------------------
-- THE PARSER IS ANCHORED TO THE WHOLE STRING, never "find a number"
--
-- Four families live in this column, and three of them punish a loose parser:
--   1. the derivation line, Hebrew  — "חשבון עסקה עבור הזמנה 10298"
--   2. the derivation line, ENGLISH — "Proforma Invoice for Order 10078".
--      Morning writes the same provenance in English on English documents;
--      a parser keyed on "עבור" alone silently misses them.
--   3. the cancellation line        — "ביטול חשבונית מס / קבלה 60162"
--   4. free text on price quotes    — multi-line terms full of numbers
--      ("כל רילס נוסף … בעלות של 250 ₪", "תנאי תשלום שוטף+30"). A
--      last-number-wins parser would record 250 or 30 as a document id.
--
-- Anchoring on the complete shape is what separates them. Measured against all
-- 1,094 rows: 640 derivations, 5 cancellations, and the 24 unmatched remarks
-- are ALL type 10 price quotes carrying free text — zero real references are
-- missed. `\yfor\y` is word-bounded so "Proforma" cannot supply the "for".
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS — STATED, NOT ASSUMED (rule 49)
--
-- Measured on this database, 2026-09-09:
--   has_table_privilege('authenticated','public.documents','SELECT') = TRUE
--   has_table_privilege('anon',         'public.documents','SELECT') = FALSE
--   RLS: documents_select USING can_view_money()
--
-- Because the TABLE-level grant to `authenticated` stands, the two columns
-- added here are readable by `authenticated` the moment they exist. No GRANT is
-- issued and none is needed.
--
-- The other half of rule 49 matters more, and is why this paragraph exists at
-- all rather than being left to inference: a column-level REVOKE on this table
-- would be a NO-OP. `revoke select (col)` removes only column-level entries;
-- while `authenticated=r` sits in relacl, has_column_privilege keeps returning
-- true. The statement would run clean and change nothing — which is how 0031
-- left production_addons' prices readable to every technician, and why 0068 had
-- to revoke the whole table to undo it.
--
-- A parent document NUMBER IS NOT MONEY — it is the same class of fact as
-- morning_doc_number, which `authenticated` already reads — so there is nothing
-- here to hide and no compartmentalisation to build. That is a decision, and
-- the canary below asserts BOTH directions of it: anon still gets nothing, and
-- authenticated really can read the new columns (the 0055 failure — a grant
-- nobody noticed was missing until a card rendered blank).
--
-- Read access to the ROW is unchanged and still can_view_money() via
-- documents_select. Write access is unchanged: no policy is added, so every
-- mutation stays server-only through the service role, exactly as the pull
-- already runs.

do $$
declare
  -- The two patterns, declared once and used by both the backfill and the
  -- canary, so the thing being verified is literally the thing that ran.
  c_derived  constant text := '^[^0-9\n]{3,40}(עבור|\yfor\y)[^0-9\n]{3,40}[0-9]{3,6}(,\s*[0-9]{3,6})*\s*$';
  c_cancel   constant text := '^ביטול[^0-9\n]{3,40}[0-9]{3,6}\s*$';
  c_tail     constant text := '([0-9]{3,6}(?:,\s*[0-9]{3,6})*)\s*$';

  v_cols        int;
  v_derived     int;
  v_derived_pull int;
  v_derived_app int;
  v_cancel      int;
  v_orphan      int;
  v_multi       int;
  v_anon_tbl    boolean;
  v_anon_col    boolean;
  v_auth_a      boolean;
  v_auth_b      boolean;
  v_auth_write  boolean;
  v_rls         boolean;
  v_policy      int;
begin
  -- 0. ledger guard — this file is not re-runnable and must say so.
  if exists (select 1 from public.schema_ledger where version = '0075') then
    raise exception '0075 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. the shape this migration reads from must actually be here. `raw` is
  --     where the whole Morning payload lands (registry.ts:242); without it the
  --     backfill would quietly write zero rows and the canary would fire.
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='documents' and column_name='raw'
  ) then
    raise exception '0075: documents.raw חסרה — אין ממה לפרסר';
  end if;

  -- 1. the columns.
  alter table public.documents
    add column if not exists parent_doc_numbers text[],
    add column if not exists parent_relation    text;

  -- 2. the invariants, as constraints rather than as conventions.
  --    · relation is one of two words, or absent
  --    · the two columns travel together — a relation with no number, or a
  --      number with no relation, is a half-parsed row and there is no reading
  --      of it that a consumer could use
  --    · an empty array is not a thing: absence is NULL
  alter table public.documents
    drop constraint if exists documents_parent_relation_chk,
    drop constraint if exists documents_parent_pair_chk,
    drop constraint if exists documents_parent_numbers_nonempty_chk;

  alter table public.documents
    add constraint documents_parent_relation_chk
      check (parent_relation is null or parent_relation in ('derived','cancellation')),
    add constraint documents_parent_pair_chk
      check ((parent_relation is null) = (parent_doc_numbers is null)),
    add constraint documents_parent_numbers_nonempty_chk
      check (parent_doc_numbers is null or array_length(parent_doc_numbers, 1) >= 1);

  -- 3. backfill — derivations.
  --    ORDER PRESERVED (`with ordinality`): Morning lists the parents in its
  --    own order and re-sorting them would invent a fact. On 50027 that order
  --    is the order nine deal invoices were folded into one tax invoice.
  --    Runs across EVERY source, not just 'pull': the chain is a property of
  --    the document, and 21 app-issued rows carry one too — 7 of which have no
  --    job_id either.
  update public.documents d
     set parent_doc_numbers = (
           select array_agg(trim(x) order by ord)
             from unnest(string_to_array(
                    (regexp_match(d.raw->>'remarks', c_tail))[1], ',')
                  ) with ordinality as t(x, ord)
         ),
         parent_relation = 'derived'
   where d.raw->>'remarks' ~ c_derived;

  -- 4. backfill — cancellations. Same number, different meaning.
  update public.documents d
     set parent_doc_numbers = (
           select array_agg(trim(x) order by ord)
             from unnest(string_to_array(
                    (regexp_match(d.raw->>'remarks', c_tail))[1], ',')
                  ) with ordinality as t(x, ord)
         ),
         parent_relation = 'cancellation'
   where d.raw->>'remarks' ~ c_cancel;

  -- 5. no GRANT and no REVOKE — see the permissions note in the header. The
  --    table grant already covers the new columns, and a column REVOKE here
  --    would be a no-op (rule 49). The canary proves both halves instead of
  --    trusting either.

  -- ---- 6. CANARY — every check below runs BEFORE the ledger row, so a
  --         failure rolls the whole migration back rather than recording a
  --         half-applied schema. -------------------------------------------

  -- 6a. anon gets nothing, at table level. This is the direction that killed
  --     0071's first run: a privilege nobody granted was already there.
  select has_table_privilege('anon','public.documents','SELECT') into v_anon_tbl;
  if v_anon_tbl then
    raise exception '0075 canary: ל-anon יש SELECT על documents — לא היה אמור, בדוק pg_default_acl';
  end if;

  -- 6b. ...and at column level too, which a table-level false does not imply.
  select bool_or(has_column_privilege('anon','public.documents', c, 'SELECT'))
    into v_anon_col
    from unnest(array['parent_doc_numbers','parent_relation']) c;
  if coalesce(v_anon_col,false) then
    raise exception '0075 canary: ל-anon יש הרשאה עמודתית על עמודות ההורה החדשות';
  end if;

  -- 6c. the opposite failure, and the expensive one: authenticated MUST be able
  --     to read them. This is 0055 — a missing grant announces itself as a
  --     blank screen weeks later, never as an error.
  select has_column_privilege('authenticated','public.documents','parent_doc_numbers','SELECT'),
         has_column_privilege('authenticated','public.documents','parent_relation','SELECT')
    into v_auth_a, v_auth_b;
  if not (v_auth_a and v_auth_b) then
    raise exception '0075 canary: authenticated אינו קורא את עמודות ההורה — גרנט הטבלה לא כיסה אותן, המסך יירנדר ריק';
  end if;

  -- 6d. write access unchanged: still server-only through the service role.
  select bool_or(has_column_privilege('authenticated','public.documents', c, 'UPDATE'))
    into v_auth_write
    from unnest(array['parent_doc_numbers','parent_relation']) c;
  if coalesce(v_auth_write,false) then
    raise exception '0075 canary: ל-authenticated יש הרשאת כתיבה על עמודות ההורה — כל כתיבה כאן היא server-only';
  end if;

  -- 6e. RLS still on, and the row gate is still the money gate.
  select relrowsecurity into v_rls from pg_class where oid = 'public.documents'::regclass;
  if not v_rls then
    raise exception '0075 canary: RLS כבוי על documents';
  end if;
  select count(*) into v_policy from pg_policies
   where tablename='documents' and policyname='documents_select';
  if v_policy <> 1 then
    raise exception '0075 canary: documents_select חסר — שער הקריאה של הטבלה נעלם';
  end if;

  -- 6f. structure: 26 columns before, 28 after. A literal, so a stray column
  --     added by something else shows up here rather than in a screen.
  select count(*) into v_cols from information_schema.columns
   where table_schema='public' and table_name='documents';
  if v_cols <> 28 then
    raise exception '0075: documents נושאת % עמודות במקום 28 — משהו נוסף מחוץ למיגרציה הזו', v_cols;
  end if;

  -- 6g. the backfill wrote what was measured, to the row.
  --     640 derivations = 619 pulled + 21 app-issued, and 5 cancellations,
  --     counted 2026-09-09 against all 1,094 rows. A deviation means the data
  --     moved under the parse and the numbers must be re-measured before this
  --     is trusted — so it stops rather than records.
  select count(*) filter (where parent_relation='derived'),
         count(*) filter (where parent_relation='derived' and source='pull'),
         count(*) filter (where parent_relation='derived' and source='app'),
         count(*) filter (where parent_relation='cancellation')
    into v_derived, v_derived_pull, v_derived_app, v_cancel
    from public.documents;

  if v_derived <> 640 then
    raise exception '0075 canary: % שורות derived במקום 640 (צפוי 619 pull + 21 app) — הנתונים זזו מתחת לפרסר', v_derived;
  end if;
  if v_derived_pull <> 619 or v_derived_app <> 21 then
    raise exception '0075 canary: פילוח derived הוא % pull / % app במקום 619 / 21', v_derived_pull, v_derived_app;
  end if;
  if v_cancel <> 5 then
    raise exception '0075 canary: % שורות cancellation במקום 5 — שורת ביטול נקראה כאב או להפך', v_cancel;
  end if;

  -- 6h. no row was left half-parsed. The pair constraint already forbids it;
  --     this proves the backfill did not somehow produce zero-length arrays.
  select count(*) into v_orphan from public.documents
   where (parent_relation is null) <> (parent_doc_numbers is null)
      or (parent_doc_numbers is not null and array_length(parent_doc_numbers,1) is null);
  if v_orphan <> 0 then
    raise exception '0075 canary: % שורות עם עמודות הורה חצי-מלאות', v_orphan;
  end if;

  -- 6i. the multi-parent case really survived. If this is 0, the array was
  --     collapsed somewhere and the whole reason for text[] was lost.
  select count(*) into v_multi from public.documents
   where array_length(parent_doc_numbers,1) > 1;
  if v_multi <> 23 then
    raise exception '0075 canary: % שורות רב-הורה במקום 23 — המערך נקטע', v_multi;
  end if;

  raise notice '0075 OK — derived: % (% pull / % app) · cancellation: % · רב-הורה: % · עמודות: %',
    v_derived, v_derived_pull, v_derived_app, v_cancel, v_multi, v_cols;

  -- ---- 7. the ledger row, last. ---------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0075', now(), current_user,
    'קישור מסמך להורהו, מפורסר פעם אחת מתוך remarks של מורנינג — סכימה ובאקפיל בלבד, אפס שינוי התנהגות: שום קוד עדיין לא קורא את העמודות, הפרסור במשיכה והצ׳יפ ברג׳יסטרי הם שני צעדים נפרדים אחרי זה. שתי עמודות על documents: parent_doc_numbers text[] ו-parent_relation text. הבעיה: מסמך שהונפק ידנית במורנינג מגיע במשיכה כשורה מבודדת — 1,015 מתוך 1,035 שורות pull הן בלי job_id, ו-job_id הוא הקיבוץ היחיד שהטבלה הזאת אי פעם החזיקה, שכן production_id ריק בכל שורות ה-pull ו-bundle_job_ids עוגן ב-job. מורנינג כן רושם את השרשרת, במקום אחד בדיוק: שורת remarks שהוא מייצר על הילד, באותה צורה שה-sourceRemark שלנו כותב (morning/types.ts:113), והמחרוזת הזאת כבר יושבת אצלנו בתוך raw על כל שורה נמשכת — ואיש מעולם לא קרא אותה בחזרה. למה עמודה ולא תצוגה נגזרת (הכרעת בעלים 9.9): remarks הוא טקסט חופשי שמורנינג עשוי לנסח מחדש, והפרסור צריך לקרות פעם אחת בזמן כתיבה ולא בכל טעינת מסך, ועמודה שמורה היא גם מה שמאפשר join לצרכן עתידי. למה text[] ולא מפתח זר יחיד, וזו ההכרעה הנושאת: היחס הוא N:M ונמדד ולא הונח — 23 שורות כבר נושאות יותר מהורה אחד, ומסמך 50027 נושא תשעה (חשבונית מס מאוגדת שקיפלה תשעה חשבונות עסקה), כך שעמודת parent_document_id יחידה הייתה שומרת אחד מהתשעה ומאבדת שמונה, בדיוק במסמכים שבהם הסכום הגדול ביותר. ולמה מספרים ולא uuid: הילד יכול להימשך לפני האב — searchDocuments מדפדף לפי documentDate (morning/client.ts:280) וילד עשוי לשאת תאריך מוקדם מאביו או לנחות בעמוד אחר — ולכן uuid[] עם מפתח זר היה הופך את סדר המשיכה לאילוץ שלמות, והמשיכה הייתה מתחילה להיכשל על סדר במקום על נתונים. המספר הוא העובדה שמורנינג הצהיר עליה, ה-uuid הוא תוצאה של חיפוש: שומרים את העובדה ופותרים אותה ב-join בזמן קריאה, אמת אחת ולא שתיים. נמדד 9.9.26 שכל 1,094 ערכי morning_doc_number ייחודיים, אפס NULL, וכל הורה מוזכר כבר קיים מקומית — שתי העובדות נכונות בדיעבד אחרי מילוי לאחור מלא, אף אחת אינה מובטחת בזמן אמת, ואף אחת אינה נסמכת עליה כאן. אין אינדקס במכוון: הצרכן היחיד המתוכנן, צ׳יפ בשורת הרג׳יסטרי, קורא את המערך מהשורה שכבר בידו ואינו זקוק לאינדקס, ו-GIN הוא התוספת המתבקשת ביום שמישהו ישאל את השאלה ההפוכה — אילו מסמכים הונפקו כנגדי — וזו מיגרציה של שורה אחת כשיהיה קורא. למה parent_relation: חמש שורות קוראות ביטול חשבונית מס / קבלה 60162, כלומר קבלה שמבטלת מסמך, והן נושאות מספר בסוף השורה בדיוק כמו גזירה — פרסר שהיה חוטף את המספר האחרון היה מתייק ביטול כהורה והופך את משמעות הקישור בדיוק בחמש השורות שבהן טעות היא הכי יקרה. שניהם נשמרים, ו-parent_relation הוא מה שמבדיל: המספר נשמר גם לביטול, כי ביטול שיעדו אינו רשום הוא חסר תועלת, ולכן כל צרכן שעושה join על parent_doc_numbers חייב לסנן קודם לפי parent_relation — זו כל הסיבה שהעמודה השנייה קיימת. הפרסר מעוגן למחרוזת השלמה ולעולם לא מחפש מספר: ארבע משפחות חיות בעמודה הזאת ושלוש מהן מענישות פרסר רופף — שורת הגזירה בעברית, שורת הגזירה באנגלית שמורנינג כותב על מסמכים באנגלית ושפרסר על עבור בלבד מפספס בשקט, שורת הביטול, וטקסט חופשי על הצעות מחיר שמלא במספרים כמו 250 ש״ח ושוטף+30 ושפרסר של המספר-האחרון-מנצח היה רושם כמזהה מסמך. נמדד מול כל 1,094 השורות: 640 גזירות, 5 ביטולים, ו-24 ה-remarks שלא הותאמו הם כולם הצעות מחיר מסוג 10 עם טקסט חופשי — אפס ייחוסים אמיתיים מוחמצים. ה-for באנגלית תחום במילה כך ש-Proforma לא יכול לספק אותו. ההרשאות מוצהרות ולא מונחות לפי כלל 49: נמדד שגרנט ה-SELECT ברמת הטבלה ל-authenticated עומד ו-anon אינו מחזיק דבר, ולכן שתי העמודות נולדות קריאות ל-authenticated ואין צורך ב-GRANT ולא הונפק אחד. החצי השני של כלל 49 הוא הסיבה שזה נאמר במפורש: REVOKE עמודתי על הטבלה הזאת היה no-op, כי כל עוד authenticated=r יושב ב-relacl הפונקציה has_column_privilege ממשיכה להחזיר true, ההצהרה הייתה עוברת נקייה ולא משנה דבר — כך 0031 השאירה את המחירים ב-production_addons קריאים לכל טכנאי ולכן 0068 נאלצה לשלול את הטבלה כולה. מספר מסמך אב אינו כסף, הוא מאותה מחלקה כמו morning_doc_number שה-authenticated כבר קורא, ולכן אין כאן מה להסתיר ואין קומפרטמנטציה לבנות — וזו החלטה, וה-canary מאמת את שני כיווניה. קריאת השורה לא השתנתה ועדיין can_view_money דרך documents_select, וכתיבה לא השתנתה: לא נוסף policy ולכן כל מוטציה נשארת server-only דרך service role, בדיוק כפי שהמשיכה כבר רצה. הבאקפיל רץ על כל המקורות ולא רק על pull, כי השרשרת היא תכונה של המסמך ו-21 שורות שהונפקו מהאפליקציה נושאות אותה גם כן, מתוכן 7 בלי job_id, וסדר ההורים נשמר עם ordinality כי מורנינג מונה אותם בסדר משלו ומיון מחדש היה ממציא עובדה. תשע בדיקות canary לפני שורת הפנקס: anon אפס ברמת טבלה וברמת עמודה, authenticated כן קורא את שתי העמודות, אין הרשאת כתיבה, RLS דלוק ו-documents_select קיים, 28 עמודות, 640 גזירות בפילוח 619 pull ו-21 app, 5 ביטולים, אפס שורות חצי-מפורסרות, ו-23 שורות רב-הורה כדי להוכיח שהמערך לא נקטע. אפס DELETE, אפס נגיעה בעמודה קיימת, אפס שינוי בהתנהגות קיימת.');

end $$;
