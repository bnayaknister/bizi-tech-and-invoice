-- ============================================================================
-- 0099 — כתיבה ליומן גוגל בעת אישור בקשת הקלטה (E8). חמש עמודות על
-- `booking_requests`, אפס טבלה חדשה, אפס שינוי התנהגות עד שהקוד שמשתמש בהן
-- נדחף ו-CALENDAR_WRITE_DRY_RUN=false.
--
-- **אפס שינוי התנהגות ברגע ההחלה.** שום קוד עדיין לא כותב לעמודות האלה —
-- 🔴 הענף feat/calendar-write כולל קוד שמשתמש בהן, אבל המיגרציה הזו מוחלת
-- **לפני** שהענף נדחף (שלב 1 בסדר הפריסה, ראה דוח ה-PR). כל שורה קיימת
-- מקבלת null בכל חמש העמודות, וה-CHECK מתיר null.
--
-- ═══ 🔒 הכרעות הבעלים (7.10), מילה במילה ═══
--   · יומן משותף אחד עם חברת הפרסומות. לא יומן נפרד.
--   · חשבון שירות (Service Account) משותף ישירות, הרשאת "Make changes to
--     events". בלי Domain-Wide Delegation.
--   · הפקה נוצרת מיד באישור (מתווה א׳), ולא ממתינה לסנכרון.
--   · כתיבה שנכשלת → האישור נשאר, הכתיבה מדווחת בנפרד עם "נסה שוב".
--   · הקוד לעולם לא קורא ל-events.patch/delete על אירוע שהמזהה שלו אינו
--     שמור אצלנו כשייך לבקשה מאושרת — גוגל לא מאפשר "כתיבה בלבד" על יומן
--     משותף, זו משמעת קוד ולכן נאכפת בבדיקה (לא כאן — שום דבר כאן אינו
--     ACL ברמת גוגל, זו רק הסכימה ששומרת את מה שהקוד צריך כדי לדעת מה שלנו).
--
-- ═══ מה כל עמודה מחזיקה, ולמה שתיים ולא אחת לכל "מזהה" ═══
--   calendar_event_id    המזהה הדטרמיניסטי שהקוד עצמו ייצר (base32hex, נגזר
--                        מ-booking_requests.id — ראה lib/calendar/write.ts
--                        calendarEventIdFor), נשמר **לפני** הקריאה לגוגל.
--                        זהו מנגנון ה-idempotency כולו: timeout לא אומר
--                        "נכשל", והוא מה שמאפשר ניסיון חוזר בטוח עם אותו
--                        מזהה בדיוק (409 מגוגל = הצלחה, לא קונפליקט).
--   calendar_event_uid   ה-iCalUID שגוגל מחזיר בתשובה. 🔴 לא ה-`id` הרגיל —
--                        זה השדה ש-ical.js יקרא בשורת UID: כשהאירוע יופיע
--                        בפיד ה-ICS שהסנכרון כבר קורא, וזה מה ש-
--                        productions.calendar_uid יקבל כדי ש-buildSyncPlan
--                        יזהה את ההפקה כקיימת (sync.ts:67) ולא ייצור כפילה.
--   calendar_write_status / calendar_write_error   תוצאת הכתיבה, לתצוגה
--                        ול"נסה שוב" (POST /api/bookings/[id]/retry-calendar).
--   production_id        ההפקה שנוצרה (מתווה א׳) — FK, on delete set null
--                        (כמו documents.production_id, 0027:38): מחיקת הפקה
--                        לעולם לא אמורה למחוק את רשומת הבקשה המאושרת עצמה.
--
-- ═══ הרשאות — אותו דפוס בדיוק של 0097, לא ירושה ═══
-- 🔴 חמש עמודות חדשות **אינן** יורשות גרנט עמודתי קיים (0096:229-231,
--    0097). גרנט מפורש לחמשתן, ואז canary לשני הכיוונים.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0099_dryrun.sql`
--   2. הקובץ הזה
--   3. `supabase/verify/0099_verify.sql`
--
-- ⚠️ אחרי ההחלה חובה לייצר מחדש את `src/lib/supabase/database.types.ts`,
--    אחרת בדיקת הדריפט ב-`prebuild` תיפול והדיפלוי ייחסם. (הקוד בענף
--    feat/calendar-write עצמו כותב לעמודות האלה דרך `createAdminClient`
--    הלא-טיפוסי, לא `createTypedAdminClient` — אותו דפוס ש-calendar/sync
--    כבר משתמש בו למשפחת הקוד הזו — כך שה-build אינו תלוי בסדר הרצה בין
--    החלת המיגרציה לדחיפת הקוד.)
--
-- אפס DELETE, אפס שינוי נתונים, אפס טבלה חדשה.
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_rows   bigint;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0099') then
    raise exception '0099 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from public.schema_ledger where version = '0097') then
    raise exception '0097 טרם הוחלה — guest טרם קיימת, וההנחה כאן היא ש-booking_requests כבר 12 עמודות. הרץ אותה קודם';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests'
      and column_name in (
        'calendar_event_id', 'calendar_event_uid', 'calendar_write_status',
        'calendar_write_error', 'production_id'
      )
  ) then
    raise exception '0099: אחת מחמש העמודות כבר קיימת על booking_requests אך אינה בפנקס — מישהו הוסיף אותה מחוץ למיגרציה. בדוק מה היא מחזיקה לפני שתמשיך';
  end if;

  -- ── 1. העמודות ─────────────────────────────────────────────────────────────
  -- כולן null מפורש, בלי DEFAULT — אותה סיבה כמו 0097: DEFAULT '' היה יוצר
  -- שני ייצוגים לאותו מצב ("עדיין לא ניסינו" מול "ניסינו וקיבלנו ריק").
  alter table public.booking_requests
    add column calendar_event_id     text null,
    add column calendar_event_uid    text null,
    add column calendar_write_status text null,
    add column calendar_write_error  text null,
    add column production_id        uuid null references public.productions(id) on delete set null;

  -- `calendar_write_status`: null (עוד לא ניסינו) | 'created' | 'failed'.
  -- `is null or ... in (...)` מפורש — אותו דפוס בדיוק של booking_requests_guest_len_chk
  -- (0097) ולא הישענות על סמנטיקת שלושה-ערכים של CHECK מול null.
  alter table public.booking_requests
    add constraint booking_requests_calendar_write_status_chk
    check (calendar_write_status is null or calendar_write_status in ('created', 'failed'));

  -- בטחון נוסף, לא רק משמעת אפליקציה: שתי בקשות לעולם לא אמורות להצביע על
  -- אותה הפקה (כל אישור יוצר הפקה משלו). אינדקס חלקי — null מותר בכל מספר
  -- שורות, אותו דפוס כמו productions_calendar_uid_key (0019:35-37).
  create unique index if not exists booking_requests_production_id_key
    on public.booking_requests (production_id) where production_id is not null;

  -- ── 2. הרשאות ──────────────────────────────────────────────────────────────
  -- 🔴 לא בירושה. בלי זה חמש העמודות היו בלתי קריאות מכל סשן מחובר, והמסך
  --    היה מציג "לא נוצר" לכל שורה בלי שום שגיאה (הכשל של 0055, שוב).
  grant select (
    calendar_event_id, calendar_event_uid, calendar_write_status,
    calendar_write_error, production_id
  ) on public.booking_requests to authenticated;

  -- anon אינו מוזכר כלל — 0069 חלק א׳ כבר מבטיחה שעמודה חדשה נולדת סגורה
  -- בפניו; ה-canary למטה מודד את זה ולא מניח.

  -- ── 3. canary — שני הכיוונים ───────────────────────────────────────────────
  if not has_column_privilege('authenticated', 'public.booking_requests', 'production_id', 'select') then
    raise exception '0099 canary: ל-authenticated אין SELECT על booking_requests.production_id — הגרנט לא תפס';
  end if;
  if not has_column_privilege('authenticated', 'public.booking_requests', 'calendar_write_status', 'select') then
    raise exception '0099 canary: ל-authenticated אין SELECT על booking_requests.calendar_write_status — הגרנט לא תפס';
  end if;
  if has_column_privilege('anon', 'public.booking_requests', 'production_id', 'select')
     or has_column_privilege('anon', 'public.booking_requests', 'calendar_event_uid', 'select') then
    raise exception '0099 canary: ל-anon יש SELECT על אחת מחמש העמודות החדשות — בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  -- הכתיבה נשארת server-only — עמודה חדשה אינה עילה לפתוח אותה, בדיוק כמו 0097.
  if has_table_privilege('authenticated', 'public.booking_requests', 'insert')
     or has_table_privilege('authenticated', 'public.booking_requests', 'update')
     or has_table_privilege('authenticated', 'public.booking_requests', 'delete') then
    raise exception '0099 canary: ל-authenticated יש הרשאת כתיבה על booking_requests — כל שינוי חייב לעבור server-side';
  end if;

  -- ה-CHECK וה-FK וה-אינדקס באמת קיימים ומקושרים לטבלה הזו
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_requests'::regclass
      and contype = 'c' and conname = 'booking_requests_calendar_write_status_chk'
  ) then
    raise exception '0099 canary: אילוץ booking_requests_calendar_write_status_chk אינו קיים';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_requests'::regclass
      and contype = 'f'
      and confrelid = 'public.productions'::regclass
      and conname like '%production_id%'
  ) then
    raise exception '0099 canary: אין FK מ-booking_requests.production_id אל productions';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'booking_requests'
      and indexname = 'booking_requests_production_id_key'
  ) then
    raise exception '0099 canary: האינדקס הייחודי החלקי על production_id אינו קיים';
  end if;

  -- כל חמש העמודות nullable — אין הכרעת בעלים "חובה" כאן בשום צורה
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests'
      and column_name in (
        'calendar_event_id', 'calendar_event_uid', 'calendar_write_status',
        'calendar_write_error', 'production_id'
      )
      and is_nullable = 'NO'
  ) then
    raise exception '0099 canary: אחת מחמש העמודות אינה nullable';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests';
  if v_n_cols <> 17 then
    raise exception '0099 canary: booking_requests אמורה להיות 17 עמודות (12 מ-0096+0097 + 5 כאן), נמצאו %', v_n_cols;
  end if;

  -- אף שורה קיימת לא נגעה
  select count(*) into v_rows from public.booking_requests;
  if exists (
    select 1 from public.booking_requests
    where calendar_event_id is not null or calendar_event_uid is not null
       or calendar_write_status is not null or calendar_write_error is not null
       or production_id is not null
  ) then
    raise exception '0099 canary: יש שורה עם ערך לא-null באחת מחמש העמודות מיד אחרי יצירתן — זו מיגרציית סכימה בלבד';
  end if;

  -- ── 4. שורת הפנקס ──────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0099', now(), 'bnaya',
    'כתיבה ליומן גוגל בעת אישור בקשת הקלטה (E8) — חמש עמודות על booking_requests, אפס טבלה חדשה, אפס שינוי התנהגות עד שהקוד הנדחף משתמש בהן. '
    'calendar_event_id text null — המזהה הדטרמיניסטי (base32hex, נגזר מ-booking_requests.id) שהקוד מייצר ושומר לפני הקריאה לגוגל, ושמאפשר ניסיון חוזר בטוח אחרי timeout (409 מגוגל = הצלחה). '
    'calendar_event_uid text null — ה-iCalUID שגוגל מחזיר בתשובה, לא ה-id הרגיל; זה מה ש-productions.calendar_uid מקבל וזה מה ש-buildSyncPlan מזהה כקיים (sync.ts:67) כדי שהסנכרון הבא לא ייצור הפקה כפולה. '
    'calendar_write_status text null, CHECK null/created/failed, ו-calendar_write_error text null — תוצאת הכתיבה, לתצוגה ול-retry-calendar. '
    'production_id uuid null, FK אל productions on delete set null (כמו documents.production_id, 0027:38) — ההפקה שנוצרה מיד באישור (מתווה א׳, הכרעת בעלים 7.10), ואינדקס ייחודי חלקי מונע שתי בקשות על אותה הפקה. '
    'הכרעות בעלים 7.10 שהעמודות האלה משרתות: יומן משותף אחד עם חברת הפרסומות (לא נפרד); חשבון שירות משותף ישירות בהרשאת Make changes to events, בלי Domain-Wide Delegation; הפקה נוצרת מיד ולא ממתינה לסנכרון; כשל כתיבה משאיר את האישור ומדווח בנפרד עם אפשרות ניסיון חוזר; הקוד לעולם אינו קורא ל-events.patch/delete, כי גוגל אינו מציע הרשאת כתיבה-בלבד על יומן משותף וזו משמעת קוד הנאכפת בבדיקה. '
    'הרשאה הוענקה במפורש ולא בירושה, כמו 0097: גרנט עמודתי קיים (0096, 0097) אינו מתרחב לעמודות חדשות; anon אינו מוזכר כלל ונולד סגור בזכות 0069 חלק א׳; הכתיבה נשארת server-only. '
    'מחוץ להיקף במכוון: הקוד שמשתמש בעמודות (lib/calendar/write.ts, lib/calendar/createProductionFromEvent.ts, approve/route.ts, retry-calendar/route.ts) נדחף בנפרד, אחרי שהמיגרציה הזו מוחלת — ראה דוח ה-PR לסדר הפריסה המלא. אפס DELETE, אפס שינוי נתונים, אפס טבלה חדשה.');

  raise notice '✅ 0099: חמש עמודות הכתיבה ליומן נוספו ל-booking_requests (% עמודות בסך הכל, % שורות בטבלה). זכור לייצר מחדש את database.types.ts.', v_n_cols, v_rows;
end $mig$;
