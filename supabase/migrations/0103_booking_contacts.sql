-- ============================================================================
-- 0103 — מי רשאי להזמין חדר לכל פודקאסט (E9-3). טבלה אחת, `booking_contacts`.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: הטבלה נולדת ריקה, אין backfill, אין
-- DELETE, ואף שורה או טבלה קיימת לא נגעה.
--
-- ═══ 🔴 למה טבלה חדשה, ולא עמודה במורנינג או על `shows` ═══
-- תחקיר E9 (8.10) מדד את זה: ל-`clients` **אין עמודת טלפון בכלל**, במוצהר
-- ("giving it one would make a second source of truth for a fact Morning
-- owns", `api/clients/[id]/contacts/route.ts:49-53`), והטלפון חי **רק
-- במורנינג** — טקסט חופשי, מאחרי קריאת HTTP עם deadline של 15 שניות
-- (`morning/client.ts:70`), עם שלוש צורות שונות ל"ריק" (`:408`).
--
-- שלוש סיבות שזה לא יכול לשרת את הבוט:
--   1. **webhook חייב להחזיר 200 במהירות.** זיהוי שולח שנשען על קריאה
--      סינכרונית למורנינג הוא בוט שמפסיק לענות כשמורנינג אטי.
--   2. **מורנינג הוא פר לקוח; ההרשאה היא פר פודקאסט.** `shows.client_id`
--      (0008:9) הוא לקוח-אחד-לכמה-תוכניות, וקישור ההזמנות הוא פר תוכנית
--      (0096:132). טלפון אחד במורנינג אינו מפה חד-ערכית אל תוכנית.
--   3. **הכרעת בעלים: כמה אנשים לכל פודקאסט**, ואותו מספר יכול לשרת כמה
--      פודקאסטים. זה יחס רבים-לרבים, ואין לו מקום בשדה טקסט.
--
-- ═══ ⚠️ והיא **אינה** מחליפה את אנשי הקשר של מורנינג ═══
-- `ClientMorningCard` ממשיך להציג את ה-emails/phone/contactPerson של מורנינג
-- בדיוק כמו היום, ואלה נשארים המקור לכל מה שקשור **לחיוב ולמסמכים**. הטבלה
-- הזאת עונה על שאלה אחרת לגמרי: **מי מורשה להזמין חדר**. אדם יכול להיות
-- בשתיהן, באחת, או באף אחת, ואין שום סינכרון ביניהן — סינכרון היה הופך את
-- "איש קשר לחשבוניות" ו"מי מזמין אולפן" לאותו שדה, והם אינם.
--
-- ═══ 🔴 `show_id` ולא `client_id`, וזו ההכרעה המבנית ═══
-- ההרשאה תלויה ב**פודקאסט**, מהסיבה שהכרעת הבעלים נוקבת: "הבוט והמערכת
-- מזהים לפי המספר לאיזה פודקאסט הוא שייך, ומאפשרים להזמין רק את מה שמשויך
-- אליו". הכרטיסייה **מוצגת** בכרטיס הלקוח, ולכן היא מקבצת לפי
-- `shows.client_id` — אבל ה**נתון** הוא פר תוכנית. תלייה בלקוח הייתה נותנת
-- לאיש קשר של פודקאסט אחד להזמין חדר בשם פודקאסט אחר של אותו לקוח.
--
-- ═══ 🔴 `wa_id` — ספרות בלבד, ובפורמט אחד ═══
-- E.164 בלי `+`, כפי ש-Meta שולחת `wa_id`. ההמרה מקלט ישראלי (`050-123-4567`)
-- נעשית **פעם אחת, באפליקציה, בדרך פנימה** (`lib/whatsapp/phone.ts:toWaId`),
-- והערך השמור הוא הקנוני. ⚠️ שימו לב שזה **הפוך** מהבחירה ב-0101, שם ה-CHECK
-- על `wa_id` רפוי בכוונה: שם זו **רשומת יומן** של מה שהגיע מבחוץ ואסור לאבד
-- הודעה בגלל פורמט; כאן זה **מפתח חיפוש** שאנחנו בעצמנו כותבים, והשוואה
-- שמנרמלת את שני הצדדים אינה יכולה להשתמש באינדקס ומסתירה שתי שורות שהן
-- אותו מספר.
--
-- ═══ הרשאות — לפי הכלל ש-0071 קבעה ═══
-- מיגרציה שיוצרת אובייקט נושא-ACL חייבת להצהיר על הרשאותיו **במפורש**
-- ולאמת אותן לפני שורת הפנקס (`0069` חלק א׳ הסירה את `pg_default_acl` עבור
-- `postgres`, ובלעדיה כל טבלה כאן נולדת קריאה ל-anon).
--
-- 🔴 **אפס קריאה מכל תפקיד של סשן, כמו 0101.** הטבלה נושאת **שמות ומספרי
--    טלפון של אנשים אמיתיים**. כל קריאה וכתיבה עוברת
--    `GET/POST/DELETE /api/clients/[id]/booking-contacts`, שבודק
--    `can_view_money` / `can_edit_money` — **אותו שער בדיוק** ששומר על שם
--    הלקוח (entities.ts:158) ועל בלוק אנשי הקשר של מורנינג
--    (`contacts/route.ts:20-25`), כי הכרטיסייה הזאת יושבת באותו כרטיס ומי
--    שאינו עובר את השער אינו מגיע לכרטיס לקוח בכלל (RLS `clients_view` הוא
--    `can_view_money()` ברמת שורה).
--
-- ⚠️ ולכן אין כאן policy ואין גרנט: RLS דלוק בלי policy מתיר = אפס שורות לכל
--    סשן, ו-service role (שאינו כפוף ל-RLS) הוא הדרך היחידה. גרנט שנותנים
--    לפני שיש צורך הוא הדרך שבה עמודה דולפת.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0103_dryrun.sql`  — יוצר באמת, מוכיח כל אילוץ ואת
--      הייחודיות, מאמת הרשאות, ומגלגל. **מסיים ב-exception גם בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0103_verify.sql`  — שורה אחת, כל העמודות true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--
-- אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_n_rows int;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0103') then
    raise exception '0103 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — היא מסירה את ברירות המחדל של pg_default_acl, ובלעדיה הטבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;

  -- ── 1. הטבלה ───────────────────────────────────────────────────────────────
  create table if not exists public.booking_contacts (
    id          uuid primary key default gen_random_uuid(),

    -- 🔴 פר **תוכנית**, לא פר לקוח. ראה הכותרת. `cascade` כי איש קשר
    --    לתוכנית שנמחקה אינו מורשה לשום דבר — אותה בחירה של booking_links.
    show_id     uuid not null references public.shows(id) on delete cascade,

    -- השם כפי שהבעלים מקליד אותו. לא מנורמל ולא מושווה לשום דבר — הוא
    -- לתצוגה בלבד, והמפתח הוא המספר.
    name        text not null,

    -- E.164 בלי `+`. ההמרה באפליקציה, והערך כאן קנוני — ראה הכותרת.
    wa_id       text not null,

    created_at  timestamptz not null default now(),
    created_by  uuid references public.profiles(id),

    constraint booking_contacts_name_len_chk
      check (char_length(btrim(name)) between 1 and 120),

    -- ספרות בלבד, 7..15 — טווח E.164. **מאומת ולא מנוקה**: ערך שאינו עומד
    -- בזה הוא שגיאת אפליקציה, לא ערך לתקן בשקט.
    constraint booking_contacts_wa_id_chk
      check (wa_id ~ '^[0-9]{7,15}$')
  );

  -- 🔴 **אותו אדם פעם אחת לכל תוכנית.** שתי שורות עם אותו מספר לאותה תוכנית
  --    הן שתי הרשאות זהות, והבוט היה שולח לאותו אדם שתי הודעות או מציג את
  --    אותו פודקאסט פעמיים ברשימת הבחירה. ⚠️ וזה **אינו** ייחודי על `wa_id`
  --    לבדו: הכרעת בעלים — אותו מספר **כן** יכול להיות משויך לכמה פודקאסטים,
  --    וזה בדיוק המקרה שמייצר את הודעת הרשימה.
  create unique index if not exists booking_contacts_show_wa_key
    on public.booking_contacts (show_id, wa_id);

  -- 🔴 השאילתה שה-webhook שואל בכל הודעה נכנסת: "למי שייך המספר הזה".
  --    היא על הנתיב הקריטי של תשובת ה-200, ולכן אינדקס ולא סריקה.
  create index if not exists booking_contacts_wa_id_idx
    on public.booking_contacts (wa_id);

  -- והשאילתה שהכרטיסייה שואלת: "כל אנשי הקשר של התוכניות של הלקוח הזה"
  create index if not exists booking_contacts_show_idx
    on public.booking_contacts (show_id);

  -- ── 2. RLS + הרשאות ───────────────────────────────────────────────────────
  alter table public.booking_contacts enable row level security;

  -- ⚠️ הסדר חשוב, ו-0031 שילמה עליו: שלילה עמודתית **אינה** גוברת על גרנט
  -- ברמת טבלה. כאן אין גרנטים עמודתיים בכלל — שלילה מלאה ואחריה כלום.
  revoke all privileges on public.booking_contacts from public, anon, authenticated;

  -- 🔴 **ואין policy.** RLS דלוק בלי policy מתיר = אפס שורות לכל סשן. השער
  --    האמיתי הוא can_view_money/can_edit_money בראוט, שהוא אותו שער ששומר
  --    על שם הלקוח ועל אנשי הקשר של מורנינג — ראה הכותרת.

  -- ── 3. canary — הכיוון המסוכן ─────────────────────────────────────────────
  if has_table_privilege('anon', 'public.booking_contacts', 'select') then
    raise exception '0103 canary: ל-anon יש SELECT על booking_contacts — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_table_privilege('authenticated', 'public.booking_contacts', 'select') then
    raise exception '0103 canary: ל-authenticated יש SELECT על booking_contacts — הטבלה נושאת שמות ומספרי טלפון ואינה אמורה להיות קריאה מסשן';
  end if;
  if has_table_privilege('authenticated', 'public.booking_contacts', 'insert')
     or has_table_privilege('authenticated', 'public.booking_contacts', 'update')
     or has_table_privilege('authenticated', 'public.booking_contacts', 'delete') then
    raise exception '0103 canary: ל-authenticated יש הרשאת כתיבה על booking_contacts — כל שינוי חייב לעבור server-side';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.booking_contacts'::regclass) then
    raise exception '0103 canary: RLS אינו דלוק על booking_contacts';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_contacts') then
    raise exception '0103 canary: נמצאה policy על booking_contacts — הטבלה אמורה להיות בלי אף policy';
  end if;

  -- הייחודיות היא ההבטחה שהבוט נשען עליה (אדם אחד פעם אחת לכל תוכנית)
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'booking_contacts'
      and indexname = 'booking_contacts_show_wa_key'
  ) then
    raise exception '0103 canary: אין אינדקס ייחודי על (show_id, wa_id) — אותו אדם יוכל להופיע פעמיים לאותה תוכנית';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_contacts';
  if v_n_cols <> 6 then
    raise exception '0103 canary: booking_contacts אמורה להיות 6 עמודות, nfound=%', v_n_cols;
  end if;

  select count(*) into v_n_rows from public.booking_contacts;
  if v_n_rows <> 0 then
    raise exception '0103 canary: טבלה חדשה אינה ריקה, nrows=% — האם הקובץ רץ פעמיים על נתונים?', v_n_rows;
  end if;

  -- ── 4. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0103', now(), 'bnaya',
    'בוט הוואטסאפ, שלב E9-3 — סכימה בלבד: טבלה אחת, booking_contacts, נולדת ריקה, אפס backfill, אפס DELETE ואפס נגיעה בטבלה קיימת. היא עונה על שאלה אחת: מי מורשה להזמין חדר לכל פודקאסט. '
    'show_id ולא client_id, וזו ההכרעה המבנית: הכרעת הבעלים נוקבת שהבוט מזהה לפי המספר לאיזה פודקאסט הוא שייך ומאפשר להזמין רק את מה שמשויך אליו. הכרטיסייה מוצגת בכרטיס הלקוח ולכן מקבצת לפי shows.client_id, אבל הנתון הוא פר תוכנית. תלייה בלקוח הייתה נותנת לאיש קשר של פודקאסט אחד להזמין חדר בשם פודקאסט אחר של אותו לקוח. '
    'למה טבלה חדשה ולא מורנינג: ל-clients אין עמודת טלפון בכלל במוצהר, הטלפון חי רק במורנינג כטקסט חופשי מאחרי קריאת HTTP עם deadline של 15 שניות ועם שלוש צורות לריק. שלוש סיבות שזה לא יכול לשרת את הבוט — webhook חייב להחזיר 200 במהירות ולא יכול להישען על קריאה סינכרונית למורנינג; מורנינג הוא פר לקוח בעוד ההרשאה פר פודקאסט ו-shows.client_id הוא לקוח-אחד-לכמה-תוכניות; והכרעת הבעלים היא כמה אנשים לכל פודקאסט ואותו מספר לכמה פודקאסטים, כלומר יחס רבים-לרבים שאין לו מקום בשדה טקסט. '
    'והיא אינה מחליפה את אנשי הקשר של מורנינג: ClientMorningCard ממשיך להציג emails/phone/contactPerson בדיוק כמו היום, ואלה נשארים המקור לכל מה שקשור לחיוב ולמסמכים. אין שום סינכרון בין השתיים, כי סינכרון היה הופך את איש-קשר-לחשבוניות ואת מי-מזמין-אולפן לאותו שדה, והם אינם. '
    'wa_id הוא E.164 בלי פלוס, ספרות בלבד, 7 עד 15, עם CHECK על regex. ההמרה מקלט ישראלי נעשית פעם אחת באפליקציה בדרך פנימה (lib/whatsapp/phone.ts toWaId) והערך השמור קנוני. זה הפוך מהבחירה ב-0101, שם ה-CHECK על wa_id רפוי בכוונה: שם זו רשומת יומן של מה שהגיע מבחוץ ואסור לאבד הודעה בגלל פורמט, וכאן זה מפתח חיפוש שאנחנו כותבים, והשוואה שמנרמלת את שני הצדדים אינה יכולה להשתמש באינדקס ומסתירה שתי שורות שהן אותו מספר. '
    'אינדקס ייחודי על (show_id, wa_id): אותו אדם פעם אחת לכל תוכנית, כי שתי שורות זהות היו שולחות לאותו אדם שתי הודעות או מציגות את אותו פודקאסט פעמיים ברשימת הבחירה. ובמפורש לא ייחודי על wa_id לבדו — אותו מספר כן יכול להיות משויך לכמה פודקאסטים, וזה בדיוק המקרה שמייצר את הודעת הרשימה. אינדקס על wa_id לבדו קיים כי זו השאילתה שה-webhook שואל בכל הודעה נכנסת, על הנתיב הקריטי של תשובת ה-200. '
    'הרשאות: אפס קריאה מכל תפקיד של סשן. revoke all בלי שום grant, RLS דלוק, אפס policy, ו-service role בלבד. הטבלה נושאת שמות ומספרי טלפון של אנשים אמיתיים, וכל קריאה וכתיבה עוברת api/clients/[id]/booking-contacts שבודק can_view_money ו-can_edit_money — אותו שער בדיוק ששומר על שם הלקוח ועל בלוק אנשי הקשר של מורנינג, כי הכרטיסייה יושבת באותו כרטיס ומי שאינו עובר את השער אינו מגיע לכרטיס לקוח בכלל (RLS clients_view הוא can_view_money ברמת שורה). ההצהרה והאימות לפני שורת הפנקס הם הכלל ש-0071 קבעה. '
    'מחוץ להיקף במכוון: שינוי כלשהו ב-wa_messages (0102), כל סינכרון מול מורנינג, וכל שימוש בטבלה לצורך חיוב או מסמכים.');

  raise notice '✅ 0103: booking_contacts נוצרה. ncols=%, nrows=%', v_n_cols, v_n_rows;
end $mig$;
