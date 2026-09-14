-- 0079 — one live document of a kind per JOB, the way 0025 meant it per production
--
-- WHAT THIS IS FOR. pending_documents has exactly one uniqueness rule, and it
-- has a hole shaped like a column:
--
--   pending_documents_one_live_per_production
--     on (doc_type, production_id)
--     where production_id is not null
--       and status not in ('rejected','failed','cancelled')
--
-- `where production_id is not null` is what makes it partial, and an entire
-- class of queue row has always been on the wrong side of it. A row that bills
-- a JOB rather than an episode carries production_id NULL by construction, so
-- the index does not index it, does not constrain it, and cannot refuse a
-- second copy of it. There is no unique index on job_id either — six indexes on
-- the table, all read 2026-09-14 — so for those rows the database has never
-- said no to anything.
--
-- This adds the missing half, in the same shape.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE THIRD OF THREE — AND THE LAST
--
-- This is not one bug. It is the third time the same mistake has surfaced, and
-- writing that down is the point of this paragraph: THREE SEPARATE MECHANISMS
-- WERE BUILT AROUND production_id, AND "רדיו ושונות" WALKED UNDER ALL THREE.
-- 0074 gave misc work its own table precisely because productions could not
-- hold it — and every safety net downstream had been woven on the assumption
-- that money work is always anchored to a production.
--
--   1. THE RADAR ALERT — cancelled_with_work_order built its candidate set from
--      `d.production_id`, so a cancelled misc job with an issued work order in
--      Morning produced no alert at all. The net /productions relies on to
--      catch an orphaned document simply did not exist over there.
--      CLOSED 2026-09-14 (its own card, matched through job_id).
--
--   2. THE "IS IT BILLED" TEST — productions/[id]/cancel decides whether to
--      hide a job by reading invoice_biz/invoice_tax, which only a 300/305/320
--      ever stamps. The misc chain stops at 100, so a misc job whose work order
--      is already issued in Morning reads as "never billed".
--      NOT CLOSED — it matters only to a full misc cancellation route, which
--      does not exist yet, and it is recorded in the backlog with the fix:
--      ask whether a document was ISSUED for the job, not whether an invoice
--      number was stamped on it.
--
--   3. THIS INDEX. Closed here.
--
-- The pattern to carry forward, and the reason it belongs in a migration rather
-- than a commit message: WHEN A TABLE GETS A SECOND ANCHOR COLUMN, EVERY RULE
-- WRITTEN ON THE FIRST ONE BECOMES A HOLE. pending_documents has two — a row
-- points at its work through production_id OR job_id, never both — and the
-- three mechanisms above were each written when only one of them existed. The
-- next mechanism that keys on production_id should be assumed incomplete until
-- someone has asked what it does with a null.
--
-- ---------------------------------------------------------------------------
-- THE PREDICATE — 0063'S, CLAUSE FOR CLAUSE
--
--   on (doc_type, job_id)
--   where job_id is not null
--     and status not in ('rejected', 'failed', 'cancelled')
--
-- The status list is not retyped from judgement; it is the one 0063 left
-- behind, and it has to stay identical or the table acquires two different
-- definitions of "live" that drift the first time either moves. 0025 wrote it
-- as an allow-list (pending/approved/issued), 0047 inverted it to close a hole
-- in `accrued`, and 0063 put `cancelled` back on the free side so a cancelled
-- document releases its slot for a corrective one. Every one of those decisions
-- applies here for exactly the same reasons, and none of them was re-litigated.
--
-- ⚠️ THAT LAST CLAUSE IS LOAD-BEARING, AND THE DATA PROVES IT RATHER THAN
-- SUGGESTING IT. Measured 2026-09-14, before this was written:
--
--   under the full predicate ................ 0 duplicate keys, 0 rows
--   ignoring status .......................... 1 duplicate key
--
-- That one key is job 07faca02, twice, both with production_id NULL:
--   10318 · 2026-09-02 · cancelled
--   10327 · 2026-09-07 · issued     ← the replacement
--
-- A corrective work order: one cancelled, another issued five days later in its
-- place. Without `cancelled` on the free side this migration would fail with
-- 23505 on those two rows, and applying it anyway would have walled off a
-- repair path that already works in production. It also says something about
-- the hole being closed: BOTH of those rows carry production_id NULL, so that
-- entire correction ran with no uniqueness rule watching it at all.
--
-- ---------------------------------------------------------------------------
-- WHAT THE INDEX DOES AND DOES NOT COVER
--
-- COVERS: a queue row anchored to a job — every "רדיו ושונות" work order
-- (api/misc-productions and its step-6 button, both via lib/misc/workOrder.ts),
-- the registry's manual enqueue (api/documents/enqueue), and the contract
-- milestone routes. 44 rows today.
--
-- DOES NOT COVER, and deliberately:
--   · a BUNDLED row. It carries job_id NULL and production_id NULL and holds
--     its members in bundle_job_ids instead — an array, which this index cannot
--     see and a btree unique index cannot constrain. A bundle covers N jobs and
--     "one live document per job" is not a statement about it as a whole; the
--     same reason the cancelled-work block shipped today skips bundles.
--   · a row anchored to neither. Nothing to be unique about.
-- Both were already outside the production index for the same reason. This
-- widens the wall; it does not claim to finish it.
--
-- ---------------------------------------------------------------------------
-- WHY THIS AND NOT ONLY THE APPLICATION GUARD
--
-- The application guard is real and it is good: billMiscProduction stamps
-- misc_productions.job_id with `.is("job_id", null)` as the PREDICATE rather
-- than a read-then-write, so two concurrent callers cannot both match and the
-- loser deletes the job it made. That is what makes the step-6 button safe from
-- a double click today.
--
-- It is also the ONLY thing. It lives in one function, it protects the one
-- table it writes, and it says nothing about api/documents/enqueue, which
-- inserts a job-anchored row through a different path and guards itself with a
-- SELECT-then-INSERT that has a window between the two. 0025 wrote the original
-- index for precisely this reason — "iron rule 1, enforced in the schema rather
-- than trusted to the caller" — and the argument has not changed, only the
-- column it has to be written on.
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS — STATED, NOT ASSUMED (rule 49)
--
-- An index is not an ACL-bearing object. It grants nothing, revokes nothing,
-- and has no owner-visible privilege of its own: there is no GRANT that could
-- be forgotten here and no column born readable to the wrong role. That is the
-- whole of rule 49's first half as it applies to this file, and it is stated
-- rather than left silent because "no permissions changed" is a claim a reader
-- should be able to find rather than infer.
--
-- The second half still deserves a sentence, because it is the half that bites
-- without an error. Measured on this database, 2026-09-14:
--
--   has_table_privilege('authenticated','public.pending_documents','SELECT') = TRUE
--   has_table_privilege('anon',         'public.pending_documents','SELECT') = FALSE
--   RLS on, 2 policies (select: can_view_money, update: can_edit_money)
--
-- Nothing here touches any of that, and the canary asserts all of it unchanged
-- rather than trusting that an index cannot have moved it. If someone ever does
-- want to hide a column on this table, the shape that WORKS is revoke-then-
-- enumerate: a bare `revoke select (col)` would run clean and do nothing while
-- `authenticated=r` sits in relacl, which is how 0031 left production_addons'
-- prices readable to every technician until 0068 revoked the whole table.
--
-- ---------------------------------------------------------------------------
-- ZERO DELETE. ZERO row written. ZERO column added. One index.

