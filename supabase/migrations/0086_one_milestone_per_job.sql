-- 0086 — אבן דרך אחת לכל job
--
-- אינדקס אחד. אפס שינוי סכימה, אפס DELETE, אפס שורה שנכתבה.
--
--   create unique index contract_milestones_one_per_job
--     on public.contract_milestones (job_id)
--     where job_id is not null
--
-- ═══ הבעיה: יחס 1:1 שנשען כולו על בדיקת קריאה ═══
--
-- contract_milestones.job_id הוא עמודה יחידה, ולכן היחס בין אבן דרך ל-job
-- אמור להיות 1:1 משני הכיוונים. הכיוון האחד — אבן דרך אחת מצביעה על job אחד
-- לכל היותר — נאכף על ידי הטיפוס עצמו. הכיוון השני — job אחד נתפס על ידי אבן
-- דרך אחת לכל היותר — אינו נאכף בשום מקום במסד.
--
-- ההגנה היחידה היא בדיקת קריאה בקוד, ב-milestones/[mid]/route.ts:67-75:
--
--     const { data: taken } = await supabase
--       .from("contract_milestones").select("id,name")
--       .eq("job_id", jobId).neq("id", params.mid).maybeSingle();
--     if (taken) return 409;
--
-- וההערה שמעליה (שורות 16-18 באותו קובץ) מודה בכך במילים מפורשות: "there is
-- NO unique index on job_id in the DB and this route does not add one, so the
-- 'already taken' check is a read, with the race that implies". נמדד היום:
-- על contract_milestones יש אינדקס אחד בלבד, ה-PK. אין שום דבר על job_id.
--
-- ═══ למה דווקא עכשיו: הראוט החדש אינו יוצר שורת תור ═══
--
-- עד היום המסלול היחיד שיצר job לאבן דרך היה enqueue/route.ts:136-165, והוא
-- מוגן בעקיפין — לא על ידי כלל על contract_milestones, אלא על ידי
-- pending_documents_one_live_per_job שנוצר ב-0079. הראוט יוצר job ומיד אחריו
-- שורת תור, והאינדקס ההוא מסרב לשורה שנייה על אותו (doc_type, job_id); לחיצה
-- כפולה נחסמת שם, אחרי שכבר נוצרו שני jobs, אבל נחסמת.
--
-- ⚠️ record-billed אינו יוצר שורת תור. זה כל עניינו: הוא רושם מסמכים שכבר
-- יצאו ממורנינג, ואינו מנפיק דבר. לכן 0079 אינו מגן עליו — אין שורת תור
-- שתתנגש. שתי לחיצות מהירות על "רשום כחויב" ייצרו שני jobs, ו-
-- contract_milestones.job_id יצביע על השני. הראשון יישאר יתום עם contract_id
-- מלא ועם paid='לא', וייספר ב-debtToCollect ברדאר (alerts.ts:263-264) לנצח,
-- בלי שאף מסך יצביע עליו.
--
-- כלומר: הפיצ'ר החדש הוא המסלול הראשון שיוצר job בלי שום רשת ייחודיות
-- מאחוריו. האינדקס הזה הוא הרשת.
--
-- ═══ התקדים: 0079, אותה צורה ואותו טיעון ═══
--
-- 0079 כתב בדיוק את זה על pending_documents, וההנמקה שלו חלה כאן מילה במילה:
-- "כלל הברזל נאכף בסכימה במקום להיות מופקד בידי הקורא" (0025, שצוטט שם).
-- ההבדל היחיד הוא העמודה. שם היה גארד אפליקטיבי אמיתי וטוב (billMiscProduction
-- עם is(job_id, null) כפרדיקט) שהגן על מסלול אחד ושתק על השני; כאן הגארד חלש
-- יותר עוד — הוא SELECT ואז UPDATE בראוט אחד, ושני מסלולים נוספים
-- (enqueue/route.ts:156-159 ו-record-billed) כותבים job_id בלי לבדוק כלל.
-- שלושה כותבים, בדיקה אחת, אפס אכיפה. זה בקלוג 3, והוא נסגר כאן.
--
-- ═══ מה האינדקס מכסה ומה לא ═══
--
-- מכסה: כל אבן דרך שמצביעה על job. חמש היום, וכולן מצביעות.
--
-- אינו מכסה, ובמכוון: אבן דרך עם job_id ריק. זהו המצב הפותח הרגיל של אבן
-- דרך לפני המסמך הראשון שלה (milestone.ts:31-33 אומר זאת במפורש), ואין בו מה
-- לייחד — כמה אבני דרך יכולות וצריכות לשבת בלי job בו-זמנית. זו הסיבה
-- שהאינדקס חלקי, ולא כלל ייחודיות מלא על העמודה: NULL אחד היה חוסם את כל
-- השאר ב-btree שאינו NULLS NOT DISTINCT, ומעבר לכך היה הופך את המצב הנכון
-- ביותר במערכת לבלתי אפשרי.
--
-- ═══ הערה על ה-FK, כי היא משלימה את התמונה ═══
--
-- contract_milestones_job_id_fkey היא FOREIGN KEY (job_id) REFERENCES jobs(id)
-- בלי ON DELETE — כלומר NO ACTION. job שאבן דרך מצביעה עליו אינו ניתן למחיקה.
-- זה מה שהופך את מסלול הגלגול של enqueue/route.ts:160-164 לבטוח: הוא מוחק את
-- ה-job רק כשהקישור לאבן הדרך נכשל, כלומר רק כשאין שורה שמצביעה עליו. אותו
-- סדר בדיוק נדרש מ-record-billed, ומשני הכיוונים: האינדקס הזה מונע את ה-job
-- הכפול, וה-FK מונע מהגלגול למחוק job שכבר נתפס.
--
-- ═══ הרשאות — מוצהר ולא מונח (כלל 49) ═══
--
-- אינדקס אינו אובייקט נושא-ACL. הוא אינו מעניק דבר, אינו שולל דבר, ואין לו
-- הרשאה משלו: אין כאן GRANT שאפשר לשכוח ואין עמודה שנולדת קריאה לתפקיד הלא
-- נכון. זה החצי הראשון של כלל 49 כפי שהוא חל על הקובץ הזה, והוא נאמר במפורש
-- ולא מושאר לשתיקה — "אין שינוי הרשאות" היא טענה שקורא צריך למצוא ולא להסיק.
--
-- החצי השני מקבל משפט כי הוא החצי שמכה בלי שגיאה. נמדד על המסד הזה, 15.9.26:
--
--   has_table_privilege('authenticated','public.contract_milestones','SELECT') = TRUE
--   has_table_privilege('anon',         'public.contract_milestones','SELECT') = FALSE
--   RLS דלוק, 4 policies (view/write/update/delete — can_view_money / can_edit_money ×3)
--
-- כלום מזה לא נגע, וה-canary מאמת את כולם כבלתי משתנים במקום לסמוך על כך
-- שאינדקס לא יכול היה להזיז אותם.
--
-- ---------------------------------------------------------------------------
-- אפס DELETE. אפס שורה שנכתבה. אפס עמודה. אינדקס אחד.

