-- ============================================================================
-- 0094 — הרצה מדומה. להריץ לפני קובץ המיגרציה.
--
-- מה המיגרציה עושה: יוצרת את `client_morning_ids` — לקוח אחד, כמה מזהי
-- מורנינג — זורעת אליה 60 שורות `is_primary` מהעמודה הקיימת ועוד **3 שורות
-- alias**, ומתקינה טריגר שמסנכרן כל כתיבה עתידית ל-`clients.morning_client_id`
-- לתוך שורת ה-`is_primary`.
--
-- ═══ 🔴 הקובץ הזה אינרטי במכוון. הוא אינו משנה שום התנהגות. ═══
-- `registry.ts` ו-`backfill.ts` קוראים היום את `clients.morning_client_id`
-- **ישירות**, ולא את הטבלה. כלומר אחרי 0094: אפס מסמך זז, אפס `client_id`
-- נכתב, אפס מספר על אפס מסך משתנה. **שינוי ההתנהגות הוא בקוד, בסבב נפרד**
-- (הכרעת בעלים א׳) — וזה מה שמבודד את הסיכון לשלב אחד ומאפשר `git revert`
-- במקום מיגרציה הפוכה. מבחנים 7-10 הם ההוכחה לאינרטיות הזו.
--
-- ═══ שלוש שורות ה-alias, והראיה לכל אחת ═══
-- ⚠️ נבדקו מחדש 19.9 לפני הזריעה, בדרישת הבעלים. **בדיקת מספר העוסק/ח.פ.
--    מתוך `raw->'client'->>'taxId'` הוספה בבדיקה הזו ושינתה את התמונה** —
--    פרטים בכל שורה.
--
--   1. 90b369a5  טל מדיקל גרופ      → סבטלנה ניקסון   ⭐ שלושה קווי ראיה
--      · שרשרת: **שלוש** שרשראות חוצות זהות — 60090←40112, 60099←40176,
--        60141←40207 — ובכולן ההורה נושא את 0b3b8274, שהוא המזהה הממופה שלה.
--      · קישור אנושי: 6 מסמכים נושאים client_id שלה, 5 מקושרים ל-jobs שלה
--        (40266 ו-60186 בידיים 16.9; 60141, 40249, 60160 ב-0093).
--      · ⚠️ **מספר העוסק שונה** — 513803809 (ח.פ. חברה) מול 310577473 שלה.
--        זה **אינו סתירה**: זו בדיוק הכרעת הבעלים מ-19.9 — לקוח אחד עם כמה
--        גופים משלמים, ושם הגוף המשלם הוא עניין של רשויות המס בלבד. נרשם
--        ב-note כדי שביקורת מס תמצא את ההסבר ולא תצטרך לשחזר אותו.
--
--   2. fcf1e261  שחף סגינר          → דה פקטו         שני קווי ראיה
--      · שרשרת: 60143←40228, וההורה נושא את 842fcea8 = דה פקטו הממופה.
--      · קישור אנושי: 60143, 40261 ו-60181 נושאים client_id של דה פקטו
--        ומקושרים ל-jobs שלה.
--      · מספר עוסק: 304889611; למסמכי דה פקטו אין taxId כלל, ולכן אין
--        השוואה — **אין אות, ואין סתירה**.
--
--   3. 3236ef61  Nikson Mediconsult → סבטלנה ניקסון   שני קווי ראיה
--      · ⭐ **מספר עוסק זהה: 310577473 — בדיוק זה של 0b3b8274 הממופה.**
--        מזהה שהמדינה הנפיקה, בשדה אחר לגמרי מהשם, והוא תואם תו בתו.
--      · שם: תעתיק אנגלי של "ניקסון מדיקונסלט".
--      · ❌ **אין שרשרת** (לשלושת מסמכיו `parent_doc_numbers` ריק) ו**אין
--        קישור** (0 עם client_id, 0 עם job).
--      · ⚠️ **לפני בדיקת מספר העוסק השורה הזו נשענה על השם בלבד.** היא זו
--        שהבעלים ביקש לסמן, ובדיקת ה-taxId היא שהעלתה אותה לשני קווים.
--      · 📌 **ואין לה שום השפעה תפעולית היום:** שלושת מסמכיה **מאורכבים**,
--        ו-`backfillDocumentClients` מסנן `archived_at is null` — כלומר גם
--        אחרי שינוי הקוד הם לא יסומנו. הערך של השורה הוא עתידי בלבד.
--
-- ═══ מה קורה למזהה היוצא — והתשובה ל-null ═══
-- **הכרעת בעלים 19.9: מזהה שיוצא מראשי נשאר כאליאס ואינו נמחק.** מסמכים
-- ישנים נושאים אותו, ומחיקה הייתה מייצרת יתומים חדשים — בדיוק הבעיה ש-F10
-- בא לפתור. הטריגר מוריד `is_primary`, משאיר את השורה, ורושם ב-`note` **מתי
-- ולמה** ירדה.
--
-- **וכש-`morning_client_id` מתאפס ל-null:** אותו כלל בדיוק — האליאסים
-- נשארים, ו**הלקוח נשאר בלי ראשי כלל**. זו התשובה שאני סבור שהיא הנכונה,
-- משלוש סיבות:
--   1. **עקביות.** מזהה אינו מפסיק להיות היסטוריה אמיתית רק מפני שביטלו את
--      המיפוי; אותו נימוק שמונע מחיקה בהחלפה מונע אותה גם כאן.
--   2. **`morning_client_id = null` פירושו "הלקוח אינו ממופה"**, וביטול
--      מיפוי הוא הכיוון שמתקן (כך אומרת ההערה ב-morning/clients/route.ts).
--      "אין ראשי" הוא הייצוג הנאמן של המצב הזה, לא "אין כלום".
--   3. **וזו בדיוק ההתנהגות הקיימת היום** — לקוח בלי מזהה אינו בר-הנפקה.
--
-- 🔴 **ומה זה אומר על ההנפקה, שצריכה מזהה יחיד — זו המלכודת, והיא נרשמת
--    כאן כדי שלא תתגלה בקוד:** [`enqueue.ts:272`](../src/lib/documents/enqueue.ts#L272)
--    ו-[`receiptFromTaxInvoice.ts:218`](../src/lib/documents/receiptFromTaxInvoice.ts#L218)
--    חייבות לקרוא **`is_primary` בלבד**, ולא "האם קיימת שורה כלשהי". אם
--    ההנפקה תשאל "יש לו מזהה?" במקום "יש לו ראשי?", לקוח שהמיפוי שלו **בוטל
--    במכוון** ימשיך להיראות בר-הנפקה בזכות אליאס היסטורי — כלומר ביטול
--    המיפוי יפסיק לעצור הנפקה, וזה היפוך של כוונת הפעולה. מבחן 6 אוכף את
--    הצד של המסד (אפס ראשי אחרי ביטול); הצד של הקוד הוא סבב נפרד.
--
-- ═══ מה הטבלה אינה פותרת ═══
-- **כפילות לקוח** — שתי שורות `clients` לאותו גוף — היא משפחה אחרת, והטבלה
-- ממפה מזהים ללקוח ולא לקוחות זה לזה. `2b73787f` משותף לגל אורן ולגל אורן
-- לרנר, וזה **מזהה המורנינג היחיד במסד שיותר מלקוח אחד תובע**. ראה **F16**.
-- ⚠️ ולכן ה-PK הוא (client_id, morning_client_id) ולא המזהה לבדו — שיתוף
--    מזהה בין כמה מלקוחותינו לגיטימי בהכרעת בעלים מ-20.7.
--
-- מסתיים ב-raise exception — הגלגול מובטח ע"י PostgreSQL ולא ע"י ה-API,
-- והטבלה, הטריגר, ה-policies וכל 63 השורות נעלמים איתו.
-- הצלחה:  ✅ 0094 DRY RUN OK — ...   ·   כישלון: ❌ ...
-- ============================================================================
do $dry$
declare
  c_svetlana constant uuid := 'b42808ad-4e91-4951-bcff-23111644a88b';
  c_defacto  constant uuid := '261c0445-c013-4f87-9dc6-e82f8c7e9c30';
  c_mid_tal  constant text := '90b369a5-b071-4a83-8c32-880671625eaf';
  c_mid_nik  constant text := '3236ef61-db85-491e-a407-e81b493e79ea';
  c_mid_sha  constant text := 'fcf1e261-214c-4195-a372-4380e7bb9b5f';

  v_clients_before text; v_clients_after text;
  v_docs_before    text; v_docs_after    text;
  v_jobs_before    text; v_jobs_after    text;
  v_inv_rows_before int; v_inv_rows_after int;
  v_mapped int; v_n int; v_txt text;
  v_tmp uuid; v_blocked boolean;
  v_fail text := ''; v_rep text := '';
begin
  -- ══ 0. מצב הפתיחה ═════════════════════════════════════════════════════════
  if to_regclass('public.client_morning_ids') is not null then
    raise exception '❌ 0094 DRY RUN: הטבלה כבר קיימת — 0094 כנראה הוחלה.';
  end if;

  select count(*) into v_mapped from public.clients
   where morning_client_id is not null and merged_into is null;
  if v_mapped <> 60 then
    raise exception '❌ 0094 DRY RUN: % לקוחות ממופים וחיים, ציפיתי 60.', v_mapped;
  end if;

  -- שלושת האליאסים עדיין במצב שנמדד. כלל 51: VALUES + join, is null נפרד.
  with expected(mid, cid, docs) as (
    values (c_mid_tal, c_svetlana, 17), (c_mid_nik, c_svetlana, 3), (c_mid_sha, c_defacto, 4)
  )
  select count(*), string_agg(e.mid, ', ' order by e.mid) into v_n, v_txt
  from expected e
  where (select count(*) from public.documents d where d.morning_client_id = e.mid) = e.docs
    and not exists (select 1 from public.clients c where c.morning_client_id = e.mid)
    and exists (select 1 from public.clients c where c.id = e.cid and c.merged_into is null);
  if v_n <> 3 then
    raise exception '❌ 0094 DRY RUN: % מתוך 3 האליאסים במצב שנמדד. עברו: [%].', v_n, coalesce(v_txt, 'אף אחד');
  end if;

  -- ⚠️ ראיית מספר העוסק, נאכפת ולא מונחת: 3236ef61 חייב לשאת את אותו taxId
  --    כמו המזהה הממופה של סבטלנה. זה קו הראיה הקשה של השורה הזו, ואם הוא
  --    ישתנה — השורה חוזרת להישען על השם בלבד, והקובץ עוצר.
  if (select distinct raw->'client'->>'taxId' from public.documents where morning_client_id = c_mid_nik)
     is distinct from
     (select distinct raw->'client'->>'taxId' from public.documents
       where morning_client_id = '0b3b8274-7372-4938-bb28-196944feab33') then
    raise exception '❌ 0094 DRY RUN: מספר העוסק של Nikson Mediconsult אינו תואם עוד — השורה נשענת על השם בלבד.';
  end if;

  v_rep := v_rep || format('מצב פתיחה — %s לקוחות ממופים, 3 אליאסים מאומתים (כולל taxId). | ', v_mapped);

  -- ══ 1. טביעות אצבע לפני — ההוכחה שהקובץ אינרטי ════════════════════════════
  select md5(coalesce(string_agg(c.id::text||'|'||coalesce(c.morning_client_id,'-')||'|'||
                                 coalesce(c.merged_into::text,'-')||'|'||c.name, ',' order by c.id),''))
    into v_clients_before from public.clients c;
  select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-')||'|'||
                                 coalesce(d.job_id::text,'-'), ',' order by d.id),''))
    into v_docs_before from public.documents d;
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text,
                                 ',' order by j.id),''))
    into v_jobs_before from public.jobs j;
  select count(*) into v_inv_rows_before from public.invoices;

  -- ══ 2. המעשה — בדיוק מה שהמיגרציה תיצור ═══════════════════════════════════
  create table public.client_morning_ids (
    client_id         uuid        not null references public.clients(id) on delete cascade,
    morning_client_id text        not null,
    is_primary        boolean     not null default false,
    morning_name      text,
    note              text,
    created_at        timestamptz not null default now(),
    created_by        uuid        references public.profiles(id),
    primary key (client_id, morning_client_id)
  );

  -- ראשי אחד לכל לקוח — ההנפקה חייבת לדעת תחת איזה מזהה להוציא
  create unique index client_morning_ids_one_primary
    on public.client_morning_ids (client_id) where is_primary;
  create index client_morning_ids_morning_idx
    on public.client_morning_ids (morning_client_id);

  -- ⚠️ שורה מוזגת אינה יעד מיפוי — במראָה ל-CHECK clients_merged_row_unmapped.
  --    זה בדיוק מה שהזיז 14 מסמכים בעבר (registry.ts:198).
  --
  -- 🔴 טריגר ולא CHECK, וזו אינה העדפת סגנון: CHECK אינו יכול לקרוא טבלה
  --    אחרת — תת-שאילתה אסורה בו — ופונקציה שקוראת טבלה בתוך CHECK נבדקת רק
  --    ברגע הכתיבה ולעולם לא מחדש, כך שמיזוג מאוחר יותר של הלקוח היה משאיר
  --    את השורה מאחוריו בלי שאיש יידע. הטריגר נבדק בכל כתיבה, וזו ההגנה
  --    שבאמת נדרשת כאן. הוא מרים `check_violation` כדי שהקורא יקבל את אותה
  --    משפחת שגיאה שהיה מקבל מ-CHECK.
  execute $f$
    create or replace function public.client_morning_ids_reject_merged()
    returns trigger language plpgsql security definer set search_path = public as $body$
    begin
      if exists (select 1 from public.clients c where c.id = new.client_id and c.merged_into is not null) then
        raise exception 'שורת לקוח שמוזגה אינה יכולה לשאת מזהה מורנינג'
          using errcode = 'check_violation';
      end if;
      return new;
    end; $body$;
  $f$;
  execute $f$
    create trigger trg_client_morning_ids_not_merged
    before insert or update on public.client_morning_ids
    for each row execute function public.client_morning_ids_reject_merged();
  $f$;

  alter table public.client_morning_ids enable row level security;
  create policy client_morning_ids_view   on public.client_morning_ids for select using (public.can_view_money());
  create policy client_morning_ids_insert on public.client_morning_ids for insert with check (public.can_edit_money());
  create policy client_morning_ids_update on public.client_morning_ids for update using (public.can_edit_money()) with check (public.can_edit_money());
  create policy client_morning_ids_delete on public.client_morning_ids for delete using (public.can_edit_money());

  -- 2b. הזריעה: 60 ראשיים + 3 אליאסים
  insert into public.client_morning_ids (client_id, morning_client_id, is_primary, morning_name, note)
  select c.id, c.morning_client_id, true,
         (select d.morning_client_name from public.documents d
           where d.morning_client_id = c.morning_client_id
           order by d.document_date desc nulls last limit 1),
         'הועבר מ-clients.morning_client_id ב-0094'
  from public.clients c
  where c.morning_client_id is not null and c.merged_into is null;

  insert into public.client_morning_ids (client_id, morning_client_id, is_primary, morning_name, note)
  values
    (c_svetlana, c_mid_tal, false, 'טל מדיקל גרופ',
     'F10 · שלוש שרשראות חוצות זהות (60090←40112, 60099←40176, 60141←40207) שההורה בכולן הוא 0b3b8274 הממופה; ו-6 מסמכים נושאים client_id שלה, 5 מקושרים ל-jobs שלה. ⚠️ מספר העוסק שונה — 513803809 מול 310577473 — וזה גוף משלם אחר של אותה לקוחה, בהכרעת בעלים 19.9; documents.morning_client_name שומר את שם המשלם לכל מסמך.'),
    (c_svetlana, c_mid_nik, false, 'Nikson Mediconsult',
     'F10 · מספר העוסק זהה למזהה הממופה 0b3b8274 — 310577473 — וזה קו הראיה הקשה; השם הוא תעתיק אנגלי של ניקסון מדיקונסלט. ⚠️ אין שרשרת ואין מסמך מקושר, ושלושת מסמכיו מאורכבים ולכן אין לשורה השפעה תפעולית היום.'),
    (c_defacto, c_mid_sha, false, 'שחף סגינר',
     'F10 · שרשרת חוצה זהות 60143←40228 שההורה בה הוא 842fcea8 הממופה; ו-60143, 40261, 60181 נושאים client_id של דה פקטו ומקושרים ל-jobs שלה. למסמכי דה פקטו אין taxId ולכן אין השוואת מספר עוסק — אין אות ואין סתירה.');

  -- 2c. טריגר הסנכרון — המסך ממשיך לכתוב לעמודה, והמסד מסנכרן. בלעדיו
  --     מיפוי חדש ייכנס לעמודה ולא לטבלה, והפול לא יראה אותו: כשל שקט.
  -- ⚠️ הגרסה הראשונה של הפונקציה הזו נכשלה בהרצה המדומה, ומבחן 5 הוא שתפס
  --    אותה. היא נפתחה ב-`if old is not null and …` כדי להבחין בין INSERT
  --    ל-UPDATE, **וענף ההורדה לא רץ מעולם**: `record IS NOT NULL` ב-SQL הוא
  --    אמת רק כאשר **כל** שדות הרשומה אינם ריקים, ולכל שורת `clients` יש
  --    עמודה ריקה כלשהי (merged_into, notes, billing_every_n…). כלומר התנאי
  --    היה `false` תמיד, הטריגר הריץ רק את ההוספה, ובהחלפת מזהה הוא ניסה
  --    להוסיף ראשי **שני** ונפל על client_morning_ids_one_primary.
  --    זו אותה משפחה של **כלל 51** בדיוק, בלבוש של `record` במקום `row(...)`:
  --    ההבחנה בין INSERT ל-UPDATE נעשית ב-`TG_OP`, לעולם לא ב-`old is null`.
  --
  -- 🔴 והכרעת בעלים 19.9 על מה קורה למזהה היוצא: **הוא נשאר כאליאס ואינו
  --    נמחק.** מסמכים ישנים נושאים אותו, ומחיקה הייתה מייצרת יתומים חדשים —
  --    בדיוק הבעיה ש-F10 בא לפתור. הסדר חייב להיות הורדה ואז העלאה, כי
  --    האינדקס החלקי מתיר ראשי אחד בלבד לרגע.
  execute $f$
    create or replace function public.sync_primary_morning_id()
    returns trigger language plpgsql security definer set search_path = public as $body$
    begin
      -- שמירה חוזרת של אותו ערך אינה אירוע: לא מורידים, לא מעלים, ולא
      -- מלכלכים את ה-note. `is distinct from` ולא `=`, כי שני הצדדים ריקים.
      if tg_op = 'UPDATE' and new.morning_client_id is not distinct from old.morning_client_id then
        return null;
      end if;

      -- 1. הורדה. השורה **נשארת** כאליאס ומתעדת מתי ולמה ירדה.
      if tg_op = 'UPDATE' and old.morning_client_id is not null then
        update public.client_morning_ids
           set is_primary = false,
               note = coalesce(note || ' | ', '') ||
                      'ירד מראשי ' || to_char(now(), 'YYYY-MM-DD HH24:MI') || ' — ' ||
                      case when new.morning_client_id is null
                           then 'המיפוי בוטל; נשמר כאליאס כי מסמכים ישנים נושאים אותו'
                           else 'הלקוח מופה מחדש ל-' || new.morning_client_id
                      end
         where client_id = new.id
           and morning_client_id = old.morning_client_id;
      end if;

      -- 2. העלאה, רק אחרי שההורדה פינתה את האינדקס החלקי
      if new.morning_client_id is not null then
        insert into public.client_morning_ids (client_id, morning_client_id, is_primary, note)
        values (new.id, new.morning_client_id, true, 'סונכרן מ-clients.morning_client_id')
        on conflict (client_id, morning_client_id)
        -- ⚠️ שם הטבלה ללא סכימה: ב-ON CONFLICT DO UPDATE מפנים לשורה הקיימת
        --    בשם הטבלה בלבד (`client_morning_ids.note`), ו-`public.` מלפניו
        --    נדחה. `excluded` הוא השורה המוצעת, ואינו מה שרוצים כאן.
        do update set is_primary = true,
                      note = coalesce(client_morning_ids.note || ' | ', '') ||
                             'הועלה לראשי ' || to_char(now(), 'YYYY-MM-DD HH24:MI');
      end if;
      return null;
    end; $body$;
  $f$;
  execute $f$
    create trigger trg_sync_primary_morning_id
    after insert or update of morning_client_id on public.clients
    for each row execute function public.sync_primary_morning_id();
  $f$;

  -- ══ 3. המבחנים ════════════════════════════════════════════════════════════

  -- מבחן 1 — 63 שורות: 60 ראשיות + 3 אליאסים
  select count(*) into v_n from public.client_morning_ids;
  if v_n <> 63 then
    v_fail := v_fail || format('מבחן 1: %s שורות, ציפיתי 63. ', v_n);
  elsif (select count(*) from public.client_morning_ids where is_primary) <> 60
     or (select count(*) from public.client_morning_ids where not is_primary) <> 3 then
    v_fail := v_fail || 'מבחן 1: הפילוח אינו 60 ראשיות ו-3 אליאסים. ';
  else
    v_rep := v_rep || 'מבחן 1 — 63 שורות: 60 ראשיות + 3 אליאסים. | ';
  end if;

  -- מבחן 2 — כל לקוח ממופה קיבל בדיוק את המזהה שבעמודה שלו
  select count(*) into v_n from public.clients c
   join public.client_morning_ids m on m.client_id = c.id and m.is_primary
   where c.morning_client_id = m.morning_client_id and c.merged_into is null;
  if v_n <> 60 then
    v_fail := v_fail || format('מבחן 2: %s מתוך 60 הראשיות תואמות את העמודה. ', v_n);
  else
    v_rep := v_rep || 'מבחן 2 — 60 הראשיות תואמות את clients.morning_client_id תו בתו. | ';
  end if;

  -- מבחן 3 — שלושת האליאסים, עם ה-note שלהם
  with expected(cid, mid) as (
    values (c_svetlana, c_mid_tal), (c_svetlana, c_mid_nik), (c_defacto, c_mid_sha)
  )
  select count(*) into v_n
  from expected e join public.client_morning_ids m
    on m.client_id = e.cid and m.morning_client_id = e.mid
  where m.is_primary = false and m.note like 'F10 ·%' and m.morning_name is not null;
  if v_n <> 3 then
    v_fail := v_fail || format('מבחן 3: %s מתוך 3 האליאסים נזרעו עם note ו-morning_name. ', v_n);
  else
    v_rep := v_rep || 'מבחן 3 — 3 האליאסים נזרעו, כל אחד עם הראיה ב-note. | ';
  end if;

  -- מבחן 4 — הטריגר: מיפוי לקוח חדש מגיע לטבלה בלי שאיש נגע בה
  insert into public.clients (name, normalized_name, morning_client_id)
  values ('ZZ-0094-dryrun', 'zz-0094-dryrun', 'zz-morning-id-1') returning id into v_tmp;
  if (select count(*) from public.client_morning_ids
       where client_id = v_tmp and morning_client_id = 'zz-morning-id-1' and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 4: הטריגר לא סנכרן INSERT. ';
  else
    v_rep := v_rep || 'מבחן 4 — INSERT על clients סונכרן לטבלה כ-is_primary. | ';
  end if;

  -- מבחן 5 — 🔴 החלפת מזהה: הישן **נשאר כאליאס**, החדש עולה לראשי.
  --            הכרעת בעלים: מחיקה הייתה מייצרת יתומים חדשים.
  update public.clients set morning_client_id = 'zz-morning-id-2' where id = v_tmp;
  if (select count(*) from public.client_morning_ids where client_id = v_tmp) <> 2 then
    v_fail := v_fail || format('מבחן 5: %s שורות ללקוח, ציפיתי 2 (הישן כאליאס + החדש כראשי). ',
                               (select count(*) from public.client_morning_ids where client_id = v_tmp));
  elsif (select count(*) from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-morning-id-1' and not is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 5: המזהה הישן לא נשאר כאליאס. ';
  elsif (select count(*) from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-morning-id-2' and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 5: המזהה החדש לא עלה לראשי. ';
  elsif (select note from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-morning-id-1')
        not like '%ירד מראשי%zz-morning-id-2%' then
    v_fail := v_fail || format('מבחן 5: ה-note של השורה שירדה אינו מתעד מתי ולמה. הוא: [%s]. ',
                               (select note from public.client_morning_ids
                                 where client_id = v_tmp and morning_client_id = 'zz-morning-id-1'));
  else
    v_rep := v_rep || 'מבחן 5 — הישן נשאר כאליאס עם note מתוארך, החדש עלה לראשי. | ';
  end if;

  -- מבחן 6 — 🔴 ביטול מיפוי (null): **שתי השורות נשארות כאליאסים, ואין ראשי.**
  --            זו התשובה ל"מה קורה ל-null" — ראה ההסבר בראש הקובץ.
  update public.clients set morning_client_id = null where id = v_tmp;
  if (select count(*) from public.client_morning_ids where client_id = v_tmp) <> 2 then
    v_fail := v_fail || 'מבחן 6: ביטול מיפוי לא השאיר את שתי השורות. ';
  elsif (select count(*) from public.client_morning_ids where client_id = v_tmp and is_primary) <> 0 then
    v_fail := v_fail || 'מבחן 6: נשאר ראשי אחרי ביטול מיפוי — ההנפקה תחשוב שהלקוח ממופה. ';
  elsif (select note from public.client_morning_ids
          where client_id = v_tmp and morning_client_id = 'zz-morning-id-2') not like '%המיפוי בוטל%' then
    v_fail := v_fail || 'מבחן 6: ה-note אינו מתעד שהמיפוי בוטל. ';
  else
    v_rep := v_rep || 'מבחן 6 — ביטול מיפוי: 2 אליאסים נשארו, אפס ראשי (ההנפקה תסרב). | ';
  end if;

  -- מבחן 6ב — ⚠️ ושמירה חוזרת של אותו ערך אינה מלכלכת את ה-note
  update public.clients set morning_client_id = 'zz-morning-id-2' where id = v_tmp;
  select note into v_txt from public.client_morning_ids
   where client_id = v_tmp and morning_client_id = 'zz-morning-id-2';
  update public.clients set morning_client_id = 'zz-morning-id-2' where id = v_tmp;
  if (select note from public.client_morning_ids
       where client_id = v_tmp and morning_client_id = 'zz-morning-id-2') is distinct from v_txt then
    v_fail := v_fail || 'מבחן 6ב: שמירה חוזרת של אותו ערך שינתה את ה-note. ';
  elsif (select count(*) from public.client_morning_ids where client_id = v_tmp and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 6ב: מיפוי חוזר לא החזיר בדיוק ראשי אחד. ';
  else
    v_rep := v_rep || 'מבחן 6ב — מיפוי חוזר למזהה קיים מחזיר אותו לראשי; שמירה חוזרת שותקת. | ';
  end if;

  -- ══ 4. 🔴 האינרטיות — ההוכחה שהקובץ אינו משנה התנהגות ═════════════════════

  -- מבחן 7 — clients לא נגעה (מלבד הלקוח המדומה)
  select md5(coalesce(string_agg(c.id::text||'|'||coalesce(c.morning_client_id,'-')||'|'||
                                 coalesce(c.merged_into::text,'-')||'|'||c.name, ',' order by c.id),''))
    into v_clients_after from public.clients c where c.id <> v_tmp;
  if v_clients_after is distinct from v_clients_before then
    v_fail := v_fail || 'מבחן 7: clients השתנתה! הקובץ אינו אמור לגעת בה. ';
  else
    v_rep := v_rep || 'מבחן 7 — clients זהה בתו. | ';
  end if;

  -- מבחן 8 — 🔴 אפס מסמך זז. אפס client_id נכתב, אפס job_id.
  select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-')||'|'||
                                 coalesce(d.job_id::text,'-'), ',' order by d.id),''))
    into v_docs_after from public.documents d;
  if v_docs_after is distinct from v_docs_before then
    v_fail := v_fail || 'מבחן 8: מסמך זז! 0094 אמור להיות אינרטי לחלוטין. ';
  else
    v_rep := v_rep || format('מבחן 8 — אפס מסמך זז (%s). | ', left(v_docs_after,8));
  end if;

  -- מבחן 9 — jobs ו-invoices לא נגעו
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text,
                                 ',' order by j.id),''))
    into v_jobs_after from public.jobs j;
  select count(*) into v_inv_rows_after from public.invoices;
  if v_jobs_after is distinct from v_jobs_before or v_inv_rows_after <> v_inv_rows_before then
    v_fail := v_fail || 'מבחן 9: jobs או invoices זזו. ';
  else
    v_rep := v_rep || 'מבחן 9 — jobs ו-invoices זהים. | ';
  end if;

  -- מבחן 10 — לשונית "לא משויך" לא זזה: הקוראים עדיין על העמודה
  select count(*) into v_n from public.documents
   where client_id is null and archived_at is null and cancelled_at is null;
  if v_n <> 25 then
    v_fail := v_fail || format('מבחן 10: %s מסמכים לא-משויכים, ציפיתי 25 — הקובץ אמור לא להזיז דבר. ', v_n);
  else
    v_rep := v_rep || 'מבחן 10 — "לא משויך" נשאר 25; שינוי ההתנהגות הוא בקוד, בסבב נפרד. | ';
  end if;

  -- ══ 5. האילוצים באמת אוכפים ═══════════════════════════════════════════════

  -- מבחן 11 — שני ראשיים לאותו לקוח נדחים
  v_blocked := false;
  begin
    insert into public.client_morning_ids (client_id, morning_client_id, is_primary)
    values (c_svetlana, 'zz-second-primary', true);
  exception when unique_violation then v_blocked := true;
  end;
  if not v_blocked then
    v_fail := v_fail || 'מבחן 11: שני ראשיים לאותו לקוח עברו! ההנפקה לא תדע לאן להוציא. ';
  else
    v_rep := v_rep || 'מבחן 11 — ראשי שני נחסם ע"י client_morning_ids_one_primary. | ';
  end if;

  -- מבחן 12 — ⚠️ אליאס על שורה מוזגת נדחה. זה מה שהזיז 14 מסמכים בעבר.
  select id into v_tmp from public.clients where merged_into is not null limit 1;
  if v_tmp is null then
    v_fail := v_fail || 'מבחן 12: לא נמצאה שורה מוזגת לבדיקה. ';
  else
    v_blocked := false;
    begin
      insert into public.client_morning_ids (client_id, morning_client_id, is_primary)
      values (v_tmp, 'zz-merged-target', false);
    exception when check_violation then v_blocked := true;
    end;
    if not v_blocked then
      v_fail := v_fail || 'מבחן 12: אליאס על שורה מוזגת עבר! שורה שהוצאה משימוש חזרה להיות יעד. ';
    else
      v_rep := v_rep || 'מבחן 12 — אליאס על שורה מוזגת נחסם. | ';
    end if;
  end if;

  -- מבחן 13 — RLS דולקת וארבע ה-policies קיימות
  if not (select relrowsecurity from pg_class where oid = 'public.client_morning_ids'::regclass) then
    v_fail := v_fail || 'מבחן 13: RLS אינה דולקת על הטבלה. ';
  elsif (select count(*) from pg_policies where schemaname='public' and tablename='client_morning_ids') <> 4 then
    v_fail := v_fail || 'מבחן 13: אין ארבע policies. ';
  else
    v_rep := v_rep || 'מבחן 13 — RLS דולקת, 4 policies במראָה ל-clients. | ';
  end if;

  -- מבחן 14 — המפה באמת רבים-לאחד: לסבטלנה שלושה מזהים
  select count(*) into v_n from public.client_morning_ids where client_id = c_svetlana;
  if v_n <> 3 then
    v_fail := v_fail || format('מבחן 14: לסבטלנה %s מזהים, ציפיתי 3. ', v_n);
  elsif (select count(*) from public.client_morning_ids where client_id = c_svetlana and is_primary) <> 1 then
    v_fail := v_fail || 'מבחן 14: לסבטלנה אין בדיוק ראשי אחד. ';
  else
    v_rep := v_rep || 'מבחן 14 — סבטלנה: 3 מזהים, אחד ראשי. רבים-לאחד עובד. | ';
  end if;

  -- מבחן 15 — ⚠️ ומזהה משותף לכמה מלקוחותינו עדיין אפשרי (F16, הכרעת 20.7)
  if (select count(*) from public.client_morning_ids
       where morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394') <> 2 then
    v_fail := v_fail || 'מבחן 15: 2b73787f אינו משותף לשני לקוחות — ה-PK חוסם שיתוף לגיטימי. ';
  else
    v_rep := v_rep || 'מבחן 15 — 2b73787f משותף לגל אורן ולגל אורן לרנר, כמקודם (F16). | ';
  end if;

  -- ══ הדוח ══════════════════════════════════════════════════════════════════
  if v_fail <> '' then
    raise exception '❌ 0094 DRY RUN FAILED — %', v_fail;
  end if;

  raise exception '✅ 0094 DRY RUN OK — % הכל מגולגל, אפס שינוי על המסד.', v_rep;
end $dry$;
