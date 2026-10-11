-- ============================================================================
-- 0106 — שפה מועדפת לכל מספר בבוט (E19). טבלה אחת, `wa_contact_prefs`.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: הטבלה נולדת ריקה, אין backfill, אין
-- DELETE, ואף שורה או טבלה קיימת לא נגעה. כל עוד הקוד של E19 לא נפרס,
-- איש לא קורא ממנה; וכשהוא נפרס, מספר בלי שורה = "טרם נבחר" = הבוט שואל.
--
-- ═══ למה טבלה חדשה ולא עמודה ב-`wa_conversations` (0104) ═══
-- `wa_conversations` כבר ממופתחת ב-`wa_id`, אבל היא **לא** מקום לשפה:
--   · `show_id` שם NOT NULL — ומספר שאינו משויך לאף פודקאסט (בדיוק מי
--     שהבוט צריך לשאול בפעם הראשונה) לא יכול לקבל שם שורה בכלל;
--   · השורה נדרסת בכל התחלה מחדש ופגה אחרי 30 דקות — העדפה שנשמרת שם
--     נעלמת עם השיחה.
-- `booking_contacts` (0103) גם אינה מתאימה: שורה לכל זוג פודקאסט–מספר, כך
-- שלמספר אחד יכולות להיות כמה שפות, ולמספר לא משויך — אף אחת.
-- לכן: טבלה של מספר בלבד, בלי FK לשום דבר, שחיה כל עוד המספר קיים.
--
-- ═══ מה נשמר ═══
-- `lang`: 'he' / 'en', או NULL = טרם נבחר. NULL הוא ערך לגיטימי ולא רק
-- "אין שורה" — כך הקוד יכול ליצור שורה ברגע הראשון בלי להכריע שפה.
-- `lang_set_at`: מתי נבחרה. CHECK כופה שהשתיים יחד — או שתיהן, או אף אחת.
-- הבקשה שהלקוח כתב **לפני** הבחירה אינה נשמרת כאן: מזהה ההודעה הנכנסת
-- נישא ב-id של כפתור הבחירה, והגוף שלה כבר נמצא ב-`wa_messages`.
--
-- ═══ `wa_id` — אותו פורמט של 0103/0104 ═══
-- E.164 בלי `+`, 7–15 ספרות. `normalizeWaId` של ה-webhook מקבל 6–20, ולכן
-- מספר חריג יכול להגיע; הכתיבה תיכשל על ה-CHECK והקוד ייפול לעברית בלי
-- לשמור — עדיף על להרחיב את הפורמט רק כאן.
--
-- ═══ הרשאות — לפי הכלל ש-0071 קבעה, ובתקדים 0101/0103/0104 ═══
-- 🔴 אפס הרשאות לכל תפקיד של סשן. הטבלה נושאת מספרי טלפון.
-- רק ה-webhook (service role) קורא וכותב. RLS דלוק בלי policy.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0106_dryrun.sql`  — יוצר באמת, מוכיח כל אילוץ ואת
--      ה-upsert שהקוד ישתמש בו, מאמת הרשאות, מוכיח שטבלאות הבוט האחרות
--      לא זזו (md5), ומגלגל. **מסיים ב-exception גם בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0106_verify.sql`  — שורה אחת, כל עמודות הבדיקה true.
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
  if exists (select 1 from public.schema_ledger where version = '0106') then
    raise exception '0106 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — בלעדיה הטבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0105') then
    raise exception '0105 טרם הוחלה — 0106 באה אחריה. הרץ אותה קודם';
  end if;

  -- ── 1. הטבלה ───────────────────────────────────────────────────────────────
  create table if not exists public.wa_contact_prefs (
    -- E.164 בלי `+`, כמו booking_contacts.wa_id (0103) ו-wa_conversations (0104)
    wa_id        text primary key,

    -- NULL = טרם נבחר
    lang         text,
    lang_set_at  timestamptz,

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),

    constraint wa_contact_prefs_wa_id_chk
      check (wa_id ~ '^[0-9]{7,15}$'),
    constraint wa_contact_prefs_lang_chk
      check (lang is null or lang in ('he', 'en')),
    constraint wa_contact_prefs_lang_set_together_chk
      check ((lang is null) = (lang_set_at is null))
  );

  -- ── 2. RLS + הרשאות ───────────────────────────────────────────────────────
  alter table public.wa_contact_prefs enable row level security;
  revoke all privileges on public.wa_contact_prefs from public, anon, authenticated;
  -- ואין policy ואין גרנט — ראה הכותרת.

  -- ── 3. canary — הכיוון המסוכן ─────────────────────────────────────────────
  if has_table_privilege('anon', 'public.wa_contact_prefs', 'select') then
    raise exception '0106 canary: ל-anon יש SELECT על wa_contact_prefs — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_table_privilege('authenticated', 'public.wa_contact_prefs', 'select') then
    raise exception '0106 canary: ל-authenticated יש SELECT על wa_contact_prefs — הטבלה נושאת מספרי טלפון';
  end if;
  if has_table_privilege('authenticated', 'public.wa_contact_prefs', 'insert')
     or has_table_privilege('authenticated', 'public.wa_contact_prefs', 'update')
     or has_table_privilege('authenticated', 'public.wa_contact_prefs', 'delete') then
    raise exception '0106 canary: ל-authenticated יש הרשאת כתיבה על wa_contact_prefs — כל שינוי חייב לעבור server-side';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.wa_contact_prefs'::regclass) then
    raise exception '0106 canary: RLS אינו דלוק על wa_contact_prefs';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_contact_prefs') then
    raise exception '0106 canary: נמצאה policy על wa_contact_prefs — הטבלה אמורה להיות בלי אף policy';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'wa_contact_prefs';
  if v_n_cols <> 5 then
    raise exception '0106 canary: wa_contact_prefs אמורה להיות 5 עמודות, nfound=%', v_n_cols;
  end if;

  select count(*) into v_n_rows from public.wa_contact_prefs;
  if v_n_rows <> 0 then
    raise exception '0106 canary: טבלה חדשה אינה ריקה, nrows=% — האם הקובץ רץ פעמיים על נתונים?', v_n_rows;
  end if;

  -- ── 4. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0106', now(), 'bnaya',
    'בוט דו-לשוני, E19 — סכימה בלבד: טבלה אחת, wa_contact_prefs, נולדת ריקה, אפס backfill, אפס DELETE ואפס נגיעה בטבלה קיימת. היא שומרת שפה מועדפת לכל מספר וואטסאפ: he או en, ו-NULL = טרם נבחר, עם lang_set_at ו-CHECK שכופה ששתיהן יחד. '
    'wa_id הוא המפתח הראשי ואין FK לשום טבלה, כי השפה צריכה לעבוד גם למספר שאינו משויך לאף פודקאסט. לא עמודה ב-wa_conversations: שם show_id הוא NOT NULL והשורה נדרסת ופגה אחרי 30 דקות. '
    'פורמט wa_id זהה ל-0103 ו-0104: 7 עד 15 ספרות בלי פלוס. '
    'הרשאות: אפס לכל תפקיד של סשן, revoke all בלי grant, RLS דלוק ואפס policy, service role בלבד — כמו 0101, 0103 ו-0104, כי הטבלה נושאת מספרי טלפון.');

  raise notice '✅ 0106: wa_contact_prefs נוצרה. ncols=%, nrows=%', v_n_cols, v_n_rows;
end $mig$;
