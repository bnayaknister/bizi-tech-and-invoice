-- ============================================================================
-- 0104 — מצב שיחת ההזמנה בבוט (E9-4). טבלה אחת, `wa_conversations`.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: הטבלה נולדת ריקה, אין backfill, אין
-- DELETE, ואף שורה או טבלה קיימת לא נגעה. הקוד שמשתמש בה מאחורי המתג
-- WHATSAPP_BOOKING_FLOW (כבוי כברירת מחדל), ונופל לתשובת E9-3 (קישור
-- ההזמנה) כל עוד הטבלה אינה קריאה.
--
-- ═══ מה נשמר ═══
-- שורה אחת לכל מספר טלפון: באיזה פודקאסט מדובר, באיזה שלב השיחה, והבחירות
-- עד כה (אורך, אולפן, יום, שעה, אורח, הערה) — ב-`state` כ-jsonb. מכונת
-- השלבים (`lib/whatsapp/flow/machine.ts`) היא הבעלים היחיד של מבנה ה-jsonb,
-- וקוראת אותו בהגנה: מצב שאינו תקין מוחלף בהתחלה מחדש, לא בקריסה.
--
-- ═══ 🔴 `wa_id` הוא המפתח הראשי, לא עמודה עם אינדקס ═══
-- שיחה פעילה אחת לכל מספר, בהגדרה: הבוט עונה למספר, לא לפודקאסט. מי שמשויך
-- לכמה פודקאסטים בוחר אחד ברשימה, והבחירה מחליפה את השיחה. מפתח ראשי על
-- `wa_id` הוא מה שהופך את "שתי הודעות ראשונות במקביל" לשורה אחת: ההוספה
-- השנייה נדחית על המפתח, והקוד מזהה זאת כהתנגשות ולא שולח כלום.
--
-- ═══ 🔴 `version` — נעילה אופטימית ═══
-- כל כתיבה מותנית בגרסה שנקראה (`where version = N`, ואז `N+1`). שתי לחיצות
-- על "✅ לקבוע" שמעובדות באותו רגע קוראות שתיהן N; הראשונה כותבת, השנייה
-- לא מתאימה לאף שורה, והקוד לא מגיש ולא שולח. זו השכבה הראשונה נגד הזמנה
-- כפולה; השנייה היא בדיקת הכפילות הקיימת ב-`submitBookingRequest`.
--
-- ═══ `expires_at` ═══
-- שיחה שלא התקדמה 30 דקות פגה (הצעה שאושרה, 11.10). הפקיעה נבדקת בקוד
-- בקריאה (`isLive`), והשורה נדרסת בהתחלה הבאה. אין קרון ניקוי: שורה אחת
-- לכל איש קשר מורשה היא כמות חסומה, ושורה שפגה אינה מזיקה.
--
-- ═══ הרשאות — לפי הכלל ש-0071 קבעה, ובתקדים 0101/0103 ═══
-- 🔴 אפס הרשאות לכל תפקיד של סשן. הטבלה נושאת מספרי טלפון ושמות אורחים.
-- רק ה-webhook (service role) קורא וכותב. RLS דלוק בלי policy = אפס שורות
-- לכל סשן. ההצהרה והאימות לפני שורת הפנקס.
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0104_dryrun.sql`  — יוצר באמת, מוכיח כל אילוץ, את
--      המפתח ואת נעילת הגרסה, מאמת הרשאות, ומגלגל. **מסיים ב-exception גם
--      בהצלחה.**
--   2. הקובץ הזה.
--   3. `supabase/verify/0104_verify.sql`  — שורה אחת, כל העמודות true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--   5. ב-Vercel: `WHATSAPP_BOOKING_FLOW=true` (ו-redeploy).
--
-- אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_n_rows int;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  if exists (select 1 from public.schema_ledger where version = '0104') then
    raise exception '0104 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — בלעדיה הטבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0103') then
    raise exception '0103 טרם הוחלה — שיחת ההזמנה נשענת על booking_contacts. הרץ אותה קודם';
  end if;

  -- ── 1. הטבלה ───────────────────────────────────────────────────────────────
  create table if not exists public.wa_conversations (
    -- E.164 בלי `+`, כמו booking_contacts.wa_id (0103) — רק מספר מורשה מגיע
    -- לשיחה, ולכן אותו פורמט קנוני בדיוק.
    wa_id       text primary key,

    -- `cascade`: שיחה על תוכנית שנמחקה אינה שיחה. אותה בחירה של 0103.
    show_id     uuid not null references public.shows(id) on delete cascade,

    -- השלב, גם בתוך ה-jsonb וגם כאן: כאן כדי שאפשר יהיה לראות ולספור בלי
    -- לפרק jsonb, וה-CHECK מבטיח שאין שלב שהמכונה אינה מכירה.
    step        text not null,

    state       jsonb not null,
    version     integer not null default 1,

    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    expires_at  timestamptz not null,

    constraint wa_conversations_wa_id_chk
      check (wa_id ~ '^[0-9]{7,15}$'),
    constraint wa_conversations_step_chk
      check (step in ('menu', 'duration', 'studio-default', 'studio', 'day', 'hour',
                      'guest', 'note', 'summary', 'submitting', 'done')),
    constraint wa_conversations_state_object_chk
      check (jsonb_typeof(state) = 'object'),
    constraint wa_conversations_version_chk
      check (version >= 1)
  );

  -- "אילו שיחות פתוחות על התוכנית הזאת" — ול-cascade של ה-FK
  create index if not exists wa_conversations_show_idx
    on public.wa_conversations (show_id);

  -- ── 2. RLS + הרשאות ───────────────────────────────────────────────────────
  alter table public.wa_conversations enable row level security;
  revoke all privileges on public.wa_conversations from public, anon, authenticated;
  -- ואין policy ואין גרנט — ראה הכותרת.

  -- ── 3. canary — הכיוון המסוכן ─────────────────────────────────────────────
  if has_table_privilege('anon', 'public.wa_conversations', 'select') then
    raise exception '0104 canary: ל-anon יש SELECT על wa_conversations — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_table_privilege('authenticated', 'public.wa_conversations', 'select') then
    raise exception '0104 canary: ל-authenticated יש SELECT על wa_conversations — הטבלה נושאת מספרי טלפון ושמות אורחים';
  end if;
  if has_table_privilege('authenticated', 'public.wa_conversations', 'insert')
     or has_table_privilege('authenticated', 'public.wa_conversations', 'update')
     or has_table_privilege('authenticated', 'public.wa_conversations', 'delete') then
    raise exception '0104 canary: ל-authenticated יש הרשאת כתיבה על wa_conversations — כל שינוי חייב לעבור server-side';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.wa_conversations'::regclass) then
    raise exception '0104 canary: RLS אינו דלוק על wa_conversations';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_conversations') then
    raise exception '0104 canary: נמצאה policy על wa_conversations — הטבלה אמורה להיות בלי אף policy';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'wa_conversations';
  if v_n_cols <> 8 then
    raise exception '0104 canary: wa_conversations אמורה להיות 8 עמודות, nfound=%', v_n_cols;
  end if;

  select count(*) into v_n_rows from public.wa_conversations;
  if v_n_rows <> 0 then
    raise exception '0104 canary: טבלה חדשה אינה ריקה, nrows=% — האם הקובץ רץ פעמיים על נתונים?', v_n_rows;
  end if;

  -- ── 4. שורת הפנקס ─────────────────────────────────────────────────────────
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0104', now(), 'bnaya',
    'בוט הוואטסאפ, שלב E9-4 — סכימה בלבד: טבלה אחת, wa_conversations, נולדת ריקה, אפס backfill, אפס DELETE ואפס נגיעה בטבלה קיימת. היא שומרת את מצב שיחת ההזמנה המובנית (כפתורים ורשימות) לכל מספר: פודקאסט, שלב, והבחירות עד כה ב-jsonb. '
    'wa_id הוא המפתח הראשי: שיחה פעילה אחת לכל מספר בהגדרה, ושתי הודעות ראשונות במקביל נותנות שורה אחת — ההוספה השנייה נדחית על המפתח והקוד לא שולח כלום. '
    'version היא נעילה אופטימית: כל כתיבה מותנית בגרסה שנקראה, ולכן שתי לחיצות במקביל על לקבוע מגישות בקשה אחת בלבד. זו השכבה הראשונה נגד הזמנה כפולה; השנייה היא בדיקת הכפילות הקיימת במסלול ההגשה המשותף. '
    'expires_at: שיחה שלא התקדמה 30 דקות פגה, נבדק בקוד בקריאה, והשורה נדרסת בהתחלה הבאה. אין קרון ניקוי, כי שורה אחת לכל איש קשר מורשה היא כמות חסומה. '
    'step כפול גם בעמודה וגם ב-jsonb כדי שאפשר יהיה לספור בלי לפרק jsonb, עם CHECK על אחד עשר השלבים שהמכונה מכירה. '
    'הרשאות: אפס לכל תפקיד של סשן, revoke all בלי grant, RLS דלוק ואפס policy, service role בלבד — כמו 0101 ו-0103, כי הטבלה נושאת מספרי טלפון ושמות אורחים. '
    'הקוד מאחורי WHATSAPP_BOOKING_FLOW (כבוי כברירת מחדל) ונופל לתשובת E9-3 כשהטבלה אינה קריאה.');

  raise notice '✅ 0104: wa_conversations נוצרה. ncols=%, nrows=%', v_n_cols, v_n_rows;
end $mig$;
