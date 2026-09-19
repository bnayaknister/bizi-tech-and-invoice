-- ============================================================================
-- 0094 — F10, שלב א׳: `client_morning_ids` — לקוח אחד, כמה מזהי מורנינג
--
-- ⚠️ להריץ את supabase/verify/0094_dryrun.sql לפני. כלל 50.
--
-- ═══ 🔴 הקובץ הזה אינרטי במכוון. הוא אינו משנה שום התנהגות. ═══
-- `registry.ts:203-212` ו-`backfill.ts:30-40` קוראים היום את
-- `clients.morning_client_id` **ישירות**, ולא את הטבלה. כלומר אחרי 0094:
-- אפס מסמך זז, אפס `client_id` נכתב, אפס מספר על אפס מסך משתנה.
-- **שינוי ההתנהגות הוא בקוד, בסבב נפרד** (הכרעת בעלים א׳, 19.9) — וזה מה
-- שמבודד את הסיכון לשלב אחד ומאפשר `git revert` במקום מיגרציה הפוכה.
-- סעיפים 4א-4ד הם ההוכחה לאינרטיות, ב-md5 על ארבע הטבלאות.
--
-- ═══ למה הטבלה קיימת ═══
-- `clients.morning_client_id` היא עמודה **יחידה**, ולעסק אחד יכולים להיות
-- כמה כרטיסים במורנינג. נמדד 19.9: **59 מזהי מורנינג אינם נתבעים ע"י אף
-- לקוח, על 275 מסמכים**. מתוכם **שניים בלבד** הם באמת "עסק אחד, כמה מזהים"
-- — וזה כל מה שנזרע כאן. 57 הנותרים הם לקוחות שמעולם לא היו ב-bizi, כמעט
-- כולם מאורכבים, והם **מחוץ להיקף** (טיקט נפרד, הכרעת בעלים ד׳).
--
-- ═══ שלוש שורות ה-alias, והראיה לכל אחת ═══
-- ⚠️ נבדקו מחדש 19.9 לפני הזריעה, בדרישת הבעלים. **בדיקת מספר העוסק/ח.פ.
--    מתוך `raw->'client'->>'taxId'` נוספה בבדיקה הזו ושינתה את התמונה.**
--
--   1. 90b369a5  טל מדיקל גרופ      → סבטלנה ניקסון   ⭐ שלושה קווי ראיה
--      · **שלוש** שרשראות חוצות זהות — 60090←40112, 60099←40176,
--        60141←40207 — ובכולן ההורה נושא את 0b3b8274, המזהה הממופה שלה.
--      · 6 מסמכים נושאים client_id שלה, 5 מקושרים ל-jobs שלה (40266 ו-60186
--        בידיים 16.9; 60141, 40249, 60160 ב-0093).
--      · ⚠️ **מספר העוסק שונה** — 513803809 (ח.פ. חברה) מול 310577473
--        (יחיד). **זה אינו סתירה** אלא בדיוק הכרעת הבעלים מ-19.9: לקוח אחד
--        עם כמה גופים משלמים, ושם הגוף המשלם הוא עניין של רשויות המס בלבד.
--        נרשם ב-note כדי שביקורת מס תמצא את ההסבר ולא תשחזר אותו.
--
--   2. fcf1e261  שחף סגינר          → דה פקטו         שני קווי ראיה
--      · שרשרת 60143←40228, וההורה נושא את 842fcea8 = דה פקטו הממופה.
--      · 60143, 40261, 60181 נושאים client_id של דה פקטו ומקושרים ל-jobs שלה.
--      · למסמכי דה פקטו אין taxId — אין השוואה, אין אות ואין סתירה.
--
--   3. 3236ef61  Nikson Mediconsult → סבטלנה ניקסון   שני קווי ראיה
--      · ⭐ **מספר עוסק זהה: 310577473**, בדיוק זה של 0b3b8274 הממופה —
--        מזהה שהמדינה הנפיקה, בשדה אחר לגמרי מהשם, תואם תו בתו.
--      · שם: תעתיק אנגלי של "ניקסון מדיקונסלט".
--      · ❌ אין שרשרת ואין מסמך מקושר.
--      · ⚠️ **לפני בדיקת מספר העוסק השורה הזו נשענה על השם בלבד**, וסעיף 1ג
--        אוכף את ההתאמה: אם ה-taxId יפסיק להתאים, הקובץ עוצר.
--      · 📌 ואין לה השפעה תפעולית היום: שלושת מסמכיה **מאורכבים**,
--        ו-`backfillDocumentClients` מסנן `archived_at is null`.
--
-- ═══ מה קורה למזהה היוצא — והתשובה ל-null ═══
-- **הכרעת בעלים 19.9: מזהה שיוצא מראשי נשאר כאליאס ואינו נמחק.** מסמכים
-- ישנים נושאים אותו, ומחיקה הייתה מייצרת יתומים חדשים — בדיוק הבעיה ש-F10
-- בא לפתור. הטריגר מוריד `is_primary`, משאיר את השורה, ורושם ב-`note` **מתי
-- ולמה** ירדה. וכש-`morning_client_id` מתאפס ל-null: האליאסים נשארים
-- ו**הלקוח נשאר בלי ראשי כלל** — זה הייצוג הנאמן של "אינו ממופה", וזו
-- ההתנהגות הקיימת היום (לקוח בלי מזהה אינו בר-הנפקה).
--
-- 🔴 **המלכודת שהסבב הבא חייב להכיר:** `enqueue.ts:272` ו-
--    `receiptFromTaxInvoice.ts:218` חייבות לקרוא **`is_primary` בלבד**, ולא
--    "האם קיימת שורה כלשהי". אחרת לקוח שהמיפוי שלו **בוטל במכוון** ימשיך
--    להיראות בר-הנפקה בזכות אליאס היסטורי — כלומר ביטול המיפוי יפסיק לעצור
--    הנפקה, היפוך של כוונת הפעולה. סעיף 5ג אוכף את צד המסד (אפס ראשי אחרי
--    ביטול); צד הקוד הוא הסבב הנפרד.
--
-- ═══ למה טריגר ולא CHECK על "שורה מוזגת" ═══
-- `CHECK` אינו יכול לקרוא טבלה אחרת — תת-שאילתה אסורה בו — ופונקציה שקוראת
-- טבלה בתוך `CHECK` נבדקת רק ברגע הכתיבה ולעולם לא מחדש, כך שמיזוג מאוחר של
-- הלקוח היה משאיר את השורה מאחוריו בלי שאיש יידע. הטריגר נבדק בכל כתיבה
-- ומרים `check_violation`, כדי שהקורא יקבל את אותה משפחת שגיאה.
-- ⚠️ זה חשוב כאן במיוחד: שורת `[מוזג]` שזכתה במיון לפי שם היא מה שהזיז 14
--    מסמכים בטעות — ההערה ב-`registry.ts:198` מתארת את האירוע.
--
-- ═══ למה ה-PK הוא (client_id, morning_client_id) ═══
-- ולא המזהה לבדו: **מזהה מורנינג משותף לכמה מלקוחותינו לגיטימי** בהכרעת
-- בעלים מ-20.7, ו-`morning/clients/route.ts:168-180` מתיר אותו במפורש אחרי
-- `confirm_shared`. יש מקרה חי אחד — `2b73787f`, גל אורן / גל אורן לרנר —
-- והוא **מזהה המורנינג היחיד במסד שיותר מלקוח אחד תובע**. PK על המזהה לבדו
-- היה חוסם אותו. (שאלת כפילות הלקוח עצמה היא **F16**, ואינה נפתרת כאן.)
--
-- ═══ כלל 49 — השפעת ACL, מוצהרת. ובקובץ הזה היא אמיתית. ═══
-- 🔴 **נוצרים שלושה אובייקטים נושאי-ACL** — בניגוד ל-0092 ול-0093:
--   1. הטבלה `client_morning_ids`. ה-ACL נקבע **במפורש** במראָה ל-`clients`:
--      `authenticated=arwd`, `service_role` מלא, **ו-`anon` נשללת**.
--      ⚠️ השלילה מ-`anon` היא `revoke … from anon` ולא `from public`, וזה
--      הלקח של **T20**: `revoke from public` מסיר את רשומת PUBLIC בלבד ואינו
--      נוגע בגרנט מפורש לתפקיד, והגרנט ל-anon מגיע מ-ALTER DEFAULT PRIVILEGES
--      של Supabase ברגע היצירה. סעיף 5ה מודד את ה-ACL שהתקבל בפועל ומשווה
--      ל-`clients`, במקום להניח שה-GRANT עשה את מה שהתכוון.
--   2+3. שתי פונקציות הטריגר, `SECURITY DEFINER` עם `search_path=public`.
--      ברירת המחדל (EXECUTE ל-PUBLIC) נשמרת בהתאמה לכל פונקציות הטריגר
--      בסכימה, וזה בטוח: plpgsql מסרב להריץ פונקציית טריגר מחוץ להקשר טריגר
--      ("trigger functions can only be called as triggers").
-- RLS דולקת על הטבלה עם ארבע policies במראָה ל-`clients`:
-- view → can_view_money() · insert/update/delete → can_edit_money().
--
-- ═══ מה הקובץ אינו נוגע בו ═══
-- אפס שינוי ב-`clients` · אפס DELETE · אפס UPDATE על נתונים קיימים · אפס
-- נגיעה ב-`documents`, `jobs`, `invoices`. הוא יוצר טבלה, ממלא אותה, ומתקין
-- שני טריגרים. סעיפים 4א-4ד נועלים את ארבע הטבלאות ב-md5.
-- ============================================================================

