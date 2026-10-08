-- ============================================================================
-- 0101 — יומן הודעות הוואטסאפ (E9-1). טבלה אחת, `wa_messages`.
--
-- **אפס שינוי התנהגות בהחלה עצמה**: אין backfill, אין DELETE, ואף שורה או
-- טבלה קיימת לא נגעה. הקוד שכותב לטבלה (`/api/wa/webhook`) נדחף באותו קומיט
-- ואינו פעיל עד שה-webhook מוגדר ב-Meta ומשתני הסביבה קיימים.
--
-- ═══ 🔒 מה הטבלה הזאת היא, ומה היא איננה ═══
-- היא **יומן**. הראיה היחידה לכך שהודעה הגיעה אל מספר הבוט, ומה היה בה.
-- היא **אינה** מצב שיחה, אינה תור, ואינה מיפוי טלפון←פודקאסט: המיפוי הוא
-- כרטיסיית "הרשאות הזמנת חדרים" ב-E9-3 וטבלה נפרדת משלו, ומצב שיחה הוכרע
-- שלא לבנות בכלל (ראה E9 ב-docs/TICKETS.md).
--
-- ═══ 🔴 `wamid` — העמודה שהיא כל השלב הראשון ═══
-- מזהה ההודעה של Meta, ו-`unique` עליו הוא **מנגנון ה-de-dup עצמו** ולא
-- אינדקס לנוחות. Meta **חוזרת ומנסה** מסירה שלא קיבלה 2xx, ולכן אותה הודעה
-- מגיעה יותר מפעם אחת כעניין שגרתי. select-then-insert היה מפסיד את המקצה
-- מול מסירה חוזרת שנכנסת בזמן שהראשונה עוד נכתבת; אינדקס ייחודי אינו מפסיד
-- אותו. הראוט מסתמך על זה במפורש: `upsert(..., ignoreDuplicates: true)`,
-- ועל כך שכשל כתיבה מחזיר 500 כדי ש-Meta **תנסה שוב** — מה שבטוח רק מפני
-- שהאינדקס קיים.
--
-- ═══ ⚠️ למה ה-CHECK על `wa_id` רפוי בכוונה ═══
-- `char_length between 1 and 32`, **לא** ספרות בלבד. הכלל הקפדני (ספרות,
-- 6..20, ללא `+`) יושב ב-`normalizeWaId` ב-`src/lib/whatsapp/webhook.ts`,
-- שם הוא פונקציה טהורה עם סוויטה. עמודה שמסרבת לפורמט שולח לא מצופה הופכת
-- את "רשמנו הכול" ל"רשמנו כל מה שזיהינו" — ושולח שאיננו יודעים לנרמל הוא
-- בדיוק זה שכדאי שתהיה עליו רשומה. הראוט נופל חזרה לערך הגולמי, חתוך ל-32.
--
-- ═══ ⚠️ `direction` ו-`status` נוסעים יחד ב-CHECK אחד ═══
-- הודעה **נכנסת** היא `status = 'received'` ובלי `template_name` — אין תבנית
-- להודעה שלקוח שלח. הודעה **יוצאת** היא כל דבר מלבד `received`. שורה שמפרה
-- את ההתאמה הזו היא רשומת יומן שאי אפשר לקרוא, בדיוק באותו נימוק של
-- `booking_requests_decided_chk` (0096:171).
--
-- `dry_run` הוא ערך סטטוס **לגיטימי** ולא מצב בדיקה חריג: כלל 40 אומר ש-
-- `WHATSAPP_DRY_RUN` דלוק כברירת מחדל (`lib/whatsapp/client.ts`), ולכן
-- ברוב הסביבות **כל** הודעה יוצאת תהיה `dry_run`. היא נרשמת כדי שאפשר יהיה
-- לראות מה היה נשלח.
--
-- ═══ 🔴 הרשאות — אפס קריאה מכל סשן, וזו הכרעה ולא השמטה ═══
-- מיגרציה שיוצרת אובייקט נושא-ACL חייבת להצהיר על הרשאותיו ולאמת אותן לפני
-- שורת הפנקס (הכלל ש-0071 קבעה; `0069` חלק א׳ הסירה את `pg_default_acl` עבור
-- `postgres`, ובלעדיה כל טבלה כאן נולדת קריאה ל-anon).
--
-- הטבלה נושאת **מספרי טלפון של לקוחות ותוכן הודעות** — הנתון האישי ביותר
-- שנכנס למערכת הזאת עד כה. 0096 בחרה במפורש שלא לשמור שם או טלפון בבקשת
-- הזמנה ("אין עמודת שם, טלפון או אימייל, וזו הכרעה ולא השמטה", 0096 כותרת);
-- הטבלה הזאת היא המקום שבו טלפון **כן** נשמר, ולכן היא נולדת **בלתי קריאה
-- מכל תפקיד של סשן**: `revoke all` בלי שום `grant` אחריו, RLS דלוק, ואפס
-- policy. הבעלים קורא אותה ב-SQL Editor (service role, ש-RLS אינו חל עליו).
--
-- ⚠️ ולכן אין כאן גרנט "לעתיד". מסך שיצטרך לקרוא ממנה — מסך הקישור של E9-3 —
-- יבוא עם מיגרציה משלו שתצהיר **אילו עמודות בדיוק** הוא חושף. גרנט שנותנים
-- לפני שיש צורך הוא הדרך שבה עמודה דולפת (זה בדיוק מה ש-0096 עשתה הפוך
-- ובמכוון עם `token`: נעדר מרשימת הגרנט **בבנייה**, לא בשלילה מאוחרת).
--
-- ═══ מה להריץ, ובאיזה סדר ═══
--   1. `supabase/verify/0101_dryrun.sql`  — יוצר את הטבלה באמת, מוכיח כל
--      CHECK ואת ה-de-dup, מאמת את ההרשאות, ואז מגלגל. **מסיים ב-
--      `raise exception` גם בהצלחה** — השורה האדומה היא הפלט הצפוי.
--   2. הקובץ הזה.
--   3. `supabase/verify/0101_verify.sql`  — שורה אחת, כל העמודות true.
--   4. `npx supabase gen types typescript --project-id teobjwdszasavvmvukfb > src/lib/supabase/database.types.ts`
--      — צעד 3 של הטקס (supabase/migrations/README.md). עד שהוא רץ, הראוט
--      עובד על הקליינט הלא-מוטפס במכוון, כדי שבודק הסטיות יישאר ירוק.
--
-- אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.
-- ============================================================================

