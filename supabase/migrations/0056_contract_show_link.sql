-- 0056: מסלול החוזה — קישור תוכנית↔חוזה (פריט G).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. אל תחליף ל-$$.
--
-- ═══ הבעיה ═══
-- ל-contracts אין דרך לומר לאיזו תוכנית היא שייכת. התוצאה היא ש"מחויבת
-- בחוזה" אינו מצב שמישהו יכול להגדיר — הוא רק תווית. עופר גולן הוא
-- הדוגמה השבורה: חוזה צף (23,500 נטו) עם 0 אבני דרך, תוכנית שהושתקה
-- ב-billing_mode='none' + kind='internal' + internal_confirmed_* ריקים.
-- שלוש עקיפות ידניות במקום הצהרה אחת. "מכירת ביפו" היא התבנית שעובדת:
-- חוזה → אבן דרך → job → מסמך.
--
-- ═══ מה יש כאן ═══
-- 1. contracts.show_id nullable + FK.
-- 2. אינדקס ייחודי חלקי: לכל היותר חוזה פעיל אחד לתוכנית.
-- 3. comment on column על total_amount — מוסכמת הנטו, במקום שנשלף
--    מ-information_schema ומופיע בעורך הטבלאות. הערת -- במיגרציה לא
--    נקראת פעמיים.
-- 4. show_id מצטרף לגארד הכספי של contracts.
-- 5. 🔶 מעבר לארבעת הצעדים: גארד כספי על productions.kind ו-
--    productions.contract_id. ראה נימוק בסעיף 5.
--
-- ═══ מוסכמת הנטו — מוכחת, לא מוצהרת ═══
--   contracts.total_amount (עופר גולן)  =  23,500
--   23,500 × 1.18                       =  27,730.00
--   הצעת מחיר 392 במורנינג               =  27,730
-- ומהצד השני: ביפו 150,000 + 250,000 = 400,000 = total_amount.
--
-- ═══ מה 0056 לא עושה ═══
-- • אפס UPDATE, אפס DELETE. עמודה אחת, אינדקס, שתי הערות, שני גארדים.
-- • אינה נוגעת ב-27 התוכניות הארכיוניות. הן נשארות billing_mode='contract'
--   בלי חוזה מקושר, ו-show_id=NULL הוא המצב הנכון עבור חוזה-מטרייה כמו
--   "מכירת ביפו" שמכסה קטלוג שלם ולא תוכנית אחת.
-- • אינה מתקנת את עופר גולן. זה תיקון נתונים נפרד, והוא אינו חסום:
--   אומת ב-2026-08-12 שאף גארד על productions אינו מזכיר את kind
--   (guard_production_stage_columns = on_hold+status בלבד, calendar =
--   שדות יומן, split = שדות פיצול, approval = status). אחרי סעיף 5 כאן
--   השינוי יידרוש can_edit_money — וזה נכון, זו הכרעה כספית.