-- ── הטבלה ─────────────────────────────────────────────────────────────────
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

comment on table public.client_morning_ids is
  'F10 (0094): לקוח אחד, כמה מזהי מורנינג. is_primary הוא המזהה שההנפקה מוציאה תחתיו — יחיד ומחייב; השאר הם אליאסים לקריאה בלבד (התאמה, שיוך, backfill). clients.morning_client_id נשארת כמקור הכתיבה ומסונכרנת הנה בטריגר.';
comment on column public.client_morning_ids.note is
  'למה המזהה הזה שייך ללקוח הזה — קווי הראיה, ומתי ולמה השורה ירדה מראשי. זה בדיוק מה שחסר היה בכל מקרה שנתקלנו בו.';

-- ראשי אחד לכל לקוח: ההנפקה חייבת לדעת תחת איזה מזהה להוציא
create unique index client_morning_ids_one_primary
  on public.client_morning_ids (client_id) where is_primary;
create index client_morning_ids_morning_idx
  on public.client_morning_ids (morning_client_id);

-- ── ACL, מוצהר ולא מונח ───────────────────────────────────────────────────
alter table public.client_morning_ids enable row level security;
revoke all on public.client_morning_ids from anon;
grant select, insert, update, delete on public.client_morning_ids to authenticated;
grant all on public.client_morning_ids to service_role;

