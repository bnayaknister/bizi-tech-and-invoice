-- 0053: הערך 'receipt' ב-pending_doc_type — לבדו.
--
-- ⚠️ מורץ ידנית ב-SQL Editor, לא דרך supabase db push. הקובץ הזה הוא תיעוד
-- בלבד — הרשומה האמיתית היא ב-schema_ledger. (0052 הודבקה ידנית ולא נשמרה
-- כקובץ, ולכן ls הראה 0051 כאחרונה והמספור התנגש. לכן זה נשמר.)
--
-- ❗ שלוש ההצהרות מורצות בנפרד ולפי הסדר. אל תדביק את כולן יחד.
--
-- למה קבלה היא מסמך נפרד ולא ווריאנט: אומת על 61 קבלות בספרים —
-- אף אחת מהן אינה נושאת income, וכולן נושאות payment (2026-08-10). לכן היא
-- מקבלת מסלול בנייה משלה (receiptFromTaxInvoice.ts) ולא ענף בבנאי הקיים.
--
-- למה ה-ALTER לבדו: PostgreSQL אוסר להשתמש בערך enum חדש באותה טרנזקציה
-- שהוסיפה אותו (ERROR 55P04). כל מיגרציה או קוד שמזכירים 'receipt' חייבים
-- לרוץ אחרי שהצהרה 2 נסגרה. אותו כלל שחייב את פיצול 0046/0047.
--
-- למה הגארד על ה-enum רץ לפני ה-ALTER ולא אחריו: אחרי ההוספה הערך תמיד
-- קיים, ולכן גארד שיושב אחריה לא יכול להבחין בין "היה קיים קודם" לבין
-- "אני יצרתי אותו". הבדיקה חייבת להקדים את השינוי כדי להיות בעלת משמעות.
--
-- אין כאן שינוי התנהגות: הוספת ערך ל-enum אינה נוגעת באף שורה קיימת, ואף
-- קוד עדיין לא כותב אותו. שים לב שאין DROP VALUE בפוסטגרס — הפעולה אינה
-- הפיכה, אך היא בלתי-מזיקה כל עוד איש אינו כותב את הערך.


-- ═══ 1. בדיקה מקדימה — הרץ לבד. אם זורק, אל תמשיך. ═══
do $$
begin
  if exists (select 1 from schema_ledger where version = '0053') then
    raise exception '0053 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if exists (
    select 1 from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'pending_doc_type' and e.enumlabel = 'receipt'
  ) then
    raise exception 'הערך receipt כבר קיים ב-pending_doc_type — הוחל קודם, אולי תחת מספר אחר. אל תוסיף רישום שני.';
  end if;

  raise notice '0053: שתי הבדיקות עברו — אפשר להריץ את ה-ALTER';
end $$;


-- ═══ 2. ההוספה — הרץ לבד. מחוץ ל-DO בכוונה (תקדים 0046:14-15). ═══
alter type pending_doc_type add value if not exists 'receipt';


-- ═══ 3. הרישום — הרץ לבד, אחרי ש-2 נסגרה. ═══
do $$
begin
  if exists (select 1 from schema_ledger where version = '0053') then
    raise exception '0053 כבר רשומה בפנקס';
  end if;

  -- הגארד ההפוך: מוודא שהצהרה 2 באמת עברה, כדי שלא ייווצר רישום על שינוי
  -- שלא קרה
  if not exists (
    select 1 from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'pending_doc_type' and e.enumlabel = 'receipt'
  ) then
    raise exception 'הערך receipt לא נמצא ב-pending_doc_type — הצהרה 2 לא רצה או נכשלה';
  end if;

  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0053', now(), 'bnaya',
          'הערך receipt ב-pending_doc_type, לבדו (כלל 55P04). מכין את מסלול הקבלה 400 — מסמך נפרד, ללא income, עם payment. שום קוד עדיין לא משתמש בו.');
end $$;