do $mig$
declare
  v_rows_pre     bigint;
  v_rows_post    bigint;
  v_indexed      bigint;
  v_violating    int;
  v_idx_def      text;
  v_idx_unique   boolean;
  v_old_idx      text;
  v_index_count  int;

  v_auth_sel     boolean;
  v_anon_sel     boolean;
  v_rls          boolean;
  v_policy_sel   int;
  v_policy_upd   int;
begin
  -- ---------------------------------------------------------------------
  -- 0. GUARDS.
  -- ---------------------------------------------------------------------

  -- 0a. not re-runnable, and it says so.
  if exists (select 1 from public.schema_ledger where version = '0079') then
    raise exception '0079 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. the ledger is the sequence, not the filenames (migrations/README.md).
  --     0078 was applied 2026-09-10 20:38 UTC and this is the next number.
  if not exists (select 1 from public.schema_ledger where version = '0078') then
    raise exception '0079: 0078 אינה בפנקס — המספור נגזר מפנקס אחר, עצור ובדוק';
  end if;

  -- 0c. the index this one is modelled on must still exist AND still carry
  --     0063's predicate. The two are a matched pair from here on: if someone
  --     changes the status list on one, the table gets two meanings of "live"
  --     and this file's whole argument stops being true. Better to refuse now
  --     than to add a second rule that silently disagrees with the first.
  select indexdef into v_old_idx from pg_indexes
   where schemaname = 'public' and indexname = 'pending_documents_one_live_per_production';
  if v_old_idx is null then
    raise exception '0079: pending_documents_one_live_per_production אינו קיים — האינדקס שממנו הפרדיקט מועתק נעלם';
  end if;
  if v_old_idx not like '%rejected%' or v_old_idx not like '%failed%' or v_old_idx not like '%cancelled%' then
    raise exception '0079: רשימת הסטטוסים של 0063 השתנתה (%) — יישר קודם את שני האינדקסים, אל תוסיף הגדרה שנייה', v_old_idx;
  end if;

  -- ---------------------------------------------------------------------
  -- 1. THE MEASUREMENT, BEFORE THE INDEX — so a failure is a sentence and
  --    not a raw 23505 from the CREATE below.
  -- ---------------------------------------------------------------------
  select count(*) into v_rows_pre from public.pending_documents;

  select count(*) into v_indexed from public.pending_documents
   where job_id is not null
     and status not in ('rejected', 'failed', 'cancelled');

  select count(*) into v_violating from (
    select doc_type, job_id
      from public.pending_documents
     where job_id is not null
       and status not in ('rejected', 'failed', 'cancelled')
     group by doc_type, job_id
    having count(*) > 1
  ) d;

  if v_violating <> 0 then
    raise exception '0079: % מפתחות (doc_type, job_id) כבר כפולים בסטטוס חי — האינדקס ייכשל ב-23505. הכרע מה עושים עם הכפילויות לפני שמריצים', v_violating;
  end if;

  -- 44 when this was written. NOT a hard assert: the queue is a working
  -- table and this number moves every time a document is issued or a job is
  -- billed, so pinning it would turn an ordinary day into a failed migration.
  -- Reported in the notice instead, where a surprising value is visible
  -- without being fatal. The assert that matters is v_violating above.
  raise notice '0079: % שורות ייכנסו לאינדקס (היו 44 בכתיבה), אפס מפתחות כפולים', v_indexed;

  -- ---------------------------------------------------------------------
  -- 2. THE INDEX. `if not exists` for re-entrancy only — the ledger guard
  --    above is the real "run once", and this just means a half-applied
  --    attempt can be re-run without a confusing 42P07.
  -- ---------------------------------------------------------------------
  create unique index if not exists pending_documents_one_live_per_job
    on public.pending_documents (doc_type, job_id)
    where job_id is not null
      and status not in ('rejected', 'failed', 'cancelled');

  -- ---------------------------------------------------------------------
  -- 3. CANARY. All of it before the ledger row, so a failure rolls the
  --    whole migration back rather than recording a half-applied schema.
  -- ---------------------------------------------------------------------

  -- 3a. the index exists, is UNIQUE, and carries the predicate that was
  --     argued for. Asserting mere existence would pass on a non-unique
  --     index or one with the wrong status list — which is to say, on an
  --     index that does not do the one thing this file is for.
  select indexdef into v_idx_def from pg_indexes
   where schemaname = 'public' and indexname = 'pending_documents_one_live_per_job';
  if v_idx_def is null then
    raise exception '0079 canary: pending_documents_one_live_per_job לא נוצר';
  end if;

  select indisunique into v_idx_unique from pg_index
   where indexrelid = 'public.pending_documents_one_live_per_job'::regclass;
  if not coalesce(v_idx_unique, false) then
    raise exception '0079 canary: האינדקס נוצר אך אינו UNIQUE — הוא אינו חוסם דבר';
  end if;

  if v_idx_def not like '%job_id IS NOT NULL%'
     or v_idx_def not like '%rejected%'
     or v_idx_def not like '%failed%'
     or v_idx_def not like '%cancelled%'
     or v_idx_def not like '%doc_type%' then
    raise exception '0079 canary: פרדיקט האינדקס אינו זה שנטען (%)', v_idx_def;
  end if;

  -- 3b. and the 0063 index is untouched beside it. Two rules on one table,
  --     and this file swore they say the same thing about "live".
  if (select indexdef from pg_indexes
       where schemaname = 'public' and indexname = 'pending_documents_one_live_per_production')
     is distinct from v_old_idx then
    raise exception '0079 canary: pending_documents_one_live_per_production השתנה במהלך המיגרציה';
  end if;

  -- 3c. zero rows violated — restated AFTER the index exists, because until
  --     now it was a query and now it is a constraint that survived being
  --     built. A unique index cannot exist over duplicate rows, so reaching
  --     this line already proves it; the count is here so the notice can say
  --     so in numbers rather than by implication.
  select count(*) into v_violating from (
    select doc_type, job_id
      from public.pending_documents
     where job_id is not null
       and status not in ('rejected', 'failed', 'cancelled')
     group by doc_type, job_id
    having count(*) > 1
  ) d;
  if v_violating <> 0 then
    raise exception '0079 canary: % מפתחות כפולים אחרי יצירת האינדקס — בלתי אפשרי, עצור וברר', v_violating;
  end if;

  -- 3d. NOT ONE ROW MOVED. An index creates, deletes and rewrites nothing —
  --     and this is the assertion that says so out loud rather than assuming
  --     it, the same way 0077 asserted the job count it could not have
  --     changed.
  select count(*) into v_rows_post from public.pending_documents;
  if v_rows_post <> v_rows_pre then
    raise exception '0079 canary: מספר השורות בתור % במקום % — מיגרציה של אינדקס אינה אמורה לגעת בשורה', v_rows_post, v_rows_pre;
  end if;

  -- 3e. six indexes before, seven after. A literal, so an index added by
  --     something else outside this migration surfaces here.
  select count(*) into v_index_count from pg_indexes
   where schemaname = 'public' and tablename = 'pending_documents';
  if v_index_count <> 7 then
    raise exception '0079 canary: % אינדקסים על pending_documents במקום 7 — משהו נוסף מחוץ למיגרציה הזו', v_index_count;
  end if;

  -- 3f. permissions unchanged, both directions (rule 49). An index cannot
  --     move them; this proves it did not rather than assuming it could not.
  select has_table_privilege('anon', 'public.pending_documents', 'SELECT') into v_anon_sel;
  if v_anon_sel then
    raise exception '0079 canary: ל-anon יש SELECT על pending_documents — לא היה אמור, בדוק pg_default_acl';
  end if;

  select has_table_privilege('authenticated', 'public.pending_documents', 'SELECT') into v_auth_sel;
  if not v_auth_sel then
    raise exception '0079 canary: authenticated אינו קורא את pending_documents — מסך התור יירנדר ריק';
  end if;

  select relrowsecurity into v_rls from pg_class where oid = 'public.pending_documents'::regclass;
  if not v_rls then
    raise exception '0079 canary: RLS כבוי על pending_documents';
  end if;

  select count(*) into v_policy_sel from pg_policies
   where tablename = 'pending_documents' and policyname = 'pending_documents_select';
  select count(*) into v_policy_upd from pg_policies
   where tablename = 'pending_documents' and policyname = 'pending_documents_update';
  if v_policy_sel <> 1 or v_policy_upd <> 1 then
    raise exception '0079 canary: אחד משני ה-policies של pending_documents נעלם (select=%, update=%)', v_policy_sel, v_policy_upd;
  end if;

  raise notice '0079 OK — אינדקס ייחודי על (doc_type, job_id) · % שורות מאונדקסות · אפס כפילויות · % שורות בתור ללא שינוי · % אינדקסים',
    v_indexed, v_rows_post, v_index_count;

  -- ---------------------------------------------------------------------
  -- 4. the ledger row, last.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0079', now(), 'bnaya',
    'מסמך חי אחד מסוגו לכל job — החצי החסר של כלל הייחודיות של 0025. אינדקס אחד, אפס שינוי סכימה, אפס DELETE, אפס שורה שנכתבה. הבעיה: ל-pending_documents יש בדיוק כלל ייחודיות אחד, pending_documents_one_live_per_production על (doc_type, production_id), והוא חלקי — where production_id is not null. שורה שמחייבת job ולא פרק נושאת production_id ריק מעצם בנייתה, ולכן האינדקס אינו מאנדקס אותה, אינו מגביל אותה ואינו יכול לסרב לעותק שני שלה; ואין ולא היה אינדקס ייחודי על job_id (כל ששת האינדקסים על הטבלה נקראו 14.9). כלומר עבור מחלקת השורות הזאת המסד מעולם לא אמר לא לשום דבר. זה השלישי מתוך שלושה, וזו הסיבה שזה כתוב כאן ולא בהודעת קומיט: שלושה מנגנוני בטיחות נפרדים נבנו סביב production_id, ו-רדיו ושונות עברה מתחת לשלושתם, כי 0074 נתנה לעבודה הזאת טבלה משלה בדיוק משום ש-productions לא יכלה להחזיק אותה — וכל רשת בטיחות במורד הזרם נארגה על ההנחה שעבודה כספית עוגנת תמיד להפקה. הראשון: התראת הרדאר cancelled_with_work_order בנתה את קבוצת המועמדים שלה מ-d.production_id, כך שעבודת misc מבוטלת עם הזמנה שהונפקה במורנינג לא הפיקה התראה כלל — הרשת ש-/productions נסמכת עליה כדי לתפוס מסמך יתום פשוט לא הייתה קיימת שם; נסגר 14.9 בכרטיס משלו, מותאם דרך job_id. השני: מבחן האם ה-job חויב ב-productions/[id]/cancel נשען על invoice_biz ו-invoice_tax, שרק 300/305/320 חותמות, ושרשרת misc נעצרת ב-100 — ולכן job של misc שההזמנה שלו כבר הונפקה נקרא כמי שמעולם לא חויב; לא נסגר, כי הוא נוגע אך ורק למסלול ביטול misc מלא שטרם נבנה, והוא בבקלוג עם כיוון התיקון: לשאול אם הונפק מסמך על ה-job, לא אם נחתם מספר חשבונית. השלישי הוא האינדקס הזה. הדפוס להמשך, וזו הסיבה שהוא בפנקס: כשטבלה מקבלת עמודת עוגן שנייה, כל כלל שנכתב על הראשונה הופך לחור. ל-pending_documents יש שתיים — שורה מצביעה על העבודה שלה דרך production_id או דרך job_id ולעולם לא דרך שתיהן — ושלושת המנגנונים למעלה נכתבו כל אחד כשרק אחת מהן הייתה קיימת. המנגנון הבא שיסתמך על production_id צריך להיחשב לא שלם עד שמישהו שאל מה הוא עושה עם NULL. הפרדיקט הוא של 0063, סעיף אחר סעיף: on (doc_type, job_id) where job_id is not null and status not in (rejected, failed, cancelled). רשימת הסטטוסים אינה מוקלדת מחדש מתוך שיפוט אלא מועתקת, והיא חייבת להישאר זהה אחרת לטבלה יש שתי הגדרות שונות ל-חי שנסחפות בפעם הראשונה שאחת מהן זזה: 0025 כתבה רשימת היתר, 0047 הפכה אותה לרשימת איסור כדי לסגור חור ב-accrued, ו-0063 החזירה את cancelled לצד החופשי כדי שמסמך מבוטל ישחרר את מקומו למסמך מתקן. כל אחת מההכרעות האלה חלה כאן מאותן סיבות בדיוק ואף אחת לא נפתחה מחדש. הסעיף האחרון נושא משקל, והנתונים מוכיחים זאת ולא רק מרמזים: נמדד 14.9 לפני הכתיבה — תחת הפרדיקט המלא אפס מפתחות כפולים ואפס שורות, ובהתעלמות מהסטטוס מפתח כפול אחד. המפתח ההוא הוא job 07faca02 פעמיים, שתיהן עם production_id ריק: 10318 מ-2.9 בסטטוס cancelled, ו-10327 מ-7.9 בסטטוס issued — הזמנת עבודה מתקנת, אחת בוטלה ואחרת הונפקה במקומה חמישה ימים אחר כך. בלי cancelled בצד החופשי המיגרציה הזאת הייתה נכשלת ב-23505 על שתי השורות האלה, והחלה שלה בכל זאת הייתה חוסמת מסלול תיקון שכבר עובד בפרודקשן. זה גם אומר משהו על החור שנסגר כאן: שתי השורות נושאות production_id ריק, כלומר כל התיקון ההוא רץ בלי שום כלל ייחודיות שמשגיח עליו. מה שהאינדקס מכסה: שורת תור שעוגנת ל-job — כל הזמנת רדיו ושונות (ראוט היצירה וכפתור צעד 6, שניהם דרך lib/misc/workOrder.ts), ההכנסה הידנית מהרג׳יסטרי ב-api/documents/enqueue, וראוטי אבני הדרך של החוזים. 44 שורות היום. מה שאינו מכוסה ובמכוון: שורה מאוגדת, שנושאת job_id ריק ו-production_id ריק ומחזיקה את חבריה ב-bundle_job_ids — מערך, שאינדקס btree ייחודי אינו יכול לראות ואינו יכול להגביל; ואיגוד מכסה N עבודות ו-מסמך חי אחד לכל job אינה אמירה עליו כמכלול, אותה סיבה שחסימת העבודה המבוטלת שעלתה היום מדלגת על איגודים. וגם שורה שאינה עוגנת לאף אחד מהשניים, שאין בה מה לייחד. שתיהן היו מחוץ לאינדקס ההפקות מאותה סיבה; זה מרחיב את הקיר ואינו טוען לסיים אותו. למה אינדקס ולא רק הגארד באפליקציה: הגארד אמיתי וטוב — billMiscProduction מטביע את misc_productions.job_id עם is(job_id, null) כפרדיקט ולא כקריאה-ואז-כתיבה, כך ששני קוראים בו-זמנית אינם יכולים שניהם להתאים והמפסיד מוחק את ה-job שיצר, וזה מה שהופך את כפתור צעד 6 לבטוח מלחיצה כפולה היום. הוא גם היחיד. הוא חי בפונקציה אחת, מגן על הטבלה האחת שהוא כותב, ואינו אומר דבר על api/documents/enqueue שמכניס שורה עוגנת-job במסלול אחר ומגן על עצמו ב-SELECT ואז INSERT שיש ביניהם חלון. 0025 כתבה את האינדקס המקורי בדיוק מהסיבה הזאת — כלל הברזל נאכף בסכימה במקום להיות מופקד בידי הקורא — והטיעון לא השתנה, רק העמודה שעליה צריך לכתוב אותו. הרשאות לפי כלל 49: אינדקס אינו אובייקט נושא-ACL, הוא אינו מעניק ואינו שולל דבר ואין לו הרשאה משלו, ולכן אין כאן GRANT שאפשר לשכוח ואין עמודה שנולדת קריאה לתפקיד הלא נכון — וזה נאמר במפורש ולא מושאר לשתיקה, כי אין שינוי הרשאות היא טענה שקורא צריך למצוא ולא להסיק. החצי השני של הכלל מקבל משפט כי הוא החצי שמכה בלי שגיאה: נמדד ש-authenticated מחזיק SELECT ברמת הטבלה, anon אינו מחזיק דבר, RLS דלוק ושני policies קיימים — כלום מזה לא נגע, וה-canary מאמת את כולם כבלתי משתנים במקום לסמוך על כך שאינדקס לא יכול היה להזיז אותם. השומרים לפני הכתיבה: הפנקס אינו מכיל 0079, הפנקס כן מכיל 0078, ו-pending_documents_one_live_per_production עדיין קיים ועדיין נושא את שלושת הסטטוסים של 0063 — השניים הם זוג מכאן והלאה, ואם מישהו ישנה את רשימת הסטטוסים על אחד מהם לטבלה יהיו שתי משמעויות ל-חי, ועדיף לסרב עכשיו מאשר להוסיף כלל שני שחולק בשקט על הראשון. הספירה נמדדת לפני היצירה כדי שכשל יהיה משפט ולא 23505 גולמי מתוך ה-CREATE. תשע בדיקות canary לפני שורת הפנקס: האינדקס קיים, הוא UNIQUE (בדיקת קיום בלבד הייתה עוברת על אינדקס לא-ייחודי, כלומר על אינדקס שאינו עושה את הדבר האחד שהקובץ הזה קיים בשבילו), הפרדיקט שלו הוא זה שנטען, אינדקס 0063 לא השתנה לצדו, אפס מפתחות כפולים אחרי היצירה, מספר השורות בתור לא השתנה (מיגרציה של אינדקס אינה אמורה לגעת בשורה, ונאמר בקול במקום להיות מונח), שבעה אינדקסים במקום שישה, anon אפס ו-authenticated קורא, RLS דלוק ושני ה-policies קיימים. מספר השורות המאונדקסות מדווח ב-notice ואינו נאכף, כי התור הוא טבלת עבודה והמספר זז בכל הנפקה — קיבוע שלו היה הופך יום רגיל למיגרציה שנכשלת, והבדיקה שנושאת משקל היא ספירת הכפילויות.');

  raise notice '0079 הוחלה ונרשמה. מסמך חי אחד מסוגו לכל job — החור השלישי והאחרון מבין שלושת המנגנונים שנבנו סביב production_id.';

end $mig$;
