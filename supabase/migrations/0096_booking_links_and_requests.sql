-- ============================================================================
-- 0096 — הזמנת הקלטות ע"י לקוחות, שלב 3: סכימה בלבד
--
-- שתי טבלאות: `booking_links` (קישור הזמנה קבוע לכל תוכנית) ו-`booking_requests`
-- (הבקשות שנכנסו דרכו). **אפס שינוי התנהגות** — שום קוד עדיין לא קורא אותן,
-- אין backfill, ואף שורה קיימת לא נגעה.
--
-- ═══ 🔒 הכרעות הבעלים (22.9), מילה במילה ═══
--   · קישור אחד פעיל לכל תוכנית: קבוע, רב-פעמי, **בלי תוקף**. הבעלים יכול
--     להחליף אותו בקוד חדש אם דלף — הישן מפסיק לעבוד.
--   · בבקשה נשמרים **רק** התוכנית, החדר, המועד והערה חופשית.
--     🔴 **בלי שם ובלי טלפון.** ראה "מה שאין כאן" למטה — זו אינה השמטה.
--   · אין כתיבה ליומן. אישור מייצר טקסט אירוע להדבקה ידנית.
--   · בקשה מאושרת חוסמת את המשבצת שלה **מיד**, עוד לפני שהאירוע ביומן.
--   · הקישור מציג ללקוח סטטוס: ממתינה / אושרה / נדחתה.
--
-- ═══ ⚠️⚠️ הכרעה שחייבת להתקבל לפני ההרצה — btree_gist ═══
-- ההבטחה "שתי בקשות מאושרות לא יחפפו באותו חדר" יכולה לשבת בשני מקומות:
--
--   במסד  — אילוץ EXCLUDE. דורש את ההרחבה `btree_gist`, ש**אינה מותקנת**
--           (נמדד 22.9: `0001_init.sql:5` מתקינה `pgcrypto` ו**רק** אותה,
--           ואין EXCLUDE אחד בכל הריפו). אילוץ כזה אינו ניתן לעקיפה — גם לא
--           ע"י שני אישורים בו-זמנית משני טאבים.
--   באפליקציה — בדיקה לפני ה-UPDATE. מהיר לכתוב, ו**נכשל בדיוק במקרה שבגללו
--           הוא קיים**: שתי בקשות שמאושרות באותו רגע קוראות שתיהן "פנוי"
--           ואז שתיהן כותבות. זהו race, לא היפותזה — זה הדפוס שגארד הכפילות
--           של 0065/0066 קיים בשבילו.
--
-- 🔴 **הקובץ הזה לא מתקין את ההרחבה מעצמו** ולא בוחר עבורך. הוא **עוצר**
--    עד שתסמן אחת מהשתיים בבלוק שמיד למטה. מיגרציה שמתקינה הרחבה בלי
--    שנשאלה היא בדיוק סוג השינוי שאי אפשר לגלות אחר כך מקריאת הפנקס.
--
-- ═══ מה שאין כאן, במכוון ═══
-- אין עמודת שם, אין טלפון, אין אימייל. ההכרעה היא של הבעלים, והמשמעות
-- המעשית: **הבעלים לא יכול ליצור קשר עם מבקש**. בקשה שאושרה מזוהה מול הלקוח
-- רק דרך הקישור שהוא עצמו מחזיק. זה מצמצם את הנזק אם קישור דולף — אין שם
-- נתונים אישיים לגנוב — ובאותה מידה אומר שאין דרך לברר "מי ביקש את זה".
-- כשהבעלים ירצה ליצור קשר, זו עמודה חדשה ומיגרציה חדשה, לא שינוי כאן.
--
-- ═══ הרשאות — לפי הכלל ש-0071 קבעה ═══
-- מיגרציה שיוצרת אובייקט נושא-ACL חייבת להצהיר על הרשאותיו **במפורש**
-- ולאמת אותן לפני שורת הפנקס: יצירה אינה פעולה ניטרלית בסכימה הזו
-- (`0069` חלק א׳ הסירה את רשומות `pg_default_acl` עבור `postgres`, ובלעדיה
-- כל אובייקט כאן נולד קריא ל-anon).
--
-- 🔴 **`token` אינו קריא לאף תפקיד מסשן.** הטוקן *הוא* האימות — מי שקורא את
--    העמודה יכול להזמין בשם כל תוכנית. הוא נקרא אך ורק דרך service role.
--    זו אותה הפרדה כמו `client_review_links`, ומאותה סיבה.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0096_dryrun.sql`  — מוכיח כל CHECK ואת ה-EXCLUDE, ואז
--      מגלגל. מסיים ב-`raise exception` גם בהצלחה.
--   2. הקובץ הזה.
--   3. `supabase/verify/0096_verify.sql`  — עמודות true + ספירות מדויקות.
--
-- אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.
-- ============================================================================

do $mig$
declare
  -- ══════════════════════════════════════════════════════════════════════════
  -- ⚠️ הכרעת הבעלים. לסמן **בדיוק אחת** מהשתיים כ-true לפני ההרצה.
  -- ══════════════════════════════════════════════════════════════════════════
  --
  -- install_btree_gist = true
  --   הקובץ יריץ `create extension btree_gist` ויצור את אילוץ ה-EXCLUDE.
  --   ההבטחה עוברת למסד ואינה ניתנת לעקיפה. ההרחבה היא חלק מ-contrib של
  --   PostgreSQL ונתמכת ב-Supabase; היא מוסיפה אופרטורים ל-GiST ואינה נוגעת
  --   בנתונים קיימים.
  --
  -- accept_app_only = true
  --   בלי הרחבה ובלי EXCLUDE. הטבלאות נוצרות, וההבטחה נשארת באפליקציה בלבד.
  --   🔴 שני אישורים בו-זמנית **יכולים** לייצר חפיפה, והמסד לא יעצור אותם.
  --   נבחר? אז כל נתיב אישור חייב לנעול את השורות (`select ... for update`)
  --   לפני שהוא בודק חפיפה, ואת זה צריך לכתוב ולבדוק בנפרד.
  --
  install_btree_gist boolean := true;
  accept_app_only    boolean := false;

  v_gist_present boolean;
  v_excl_created boolean := false;
  v_n_cols_links int;
  v_n_cols_reqs  int;
begin
  -- ── 0. הכרעה, ואז גארד סדר ─────────────────────────────────────────────────
  if install_btree_gist = accept_app_only then
    -- ⚠️ literal אחד, לא ארבעה מחוברים: הקידומת E חלה רק על הליטרל שאחריה,
    -- ולכן \n בליטרלים הבאים היה נשאר בקסלש-n על המסך.
    raise exception E'0096 נעצרה: לא סומנה הכרעה.\n  פתח את הקובץ, קרא את הבלוק "הכרעת הבעלים", וסמן **בדיוק אחת**:\n    install_btree_gist := true;   -- ההבטחה במסד, אילוץ EXCLUDE\n    accept_app_only    := true;   -- ההבטחה באפליקציה בלבד\n  אף טבלה לא נוצרה. אפס שינוי על המסד.';
  end if;

  -- גארד הרצה חוזרת. רועש, לעולם לא אידמפוטנטי-בשתיקה (הדפוס של 0074:127).
  if exists (select 1 from public.schema_ledger where version = '0096') then
    raise exception '0096 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד סדר. 0069 חלק א׳ היא זו שהסירה את רשומות pg_default_acl עבור
  -- postgres; בלעדיה כל טבלה כאן נולדת קריאה ל-anon וה-canary בשלב 5 היה
  -- (בצדק) מסרב לתת לקובץ לקומיט. נקוב כדרישה ולא מושאר ל-canary, כדי
  -- שהכשל יגיד מה לעשות ולא רק מה השתבש.
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — היא מסירה את ברירות המחדל של pg_default_acl, ובלעדיה כל טבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;

  select exists (select 1 from pg_extension where extname = 'btree_gist') into v_gist_present;
  raise notice '0096: btree_gist מותקן כרגע? %', v_gist_present;

  -- ── 1. booking_links ───────────────────────────────────────────────────────
  -- `token` נוצר באפליקציה ולא כאן, בדיוק כמו client_review_links: הוא
  -- `randomBytes(32).toString("base64url")` = 43 תווים url-safe
  -- (`src/lib/review/links.ts:11-14`). gen_random_uuid() היה 122 ביט של
  -- אנטרופיה בפורמט מנחש-ידידותי; 32 בתים הם 256.
  --
  -- אין `expires_at` — הכרעת בעלים: הקישור קבוע. זה ההפוך מ-client_review_links
  -- (14 יום, `links.ts:16`), ולכן זו **טבלה חדשה ולא שימוש חוזר**: מחזור החיים
  -- הפוך, ושדה תוקף שנשאר null היה מזמין קורא עתידי להתייחס אליו כאל באג.
  create table if not exists public.booking_links (
    id          uuid primary key default gen_random_uuid(),
    show_id     uuid not null references public.shows(id) on delete cascade,
    token       text not null unique,
    created_at  timestamptz not null default now(),
    created_by  uuid references public.profiles(id),
    -- null = פעיל. הבעלים מחליף קישור שדלף ע"י מילוי השדה הזה ומינוף חדש;
    -- השורה הישנה נשמרת כדי שאפשר יהיה לדעת שקישור כזה היה ונשלל.
    revoked_at  timestamptz,
    revoked_by  uuid references public.profiles(id),
    constraint booking_links_token_len check (char_length(token) between 20 and 200)
  );

  -- קישור פעיל **אחד** לכל תוכנית. חלקי, כי קישורים שנשללו נשארים בטבלה
  -- ואין הגבלה על מספרם.
  create unique index if not exists booking_links_one_active_per_show
    on public.booking_links (show_id) where revoked_at is null;

  create index if not exists booking_links_show_idx on public.booking_links (show_id);

  -- ── 2. booking_requests ────────────────────────────────────────────────────
  -- ⚠️ שלושת שמות החדרים כאן הם האיות **הקנוני** מ-`src/lib/calendar/studios.ts`
  --    (`canonical`, לא `variants`), ואחרי שמיגרציה 0095 נרמלה את הנתונים
  --    הקיימים לאותם שמות. TLV **אינו** ברשימה: הוא חדר אמיתי ומוכר בכל מקום
  --    שקורא שם חדר, ו-`bookable: false` — לקוח לא מזמין אותו.
  --    🔴 שינוי שם חדר בעתיד = שינוי כאן **וגם** ב-studios.ts באותו קומיט.
  --    הזזת צד אחד בלי השני פותחת מחדש את הפיצול ש-0095 סגרה.
  create table if not exists public.booking_requests (
    id          uuid primary key default gen_random_uuid(),
    show_id     uuid not null references public.shows(id) on delete cascade,
    -- דרך איזה קישור הבקשה נכנסה. נשמר גם אחרי שהקישור נשלל, כדי שאפשר יהיה
    -- לדעת אילו בקשות הגיעו דרך קישור שדלף.
    link_id     uuid not null references public.booking_links(id) on delete restrict,
    studio      text not null,
    start_at    timestamptz not null,
    end_at      timestamptz not null,
    note        text,
    status      text not null default 'pending',
    created_at  timestamptz not null default now(),
    decided_at  timestamptz,
    decided_by  uuid references public.profiles(id),

    constraint booking_requests_status_chk
      check (status in ('pending', 'approved', 'declined')),
    constraint booking_requests_studio_chk
      check (studio in ('גבעון', 'גבעון גדול', 'חשמונאים')),
    constraint booking_requests_range_chk
      check (end_at > start_at),
    -- 500 תווים. `char_length` ולא `length` על bytea, ו-null מותר (הערה היא
    -- אופציונלית) — `char_length(null) <= 500` הוא null, ו-CHECK עובר על null.
    constraint booking_requests_note_len_chk
      check (note is null or char_length(note) <= 500),
    -- החלטה וחותמת נוסעות יחד: שורה שנקבע לה סטטוס בלי מי/מתי, או להפך, היא
    -- רשומת אודיט חסרה.
    constraint booking_requests_decided_chk
      check ((status = 'pending' and decided_at is null) or (status <> 'pending' and decided_at is not null))
  );

  create index if not exists booking_requests_show_idx    on public.booking_requests (show_id);
  create index if not exists booking_requests_link_idx    on public.booking_requests (link_id);
  create index if not exists booking_requests_pending_idx on public.booking_requests (created_at) where status = 'pending';
  -- הפרדיקט שמסך הזמינות ישאל: מה מאושר בחדר הזה בטווח הזה
  create index if not exists booking_requests_approved_idx
    on public.booking_requests (studio, start_at) where status = 'approved';

  -- ── 3. ההבטחה: אין שתי מאושרות חופפות באותו חדר ────────────────────────────
  if install_btree_gist then
    create extension if not exists btree_gist;
    -- `studio WITH =` דורש btree_gist: GiST לבדו אינו יודע שוויון על text.
    -- `WHERE (status = 'approved')` הוא הלב — שתי בקשות **ממתינות** חופפות הן
    -- מצב תקין ושכיח (שני לקוחות ביקשו את אותה משבצת), והבעלים מכריע ביניהן.
    -- רק האישור הוא בלעדי.
    if not exists (
      select 1 from pg_constraint where conname = 'booking_requests_no_overlap_approved'
    ) then
      alter table public.booking_requests
        add constraint booking_requests_no_overlap_approved
        exclude using gist (
          studio with =,
          tstzrange(start_at, end_at) with &&
        ) where (status = 'approved');
    end if;
    v_excl_created := true;
  else
    raise notice E'⚠️ 0096: accept_app_only נבחר — **אין** אילוץ EXCLUDE.\n   שני אישורים בו-זמנית יכולים לייצר חפיפה, והמסד לא יעצור אותם.\n   נתיב האישור חייב לנעול (select ... for update) לפני שהוא בודק.';
  end if;

  -- ── 4. RLS + הרשאות, בדפוס של client_review_links (0029:44-52) ─────────────
  alter table public.booking_links    enable row level security;
  alter table public.booking_requests enable row level security;

  -- קריאה לצוות; כתיבה מאף סשן — לא. הדף הציבורי וראוט הבקשה רצים על
  -- service role, ש-RLS אינו חל עליו.
  drop policy if exists booking_links_select on public.booking_links;
  create policy booking_links_select on public.booking_links
    for select using (public.can_view_stages());

  drop policy if exists booking_requests_select on public.booking_requests;
  create policy booking_requests_select on public.booking_requests
    for select using (public.can_view_stages());

  -- ⚠️ הסדר חשוב, ו-0031 שילמה עליו: שלילה עמודתית **אינה** גוברת על גרנט
  -- ברמת טבלה. רק היעדר גרנט הטבלה הופך את הגרנטים העמודתיים לנושאי משקל.
  -- לכן קודם שלילה מלאה, ואז הענקה עמודה-עמודה.
  revoke all privileges on public.booking_links    from public, anon, authenticated;
  revoke all privileges on public.booking_requests from public, anon, authenticated;

  -- 🔴 `token` נעדר מהרשימה **בבנייה**, לא בשלילה מאוחרת. זה מה שהופך אותו
  --    לבלתי קריא בפועל מכל סשן.
  grant select (id, show_id, created_at, created_by, revoked_at, revoked_by)
    on public.booking_links to authenticated;

  grant select (id, show_id, link_id, studio, start_at, end_at, note,
                status, created_at, decided_at, decided_by)
    on public.booking_requests to authenticated;

  -- ── 5. canary — שני הכיוונים ───────────────────────────────────────────────
  -- הסכימה נכוותה מכל אחד מהם: ההרצה הראשונה של 0071 מתה כי ל-anon הייתה
  -- הרשאה שאיש לא העניק, ו-0055 נאלצה להוסיף גרנט שנשכח אחרי שכרטיס תוכנית
  -- רונדר ריק. גרנט רחב מדי ושלילה רחבה מדי הם שני כשלים, ואף אחד מהם לא
  -- מכריז על עצמו על המסך.
  if has_table_privilege('anon', 'public.booking_links', 'select')
     or has_table_privilege('anon', 'public.booking_requests', 'select') then
    raise exception '0096 canary: ל-anon יש SELECT על אחת הטבלאות החדשות — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_column_privilege('anon', 'public.booking_links', 'token', 'select') then
    raise exception '0096 canary: ל-anon יש SELECT על booking_links.token — הטוקן חשוף';
  end if;
  if has_column_privilege('authenticated', 'public.booking_links', 'token', 'select') then
    raise exception '0096 canary: ל-authenticated יש SELECT על booking_links.token — הטוקן אינו מקומפרטמנט. ודא שה-revoke ברמת הטבלה קדם לגרנטים העמודתיים';
  end if;
  if not has_column_privilege('authenticated', 'public.booking_requests', 'status', 'select') then
    raise exception '0096 canary: ל-authenticated אין SELECT על booking_requests.status — גרנט נשכח, והמסך יירנדר ריק (הכשל של 0055)';
  end if;
  if has_table_privilege('authenticated', 'public.booking_requests', 'insert')
     or has_table_privilege('authenticated', 'public.booking_requests', 'update')
     or has_table_privilege('authenticated', 'public.booking_requests', 'delete') then
    raise exception '0096 canary: ל-authenticated יש הרשאת כתיבה על booking_requests — כל שינוי חייב לעבור server-side';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.booking_links'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.booking_requests'::regclass) then
    raise exception '0096 canary: RLS אינו דלוק על אחת הטבלאות';
  end if;
  if install_btree_gist and not exists (
    select 1 from pg_constraint where conname = 'booking_requests_no_overlap_approved'
  ) then
    raise exception '0096 canary: install_btree_gist נבחר אבל אילוץ ה-EXCLUDE אינו קיים';
  end if;

  select count(*) into v_n_cols_links from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_links';
  select count(*) into v_n_cols_reqs from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests';
  if v_n_cols_links <> 7 then
    raise exception '0096 canary: booking_links אמורה להיות 7 עמודות, נמצאו %', v_n_cols_links;
  end if;
  if v_n_cols_reqs <> 11 then
    raise exception '0096 canary: booking_requests אמורה להיות 11 עמודות, נמצאו %', v_n_cols_reqs;
  end if;
  -- הטבלאות נולדות ריקות, ונבדק שהן ריקות
  if (select count(*) from public.booking_links) <> 0
     or (select count(*) from public.booking_requests) <> 0 then
    raise exception '0096 canary: טבלה חדשה אינה ריקה — האם הקובץ רץ פעמיים על נתונים?';
  end if;

  -- ── 6. שורת הפנקס ──────────────────────────────────────────────────────────
  -- ⚠️ `schema_ledger` ולא `events`: זה קובץ סכימה-בלבד, והתקדים הוא 0074:400.
  -- 0095 כתבה ל-`events` כי היא שינתה **נתונים** ושורת הפנקס שלה הייתה
  -- הרשומה היחידה של הספירות. כאן אין נתונים שזזו — יש סכימה חדשה, ומיגרציה
  -- שאינה נרשמת בפנקס היא שינוי סכימה שאיש לא ימצא אחר כך (הלקח של 0052).
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0096', now(), 'bnaya',
    'הזמנת הקלטות ע"י לקוחות, שלב 3 — סכימה בלבד, אפס שינוי התנהגות: שום קוד עדיין לא קורא את הטבלאות, אין backfill ואף שורה קיימת לא נגעה. שתי טבלאות, booking_links ו-booking_requests. '
    'הכרעות הבעלים (22.9): קישור אחד פעיל לכל תוכנית, קבוע, רב-פעמי ובלי תוקף, שהבעלים מחליף בקוד חדש אם דלף; בבקשה נשמרים רק התוכנית, החדר, המועד והערה חופשית; אין כתיבה ליומן ואישור מייצר טקסט להדבקה; בקשה מאושרת חוסמת את המשבצת מיד, עוד לפני שהאירוע ביומן; הקישור מציג ללקוח ממתינה/אושרה/נדחתה. '
    'אין עמודת שם, טלפון או אימייל, וזו הכרעה ולא השמטה: המשמעות המעשית היא שהבעלים אינו יכול ליצור קשר עם מבקש, ובקשה מזוהה מול הלקוח רק דרך הקישור שהוא עצמו מחזיק. זה מצמצם את הנזק בדליפת קישור — אין נתונים אישיים לגנוב — ובאותה מידה אומר שאין דרך לברר מי ביקש. יצירת קשר בעתיד = עמודה חדשה ומיגרציה חדשה. '
    'אין expires_at, בניגוד ל-client_review_links שחי 14 יום (links.ts:16): מחזור החיים הפוך בדיוק, ולכן זו טבלה חדשה ולא שימוש חוזר — שדה תוקף שנשאר null היה מזמין קורא עתידי להתייחס אליו כבאג. '
    'token נוצר באפליקציה ולא במיגרציה, אותו מנגנון כמו client_review_links: randomBytes(32).toString("base64url") = 43 תווים url-safe, 256 ביט (links.ts:11-14). gen_random_uuid() היה 122 ביט בפורמט מנחש-ידידותי. העמודה נעדרת מרשימת הגרנט בבנייה ולא בשלילה מאוחרת, ולכן אינה קריאה מאף סשן — הטוקן הוא האימות עצמו, ומי שקורא אותו יכול להזמין בשם כל תוכנית. '
    'אינדקס ייחודי חלקי where revoked_at is null נותן קישור פעיל אחד לכל show_id, בעוד קישורים שנשללו נשארים בטבלה בלי הגבלת מספר, כדי שאפשר יהיה לדעת שקישור כזה היה ונשלל ואילו בקשות הגיעו דרכו (link_id הוא on delete restrict מאותה סיבה). '
    'שלושת שמות החדרים ב-CHECK הם האיות הקנוני מ-studios.ts אחרי שמיגרציה 0095 נרמלה את הנתונים לאותם שמות; TLV אינו ברשימה כי bookable=false — הוא חדר אמיתי ומוכר בכל מקום שקורא שם חדר, ולקוח אינו מזמין אותו. שינוי שם חדר בעתיד חייב לזוז כאן וב-studios.ts באותו קומיט, אחרת הפיצול ש-0095 סגרה נפתח מחדש. '
    'שתי בקשות ממתינות חופפות מותרות במכוון: זה מצב תקין ושכיח, שני לקוחות ביקשו את אותה משבצת, והבעלים מכריע ביניהן. רק האישור בלעדי, ולכן ה-EXCLUDE נושא WHERE (status = ''approved''). '
    'הכרעת btree_gist מתועדת בשדות owner_choice ו-exclude_constraint_created למטה: ההרחבה לא הייתה מותקנת לפני הקובץ הזה (0001:5 מתקינה pgcrypto ורק אותה, ואין EXCLUDE אחד בכל הריפו), והקובץ אינו מתקין אותה מעצמו אלא עוצר עד שמסמנים. נבחר accept_app_only? אז ההבטחה באפליקציה בלבד, שני אישורים בו-זמנית יכולים לייצר חפיפה, וכל נתיב אישור חייב לנעול select ... for update לפני שהוא בודק. '
    'החלטה וחותמת נוסעות יחד ב-CHECK אחד: שורה עם סטטוס שאינו pending בלי decided_at, או להפך, היא רשומת אודיט חסרה. '
    'ההרשאות מוצהרות ומאומתות לפי הכלל ש-0071 קבעה, כי יצירה אינה פעולה ניטרלית בסכימה הזו, והסדר הוא שלילה ברמת הטבלה ואז הענקה עמודה-עמודה — 0031 ניסתה את הצורה ההפוכה ו-0068 נאלצה לתקן. אפס הרשאות כתיבה לאף תפקיד מלבד service_role ואין policy ל-INSERT/UPDATE/DELETE: כל שינוי הוא server-only, אותו כלל של client_review_links (0029) ו-production_addons (0031). '
    'מחוץ להיקף במכוון: הראוט הציבורי, מסך הבקשות, כפתור האישור, מחולל טקסט האירוע, וכל הגבלת קצב. אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.');

  raise notice '✅ 0096: שתי טבלאות נוצרו (% ו-% עמודות). EXCLUDE: %.',
    v_n_cols_links, v_n_cols_reqs,
    case when v_excl_created then 'קיים' else 'לא נוצר (accept_app_only)' end;
end $mig$;