create policy client_morning_ids_view   on public.client_morning_ids
  for select using (public.can_view_money());
create policy client_morning_ids_insert on public.client_morning_ids
  for insert with check (public.can_edit_money());
create policy client_morning_ids_update on public.client_morning_ids
  for update using (public.can_edit_money()) with check (public.can_edit_money());
create policy client_morning_ids_delete on public.client_morning_ids
  for delete using (public.can_edit_money());

-- ── שומר: שורה מוזגת אינה יעד מיפוי ───────────────────────────────────────
create or replace function public.client_morning_ids_reject_merged()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.clients c where c.id = new.client_id and c.merged_into is not null) then
    raise exception 'שורת לקוח שמוזגה אינה יכולה לשאת מזהה מורנינג'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_client_morning_ids_not_merged
before insert or update on public.client_morning_ids
for each row execute function public.client_morning_ids_reject_merged();

-- ── טריגר הסנכרון ─────────────────────────────────────────────────────────
-- המסך ממשיך לכתוב ל-`clients.morning_client_id`, והמסד מסנכרן. בלעדיו מיפוי
-- חדש היה נכנס לעמודה ולא לטבלה, והפול לא היה רואה אותו: **כשל שקט**, והוא
-- הגרוע מכולם. אפס שינוי TypeScript, והסחף בלתי אפשרי מבנית.
--
-- ⚠️ ההבחנה בין INSERT ל-UPDATE היא `TG_OP`, **לעולם לא `old is null`**:
--    `record IS NOT NULL` הוא אמת רק כשכל שדות הרשומה מלאים, ולכל שורת
--    `clients` יש עמודה ריקה, ולכן תנאי כזה הוא `false` תמיד. הגרסה הראשונה
--    של הפונקציה הזו נפלה בדיוק על כך בהרצה המדומה — ענף ההורדה לא רץ מעולם
--    והטריגר ניסה להוסיף ראשי שני. זו אותה משפחה של **כלל 51**.
create or replace function public.sync_primary_morning_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- שמירה חוזרת של אותו ערך אינה אירוע: לא מורידים, לא מעלים, ולא מלכלכים
  -- את ה-note. `is distinct from` ולא `=`, כי שני הצדדים יכולים להיות ריקים.
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
    -- ⚠️ שם הטבלה ללא סכימה: ב-ON CONFLICT DO UPDATE מפנים לשורה הקיימת בשם
    --    הטבלה בלבד, ו-`public.` מלפניו נדחה. `excluded` הוא השורה המוצעת.
    do update set is_primary = true,
                  note = coalesce(client_morning_ids.note || ' | ', '') ||
                         'הועלה לראשי ' || to_char(now(), 'YYYY-MM-DD HH24:MI');
  end if;
  return null;
