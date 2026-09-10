-- 0076 — transcript + separate audio file on a review round
--
-- WHAT THIS IS FOR. A technician can attach two optional extras to the round a
-- client is being asked to approve: a TRANSCRIPT (pasted text, or a link to a
-- document) and a SEPARATE AUDIO FILE. The public review page shows them under
-- "חומרים נוספים" — things the client RECEIVES, with no approve/reject buttons,
-- because they are not deliverables being judged.
--
-- SCOPE: schema only. Nothing reads or writes these yet — the routes, the
-- drawer fields and the carry-forward are three separate steps after this. No
-- existing column is touched, no row is written, no behaviour changes.
--
-- ---------------------------------------------------------------------------
-- WHY ON THE LINK AND NOT ON THE PRODUCTION — decided with the duplication in
-- full view (owner, 2026-09-10)
--
-- There are already TWO places media can live, at two different lifetimes, and
-- this migration deliberately adds to the shorter one:
--
--   client_review_links.episode_link   — PER ROUND. Written at every mint.
--   client_review_items.media_link     — PER PRODUCTION. Seeded once, at the
--                                        first mint ever (links.ts:63-95), and
--                                        sticky across every later round.
--
-- The episode's video usually does not change between rounds, so the sticky
-- item suits it. A TRANSCRIPT IS DERIVED FROM THE CONTENT: the moment the cut
-- changes, last round's transcript is not stale, it is WRONG — it describes a
-- version the client is no longer looking at. A sticky transcript would follow
-- a new cut and quietly misdescribe it. So it is bound to the round, and dies
-- with it.
--
-- The cost, stated rather than discovered later: on a second round the video
-- arrives via the sticky item while the transcript does not arrive at all,
-- until the carry-forward step lands. Two lifetimes for one episode, on
-- purpose. The carry-forward (a later step) is what closes it, and it is
-- deliberately explicit — it will copy the transcript and the audio forward
-- WITH A VISIBLE "נגרר מסבב קודם" mark the technician can see and correct,
-- rather than making them sticky and invisible.
--
-- NOT TOUCHED, ON PURPOSE: episode_link / reels_link do not carry forward
-- either — a second round minted without re-pasting gets NULL, and the client
-- still sees the video only because the sticky item covers for it. That is
-- live, working behaviour and this migration leaves it exactly alone. It is
-- written up in docs/TICKETS.md so it is not read as a bug in six months.
--
-- ---------------------------------------------------------------------------
-- ⚠️ ONE COLUMN ON client_review_links, NOT TWO — a deliberate deviation from
-- the brief, flagged rather than buried. Overrule and I will add the second.
--
-- The brief asked for two: the audio link, and a marker for "there is a
-- transcript" that does not carry the text. `audio_link` is here. The marker is
-- NOT, because the transcript row's EXISTENCE already is that fact:
-- client_review_transcripts is keyed by link_id, one row per link, so
-- `a row exists` and `has_transcript` would be the same statement written
-- twice. This codebase has already paid for that shape once — 0074 refused a
-- separate paid boolean beside paid_at for exactly this reason: "שני מקורות
-- לאותה עובדה סותרים זה את זה בפעם הראשונה שאחד נכתב בלי השני".
--
-- The cost of NOT having the flag is one extra SELECT in resolveLink, which
-- already runs four. The cost of having it is a flag that can disagree with the
-- table it summarises, on a page a client reads.
--
-- ---------------------------------------------------------------------------
-- PERMISSIONS — STATED, NOT ASSUMED (rule 49)
--
-- Measured on this database, 2026-09-10:
--   has_table_privilege('authenticated','public.client_review_links','SELECT') = TRUE
--   has_table_privilege('anon',         'public.client_review_links','SELECT') = FALSE
--   RLS on client_review_links: client_review_links_select USING can_view_stages()
--   client_review_items: RLS on, ZERO policies, and `authenticated` holds NO
--   grant at all — closed to everyone but the service role.
--
-- So the new COLUMN on client_review_links is readable by `authenticated` the
-- moment it exists, and no GRANT is issued or needed. The other half of rule 49
-- is why this is written down instead of inferred: a column-level REVOKE on
-- that table would be a NO-OP — while `authenticated=r` sits in relacl,
-- has_column_privilege keeps returning true, the statement runs clean and
-- changes nothing. That is how 0031 left production_addons' prices readable to
-- every technician and why 0068 had to revoke the whole table.
--
-- A link to an audio file IS NOT MONEY — same class of fact as episode_link,
-- which `authenticated` already reads — so there is nothing to hide and no
-- compartment to build. A decision, and the canary asserts both directions.
--
-- THE NEW TABLE follows client_review_items instead: revoked outright, RLS on,
-- no policies, service role only. The public page reads it through the service
-- role already (resolveLink), and the drawer will get it through a route that
-- checks permission explicitly — so a grant to `authenticated` would buy
-- nothing and widen the surface of a table that can hold an hour of speech.
-- Closed-by-default is the cheaper default, and it is the shape 0029 set for
-- client_review_links' writes and 0031 for production_addons.

