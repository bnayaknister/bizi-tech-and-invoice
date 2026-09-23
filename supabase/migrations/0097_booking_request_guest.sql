-- ============================================================================
-- 0097 — שם האורח/ת בבקשת הזמנה. עמודה אחת, `booking_requests.guest`.
--
-- **אפס שינוי התנהגות.** שום קוד עדיין לא קורא ולא כותב את העמודה, אין
-- backfill, ואף שורה קיימת לא נגעה (הטבלה נולדה ריקה ב-0096 ואיש עוד לא
-- כותב אליה). זו סכימה בלבד, בדיוק כמו 0096.
--
-- ═══ 🔒 הכרעת הבעלים (23.9), מילה במילה ═══
--   · הלקוח ממלא בבקשה **שדה פתוח אחד**: "שם האורח/ת".
--   · **רשות.** ריק = פרק בלי אורח, וזה מצב תקין ולא חסר.
--   · **אין בדיקות שמטריחות את הלקוח.** כל ההתאמה לפורמט נעשית בקוד.
--   · המטרה: שכותרת האירוע המאושר תיקרא ע"י הסנכרון כהפקה עם האורח הנכון,
--     בשביל החשבוניות.
--
-- ═══ למה 120 תווים ═══
-- גבול שפוי ולא מדיד: אין היום עמודת אורך על `productions.guest` שאפשר היה
-- להסיק ממנה מספר. 120 מכיל בנוחות שני שמות מלאים בעברית ואת מילת החיבור
-- ביניהם, והוא קצר מספיק כדי שהכותרת שתיווצר ממנו תישאר קריאה ביומן.
-- `char_length` ולא `octet_length`: שם בעברית הוא שני בתים לתו, וגבול בבתים
-- היה חותך שם עברי באמצע ב-60 תווים. ההרצה המדומה מוכיחה בדיוק את זה —
-- 120 תווים עבריים (240 בתים) עוברים.
--
-- ═══ 🔴 מחרוזת ריקה — נדחית במסד, מנורמלת באפליקציה ═══
-- ה-CHECK דורש `char_length(guest) between 1 and 120`, ולכן `''` **נדחה**.
-- זו אינה קשיחות כלפי הלקוח: טופס ריק הוא מצב תקין, והאפליקציה היא זו
-- שמתרגמת `''` ל-`null` לפני ה-INSERT. הסיבה שהמסד בכל זאת דוחה: `''`
-- ו-`null` היו שני ייצוגים לאותו מצב, וקוד שקורא את העמודה היה חייב לבדוק
-- את שניהם לנצח. מצב אחד, ייצוג אחד.
--
-- ═══ מה שאין כאן, במכוון ═══
-- אין עמודת שם מבקש, טלפון או אימייל — הכרעת 0096 לא נפתחת כאן. `guest`
-- הוא **שם האורח/ת של הפרק**, לא פרטי הקשר של מי שביקש, ואינו הופך את
-- הבקשה למזוהה: הבעלים עדיין אינו יכול ליצור קשר עם מבקש.
--
-- אין נרמול, אין trim ואין ניקוי במסד. הכותרת נבנית בקוד, מפונקציה טהורה,
-- והמסד שומר את מה שהלקוח כתב. מסד שמנקה היה מוחק את המקור שאי אפשר לשחזר.
--
-- ═══ הרשאות — אותו דפוס של 0096, ולא בירושה ═══
-- 🔴 עמודה חדשה **אינה** יורשת גרנט עמודתי קיים. ב-0096 הוענק
--    `grant select (id, show_id, ...)`, ורשימה כזו אינה גדלה מעצמה — בלי
--    השורה למטה `guest` היה בלתי קריא מהמסך, וזה בדיוק הכשל של 0055 (כרטיס
--    תוכנית שרונדר ריק כי גרנט נשכח). לכן: גרנט מפורש, ואז canary לשני
--    הכיוונים — ש-authenticated **כן** רואה, ושל-anon **אין** דבר.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0097_dryrun.sql`  — מוסיף את העמודה ואת ה-CHECK בתוך
--      טרנזקציה, מוכיח 120 / 121 / null / '' ואז מגלגל. מסיים ב-`raise
--      exception` גם בהצלחה.
--   2. הקובץ הזה.
--   3. `supabase/verify/0097_verify.sql`  — שאילתה אחת, שורה אחת, עמודות true.
--
-- ⚠️ אחרי ההחלה חובה לייצר מחדש את `src/lib/supabase/database.types.ts`,
--    אחרת בדיקת הדריפט ב-`prebuild` תיפול והדיפלוי ייחסם.
--
-- אפס DELETE, אפס שינוי נתונים, אפס טבלה חדשה.
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_rows   bigint;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  -- גארד הרצה חוזרת. רועש, לעולם לא אידמפוטנטי-בשתיקה (הדפוס של 0074:127).
  if exists (select 1 from public.schema_ledger where version = '0097') then
    raise exception '0097 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד סדר. העמודה נתלית בטבלה ש-0096 יצרה; בלעדיה אין למה להוסיף.
  if not exists (select 1 from public.schema_ledger where version = '0096') then
    raise exception '0096 טרם הוחלה — היא יוצרת את booking_requests, ואין עמודה להוסיף לה. הרץ אותה קודם';
  end if;

  -- גארד קיום. אם העמודה כבר שם, משהו הוסיף אותה מחוץ לפנקס — וזה בדיוק
  -- הלקח של 0052 (שינוי סכימה שאיש לא ימצא אחר כך). עוצר ורועש.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests' and column_name = 'guest'
  ) then
    raise exception '0097: העמודה booking_requests.guest כבר קיימת אך אינה בפנקס — מישהו הוסיף אותה מחוץ למיגרציה. בדוק מה היא מחזיקה לפני שתמשיך';
  end if;

  -- ── 1. העמודה ──────────────────────────────────────────────────────────────
  -- `null` מפורש ולא משתמע: זו הכרעת הבעלים ("רשות"), והיא ראויה להיכתב.
  -- אין DEFAULT — ברירת מחדל '' הייתה יוצרת בדיוק את שני-הייצוגים-למצב-אחד
  -- שה-CHECK אוסר, ו-DEFAULT null הוא ממילא ההתנהגות.
  alter table public.booking_requests
    add column guest text null;

  -- ⚠️ `char_length` ולא `length` על bytea ולא `octet_length`: שם בעברית הוא
  -- שני בתים לתו. `guest is null or ...` מפורש ולא נשען על "CHECK עובר על
  -- null" — אותו דפוס שכתוב ב-0096:165-168 עבור `note`, ומאותה סיבה: הכוונה
  -- קריאה מהשורה עצמה ולא מסמנטיקה של שלושה-ערכים.
  alter table public.booking_requests
    add constraint booking_requests_guest_len_chk
    check (guest is null or char_length(guest) between 1 and 120);

  -- ── 2. הרשאות ──────────────────────────────────────────────────────────────
  -- 🔴 הגרנט העמודתי מ-0096 אינו מתרחב לעמודה חדשה. בלי השורה הזו `guest`
  --    אינו קריא מאף סשן מחובר, והמסך היה מציג עמודה ריקה בלי שגיאה.
  --    אין `revoke` לפניה: הטבלה כבר נשללה ברמת הטבלה ב-0096:222, והשלילה
  --    הזו עומדת. גרנט עמודתי בלבד — בדיוק כמו אחיותיו.
  grant select (guest) on public.booking_requests to authenticated;

  -- anon אינו מוזכר כאן **בכלל**, וזו הנקודה: אין לו גרנט ברמת הטבלה
  -- (0096:222) ואין לו גרנט עמודתי, ולכן עמודה חדשה נולדת סגורה בפניו.
  -- 0069 חלק א׳ היא שמבטיחה את זה — בלעדיה pg_default_acl היה פותח אותה.
  -- ה-canary למטה מודד ולא מניח.

  -- ── 3. canary — שני הכיוונים ───────────────────────────────────────────────
  if not has_column_privilege('authenticated', 'public.booking_requests', 'guest', 'select') then
    raise exception '0097 canary: ל-authenticated אין SELECT על booking_requests.guest — הגרנט לא תפס, והמסך יירנדר בלי אורח (הכשל של 0055)';
  end if;
  if has_column_privilege('anon', 'public.booking_requests', 'guest', 'select') then
    raise exception '0097 canary: ל-anon יש SELECT על booking_requests.guest — בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_table_privilege('anon', 'public.booking_requests', 'select') then
    raise exception '0097 canary: ל-anon יש SELECT ברמת הטבלה על booking_requests — השלילה של 0096 נשברה';
  end if;
  -- הכתיבה נשארת server-only, בדיוק כפי ש-0096 קבעה. עמודה חדשה אינה עילה
  -- לפתוח כתיבה, וזה נמדד ולא מונח.
  if has_table_privilege('authenticated', 'public.booking_requests', 'insert')
     or has_table_privilege('authenticated', 'public.booking_requests', 'update')
     or has_table_privilege('authenticated', 'public.booking_requests', 'delete') then
    raise exception '0097 canary: ל-authenticated יש הרשאת כתיבה על booking_requests — כל שינוי חייב לעבור server-side';
  end if;

  -- ה-CHECK קיים ובאמת נקשר לטבלה הזו
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.booking_requests'::regclass
      and contype = 'c' and conname = 'booking_requests_guest_len_chk'
  ) then
    raise exception '0097 canary: אילוץ booking_requests_guest_len_chk אינו קיים';
  end if;

  -- העמודה nullable. "רשות" היא ההכרעה, ועמודה שנולדה NOT NULL הייתה הופכת
  -- כל בקשה בלי אורח לבלתי אפשרית.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests'
      and column_name = 'guest' and is_nullable = 'NO'
  ) then
    raise exception '0097 canary: העמודה guest אינה nullable — הכרעת הבעלים היא שהשדה רשות';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_requests';
  if v_n_cols <> 12 then
    raise exception '0097 canary: booking_requests אמורה להיות 12 עמודות (11 מ-0096 + guest), נמצאו %', v_n_cols;
  end if;

  -- אף שורה קיימת לא נגעה. `add column` בלי DEFAULT אינו כותב מחדש את
  -- הטבלה, וכל שורה קיימת (אם יש) מקבלת null — שה-CHECK מתיר.
  select count(*) into v_rows from public.booking_requests;
  if exists (select 1 from public.booking_requests where guest is not null) then
    raise exception '0097 canary: יש שורה עם guest לא-null מיד אחרי יצירת העמודה — משהו כתב, וזו מיגרציית סכימה בלבד';
  end if;

  -- ── 4. שורת הפנקס ──────────────────────────────────────────────────────────
  -- `schema_ledger` ולא `events`: קובץ סכימה-בלבד, התקדים הוא 0074:400 ו-0096.
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0097', now(), 'bnaya',
    'שם האורח/ת בבקשת הזמנה — עמודה אחת, booking_requests.guest, text nullable. אפס שינוי התנהגות: שום קוד עדיין לא קורא ולא כותב אותה, אין backfill ואף שורה קיימת לא נגעה. '
    'הכרעת הבעלים (23.9): הלקוח ממלא בבקשה שדה פתוח אחד, "שם האורח/ת", רשות — ריק = פרק בלי אורח. אין בדיקות שמטריחות את הלקוח, וכל ההתאמה לפורמט נעשית בקוד. המטרה: שכותרת האירוע המאושר תיקרא ע"י הסנכרון כהפקה עם האורח הנכון, בשביל החשבוניות. '
    'גבול 120 תווים הוא שפוי ולא מדיד — אין היום עמודת אורך על productions.guest שאפשר להסיק ממנה מספר; 120 מכיל שני שמות מלאים בעברית ואת מילת החיבור, ונשאר קריא בכותרת ביומן. char_length ולא octet_length, כי שם בעברית הוא שני בתים לתו וגבול בבתים היה חותך שם עברי ב-60 תווים; ההרצה המדומה מוכיחה 120 תווים עבריים = 240 בתים עוברים. '
    'מחרוזת ריקה נדחית במסד ומנורמלת ל-null באפליקציה. זו אינה קשיחות כלפי הלקוח — טופס ריק הוא מצב תקין — אלא סירוב להחזיק שני ייצוגים לאותו מצב, שהיה מחייב כל קורא עתידי לבדוק גם null וגם '''' לנצח. '
    'אין נרמול, trim או ניקוי במסד: הכותרת נבנית בקוד מפונקציה טהורה, והמסד שומר את מה שהלקוח כתב. מסד שמנקה היה מוחק את המקור שאי אפשר לשחזר. אין DEFAULT, כי DEFAULT '''' היה יוצר בדיוק את שני-הייצוגים שה-CHECK אוסר. '
    'הכרעת 0096 לא נפתחת כאן: guest הוא שם האורח/ת של הפרק ולא פרטי הקשר של מי שביקש. הבקשה נשארת בלתי מזוהה והבעלים עדיין אינו יכול ליצור קשר עם מבקש. '
    'ההרשאה הוענקה במפורש ולא בירושה, וזה העיקר בקובץ: גרנט עמודתי קיים (0096:229-231) אינו מתרחב לעמודה חדשה, ובלי grant select (guest) העמודה הייתה בלתי קריאה מכל סשן מחובר והמסך היה מציג ריק בלי שגיאה — הכשל של 0055. anon אינו מוזכר כלל ולכן העמודה נולדת סגורה בפניו, בזכות 0069 חלק א׳ שהסירה את pg_default_acl; ה-canary מודד את שני הכיוונים ולא מניח. הכתיבה נשארת server-only כפי ש-0096 קבעה. '
    'מחוץ להיקף במכוון: טופס הלקוח, ראוט הבקשה, מסך הבקשות, כפתור האישור ומחולל טקסט האירוע — וגם פונקציית ניקוי השם שתבנה את הכותרת. אפס DELETE, אפס שינוי נתונים, אפס נגיעה בעמודה קיימת.');

  raise notice '✅ 0097: booking_requests.guest נוספה (% עמודות בסך הכל, % שורות בטבלה). זכור לייצר מחדש את database.types.ts.', v_n_cols, v_rows;
end $mig$;