end;
$$;

create trigger trg_sync_primary_morning_id
after insert or update of morning_client_id on public.clients
for each row execute function public.sync_primary_morning_id();

-- ── השערים, הזריעה והאימות ────────────────────────────────────────────────
do $mig$
declare
  c_svetlana constant uuid := 'b42808ad-4e91-4951-bcff-23111644a88b';
  c_defacto  constant uuid := '261c0445-c013-4f87-9dc6-e82f8c7e9c30';
  c_mid_tal  constant text := '90b369a5-b071-4a83-8c32-880671625eaf';
  c_mid_nik  constant text := '3236ef61-db85-491e-a407-e81b493e79ea';
  c_mid_sha  constant text := 'fcf1e261-214c-4195-a372-4380e7bb9b5f';
  c_mid_prim constant text := '0b3b8274-7372-4938-bb28-196944feab33';

  v_clients_before text; v_clients_after text;
  v_docs_before    text; v_docs_after    text;
  v_jobs_before    text; v_jobs_after    text;
  v_inv_before     int;  v_inv_after     int;
  v_unmatched_before int; v_unmatched_after int;
  v_mapped int; v_n int; v_txt text;
begin
  -- ══ 1. השערים ═════════════════════════════════════════════════════════════
  if exists (select 1 from public.schema_ledger where version = '0094') then
    raise exception '0094 עצרה: הקובץ כבר הוחל.';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0093') then
    raise exception '0094 עצרה: 0093 אינו בפנקס — הקבצים מוחלים לפי הסדר.';
  end if;

  -- 1a. הטבלה נוצרה ריקה — הטריגר לא הספיק לרוץ על דבר
  select count(*) into v_n from public.client_morning_ids;
  if v_n <> 0 then
    raise exception '0094 עצרה: הטבלה אינה ריקה לפני הזריעה (% שורות).', v_n;
  end if;

  select count(*) into v_mapped from public.clients
   where morning_client_id is not null and merged_into is null;
  if v_mapped <> 60 then
    raise exception '0094 עצרה: % לקוחות ממופים וחיים, ציפיתי 60.', v_mapped;
  end if;

  -- 1b. שלושת האליאסים במצב שנמדד. כלל 51: VALUES + join, is null נפרד.
  with expected(mid, cid, docs) as (
    values (c_mid_tal, c_svetlana, 17), (c_mid_nik, c_svetlana, 3), (c_mid_sha, c_defacto, 4)
  )
  select count(*), string_agg(e.mid, ', ' order by e.mid) into v_n, v_txt
  from expected e
  where (select count(*) from public.documents d where d.morning_client_id = e.mid) = e.docs
    and not exists (select 1 from public.clients c where c.morning_client_id = e.mid)
    and exists (select 1 from public.clients c where c.id = e.cid and c.merged_into is null);
  if v_n <> 3 then
    raise exception '0094 עצרה: % מתוך 3 האליאסים במצב שנמדד. עברו: [%].', v_n, coalesce(v_txt, 'אף אחד');
  end if;

  -- 1c. ⚠️ ראיית מספר העוסק, נאכפת ולא מונחת. זהו קו הראיה הקשה של 3236ef61,
  --     ובלעדיו השורה חוזרת להישען על השם בלבד.
  if (select distinct raw->'client'->>'taxId' from public.documents where morning_client_id = c_mid_nik)
     is distinct from
     (select distinct raw->'client'->>'taxId' from public.documents where morning_client_id = c_mid_prim) then
    raise exception '0094 עצרה: מספר העוסק של Nikson Mediconsult אינו תואם עוד את 0b3b8274 — השורה נשענת על השם בלבד.';
  end if;

  -- ══ 2. טביעות אצבע לפני — ההוכחה שהקובץ אינרטי ════════════════════════════
  select md5(coalesce(string_agg(c.id::text||'|'||coalesce(c.morning_client_id,'-')||'|'||
                                 coalesce(c.merged_into::text,'-')||'|'||c.name, ',' order by c.id),''))
    into v_clients_before from public.clients c;
  select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-')||'|'||
                                 coalesce(d.job_id::text,'-'), ',' order by d.id),''))
    into v_docs_before from public.documents d;
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text,
                                 ',' order by j.id),''))
    into v_jobs_before from public.jobs j;
  select count(*) into v_inv_before from public.invoices;
  select count(*) into v_unmatched_before from public.documents
   where client_id is null and archived_at is null and cancelled_at is null;

  -- ══ 3. הזריעה: 60 ראשיים + 3 אליאסים ══════════════════════════════════════
  insert into public.client_morning_ids (client_id, morning_client_id, is_primary, morning_name, note)
  select c.id, c.morning_client_id, true,
         (select d.morning_client_name from public.documents d
           where d.morning_client_id = c.morning_client_id
           order by d.document_date desc nulls last limit 1),
         'הועבר מ-clients.morning_client_id ב-0094'
  from public.clients c
  where c.morning_client_id is not null and c.merged_into is null;
  get diagnostics v_n = row_count;
  if v_n <> 60 then
    raise exception '0094 עצרה: נזרעו % שורות ראשיות, ציפיתי 60.', v_n;
  end if;

  insert into public.client_morning_ids (client_id, morning_client_id, is_primary, morning_name, note)
  values
    (c_svetlana, c_mid_tal, false, 'טל מדיקל גרופ',
     'F10 · שלוש שרשראות חוצות זהות (60090←40112, 60099←40176, 60141←40207) שההורה בכולן הוא 0b3b8274 הממופה; ו-6 מסמכים נושאים client_id שלה, 5 מקושרים ל-jobs שלה. ⚠️ מספר העוסק שונה — 513803809 מול 310577473 — וזה גוף משלם אחר של אותה לקוחה, בהכרעת בעלים 19.9; documents.morning_client_name שומר את שם המשלם לכל מסמך.'),
    (c_svetlana, c_mid_nik, false, 'Nikson Mediconsult',
     'F10 · מספר העוסק זהה למזהה הממופה 0b3b8274 — 310577473 — וזה קו הראיה הקשה; השם הוא תעתיק אנגלי של ניקסון מדיקונסלט. ⚠️ אין שרשרת ואין מסמך מקושר, ושלושת מסמכיו מאורכבים ולכן אין לשורה השפעה תפעולית היום.'),
    (c_defacto, c_mid_sha, false, 'שחף סגינר',
     'F10 · שרשרת חוצה זהות 60143←40228 שההורה בה הוא 842fcea8 הממופה; ו-60143, 40261, 60181 נושאים client_id של דה פקטו ומקושרים ל-jobs שלה. למסמכי דה פקטו אין taxId ולכן אין השוואת מספר עוסק — אין אות ואין סתירה.');
  get diagnostics v_n = row_count;
  if v_n <> 3 then
    raise exception '0094 עצרה: נזרעו % אליאסים, ציפיתי 3.', v_n;
  end if;

  -- ══ 4. 🔴 האינרטיות ═══════════════════════════════════════════════════════
  -- 4a. clients לא נגעה
  select md5(coalesce(string_agg(c.id::text||'|'||coalesce(c.morning_client_id,'-')||'|'||
                                 coalesce(c.merged_into::text,'-')||'|'||c.name, ',' order by c.id),''))
    into v_clients_after from public.clients c;
  if v_clients_after is distinct from v_clients_before then
    raise exception '0094 עצרה: clients השתנתה! הקובץ אינו אמור לגעת בה.';
  end if;

  -- 4b. אפס מסמך זז
  select md5(coalesce(string_agg(d.id::text||'|'||coalesce(d.client_id::text,'-')||'|'||
                                 coalesce(d.job_id::text,'-'), ',' order by d.id),''))
    into v_docs_after from public.documents d;
  if v_docs_after is distinct from v_docs_before then
    raise exception '0094 עצרה: מסמך זז! 0094 אמור להיות אינרטי לחלוטין.';
  end if;

  -- 4c. jobs ו-invoices
  select md5(coalesce(string_agg(j.id::text||'|'||coalesce(j.amount::text,'-')||'|'||j.paid::text,
                                 ',' order by j.id),''))
    into v_jobs_after from public.jobs j;
  select count(*) into v_inv_after from public.invoices;
  if v_jobs_after is distinct from v_jobs_before or v_inv_after <> v_inv_before then
    raise exception '0094 עצרה: jobs או invoices זזו.';
  end if;

  -- 4d. ולשונית "לא משויך" לא זזה — הקוראים עדיין על העמודה
  select count(*) into v_unmatched_after from public.documents
   where client_id is null and archived_at is null and cancelled_at is null;
  if v_unmatched_after <> v_unmatched_before then
    raise exception '0094 עצרה: "לא משויך" זזה מ-% ל-% — שינוי ההתנהגות אמור להיות בקוד, לא כאן.',
      v_unmatched_before, v_unmatched_after;
  end if;

  -- ══ 5. הטבלה היא מה שהוכרז ════════════════════════════════════════════════
  -- 5a. 63 שורות בפילוח הנכון
  if (select count(*) from public.client_morning_ids) <> 63
     or (select count(*) from public.client_morning_ids where is_primary) <> 60
     or (select count(*) from public.client_morning_ids where not is_primary) <> 3 then
    raise exception '0094 עצרה: הפילוח אינו 63 = 60 ראשיות + 3 אליאסים.';
  end if;

  -- 5b. כל ראשי תואם את העמודה שממנה נגזר
  select count(*) into v_n from public.clients c
   join public.client_morning_ids m on m.client_id = c.id and m.is_primary
   where c.morning_client_id = m.morning_client_id and c.merged_into is null;
  if v_n <> 60 then
    raise exception '0094 עצרה: % מתוך 60 הראשיות תואמות את clients.morning_client_id.', v_n;
  end if;

  -- 5c. סבטלנה: שלושה מזהים, אחד ראשי. זו המפה רבים-לאחד בפעולה.
  if (select count(*) from public.client_morning_ids where client_id = c_svetlana) <> 3
     or (select count(*) from public.client_morning_ids where client_id = c_svetlana and is_primary) <> 1 then
    raise exception '0094 עצרה: לסבטלנה אין 3 מזהים עם ראשי אחד.';
  end if;

  -- 5d. ⚠️ ומזהה משותף לכמה מלקוחותינו עדיין אפשרי — F16, הכרעת 20.7
  if (select count(*) from public.client_morning_ids
       where morning_client_id = '2b73787f-b09e-48dc-810e-3aacb0b5a394') <> 2 then
    raise exception '0094 עצרה: 2b73787f אינו משותף לשני לקוחות — ה-PK חוסם שיתוף לגיטימי.';
  end if;

  -- 5e. ⚠️ כלל 49 — ה-ACL **נמדד** ולא מונח, ובמראָה ל-clients:
  --     authenticated=arwd, service_role מלא, ו-anon נשללה.
  if exists (select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='client_morning_ids' and grantee='anon') then
    raise exception '0094 עצרה: ל-anon יש גרנט על הטבלה — revoke לא עשה את מה שהתכוון (ראה T20).';
  end if;
  select count(*) into v_n from information_schema.role_table_grants
   where table_schema='public' and table_name='client_morning_ids' and grantee='authenticated'
     and privilege_type in ('SELECT','INSERT','UPDATE','DELETE');
  if v_n <> 4 then
    raise exception '0094 עצרה: ל-authenticated יש % מתוך 4 ההרשאות, במראָה ל-clients.', v_n;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.client_morning_ids'::regclass) then
    raise exception '0094 עצרה: RLS אינה דולקת.';
  end if;
  if (select count(*) from pg_policies where schemaname='public' and tablename='client_morning_ids') <> 4 then
    raise exception '0094 עצרה: אין ארבע policies.';
  end if;

  -- 5f. שני הטריגרים במקומם
  if not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='clients' and t.tgname='trg_sync_primary_morning_id' and not t.tgisinternal)
     or not exists (select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
                  where c.relname='client_morning_ids' and t.tgname='trg_client_morning_ids_not_merged' and not t.tgisinternal) then
    raise exception '0094 עצרה: אחד משני הטריגרים אינו מותקן.';
  end if;

  raise notice '0094: הטבלה נוצרה ונזרעה — 60 ראשיות + 3 אליאסים. אפס מסמך זז, אפס שינוי התנהגות. שינוי הקוראים הוא סבב נפרד.';