do $mig$
begin

  -- ═══ 0. גארדים ═══
  if exists (select 1 from schema_ledger where version = '0056') then
    raise exception '0056 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from schema_ledger where version = '0055') then
    raise exception '0055 טרם הוחלה — 0056 מניחה את מודל התוצרים. הרץ 0055 קודם.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'contracts' and column_name = 'show_id'
  ) then
    raise exception 'contracts.show_id כבר קיימת — 0056 הוחלה קודם, אולי תחת מספר אחר';
  end if;


  -- ═══ 1. העמודה ═══
  -- nullable, ובכוונה. NULL אינו "חסר מידע" אלא מצב אמיתי: חוזה-מטרייה
  -- שאינו קשור לתוכנית אחת. "מכירת ביפו" (400,000) הוא בדיוק זה — חוזה
  -- אחד מול 27 תוכניות במצב contract. הן נשארות כפי שהן.
  -- הכיוון: תוכנית אחת לחוזה, כמה חוזים לתוכנית לאורך זמן (חידושים) —
  -- חוזה הוא אירוע בזמן, תוכנית היא ישות מתמשכת.
  alter table public.contracts
    add column show_id uuid references public.shows(id);


  -- ═══ 2. לכל היותר חוזה פעיל אחד לתוכנית ═══
  -- בלי זה "מה החוזה של התוכנית" היא שאלה עם שתי תשובות, וזו בדיוק
  -- העמימות שפריט G בא לסגור. חוזים סגורים מצטברים חופשי.
  create unique index contracts_one_active_per_show
    on public.contracts (show_id)
    where show_id is not null and status = 'active';


  -- ═══ 3. ההערות — נשלפות מ-information_schema, שורדות את מי שלא יקרא ═══
  comment on column public.contracts.total_amount is
    'נטו, לפני מע"מ. אומת 2026-08-12: עופר גולן 23,500 × 1.18 = 27,730 = הצעת מחיר 392 במורנינג; ביפו 150,000+250,000 = 400,000. כל תצוגה של הסכום חייבת לתייג "לפני מע״מ".';

  comment on column public.contracts.show_id is
    'התוכנית שהחוזה מכסה. NULL = חוזה-מטרייה שאינו קשור לתוכנית אחת (למשל "מכירת ביפו" מול קטלוג שלם) — מצב תקין, לא חוסר מידע. אינדקס contracts_one_active_per_show מבטיח חוזה פעיל אחד לכל היותר לתוכנית.';


  -- ═══ 4. show_id הוא הגדרה כספית ═══
  -- קישור תוכנית לחוזה קובע מאיפה מגיע הכסף שלה. אותו דרג בדיוק כמו
  -- total_amount ו-client_id (0010).
  create or replace function public.guard_contract_money_columns()
  returns trigger language plpgsql as $fn$
  begin
    if new.total_amount is distinct from old.total_amount
       or new.client_id is distinct from old.client_id
       or new.show_id is distinct from old.show_id then
      if not public.can_edit_money() then
        raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות סכום, לקוח או שיוך תוכנית של חוזה';
      end if;
    end if;
    return new;
  end;
  $fn$;
  -- הטריגר עצמו (trg_guard_contract_money, 0010) כבר קיים ומצביע לכאן


  -- ═══ 5. 🔶 גארד כספי על productions.kind ו-contract_id ═══
  -- מעבר לארבעת הצעדים שאושרו, ובכוונה: kind הוא העמודה שמכריעה אם
  -- on_production_approved יולידה job ("...and new.kind = 'client'"),
  -- כלומר אם אישור לקוח הופך לכסף. עד היום היא ללא שום גארד, בעוד
  -- productions_update ב-RLS מתיר can_edit_money *או* can_edit_stages —
  -- כך שטכנאי היה יכול להפוך internal ל-client ולגרום ל-job להיוולד.
  -- contract_id הוא קישור כספי מאותה משפחה.
  --
  -- אינרטי היום: אומת שאף מסלול בקוד אינו מעדכן kind או contract_id —
  -- שניהם נכתבים ב-INSERT בלבד, וגארד BEFORE UPDATE אינו יורה על INSERT.
  -- סקריפטים בשירות-על עוברים דרך דפוס ה-null (auth.uid() ריק →
  -- can_edit_money() ריק → `if not null` לעולם לא זורק), כמו 0008/0010.
  create or replace function public.guard_production_money_columns()
  returns trigger language plpgsql as $fn$
  begin
    if new.kind is distinct from old.kind
       or new.contract_id is distinct from old.contract_id then
      if not public.can_edit_money() then
        raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות סוג הפקה או שיוך לחוזה';
      end if;
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_guard_production_money on public.productions;
  create trigger trg_guard_production_money
  before update on public.productions
  for each row execute function public.guard_production_money_columns();


  -- ═══ 6. הרישום ═══
  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0056', now(), 'bnaya',
          'מסלול החוזה, פריט G. contracts.show_id nullable + FK ל-shows, עם אינדקס ייחודי חלקי contracts_one_active_per_show (show_id) where status=active — חוזה פעיל אחד לכל היותר לתוכנית. NULL = חוזה-מטרייה, מצב תקין. comment on column על total_amount (נטו, מאומת 23,500×1.18=27,730 מול הצעה 392) ועל show_id. show_id הצטרף ל-guard_contract_money_columns. נוסף guard_production_money_columns על kind + contract_id — kind מכריע אם on_production_approved יולידה job, והיה ללא גארד בעוד RLS מתיר גם can_edit_stages; אינרטי היום כי שתיהן נכתבות ב-INSERT בלבד. אפס UPDATE, אפס DELETE. 27 התוכניות הארכיוניות לא נגעו.');

  raise notice '0056 הוחלה ונרשמה. מסלול החוזה פתוח.';

end
$mig$;
