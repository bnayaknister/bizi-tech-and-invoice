-- ============================================================================
-- 0095 — נרמול שמות אולפן ב-`shows.default_studio` וב-`productions.studio`
--
-- מה זה עושה: מאחד איותים שונים של אותו חדר לשם קנוני אחד, כדי שאפשר יהיה
-- לסנן לפי אולפן בהשוואה פשוטה. 3 שורות ב-shows, 15 ב-productions.
--
-- 🔴 בלתי הפיך. הערך הקודם אינו נשמר בשום מקום מלבד שורת הפנקס בסוף הקובץ
--    הזה, ששומרת את הספירה לכל מעבר — לא את זהות השורות. `git revert` אינו
--    מחזיר נתונים. לכן ההרצה המדומה אינה קישוט.
--
-- ═══ 🔒 הכרעות הבעלים (22.9), מילה במילה — אין כאן ניחוש אחד ═══
--   · "גבעון" · "גבעון קטן" · "גבעון בוט׳" · "גבעון בוט"  → כולם חדר אחד.
--     הקנוני: גבעון
--   · החדר המקביל, הגדול, ייקרא תמיד: גבעון גדול
--   · ⚠️ "גבעון בחוץ" = אותו חדר כמו **גבעון גדול** → גבעון גדול.
--     ⚠️⚠️ זה הפוך ממה שנראה מהשם, ובפרט הפוך ממה שהמנתח היה עושה לבדו:
--     "גבעון בחוץ" מכיל את המחרוזת "גבעון", ולכן `extractStudioAndGuest`
--     היה מתאים אותו ל**גבעון** ולא לגבעון גדול. זו הכרעת בעלים מפורשת,
--     והיא הסיבה שגם `studios.ts` מקבל אותו כווריאנט של גבעון גדול באותו
--     קומיט. בלי שני החצאים האלה הנתונים והמנתח יסתרו זה את זה.
--   · כתובת רחוב בעמודת האולפן → חשמונאים. שתי צורות, עברית ואנגלית.
--   · TLV — אולפן נוסף של העסק, בשימוש מועט. **נשאר כפי שהוא. לא נוגעים.**
--   · ריברסייד · שניט · חריש · הקלטת חוץ · מיאמי?! — אינם אולפני העסק.
--     **נשארים בדיוק כפי שהם. לא נוגעים.**
--   · NULL ומחרוזת ריקה — **לא נוגעים.**
--
-- ═══ ⚠️ הסכנה היחידה שאי אפשר לתקן אחר כך ═══
-- "גבעון" ו"גבעון גדול" הם **שני חדרים נפרדים** (ההערה ב-`studios.ts:22`
-- קיימת בדיוק בשביל זה). איחוד שלהם בטעות מוחק הבחנה אמיתית ואין ממה
-- לשחזר אותה. לכן הקובץ:
--   · **אינו נוגע** ב-4 שורות "גבעון גדול" הקיימות — הן אינן ב-UPDATE כלל;
--   · ממפה לתוך "גבעון גדול" **דבר אחד בלבד**: "גבעון בחוץ";
--   · ומאמת מפורשות (מבחן 6) ש-"גבעון גדול" = 4+1 = 5 ולא יותר.
--
-- ═══ למה השוואה מדויקת ולא LIKE ═══
-- כל ההחלפות הן `= 'ערך'`, לא `like '%...%'`. תת-מחרוזת הייתה בולעת את
-- "גבעון גדול" לתוך כלל של "גבעון" — בדיוק הנזק הבלתי הפיך שלמעלה — וגם
-- הייתה תופסת "הקלטת חוץ" תחת כלל של "חוץ". ערך שאינו תואם תו-בתו פשוט
-- אינו מטופל, והספירות למטה הן מה שהופך "לא טופל" לעצירה במקום לשתיקה.
--
-- ═══ כלל 49 — השפעת ACL, מוצהרת ═══
-- הקובץ אינו יוצר שום אובייקט נושא-ACL — לא טבלה, לא עמודה, לא טיפוס, לא
-- policy, לא אינדקס, לא view — ואינו מחליף שום פונקציה. הוא כותב ערכי טקסט
-- לשתי עמודות קיימות ומוסיף שורה אחת ל-`events`. אין GRANT ואין דבר
-- שהרשאותיו יכולות להיוולד שגויות. `shows` ו-`productions` מוגנות ב-RLS
-- ובטריגרים של כסף (0008/0012 על shows) — `default_studio` ו-`studio` אינם
-- שדות כסף ואינם באף אחד מהגארדים האלה. הקובץ רץ כ-postgres ועוקף RLS כמו
-- כל מיגרציה — מצב קיים, לא דבר שהוא יוצר.
--
-- ═══ הרצה חוזרת ═══
-- הקובץ **יסרב** בהרצה שנייה: הספירות יחזרו 0 במקום הצפוי והוא יזרוק. זה
-- מכוון — הוא נורמליזציה חד-פעמית, לא פונקציה אידמפוטנטית. `DO` + exception
-- מגלגל הכול, כך שסירוב אינו משאיר חצי שינוי.
-- ============================================================================

do $mig$
declare
  -- הכתובות, מילה במילה מפלט שאילתת המצאי. מוצהרות כקבועים ולא מודבקות
  -- בתוך ה-UPDATE כדי ששורת הפנקס והבדיקות יקראו בדיוק את אותה מחרוזת.
  c_addr_he constant text := 'החשמונאים 105, תל אביב-יפו, 6713320, ישראל';
  c_addr_en constant text := 'HaHashmonaim St 105, Tel Aviv-Yafo, 6713320, Israel';

  n_shows_katan   int;
  n_prod_katan    int;
  n_prod_bot      int;
  n_prod_bahutz   int;
  n_prod_addr_he  int;
  n_prod_addr_en  int;
  n_prod_total    int;
  n_gadol_after   int;