do $$
declare
  v_links_cols   int;
  v_tr_cols      int;
  v_tr_rows      bigint;
  v_anon_l       boolean;
  v_anon_t       boolean;
  v_anon_col     boolean;
  v_auth_audio   boolean;
  v_auth_write   boolean;
  v_auth_tr      boolean;
  v_rls_l        boolean;
  v_rls_t        boolean;
  v_policy_l     int;
  v_policy_t     int;
begin
  -- 0. ledger guard — not re-runnable, and it says so.
  if exists (select 1 from public.schema_ledger where version = '0076') then
    raise exception '0076 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. order guard. 0069 removed the pg_default_acl entries for postgres;
  --     without it every table created here is born readable to anon and the
  --     canary at step 4 would (correctly) refuse to let this commit.
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — בלעדיה כל טבלה חדשה נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;

  -- ---- 1. the audio link, beside the media links it belongs with ----------
  alter table public.client_review_links
    add column if not exists audio_link text;

  -- ---- 2. the transcript body, in its own table --------------------------
  -- link_id is the PRIMARY KEY, not just a FK: that is what makes this "the
  -- transcript of this round" and not a history. A new transcript replaces the
  -- row; there is no second version to choose between, and no query anywhere
  -- has to ask which one is current.
  --
  -- ON DELETE CASCADE because a transcript without its round is not a record of
  -- anything — same reasoning as misc_production_suppliers in 0074: a component
  -- of its parent, not a row in its own right.
  create table if not exists public.client_review_transcripts (
    link_id     uuid primary key references public.client_review_links(id) on delete cascade,
    content     text not null,
    -- WHERE IT CAME FROM, and the reason this column is not optional. A later
    -- step will transcribe from the audio automatically; without a source, that
    -- job cannot tell its own previous output from an hour of a human's
    -- corrections, and would overwrite the second. 'link' means content holds a
    -- URL to a document rather than the text itself.
    source      text not null check (source in ('pasted', 'link', 'auto')),
    -- GENERATED, never written by a caller: a count that can disagree with the
    -- text it counts is worse than no count. NULL for a 'link' row, because the
    -- length of a URL is not a number of characters of transcript, and the log
    -- line ("תמלול עודכן, N תווים") would be lying if it printed one.
    char_count  integer generated always as
                  (case when source = 'link' then null else length(content) end) stored,
    created_at  timestamptz not null default now(),
    created_by  uuid references public.profiles(id)
  );

  -- ---- 3. permissions ----------------------------------------------------
  -- No GRANT and no REVOKE on client_review_links: the table grant already
  -- covers audio_link, and a column REVOKE there is a no-op (rule 49, header).
  --
  -- The new table is closed outright, in the order that actually works: revoke
  -- the table, then grant nothing. 0031 tried the reverse shape — a column
  -- revoke while the table grant stood — and it had no effect at all.
  revoke all privileges on public.client_review_transcripts from public, anon, authenticated;

  -- RLS on with NO policy, exactly like client_review_items: every read and
  -- write is server-side through the service role, after an explicit permission
  -- check in the app.
  alter table public.client_review_transcripts enable row level security;

  -- ---- 4. CANARY — all of it before the ledger row, so a failure rolls the
  --         whole migration back rather than recording a half-applied schema.

  -- 4a. anon gets nothing, at table level, on either table.
  select has_table_privilege('anon','public.client_review_links','SELECT'),
         has_table_privilege('anon','public.client_review_transcripts','SELECT')
    into v_anon_l, v_anon_t;
  if v_anon_l or v_anon_t then
    raise exception '0076 canary: ל-anon יש SELECT על אחת מטבלאות הביקורת — בדוק pg_default_acl (0069)';
  end if;

  -- 4b. ...and at column level, which a table-level false does not imply.
  select bool_or(has_column_privilege('anon','public.client_review_transcripts', c, 'SELECT'))
    into v_anon_col
    from unnest(array['content','source','char_count']) c;
  if coalesce(v_anon_col,false)
     or has_column_privilege('anon','public.client_review_links','audio_link','SELECT') then
    raise exception '0076 canary: ל-anon יש הרשאה עמודתית על העמודות החדשות';
  end if;

  -- 4c. the opposite failure, and the one that shows up as a blank screen weeks
  --     later (0055): authenticated MUST still read the link table's new column.
  select has_column_privilege('authenticated','public.client_review_links','audio_link','SELECT')
    into v_auth_audio;
  if not v_auth_audio then
    raise exception '0076 canary: authenticated אינו קורא את audio_link — גרנט הטבלה לא כיסה אותה';
  end if;

  -- 4d. and MUST NOT reach the transcript table at all.
  select bool_or(has_column_privilege('authenticated','public.client_review_transcripts', c, 'SELECT'))
    into v_auth_tr
    from unnest(array['content','source','char_count']) c;
  if coalesce(v_auth_tr,false)
     or has_table_privilege('authenticated','public.client_review_transcripts','SELECT') then
    raise exception '0076 canary: authenticated קורא את client_review_transcripts — ה-revoke לא תפס';
  end if;

  -- 4e. no write grant anywhere for authenticated.
  select has_table_privilege('authenticated','public.client_review_transcripts','INSERT')
      or has_table_privilege('authenticated','public.client_review_transcripts','UPDATE')
      or has_table_privilege('authenticated','public.client_review_transcripts','DELETE')
      or has_column_privilege('authenticated','public.client_review_links','audio_link','UPDATE')
    into v_auth_write;
  if v_auth_write then
    raise exception '0076 canary: ל-authenticated יש הרשאת כתיבה — כל כתיבה כאן היא server-only דרך service role';
  end if;

  -- 4f. RLS on for both; the link table's existing read gate untouched; the new
  --     table deliberately has NO policy, like client_review_items.
  select relrowsecurity into v_rls_l from pg_class where oid = 'public.client_review_links'::regclass;
  select relrowsecurity into v_rls_t from pg_class where oid = 'public.client_review_transcripts'::regclass;
  if not (v_rls_l and v_rls_t) then
    raise exception '0076 canary: RLS כבוי על אחת מטבלאות הביקורת';
  end if;
  select count(*) into v_policy_l from pg_policies
   where tablename='client_review_links' and policyname='client_review_links_select';
  if v_policy_l <> 1 then
    raise exception '0076 canary: client_review_links_select חסר — שער הקריאה של הלינקים נעלם';
  end if;
  select count(*) into v_policy_t from pg_policies where tablename='client_review_transcripts';
  if v_policy_t <> 0 then
    raise exception '0076 canary: נוצר policy על client_review_transcripts — הטבלה אמורה להיות service-role בלבד';
  end if;

  -- 4g. structure, as literals: 19 -> 20 on the links, 6 on the new table.
  select count(*) into v_links_cols from information_schema.columns
   where table_schema='public' and table_name='client_review_links';
  if v_links_cols <> 20 then
    raise exception '0076: client_review_links נושאת % עמודות במקום 20', v_links_cols;
  end if;
  select count(*) into v_tr_cols from information_schema.columns
   where table_schema='public' and table_name='client_review_transcripts';
  if v_tr_cols <> 6 then
    raise exception '0076: client_review_transcripts נוצרה עם % עמודות במקום 6', v_tr_cols;
  end if;

  -- 4h. born empty, and verified empty — there is no backfill here and nothing
  --     that could have written a row.
  select count(*) into v_tr_rows from public.client_review_transcripts;
  if v_tr_rows <> 0 then
    raise exception '0076: client_review_transcripts אינה ריקה (% שורות) — עצור וברר', v_tr_rows;
  end if;

  raise notice '0076 OK — client_review_links: % עמודות (audio_link נוסף) · client_review_transcripts: % עמודות, % שורות · anon אפס · authenticated קורא audio_link ולא את התמלול',
    v_links_cols, v_tr_cols, v_tr_rows;

  -- ---- 5. the ledger row, last. ------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0076', now(), current_user,
    'תמלול וקובץ אודיו נפרד לסבב ביקורת — סכימה בלבד, אפס שינוי התנהגות: שום קוד עדיין לא קורא ולא כותב, והראוטים, שדות הדרואר והגרירה הם שלושה צעדים נפרדים אחרי זה. עמודה אחת על client_review_links (audio_link text) וטבלה חדשה client_review_transcripts. הפיצ׳ר: הטכנאי מצרף לסבב שהלקוח מתבקש לאשר שני דברים אופציונליים — תמלול (טקסט מודבק או לינק למסמך) וקובץ אודיו נפרד — והדף הציבורי מציג אותם באזור חומרים נוספים, בלי כפתורי אישור, כי אלה דברים שהלקוח מקבל ולא שופט. למה על הלינק ולא על ההפקה, והכפילות מאושרת בעיניים פקוחות (הכרעת בעלים 10.9): כבר היום המדיה חיה בשני אורכי חיים — client_review_links.episode_link נכתב בכל מינטינג ולכן הוא פר-סבב, ואילו client_review_items.media_link נזרע פעם אחת בלבד במינטינג הראשון (links.ts:63-95) ודביק לכל הסבבים הבאים. הווידאו של הפרק לרוב אינו משתנה בין סבבים ולכן הפריט הדביק מתאים לו, אבל תמלול נגזר מהתוכן: ברגע שהעריכה משתנה, התמלול של הסבב הקודם אינו מיושן אלא שגוי — הוא מתאר גרסה שהלקוח כבר אינו רואה. תמלול דביק היה נגרר אחרי עריכה חדשה ומתאר אותה לא נכון, ולכן הוא קשור לסבב ומת איתו. המחיר מוצהר ולא יתגלה מאוחר: בסבב שני הווידאו מגיע דרך הפריט הדביק והתמלול אינו מגיע כלל, עד שצעד הגרירה ינחת — שני אורכי חיים לאותו פרק, במכוון. הגרירה תהיה מפורשת ולא דביקה: היא תעתיק תמלול ואודיו קדימה עם סימון גלוי נגרר מסבב קודם שהטכנאי רואה ויכול לעדכן, במקום להפוך אותם לדביקים ובלתי נראים. מה שלא נגעו בו במכוון: episode_link ו-reels_link גם הם אינם נגררים — סבב שני שנשלח בלי להדביק מחדש מקבל NULL, והלקוח בכל זאת רואה מדיה רק משום שהפריט הדביק מכסה על כך. זו התנהגות חיה שעובדת בפרודקשן והמיגרציה הזאת אינה נוגעת בה; היא מתועדת ב-docs/TICKETS.md כדי שלא תיקרא כבאג בעוד חצי שנה. עמודה אחת ולא שתיים על client_review_links, סטייה מוצהרת מהאפיון: התבקשו שתיים, האודיו וסמן ליש-תמלול שאינו נושא את הטקסט. האודיו כאן; הסמן לא, כי עצם קיומה של שורת התמלול הוא כבר העובדה הזאת — client_review_transcripts ממופתחת ב-link_id, שורה אחת ללינק, ולכן קיימת שורה ו-has_transcript הן אותה הצהרה פעמיים. הקוד הזה כבר שילם על הצורה הזו: 0074 סירבה לבוליאני paid נפרד לצד paid_at בדיוק מהסיבה הזו, שני מקורות לאותה עובדה סותרים זה את זה בפעם הראשונה שאחד נכתב בלי השני. המחיר של היעדר הסמן הוא SELECT אחד נוסף ב-resolveLink שממילא מריץ ארבעה; המחיר של קיומו הוא דגל שיכול לסתור את הטבלה שהוא מסכם, בדף שלקוח קורא. link_id הוא המפתח הראשי ולא רק מפתח זר, וזה מה שהופך את השורה לתמלול של הסבב הזה ולא להיסטוריה: תמלול חדש מחליף את השורה, אין גרסה שנייה לבחור בינה לבין הראשונה, ואף שאילתה אינה צריכה לשאול מי הנוכחית. ON DELETE CASCADE כי תמלול בלי הסבב שלו אינו רישום של דבר — אותו נימוק של misc_production_suppliers ב-0074, רכיב של האב ולא רשומה בפני עצמה. source הוא NOT NULL ולא אופציונלי כי צעד עתידי יתמלל אוטומטית מהאודיו, ובלי מקור העבודה ההיא אינה יכולה להבחין בין הפלט הקודם שלה לבין שעה של תיקונים אנושיים והייתה דורסת את השני; הערך link פירושו ש-content נושא כתובת למסמך ולא את הטקסט עצמו. char_count הוא עמודה מחושבת ולעולם אינו נכתב על ידי קורא, כי ספירה שיכולה לסתור את הטקסט שהיא סופרת גרועה מהיעדר ספירה, והוא NULL בשורת link כי אורך של כתובת אינו מספר תווים של תמלול ושורת הלוג תמלול עודכן, N תווים הייתה משקרת אילו הדפיסה מספר. ההרשאות מוצהרות ולא מונחות לפי כלל 49: נמדד ש-authenticated מחזיק SELECT ברמת הטבלה על client_review_links ו-anon אינו מחזיק דבר, ולכן audio_link נולדת קריאה ל-authenticated ואין צורך ב-GRANT ולא הונפק אחד; והחצי השני של הכלל הוא הסיבה שזה נאמר ולא מונח — REVOKE עמודתי שם היה no-op, כי כל עוד authenticated=r יושב ב-relacl הפונקציה has_column_privilege ממשיכה להחזיר true, ההצהרה עוברת נקייה ולא משנה דבר, וכך 0031 השאירה את המחירים ב-production_addons קריאים לכל טכנאי עד ש-0068 נאלצה לשלול את הטבלה כולה. לינק לקובץ אודיו אינו כסף, הוא מאותה מחלקה כמו episode_link שה-authenticated כבר קורא, ולכן אין מה להסתיר. טבלת התמלול הולכת אחרי client_review_items ולא אחרי client_review_links: revoke לטבלה כולה, RLS דלוק ואפס policies, service role בלבד — הדף הציבורי קורא אותה דרך service role ממילא ב-resolveLink, והדרואר יקבל אותה דרך ראוט שבודק הרשאה במפורש, ולכן גרנט ל-authenticated לא היה קונה דבר והיה מרחיב את המשטח של טבלה שעשויה להחזיק שעה של דיבור. שמונה בדיקות canary לפני שורת הפנקס: anon אפס על שתי הטבלאות ברמת טבלה וברמת עמודה, authenticated קורא את audio_link, authenticated אינו קורא את טבלת התמלול כלל, אפס הרשאת כתיבה, RLS דלוק על שתיהן ו-client_review_links_select עדיין קיים ואפס policies על החדשה, 20 עמודות בלינקים ו-6 בתמלול, והטבלה החדשה נולדת ריקה ונבדק שהיא ריקה. אפס DELETE, אפס backfill, אפס נגיעה בעמודה קיימת.');

end $$;