do $mig$
declare
  v_n_cols int;
  v_n_rows int;
begin
  -- ── 0. גארדים ──────────────────────────────────────────────────────────────
  -- גארד הרצה חוזרת. רועש, לעולם לא אידמפוטנטי-בשתיקה (הדפוס של 0074:127).
  if exists (select 1 from public.schema_ledger where version = '0101') then
    raise exception '0101 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד סדר. 0069 חלק א׳ היא זו שהסירה את רשומות pg_default_acl עבור
  -- postgres; בלעדיה הטבלה כאן נולדת קריאה ל-anon וה-canary בשלב 3 היה
  -- (בצדק) מסרב. נקוב כדרישה ולא מושאר ל-canary, כדי שהכשל יגיד מה לעשות
  -- ולא רק מה השתבש.
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — היא מסירה את ברירות המחדל של pg_default_acl, ובלעדיה הטבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;

  -- ── 1. הטבלה ───────────────────────────────────────────────────────────────
  create table if not exists public.wa_messages (
    id            uuid primary key default gen_random_uuid(),

    -- 🔴 מזהה ההודעה של Meta. ה-unique הזה **הוא** מנגנון ה-de-dup; ראה
    --    הכותרת. ללא אורך קבוע — Meta אינה מתחייבת על אורך ה-wamid, ו-CHECK
    --    על אורך מדויק היה מסרב הודעה אמיתית ביום שהפורמט יזוז.
    wamid         text not null unique,

    -- 'in' = מהלקוח אלינו, 'out' = מאיתנו אל הלקוח.
    direction     text not null,

    -- השולח (או הנמען, ביוצאת): E.164 **בלי** `+`, כפי ש-Meta שולחת.
    -- ה-CHECK רפוי בכוונה — ראה הכותרת.
    wa_id         text not null,

    -- סוג ההודעה של Meta: text / button / interactive / image / …
    -- בלי CHECK ובלי enum: סוג חדש אצל Meta חייב להיות **נרשם**, לא נדחה.
    type          text,

    -- התוכן הקריא, או null לסוג שאין לו (location, contacts, …).
    -- התוכן המלא תמיד ב-`payload` גם כשזה null.
    body          text,

    -- שם התבנית, להודעות יוצאות בתבנית בלבד.
    template_name text,

    status        text not null,

    -- אובייקט ההודעה המקורי של Meta, כפי שהגיע. ברירת מחדל `{}` ולא null:
    -- העמודה הזאת היא האחרונה שנשארת כשהפירוק שלנו טעה בשדה, ולכן היא
    -- לעולם לא "חסרה".
    payload       jsonb not null default '{}'::jsonb,

    created_at    timestamptz not null default now(),

    constraint wa_messages_direction_chk
      check (direction in ('in', 'out')),

    -- 'received' לנכנסות; השאר ליוצאות. `dry_run` הוא ערך לגיטימי — ראה
    -- הכותרת וכלל 40.
    constraint wa_messages_status_chk
      check (status in ('received', 'queued', 'sent', 'failed', 'dry_run')),

    -- ⚠️ ההתאמה בין הכיוון לסטטוס ולתבנית, ב-CHECK אחד. נכנסת היא תמיד
    -- 'received' ותמיד בלי תבנית; יוצאת היא תמיד משהו אחר.
    constraint wa_messages_direction_status_chk
      check (
        (direction = 'in'  and status = 'received' and template_name is null)
        or
        (direction = 'out' and status <> 'received')
      ),

    constraint wa_messages_wa_id_len_chk
      check (char_length(wa_id) between 1 and 32),

    -- 8000 תווים. `char_length` ולא `length`, ו-null מותר (יש סוגי הודעה
    -- בלי תוכן קריא) — `char_length(null) <= 8000` הוא null, ו-CHECK עובר
    -- על null. הראוט חותך ל-8000 **לפני** ה-insert, כי שורה שנדחתה היא
    -- הודעה שאבדה.
    constraint wa_messages_body_len_chk
      check (body is null or char_length(body) <= 8000),

    constraint wa_messages_template_len_chk
      check (template_name is null or char_length(template_name) between 1 and 200)
  );

  -- "מה הגיע מהמספר הזה, מהחדש לישן" — השאילתה היחידה שתישאל על הטבלה הזאת
  -- בשלב הקישור של E9-3, וההצגה שהבעלים יבקש.
  create index if not exists wa_messages_wa_id_idx
    on public.wa_messages (wa_id, created_at desc);

  -- "מה נכנס לאחרונה", לבעלים ב-SQL Editor ולכל מסך עתידי.
  create index if not exists wa_messages_created_idx
    on public.wa_messages (created_at desc);

  -- יוצאות שנכשלו — חלקי, כי זו רשימה שאמורה להיות ריקה ואין טעם
  -- באינדקס מלא על עמודה שרוב ערכיה 'received'.
  create index if not exists wa_messages_failed_idx
    on public.wa_messages (created_at desc) where status = 'failed';

  -- ── 2. RLS + הרשאות ───────────────────────────────────────────────────────
  alter table public.wa_messages enable row level security;

  -- ⚠️ הסדר חשוב, ו-0031 שילמה עליו: שלילה עמודתית **אינה** גוברת על גרנט
  -- ברמת טבלה. כאן אין גרנטים עמודתיים בכלל — יש שלילה מלאה ואחריה כלום.
  revoke all privileges on public.wa_messages from public, anon, authenticated;

  -- 🔴 **ואין policy.** RLS דלוק בלי policy מתיר = אפס שורות לכל סשן, וזה
  --    המצב המכוון: הטבלה נושאת מספרי טלפון ותוכן הודעות, ואין היום מסך
  --    שקורא אותה. service role אינו כפוף ל-RLS וממשיך לעבוד.
  --    מסך שיצטרך קריאה יבוא עם מיגרציה שתצהיר אילו עמודות הוא חושף.

  -- ── 3. canary — שני הכיוונים ──────────────────────────────────────────────
  -- הסכימה נכוותה מכל אחד מהם: ההרצה הראשונה של 0071 מתה כי ל-anon הייתה
  -- הרשאה שאיש לא העניק, ו-0055 נאלצה להוסיף גרנט שנשכח אחרי שכרטיס תוכנית
  -- רונדר ריק. כאן הכיוון המסוכן הוא היחיד שרלוונטי, כי אין גרנט לאמת.
  if has_table_privilege('anon', 'public.wa_messages', 'select') then
    raise exception '0101 canary: ל-anon יש SELECT על wa_messages — ה-revoke לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;
  if has_table_privilege('authenticated', 'public.wa_messages', 'select') then
    raise exception '0101 canary: ל-authenticated יש SELECT על wa_messages — הטבלה נושאת מספרי טלפון ותוכן הודעות ואינה אמורה להיות קריאה מסשן';
  end if;
  if has_table_privilege('authenticated', 'public.wa_messages', 'insert')
     or has_table_privilege('authenticated', 'public.wa_messages', 'update')
     or has_table_privilege('authenticated', 'public.wa_messages', 'delete') then
    raise exception '0101 canary: ל-authenticated יש הרשאת כתיבה על wa_messages — כל כתיבה חייבת לעבור server-side';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.wa_messages'::regclass) then
    raise exception '0101 canary: RLS אינו דלוק על wa_messages';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'wa_messages') then
    raise exception '0101 canary: נמצאה policy על wa_messages — הטבלה אמורה להיות בלי אף policy';
  end if;

  -- ה-unique על wamid הוא ההבטחה שהראוט נשען עליה. בדיקה בשם, לא בהנחה.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.wa_messages'::regclass and contype = 'u'
      and conname = 'wa_messages_wamid_key'
  ) then
    raise exception '0101 canary: אין אילוץ unique על wa_messages.wamid — מנגנון ה-de-dup אינו קיים, והראוט מחזיר 500 שגורם ל-Meta לנסות שוב לנצח';
  end if;

  select count(*) into v_n_cols from information_schema.columns
    where table_schema = 'public' and table_name = 'wa_messages';
  if v_n_cols <> 10 then
    raise exception '0101 canary: wa_messages אמורה להיות 10 עמודות, nfound=%', v_n_cols;
  end if;

  -- הטבלה נולדת ריקה, ונבדק שהיא ריקה
  select count(*) into v_n_rows from public.wa_messages;
  if v_n_rows <> 0 then
    raise exception '0101 canary: טבלה חדשה אינה ריקה, nrows=% — האם הקובץ רץ פעמיים על נתונים?', v_n_rows;
  end if;

  -- ── 4. שורת הפנקס ─────────────────────────────────────────────────────────
  -- ⚠️ `schema_ledger` ולא `events`: זה קובץ סכימה-בלבד, והתקדים הוא 0074:400
  -- ו-0096. מיגרציה שאינה נרשמת בפנקס היא שינוי סכימה שאיש לא ימצא אחר כך
  -- (הלקח של 0052).
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0101', now(), 'bnaya',
    'בוט הוואטסאפ, שלב E9-1 — סכימה בלבד: טבלה אחת, wa_messages, אפס backfill, אפס DELETE, אפס נגיעה בטבלה קיימת. הטבלה היא יומן ההודעות של מספר הבוט ולא מצב שיחה, לא תור ולא מיפוי טלפון לפודקאסט. '
    'wamid הוא מזהה ההודעה של Meta וה-unique עליו הוא מנגנון ה-de-dup עצמו, לא אינדקס לנוחות: Meta חוזרת ומנסה מסירה שלא קיבלה 2xx ולכן אותה הודעה מגיעה יותר מפעם אחת כעניין שגרתי, ו-select-then-insert מפסיד את המקצה מול מסירה חוזרת שנכנסת בזמן שהראשונה נכתבת. הראוט /api/wa/webhook נשען על זה פעמיים: upsert עם ignoreDuplicates, וכשל כתיבה שמחזיר 500 כדי ש-Meta תנסה שוב — מה שבטוח רק מפני שהאינדקס קיים. '
    'ה-CHECK על wa_id רפוי בכוונה (אורך 1 עד 32, כל טקסט) ולא ספרות בלבד: הכלל הקפדני יושב ב-normalizeWaId ב-src/lib/whatsapp/webhook.ts כפונקציה טהורה עם סוויטה, ועמודה שמסרבת לפורמט שולח לא מצופה הופכת את רשמנו-הכול לרשמנו-את-מה-שזיהינו. שולח שאיננו יודעים לנרמל הוא בדיוק זה שכדאי שתהיה עליו רשומה, והראוט נופל חזרה לערך הגולמי חתוך ל-32. '
    'direction, status ו-template_name נוסעים יחד ב-CHECK אחד: נכנסת היא תמיד received ותמיד בלי תבנית, יוצאת היא תמיד משהו אחר. אותו נימוק של booking_requests_decided_chk ב-0096 — שורה שמפרה את ההתאמה היא רשומת יומן שאי אפשר לקרוא. '
    'dry_run הוא ערך סטטוס לגיטימי ולא חריג: כלל 40 אומר ש-WHATSAPP_DRY_RUN דלוק כברירת מחדל (isWhatsappDryRun ב-lib/whatsapp/client.ts הוא !== false, בתקדים isCalendarDryRun ב-lib/calendar/write.ts:43 ו-isDryRun ב-lib/morning/client.ts:35), ולכן ברוב הסביבות כל הודעה יוצאת תהיה dry_run והיא נרשמת כדי שאפשר יהיה לראות מה היה נשלח. '
    'type נשאר בלי CHECK ובלי enum במכוון: סוג הודעה חדש אצל Meta חייב להיות נרשם ולא נדחה, וזו אותה סיבה שהפירוק באפליקציה מחזיר null על סוג שאינו מוכר במקום לזרוק. payload הוא not null עם ברירת מחדל ריקה כי הוא העמודה האחרונה שנשארת כשהפירוק שלנו טעה בשדה. '
    'הרשאות: אפס קריאה מכל תפקיד של סשן, וזו הכרעה ולא השמטה. revoke all בלי שום grant אחריו, RLS דלוק, ואפס policy — כלומר אפס שורות לכל סשן, ו-service role בלבד (שאינו כפוף ל-RLS). הטבלה נושאת מספרי טלפון של לקוחות ותוכן הודעות, הנתון האישי ביותר שנכנס למערכת עד כה, ובמיוחד לאור זה ש-0096 בחרה במפורש שלא לשמור שם או טלפון בבקשת הזמנה. אין כאן גרנט לעתיד: מסך הקישור של E9-3 יבוא עם מיגרציה משלו שתצהיר אילו עמודות בדיוק הוא חושף, כי גרנט שנותנים לפני שיש צורך הוא הדרך שבה עמודה דולפת. ההצהרה והאימות לפני שורת הפנקס הם הכלל ש-0071 קבעה. '
    'מחוץ להיקף במכוון: שליחת הודעות (אין פונקציית send בכלל ב-lib/whatsapp/client.ts, רק המתג), מיפוי טלפון לפודקאסט, כרטיסיית ההרשאות, האישור האוטומטי של בקשות הזמנה, ההתראות לבעלים ולאלי, וכל תבנית. הקוד שנדחף עם הקובץ הזה קורא webhook, מאמת חתימה, ורושם — ולא יותר.');

  raise notice '✅ 0101: wa_messages נוצרה. ncols=%, nrows=%', v_n_cols, v_n_rows;
end $mig$;