begin
  -- ── 1. shows.default_studio ───────────────────────────────────────────────
  update public.shows set default_studio = 'גבעון'
   where default_studio = 'גבעון קטן';
  get diagnostics n_shows_katan = row_count;

  -- ── 2. productions.studio ─────────────────────────────────────────────────
  update public.productions set studio = 'גבעון' where studio = 'גבעון קטן';
  get diagnostics n_prod_katan = row_count;

  update public.productions set studio = 'גבעון' where studio = 'גבעון בוט׳';
  get diagnostics n_prod_bot = row_count;

  -- ⚠️ היחיד שנכנס ל"גבעון גדול". הכרעת בעלים, הפוכה מהאינטואיציה — ראה הכותרת.
  update public.productions set studio = 'גבעון גדול' where studio = 'גבעון בחוץ';
  get diagnostics n_prod_bahutz = row_count;

  update public.productions set studio = 'חשמונאים' where studio = c_addr_he;
  get diagnostics n_prod_addr_he = row_count;

  update public.productions set studio = 'חשמונאים' where studio = c_addr_en;
  get diagnostics n_prod_addr_en = row_count;

  n_prod_total := n_prod_katan + n_prod_bot + n_prod_bahutz + n_prod_addr_he + n_prod_addr_en;

  -- ── 3. הספירות הן השער, לא הדיווח ─────────────────────────────────────────
  -- ערך שאינו תואם תו-בתו (רווח כפול, גרש אחר, פסיק חסר בכתובת) פשוט לא
  -- יעודכן — וזה ייראה כאן כסטייה בספירה, לא כשקט.
  if n_shows_katan <> 3 then
    raise exception '0095: shows "גבעון קטן" — צפוי 3, בפועל %. לא בוצע שינוי.', n_shows_katan;
  end if;
  if n_prod_katan <> 8 then
    raise exception '0095: productions "גבעון קטן" — צפוי 8, בפועל %. לא בוצע שינוי.', n_prod_katan;
  end if;
  if n_prod_bot <> 1 then
    raise exception '0095: productions "גבעון בוט׳" — צפוי 1, בפועל %. לא בוצע שינוי.', n_prod_bot;
  end if;
  if n_prod_bahutz <> 1 then
    raise exception '0095: productions "גבעון בחוץ" — צפוי 1, בפועל %. לא בוצע שינוי.', n_prod_bahutz;
  end if;
  if n_prod_addr_he <> 3 then
    raise exception '0095: productions כתובת עברית — צפוי 3, בפועל %. לא בוצע שינוי.', n_prod_addr_he;
  end if;
  if n_prod_addr_en <> 2 then
    raise exception '0095: productions כתובת אנגלית — צפוי 2, בפועל %. לא בוצע שינוי.', n_prod_addr_en;
  end if;
  if n_prod_total <> 15 then
    raise exception '0095: productions סה"כ — צפוי 15, בפועל %. לא בוצע שינוי.', n_prod_total;
  end if;

  -- ── 4. 🔴 השער שמגן על ההבחנה הבלתי הפיכה ─────────────────────────────────
  -- 4 קיימות + "גבעון בחוץ" אחד = 5. מספר אחר פירושו שמשהו נוסף זלג לתוך
  -- החדר הגדול, וזו בדיוק הטעות שאין ממנה חזרה.
  select count(*) into n_gadol_after from public.productions where studio = 'גבעון גדול';
  if n_gadol_after <> 5 then
    raise exception '0095: "גבעון גדול" — צפוי 5 (4+1), בפועל %. לא בוצע שינוי.', n_gadol_after;
  end if;

  -- ── 5. שורת הפנקס ─────────────────────────────────────────────────────────
  -- actor_id ריק במכוון: מיגרציה עשתה זאת, לא אדם. ה-payload שומר את הספירה
  -- לכל מעבר — זה כל מה שנשאר מהמצב הקודם אחרי שהקובץ ירוץ.
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values (
    'studio_normalization',
    '00000000-0000-0000-0000-000000000000',
    'studio_names_normalized',
    null,
    jsonb_build_object(
      'via',        '0095',
      'shows',      jsonb_build_object('גבעון קטן→גבעון', n_shows_katan),
      'productions', jsonb_build_object(
        'גבעון קטן→גבעון',   n_prod_katan,
        'גבעון בוט׳→גבעון',  n_prod_bot,
        'גבעון בחוץ→גבעון גדול', n_prod_bahutz,
        'כתובת עברית→חשמונאים',  n_prod_addr_he,
        'כתובת אנגלית→חשמונאים', n_prod_addr_en
      ),
      'totals',     jsonb_build_object('shows', n_shows_katan, 'productions', n_prod_total),
      'untouched',  jsonb_build_array('TLV', 'ריברסייד', 'שניט', 'חריש', 'הקלטת חוץ', 'מיאמי?!', 'NULL', '(מחרוזת ריקה)')
    )
  );

  raise notice '✅ 0095: shows %, productions % (גבעון גדול עכשיו %).',
    n_shows_katan, n_prod_total, n_gadol_after;
end $mig$;

-- ── שובל האודיט ─────────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
-- האימות שאחרי ההרצה: supabase/verify/0095_verify.sql — תשע עמודות, כולן true.
