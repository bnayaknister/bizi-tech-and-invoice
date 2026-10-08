-- ============================================================================
-- 0102 — שליחה אמיתית בוואטסאפ + ביטול הקלטה מאושרת (E9-3).
--
-- **שני שינויים, ושניהם תוספתיים בלבד**: שלוש עמודות ושני ערכי סטטוס על
-- `wa_messages`, וערך סטטוס אחד על `booking_requests`. אפס backfill, אפס
-- DELETE, אפס שינוי בשורה קיימת, ואפס עמודה שנמחקת.
--
-- ═══ למה שני נושאים בקובץ אחד, בניגוד לכלל ═══
-- בדרך כלל מיגרציה = נושא אחד, כדי שהפנקס יהיה קריא. כאן שני השינויים הם
-- **הרחבת CHECK של ערכי enum-בטקסט**, שניהם נדרשים לאותו שלב (E9-3), ושניהם
-- חולקים את אותה סכנה אחת שצריך לתעד פעם אחת: **CHECK שמורחב בעוד ערך הוא
-- שינוי שהקוד הקיים אינו יודע עליו**. פיצול לשני קבצים היה משכפל את ההסבר
-- הזה ומשאיר שתי הרצאות ידניות במקום אחת. הפנקס מתעד את שניהם במפורש.
--
-- ═══ 🔴 חלק א׳ — `wa_messages`: מה קורה אחרי שליחה אמיתית ═══
-- עד 0102 כל הודעה יוצאת נרשמה ב-`dry_run` (כלל 40). E9-3 מוסיף שליחה
-- אמיתית, ואיתה שלוש עובדות שלא היה להן מקום:
--
--   `provider_wamid` — המזהה ש-**Meta** מחזירה על שליחה מוצלחת.
--     🔴 **ולמה לא לדרוס את `wamid` הקיים:** `wamid` הוא **מפתח
--     האידמפוטנטיות שלנו** — `local:<kind>:<booking>:<recipient>` — וזה מה
--     שמונע שליחה כפולה של אותה התראה (ראה `notificationWamid`). אם היינו
--     מחליפים אותו במזהה של Meta, המפתח היה משתנה **אחרי** השליחה, ניסיון
--     חוזר לא היה מתנגש, ואותה התראה הייתה נשלחת פעמיים. שתי זהויות לשורה
--     אחת, כל אחת עם תפקיד אחר: שלנו למניעת כפילות, שלהם להתאמת עדכוני מצב.
--
--   `error` — נוסח הכשל משליחה שנכשלה. היום הוא נבלע ב-`console.error`.
--
--   `status_at` — מתי הגיע עדכון המצב האחרון. בלעדיו אי אפשר לדעת אם
--     `sent` הוא מלפני שנייה או מלפני יומיים.
--
-- ועוד **שני ערכי סטטוס**: `delivered` ו-`read`, שאלה עדכונים ש-Meta שולחת
-- ל-webhook. בלעדיהם הראוט היה מקבל עדכון תקף ונאלץ לזרוק אותו.
--
-- ⚠️ `provider_wamid` הוא `unique` **אבל לא `not null`**: שורה ב-`dry_run`
--    לעולם לא תקבל מזהה (אין שליחה), ושורה נכנסת אינה צריכה אותו. ב-Postgres
--    אילוץ `unique` מתיר כמה NULLים, ולכן זה בדיוק הכלי הנכון — והייחודיות
--    היא מה שמונע ששני עדכוני מצב יתאימו לשתי שורות שונות.
--
-- ═══ 🔴 חלק ב׳ — `booking_requests`: הסטטוס `cancelled` ═══
-- הכרעת בעלים: ביטול נעשה **ידנית** ע"י הבעלים או הצוות, והוא **משחרר את
-- המשבצת**. היום אין לזה סטטוס: `0096` מתיר `pending/approved/declined`
-- בלבד, ו-`declined` אינו מתאים — דחייה היא תשובה לבקשה שלא אושרה מעולם,
-- וביטול הוא הריסה של אישור שהלקוח כבר קיבל. מיזוג השניים היה הופך את
-- ההיסטוריה לבלתי קריאה.
--
-- 🟢 **ושחרור המשבצת הוא אפס עבודה, וזה מתוכנן ולא מקרי:**
--   · אילוץ ה-EXCLUDE של 0096 נושא `where (status = 'approved')`
--     (0096:193-196) — ברגע שהסטטוס אינו `approved`, השורה חדלה לחסום.
--   · `toApprovedRequests` מסנן `status === 'approved'`
--     (availabilityServer.ts:59) — המשבצת חוזרת לרשת הזמינות מעצמה.
-- כלומר אין כאן DELETE, אין שחרור ידני, ואין מקום שני שצריך לעדכן.
--
-- ⚠️ `booking_requests_decided_chk` (0096:171) **כבר מכסה את זה**: הוא דורש
--    `decided_at` לא-null לכל סטטוס שאינו `pending`, ו-`cancelled` הוא כזה.
--    אין מה לשנות בו, והביטול חייב לכתוב חותמת — מה שהוא עושה.
--
-- ⛔ **והקוד אינו מוחק מהיומן.** `write.ts` נשאר בלי `events.delete`
--    (write.ts:24-32, ובדיקה שקוראת את טקסט הקובץ שומרת על זה), כי `writer`
--    ביומן משותף יכול למחוק גם את האירועים של חברת הפרסומות. המסך מציג
--    תזכורת "מחקו את האירוע ביומן" — אדם מוחק, לא אנחנו.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0102_dryrun.sql`  — מוכיח את שני ה-CHECKים המורחבים
--      ואת הייחודיות, ואז מגלגל. **מסיים ב-`raise exception` גם בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0102_verify.sql`  — שורה אחת, כל העמודות true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--      — צעד 3 של הטקס. עד שהוא רץ, הקוד החדש עובד על הקליינט הלא-מוטפס
--      במכוון, כדי שבודק הסטיות יישאר ירוק (אותה בחירה כמו ב-0101).
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_br_status text[];
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0102') then
    raise exception '0102 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — היא מסירה את ברירות המחדל של pg_default_acl. הרץ אותה קודם';
  end if;
  -- גארד תלות אמיתי: הקובץ הזה מרחיב טבלה ש-0101 יצרה.
  if not exists (select 1 from public.schema_ledger where version = '0101') then
    raise exception '0101 טרם הוחלה — wa_messages אינה קיימת, ואין מה להרחיב. הרץ אותה קודם';
  end if;

  -- ── 1. wa_messages: שלוש עמודות ────────────────────────────────────────────
  alter table public.wa_messages
    add column if not exists provider_wamid text null,
    add column if not exists error          text null,
    add column if not exists status_at      timestamptz null;

  -- 🔴 ייחודי, ומתיר NULLים. ראה הכותרת: זה מה שמונע ששני עדכוני מצב
  --    יתאימו לשתי שורות, בעוד שורות dry_run ושורות נכנסות נשארות בלי מזהה.
  create unique index if not exists wa_messages_provider_wamid_key
    on public.wa_messages (provider_wamid) where provider_wamid is not null;

  -- ── 2. wa_messages: הרחבת ה-CHECK בשני ערכים ─────────────────────────────
  -- מוחלף ולא מתווסף: שני CHECKים על אותה עמודה היו נאכפים **שניהם**,
  -- והצר מביניהם היה ממשיך לדחות את הערכים החדשים בשקט.
  alter table public.wa_messages drop constraint if exists wa_messages_status_chk;
  alter table public.wa_messages
    add constraint wa_messages_status_chk
    check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'dry_run'));

  -- ⚠️ ואת אילוץ הצימוד צריך להרחיב **באותה נשימה**: הוא אומר
  -- `direction = 'out' and status <> 'received'`, ולכן `delivered`/`read`
  -- עוברים בו כבר עכשיו. הוא נשאר כפי שהוא — נאמר כאן במפורש כדי שלא
  -- ייראה כמו שכחה.

  -- ── 3. booking_requests: הסטטוס cancelled ────────────────────────────────
  alter table public.booking_requests drop constraint if exists booking_requests_status_chk;
  alter table public.booking_requests
    add constraint booking_requests_status_chk
    check (status in ('pending', 'approved', 'declined', 'cancelled'));

  -- ── 4. canary ──────────────────────────────────────────────────────────────
  -- ההרשאות של 0101 נשארות: אפס קריאה מכל תפקיד של סשן, אפס policy. עמודה
  -- חדשה על טבלה ששללה הכול יורשת את השלילה — ונבדק, ולא מונח.
  if has_table_privilege('anon', 'public.wa_messages', 'select')
     or has_table_privilege('authenticated', 'public.wa_messages', 'select') then
    raise exception '0102 canary: נוצרה הרשאת קריאה על wa_messages — העמודות החדשות נושאות מזהי Meta ונוסחי שגיאה';
  end if;
  if has_column_privilege('authenticated', 'public.wa_messages', 'provider_wamid', 'select') then
    raise exception '0102 canary: ל-authenticated יש SELECT על provider_wamid — ההרשאה דלפה דרך העמודה החדשה';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_messages') then
    raise exception '0102 canary: נמצאה policy על wa_messages — הטבלה אמורה להיות בלי אף policy';
  end if;

  -- שלושת העמודות קיימות
  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'wa_messages'
      and column_name in ('provider_wamid', 'error', 'status_at');
  if v_n_cols <> 3 then
    raise exception '0102 canary: שלוש העמודות החדשות אמורות להיות קיימות, nfound=%', v_n_cols;
  end if;
  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'wa_messages';
  if v_n_cols <> 13 then
    raise exception '0102 canary: wa_messages אמורה להיות 13 עמודות (10 מ-0101 + 3), nfound=%', v_n_cols;
  end if;

  -- האינדקס הייחודי קיים, והוא ההבטחה שהתאמת עדכוני מצב נשענת עליה
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'wa_messages'
      and indexname = 'wa_messages_provider_wamid_key'
  ) then
    raise exception '0102 canary: אין אינדקס ייחודי על provider_wamid — עדכון מצב עלול להתאים לשתי שורות';
  end if;

  -- 🔴 ושני ה-CHECKים באמת מתירים את הערכים החדשים. נבדק ע"י **ניסיון
  --    אמיתי** בקובץ ההרצה המדומה; כאן נבדק שהאילוץ קיים בשמו ושההגדרה
  --    שלו מכילה את המילים — אילוץ שהוחלף בשקט בגרסה צרה הוא בדיוק הכשל
  --    שהקובץ הזה עלול לייצר.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wa_messages'::regclass
      and conname = 'wa_messages_status_chk'
      and pg_get_constraintdef(oid) like '%delivered%'
      and pg_get_constraintdef(oid) like '%read%'
  ) then
    raise exception '0102 canary: wa_messages_status_chk אינו מכיל delivered/read';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_requests'::regclass
      and conname = 'booking_requests_status_chk'
      and pg_get_constraintdef(oid) like '%cancelled%'
  ) then
    raise exception '0102 canary: booking_requests_status_chk אינו מכיל cancelled';
  end if;

  -- ואילוץ ה-EXCLUDE לא נגעו בו: הוא מה שמשחרר את המשבצת בביטול
  if not exists (
    select 1 from pg_constraint where conname = 'booking_requests_no_overlap_approved'
  ) then
    raise exception '0102 canary: אילוץ ה-EXCLUDE של 0096 נעלם — ביטול לא ישחרר משבצת ושני אישורים יוכלו לחפוף';
  end if;

  -- אפס שורות נגעו, ונבדק: הקובץ הזה אינו קובץ נתונים
  select array_agg(distinct status order by status) into v_br_status from public.booking_requests;
  if v_br_status is not null and 'cancelled' = any(v_br_status) then
    raise exception '0102 canary: נמצאה שורת booking_requests במצב cancelled לפני שהקוד קיים — האם הקובץ רץ פעמיים?';
  end if;

  -- ── 5. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0102', now(), 'bnaya',
    'בוט הוואטסאפ, שלב E9-3 — שני שינויים תוספתיים בלבד, אפס backfill, אפס DELETE ואפס שינוי בשורה קיימת. '
    'חלק א, wa_messages: שלוש עמודות חדשות (provider_wamid, error, status_at) ושני ערכי סטטוס חדשים (delivered, read). provider_wamid הוא המזהה ש-Meta מחזירה על שליחה מוצלחת, והוא עמודה נפרדת ולא דריסה של wamid הקיים: wamid הוא מפתח האידמפוטנטיות שלנו, local:kind:booking:recipient, וזה מה שמונע שליחה כפולה של אותה התראה. דריסה שלו במזהה של Meta הייתה משנה את המפתח אחרי השליחה, ניסיון חוזר לא היה מתנגש, ואותה התראה הייתה נשלחת פעמיים. שתי זהויות לשורה אחת, כל אחת עם תפקיד: שלנו למניעת כפילות, שלהם להתאמת עדכוני מצב. האינדקס הייחודי על provider_wamid מתיר NULLים בכוונה, כי שורה ב-dry_run ושורה נכנסת לעולם לא יקבלו מזהה, והייחודיות היא מה שמונע שעדכון מצב יתאים לשתי שורות. error נוסף כי נוסח כשל שליחה נבלע היום ב-console.error, ו-status_at כי בלעדיו אי אפשר לדעת אם sent הוא מלפני שנייה או מלפני יומיים. '
    'חלק ב, booking_requests: הסטטוס cancelled. הכרעת בעלים — ביטול נעשה ידנית ע"י הבעלים או הצוות והוא משחרר את המשבצת. declined לא התאים: דחייה היא תשובה לבקשה שלא אושרה מעולם, וביטול הוא הריסה של אישור שהלקוח כבר קיבל, ומיזוג השניים היה הופך את ההיסטוריה לבלתי קריאה. '
    'שחרור המשבצת הוא אפס עבודה וזה מתוכנן: אילוץ ה-EXCLUDE של 0096 נושא where status = approved, ולכן שורה שסטטוסה אינו approved חדלה לחסום, ו-toApprovedRequests מסנן approved ולכן המשבצת חוזרת לרשת הזמינות מעצמה. אין DELETE, אין שחרור ידני, ואין מקום שני לעדכן. booking_requests_decided_chk כבר מכסה את cancelled כי הוא דורש decided_at לא-null לכל סטטוס שאינו pending, והביטול כותב חותמת. '
    'שני ה-CHECKים הוחלפו ולא נוספו: שני CHECKים על אותה עמודה היו נאכפים שניהם, והצר מביניהם היה ממשיך לדחות את הערכים החדשים בשקט. אילוץ הצימוד של wa_messages (direction out ו-status שאינו received) נשאר כפי שהוא ומתיר את delivered/read כבר עכשיו. '
    'הקוד אינו מוחק מהיומן: write.ts נשאר בלי events.delete, כי writer ביומן משותף יכול למחוק גם את האירועים של חברת הפרסומות, ובדיקה שקוראת את טקסט הקובץ שומרת על זה. המסך מציג תזכורת למחוק את האירוע, ואדם מוחק. '
    'ההרשאות של 0101 נשארות במלואן ונבדקו שוב: אפס קריאה מכל תפקיד של סשן, אפס policy, ואימות שהעמודות החדשות לא פתחו דלת — עמודה חדשה על טבלה ששללה הכול יורשת את השלילה, ונבדק ולא הונח. '
    'מחוץ להיקף במכוון: טבלת אנשי הקשר להזמנה (0103), וכל שינוי בפונקציות או בטריגרים.');

  raise notice '✅ 0102: wa_messages ncols=%, cancelled נוסף ל-booking_requests', v_n_cols;
end $mig$;