end $mig$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'client_morning_ids_created', null,
        jsonb_build_object(
          'migration',   '0094',
          'ticket',      'F10',
          'phase',       'א — מבנה בלבד, אפס שינוי התנהגות',
          'primaries',   60,
          'aliases',     3,
          'alias_ids',   jsonb_build_array('90b369a5','3236ef61','fcf1e261'),
          'readers_unchanged', true,
          'next',        'סבב קוד: registry.ts, backfill.ts, reconcile.ts עוברים לטבלה; enqueue ו-receiptFromTaxInvoice נשארות על is_primary',
          'source',      'investigation 2026-09-19'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0094', now(), 'bnaya',
        'F10 שלב א: נוצרה public.client_morning_ids ונזרעו אליה 63 שורות, 60 ראשיות מ-clients.morning_client_id ושלושה אליאסים, והותקנו שני טריגרים. אפס שינוי ב-clients, אפס DELETE, אפס UPDATE על נתונים קיימים ואפס נגיעה ב-documents, jobs ו-invoices. הקובץ אינרטי במכוון ואינו משנה שום התנהגות: registry.ts ו-backfill.ts קוראים היום את clients.morning_client_id ישירות ולא את הטבלה, ולכן אחרי 0094 אפס מסמך זז ואפס מספר על אפס מסך משתנה; שינוי ההתנהגות הוא בקוד ובסבב נפרד בהכרעת בעלים, וזה מה שמבודד את הסיכון לשלב אחד ומאפשר git revert במקום מיגרציה הפוכה, וסעיפים 4א עד 4ד מוכיחים זאת ב-md5 על ארבע הטבלאות. הרקע: clients.morning_client_id היא עמודה יחידה ולעסק אחד יכולים להיות כמה כרטיסים במורנינג, ונמדד ש-59 מזהי מורנינג אינם נתבעים ע"י אף לקוח על 275 מסמכים, אך מתוכם שניים בלבד הם באמת עסק אחד עם כמה מזהים וזה כל מה שנזרע, בעוד 57 הנותרים הם לקוחות שמעולם לא היו במערכת וכמעט כולם מאורכבים והם מחוץ להיקף כטיקט נפרד. שלוש שורות האליאס ונבדקו מחדש לפני הזריעה בדרישת הבעלים, כולל בדיקת מספר עוסק מתוך raw client taxId שנוספה בבדיקה הזו: 90b369a5 טל מדיקל גרופ אל סבטלנה ניקסון נשען על שלוש שרשראות חוצות זהות 60090 מ-40112 ו-60099 מ-40176 ו-60141 מ-40207 שההורה בכולן נושא את 0b3b8274 הממופה, ועל שישה מסמכים שנושאים client_id שלה וחמישה מקושרים ל-jobs שלה, ומספר העוסק שונה 513803809 מול 310577473 וזה אינו סתירה אלא בדיוק הכרעת הבעלים על לקוח אחד עם כמה גופים משלמים כאשר שם הגוף המשלם הוא עניין של רשויות המס בלבד; fcf1e261 שחף סגינר אל דה פקטו נשען על שרשרת 60143 מ-40228 שההורה בה נושא את 842fcea8 הממופה ועל שלושה מסמכים שנושאים client_id של דה פקטו ומקושרים ל-jobs שלה, ולמסמכי דה פקטו אין taxId ולכן אין השוואה; ו-3236ef61 Nikson Mediconsult אל סבטלנה ניקסון נשען על מספר עוסק זהה 310577473 בדיוק לזה של המזהה הממופה, שהוא קו הראיה הקשה, ועל היות השם תעתיק אנגלי, בעוד אין לו שרשרת ואין לו מסמך מקושר, ולפני בדיקת מספר העוסק השורה הזו נשענה על השם בלבד ולכן סעיף 1ג אוכף את ההתאמה ועוצר אם היא תיפסק, ואין לשורה השפעה תפעולית היום כי שלושת מסמכיה מאורכבים ו-backfillDocumentClients מסנן ארכיון. מה קורה למזהה היוצא, בהכרעת בעלים: הוא נשאר כאליאס ואינו נמחק, מפני שמסמכים ישנים נושאים אותו ומחיקה הייתה מייצרת יתומים חדשים שהם בדיוק הבעיה ש-F10 בא לפתור, והטריגר מוריד is_primary ומשאיר את השורה ורושם ב-note מתי ולמה ירדה; וכאשר morning_client_id מתאפס ל-null האליאסים נשארים והלקוח נשאר בלי ראשי כלל, שהוא הייצוג הנאמן של אינו ממופה וגם ההתנהגות הקיימת היום. מלכודת שהסבב הבא חייב להכיר: enqueue.ts ו-receiptFromTaxInvoice.ts חייבות לקרוא is_primary בלבד ולא האם קיימת שורה כלשהי, אחרת לקוח שהמיפוי שלו בוטל במכוון ימשיך להיראות בר הנפקה בזכות אליאס היסטורי, כלומר ביטול המיפוי יפסיק לעצור הנפקה וזה היפוך של כוונת הפעולה. טריגר הסנכרון קיים כדי שהמסך ימשיך לכתוב לעמודה בלי שינוי TypeScript ובלי סחף שקט, וההבחנה בין INSERT ל-UPDATE נעשית ב-TG_OP ולעולם לא ב-old is null, מפני ש-record IS NOT NULL הוא אמת רק כשכל שדות הרשומה מלאים ולכל שורת clients יש עמודה ריקה, והגרסה הראשונה של הפונקציה נפלה בדיוק על כך בהרצה המדומה כשענף ההורדה לא רץ מעולם והטריגר ניסה להוסיף ראשי שני, וזו אותה משפחה של כלל 51. השומר על שורה מוזגת הוא טריגר ולא CHECK מפני ש-CHECK אינו יכול לקרוא טבלה אחרת ופונקציה שקוראת טבלה בתוך CHECK נבדקת רק ברגע הכתיבה ולעולם לא מחדש, כך שמיזוג מאוחר היה משאיר את השורה מאחוריו. ה-PK הוא client_id ועוד morning_client_id ולא המזהה לבדו מפני שמזהה מורנינג משותף לכמה מלקוחותינו לגיטימי בהכרעת בעלים מ-20.7 ויש מקרה חי אחד, 2b73787f של גל אורן וגל אורן לרנר, שהוא מזהה המורנינג היחיד במסד שיותר מלקוח אחד תובע, ושאלת כפילות הלקוח עצמה היא F16. כלל 49, ACL מוצהר, ובקובץ הזה הוא אמיתי ולא הצהרת אין שינוי: נוצרים שלושה אובייקטים נושאי ACL. הטבלה, שה-ACL שלה נקבע במפורש במראה ל-clients עם authenticated arwd ו-service_role מלא ו-anon נשללת, והשלילה מ-anon היא revoke from anon ולא from public וזה הלקח של T20 שלפיו revoke from public מסיר את רשומת PUBLIC בלבד ואינו נוגע בגרנט מפורש לתפקיד בעוד הגרנט ל-anon מגיע מ-ALTER DEFAULT PRIVILEGES של Supabase, וסעיף 5ה מודד את ה-ACL שהתקבל בפועל במקום להניח שה-GRANT עשה את מה שהתכוון; ושתי פונקציות הטריגר, SECURITY DEFINER עם search_path public, שברירת המחדל של EXECUTE ל-PUBLIC נשמרת בהן בהתאמה לשאר פונקציות הטריגר בסכימה וזה בטוח כי plpgsql מסרב להריץ פונקציית טריגר מחוץ להקשר טריגר. RLS דולקת על הטבלה עם ארבע policies במראה ל-clients, view עם can_view_money ו-insert ו-update ו-delete עם can_edit_money. ההרצה המדומה ב-supabase/verify/0094_dryrun.sql ושאילתת האימות ב-supabase/verify/0094_verify.sql, כלל 50.');