do $mig$
declare
  v_rows_pre    bigint;
  v_rows_post   bigint;
  v_indexed     bigint;
  v_violating   int;
  v_idx_def     text;
  v_idx_unique  boolean;
  v_index_count int;

  v_auth_sel    boolean;
  v_anon_sel    boolean;
  v_rls         boolean;
  v_policies    int;
begin
  -- ---------------------------------------------------------------------
  -- 0. שומרים.
  -- ---------------------------------------------------------------------

  -- 0a. אינה ניתנת להרצה חוזרת, ואומרת זאת.
  if exists (select 1 from public.schema_ledger where version = '0086') then
    raise exception '0086 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- 0b. הפנקס הוא הרצף, לא שמות הקבצים (migrations/README.md).
  --     0085 הוחלה 15.9.26 20:19 UTC וזה המספר הבא.
  if not exists (select 1 from public.schema_ledger where version = '0085') then
    raise exception '0086: 0085 אינה בפנקס — המספור נגזר מפנקס אחר, מדדי מחדש';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. המדידה, לפני האינדקס — כדי שכשל יהיה משפט ולא 23505 גולמי מתוך
  --    ה-CREATE שלמטה.
  -- ---------------------------------------------------------------------
  select count(*) into v_rows_pre from public.contract_milestones;

  select count(*) into v_indexed from public.contract_milestones
   where job_id is not null;

  select count(*) into v_violating from (
    select job_id
      from public.contract_milestones
     where job_id is not null
     group by job_id
    having count(*) > 1
  ) d;

  if v_violating <> 0 then
    raise exception '0086: % jobs כבר תפוסים על ידי יותר מאבן דרך אחת — האינדקס ייכשל ב-23505. הכרע מה עושים עם הכפילויות לפני שמריצים', v_violating;
  end if;

  -- חמש אבני דרך היום, כולן מקושרות. לא assert קשיח: הטבלה גדלה בכל חוזה
  -- חדש, וקיבוע המספר היה הופך יום רגיל למיגרציה שנכשלת. הבדיקה שנושאת
  -- משקל היא v_violating למעלה.
  raise notice '0086: % שורות ייכנסו לאינדקס (היו 5 מתוך 5 בכתיבה), אפס jobs כפולים', v_indexed;

  -- ---------------------------------------------------------------------
  -- 2. האינדקס. `if not exists` לשם re-entrancy בלבד — שומר הפנקס למעלה
  --    הוא ה"הרץ פעם אחת" האמיתי, וזה רק מאפשר לנסיון חצי-מוחל לרוץ שוב
  --    בלי 42P07 מבלבל.
  -- ---------------------------------------------------------------------
  create unique index if not exists contract_milestones_one_per_job
    on public.contract_milestones (job_id)
    where job_id is not null;

  -- ---------------------------------------------------------------------
  -- 3. CANARY. הכל לפני שורת הפנקס, כך שכשל מגלגל את המיגרציה כולה במקום
  --    לרשום סכימה חצי-מוחלת.
  -- ---------------------------------------------------------------------

  -- 3a. האינדקס קיים, הוא UNIQUE, והוא נושא את הפרדיקט שנטען. בדיקת קיום
  --     בלבד הייתה עוברת על אינדקס לא-ייחודי או על אינדקס מלא — כלומר על
  --     אינדקס שאינו עושה את הדבר האחד שהקובץ הזה קיים בשבילו.
  select indexdef into v_idx_def from pg_indexes
   where schemaname = 'public' and indexname = 'contract_milestones_one_per_job';
  if v_idx_def is null then
    raise exception '0086 canary: contract_milestones_one_per_job לא נוצר';
  end if;

  select indisunique into v_idx_unique from pg_index
   where indexrelid = 'public.contract_milestones_one_per_job'::regclass;
  if not coalesce(v_idx_unique, false) then
    raise exception '0086 canary: האינדקס נוצר אך אינו UNIQUE — הוא אינו חוסם דבר';
  end if;

  if v_idx_def not like '%job_id IS NOT NULL%' or v_idx_def not like '%job_id%' then
    raise exception '0086 canary: פרדיקט האינדקס אינו זה שנטען (%)', v_idx_def;
  end if;

  -- 3b. אפס jobs כפולים — נאמר שוב אחרי שהאינדקס קיים, כי עד עכשיו זו הייתה
  --     שאילתה ועכשיו זו אילוצה ששרדה בנייה. אינדקס ייחודי אינו יכול להתקיים
  --     מעל שורות כפולות, ולכן עצם ההגעה לשורה הזו כבר מוכיחה זאת; הספירה
  --     כאן כדי שה-notice יאמר זאת במספרים ולא ברמז.
  select count(*) into v_violating from (
    select job_id
      from public.contract_milestones
     where job_id is not null
     group by job_id
    having count(*) > 1
  ) d;
  if v_violating <> 0 then
    raise exception '0086 canary: % jobs כפולים אחרי יצירת האינדקס — בלתי אפשרי, עצור וברר', v_violating;
  end if;

  -- 3c. אף שורה לא זזה. אינדקס אינו יוצר, אינו מוחק ואינו כותב מחדש דבר —
  --     וזו ההצהרה שאומרת זאת בקול במקום להניח זאת, כמו 3d ב-0079.
  select count(*) into v_rows_post from public.contract_milestones;
  if v_rows_post <> v_rows_pre then
    raise exception '0086 canary: % שורות בטבלה במקום % — מיגרציה של אינדקס אינה אמורה לגעת בשורה', v_rows_post, v_rows_pre;
  end if;

  -- 3d. אינדקס אחד לפני (ה-PK), שניים אחרי. ליטרל, כך שאינדקס שנוסף על ידי
  --     משהו אחר מחוץ למיגרציה הזו צף כאן.
  select count(*) into v_index_count from pg_indexes
   where schemaname = 'public' and tablename = 'contract_milestones';
  if v_index_count <> 2 then
    raise exception '0086 canary: % אינדקסים על contract_milestones במקום 2 — משהו נוסף מחוץ למיגרציה הזו', v_index_count;
  end if;

  -- 3e. הרשאות ללא שינוי, שני הכיוונים (כלל 49). אינדקס אינו יכול להזיז
  --     אותן; זה מוכיח שהוא לא הזיז, במקום להניח שלא יכול היה.
  select has_table_privilege('anon', 'public.contract_milestones', 'SELECT') into v_anon_sel;
  if v_anon_sel then
    raise exception '0086 canary: ל-anon יש SELECT על contract_milestones — לא היה אמור, בדוק pg_default_acl';
  end if;

  select has_table_privilege('authenticated', 'public.contract_milestones', 'SELECT') into v_auth_sel;
  if not v_auth_sel then
    raise exception '0086 canary: authenticated אינו קורא את contract_milestones — מסך החוזים יירנדר ריק';
  end if;

  select relrowsecurity into v_rls from pg_class where oid = 'public.contract_milestones'::regclass;
  if not v_rls then
    raise exception '0086 canary: RLS כבוי על contract_milestones';
  end if;

  select count(*) into v_policies from pg_policies
   where tablename = 'contract_milestones'
     and policyname in ('milestones_view','milestones_write','milestones_update','milestones_delete');
  if v_policies <> 4 then
    raise exception '0086 canary: % מתוך 4 policies של contract_milestones קיימים', v_policies;
  end if;

  raise notice '0086 OK — אינדקס ייחודי חלקי על job_id · % שורות מאונדקסות · אפס jobs כפולים · % שורות בטבלה ללא שינוי · % אינדקסים',
    v_indexed, v_rows_post, v_index_count;

  -- ---------------------------------------------------------------------
  -- 4. שורת הפנקס, אחרונה — באותו בלוק אטומי, נופלת או עוברת עם השינוי.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0086', now(), 'bnaya',
    'אבן דרך אחת לכל job — אינדקס ייחודי חלקי על contract_milestones.job_id, אפס שינוי סכימה, אפס DELETE, אפס שורה שנכתבה. הבעיה: contract_milestones.job_id היא עמודה יחידה ולכן היחס בין אבן דרך ל-job אמור להיות 1:1 משני הכיוונים, והכיוון האחד בלבד נאכף. שאבן דרך תצביע על job אחד לכל היותר מובטח על ידי הטיפוס; שאיזה job ייתפס על ידי אבן דרך אחת לכל היותר לא היה נאכף בשום מקום במסד. ההגנה היחידה הייתה בדיקת קריאה בקוד, ב-milestones/[mid]/route.ts:67-75, שבוחרת contract_milestones לפי job_id ומחזירה 409 אם נמצאה אחרת; וההערה שמעליה באותו קובץ, שורות 16-18, מודה בכך במילים מפורשות ואומרת שאין אינדקס ייחודי על job_id ושהראוט אינו מוסיף אחד ושלכן בדיקת כבר-תפוס היא קריאה על המרוץ שזה גורר. נמדד לפני הכתיבה: על contract_milestones אינדקס אחד בלבד, ה-PK, ואין שום דבר על job_id. למה דווקא עכשיו, וזו כל הסיבה שהקובץ הזה קיים היום ולא לפני חודש: עד עכשיו המסלול היחיד שיצר job לאבן דרך היה enqueue/route.ts:136-165, והוא מוגן בעקיפין ולא על ידי כלל על הטבלה הזאת אלא על ידי pending_documents_one_live_per_job שנוצר ב-0079 — הראוט יוצר job ומיד אחריו שורת תור, והאינדקס ההוא מסרב לשורה שנייה על אותו doc_type ו-job_id, כך שלחיצה כפולה נחסמת שם, אחרי שכבר נוצרו שני jobs אבל נחסמת. הראוט החדש record-billed אינו יוצר שורת תור כלל, וזה כל עניינו: הוא רושם מסמכים שכבר יצאו ממורנינג מחוץ למערכת ואינו מנפיק דבר, ולכן 0079 אינו מגן עליו כי אין שורת תור שתתנגש. שתי לחיצות מהירות על רשום כחויב היו יוצרות שני jobs, contract_milestones.job_id היה מצביע על השני, והראשון היה נשאר יתום עם contract_id מלא ועם paid שווה לא, נספר ב-debtToCollect ברדאר ב-alerts.ts:263-264 לנצח בלי שאף מסך יצביע עליו. כלומר הפיצ׳ר החדש הוא המסלול הראשון במערכת שיוצר job בלי שום רשת ייחודיות מאחוריו, והאינדקס הזה הוא הרשת. התקדים הוא 0079, אותה צורה ואותו טיעון מילה במילה: כלל הברזל נאכף בסכימה במקום להיות מופקד בידי הקורא, ניסוח שמקורו ב-0025 וצוטט שם. ההבדל היחיד הוא העמודה. שם היה גארד אפליקטיבי אמיתי וטוב, billMiscProduction שמטביע job_id עם is(job_id, null) כפרדיקט ולא כקריאה-ואז-כתיבה, והוא הגן על מסלול אחד ושתק על השני; כאן הגארד חלש עוד יותר, הוא SELECT ואז UPDATE בראוט אחד בלבד, ושני מסלולים נוספים כותבים job_id בלי לבדוק כלל — enqueue/route.ts:156-159 ו-record-billed. שלושה כותבים, בדיקה אחת, אפס אכיפה. זה בקלוג 3, והוא נסגר כאן. מה שהאינדקס מכסה: כל אבן דרך שמצביעה על job, חמש היום וכולן מצביעות. מה שאינו מכסה ובמכוון: אבן דרך עם job_id ריק, שהוא המצב הפותח הרגיל של אבן דרך לפני המסמך הראשון שלה — milestone.ts:31-33 אומר זאת במפורש — ואין בו מה לייחד, כי כמה אבני דרך יכולות וצריכות לשבת בלי job בו-זמנית. זו הסיבה שהאינדקס חלקי ולא כלל ייחודיות מלא על העמודה: NULL אחד היה חוסם את כל השאר ב-btree שאינו NULLS NOT DISTINCT, ומעבר לכך היה הופך את המצב הנכון ביותר במערכת לבלתי אפשרי. הערה על ה-FK כי היא משלימה את התמונה: contract_milestones_job_id_fkey היא FOREIGN KEY על job_id אל jobs(id) בלי ON DELETE, כלומר NO ACTION, ולכן job שאבן דרך מצביעה עליו אינו ניתן למחיקה. זה מה שהופך את מסלול הגלגול של enqueue/route.ts:160-164 לבטוח, שכן הוא מוחק את ה-job רק כשהקישור לאבן הדרך נכשל כלומר רק כשאין שורה שמצביעה עליו, ואותו סדר בדיוק נדרש מ-record-billed; שני הכיוונים נשמרים כאן, האינדקס מונע את ה-job הכפול וה-FK מונע מהגלגול למחוק job שכבר נתפס. הרשאות לפי כלל 49: אינדקס אינו אובייקט נושא-ACL, אינו מעניק ואינו שולל דבר ואין לו הרשאה משלו, ולכן אין כאן GRANT שאפשר לשכוח ואין עמודה שנולדת קריאה לתפקיד הלא נכון, וזה נאמר במפורש ולא מושאר לשתיקה כי אין שינוי הרשאות היא טענה שקורא צריך למצוא ולא להסיק. החצי השני של הכלל מקבל משפט כי הוא החצי שמכה בלי שגיאה: נמדד 15.9.26 ש-authenticated מחזיק SELECT ברמת הטבלה, ש-anon אינו מחזיק, ש-RLS דלוק ושארבעה policies קיימים — milestones_view על can_view_money ו-milestones_write ו-milestones_update ו-milestones_delete על can_edit_money; כלום מזה לא נגע וה-canary מאמת את כולם כבלתי משתנים במקום לסמוך על כך שאינדקס לא יכול היה להזיז אותם. השומרים לפני הכתיבה: הפנקס אינו מכיל 0086, והפנקס כן מכיל 0085 שהוחלה 15.9.26 בשעה 20:19:52 UTC. ספירת הכפילויות נמדדת לפני היצירה כדי שכשל יהיה משפט ולא 23505 גולמי מתוך ה-CREATE. שמונה בדיקות canary לפני שורת הפנקס: האינדקס קיים, הוא UNIQUE, הפרדיקט שלו הוא זה שנטען ובפרט הוא חלקי על job_id is not null, אפס jobs כפולים אחרי היצירה, מספר השורות בטבלה לא השתנה, שני אינדקסים במקום אחד, anon אפס ו-authenticated קורא, ו-RLS דלוק עם ארבעת ה-policies. מספר השורות המאונדקסות מדווח ב-notice ואינו נאכף, כי הטבלה גדלה בכל חוזה חדש וקיבוע המספר היה הופך יום רגיל למיגרציה שנכשלת. מחוץ להיקף במכוון: השורש עצמו, כלומר ששלושה מסלולים כותבים contract_milestones.job_id ורק אחד מהם בודק — האינדקס הופך את השניים האחרים לבטוחים על ידי כך שהמסד מסרב, ולא על ידי כך שהם למדו לבדוק, וזו הכרעה ולא פשרה לפי אותו טיעון של 0025 ו-0079; ו-bundle_job_ids, שאינו נוגע לטבלה הזאת כלל.');

  raise notice '0086 הוחלה ונרשמה. אבן דרך אחת לכל job — בקלוג 3 נסגר, והמסלול הראשון שיוצר job בלי שורת תור מקבל רשת.';

end $mig$;
