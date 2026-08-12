-- 0054: תיעוד derive_production_status החיה — העתקה מהסכימה בפרודקשן.
--
-- ⚠️⚠️  הקובץ הזה אינו מיועד להרצה.  ⚠️⚠️
-- הפונקציות והטריגרים שלהלן כבר חיים במסד. הדבקה חוזרת שלהם היא no-op
-- במקרה הטוב ודריסה של מצב עדכני יותר במקרה הרע. ההצהרה היחידה שמורצת
-- בקובץ הזה היא רישום הפנקס בסוף (סעיף 4).
--
-- ═══ למה הקובץ קיים ═══
-- 0052 שינתה את derive_production_status, הודבקה ידנית ב-SQL Editor ולא
-- נשמרה כקובץ — אותו כשל שתועד ב-0053:4. התוצאה: הגרסה האחרונה שניתן היה
-- לקרוא מהריפו הייתה 0039, והיא כבר לא מה שרץ. כלל 17 (מיגרציות מוחלות
-- ידנית, הפנקס הוא המקור לרצף) מחייב שגם ההדבקה הידנית תשאיר קובץ.
-- שלב 1 של מודל התוצרים עומד לגעת בפונקציה הזו, ואי אפשר לתקן קוד שאי
-- אפשר לראות.
--
-- ═══ מה ששרד מ-0052: רשומת הפנקס (2026-08-05 12:43:44 UTC, bnaya) ═══
--   "derive_production_status: התנאי הוחלף מ-forward-only ל-is distinct
--    from. הגזירה מיישרת גם כלפי מטה בתוך חמשת מצבי הפס. נוסף שדה
--    direction ל-payload של status_auto_advanced."
--
-- ═══ אימות מול הסכימה החיה (pg_proc + pg_trigger + events, 2026-08-12) ═══
--   derive_production_status
--     prosecdef = true                                   ✅ נשמר מ-0020/0039
--     proconfig = {search_path=public}                   ✅
--     prosrc ~ 'is distinct from'                        ✅ תואם לפנקס
--     prosrc ~ 'direction'                               ✅ תואם לפנקס
--     prosrc ~ 'prod_cursor_rank'                        ✅ עדיין נקראת,
--       אך בתפקיד חדש: תיוג direction באירוע, לא עוד שער forward-only
--     length(prosrc) = 3461 · md5 = 1941f4d549b1a514d7ac26568539df2c  ✅
--       ההעתקה בסעיף 2 אומתה בייט-בייט מול ה-md5 הזה
--   prod_cursor_rank
--     length(prosrc) = 186  · md5 = 831153c5b637e1bc54abb97af6a83684
--     ✅ ההעתקה כאן אומתה בייט-בייט מול ה-md5 הזה — זהה ל-0039, לא נגעה
--   create_default_stages
--     length(prosrc) = 510 · md5 = 50c441c81e6a6577726cc039ef694248
--     🟢 נקייה מ-0052 — הפונקציה שפולטת את חמש השורות הקשיחות (0038)
--     לא נגעה, ושלב 1 יכול לגעת בה בביטחון
--   enforce_stage_order
--     length(prosrc) = 790 · md5 = 52e7e7940653aa8db1bb35c01694b61e
--     לא נגעה ב-0052 (גרסת 0038, המודעת-למסלול)
--   events: 55 אירועי status_auto_advanced, מתוכם 10 נושאים direction
--     (9 forward, 1 backward) — היישור כלפי מטה ירה בפרודקשן פעם אחת
--
-- ═══ ✅ סטטוס דיוק ההעתקה של derive_production_status ═══
--   md5 תואם ✅ — אומת דרך base64:
--     select encode(convert_to(p.prosrc,'UTF8'),'base64')
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname = 'derive_production_status';
--   md5 = 1941f4d549b1a514d7ac26568539df2c · 3461 תווים · 3533 בייטים.
--   ההעתקה שלהלן היא בייט-בייט מול הסכימה החיה.
--
--   הפער היחיד שהיה בדרך: תו יחיד בהערה — '→' (e2 86 92) הועתק בטעות
--   כ-'—' (e2 80 94). שני בייטים נבדלים, אותו אורך בדיוק, ולכן האורך
--   תאם משני הצדדים ורק ה-md5 חשף את זה. לא סמנטי — בתוך הערה.
--
-- ═══ 🪤 מלכודות תיעוד שהתגלו בדרך — קרא לפני ההעתקה הבאה ═══
--   1. ה-CSV של ה-SQL Editor אינו כלי להעתקת סכימה. הוא מחזיר עברית
--      ב-mojibake (UTF-8 נקרא כ-Latin-1) ובולע תווי unicode: הבייטים
--      0x90–0x9F של האותיות העבריות נעלמים בתצוגה, ותווים כמו → ו-—
--      נראים זהים. **להעתקת סכימה — base64 בלבד:**
--        select encode(convert_to(p.prosrc,'UTF8'),'base64') ...
--      ואז לאמת מול md5(prosrc). אורך תואם אינו הוכחה — הפער כאן שמר
--      על האורך במדויק.
--   2. הכותרת של 0039 משקרת מאז 2026-08-05. היא עדיין מכריזה
--      "1. FORWARD ONLY. It never pulls the cursor back." — 0052 ביטלה
--      את זה בדיוק. מי שיקרא את 0039 בלי לקרוא את 0054 יבין הפוך.


-- ═══════════════════════════════════════════════════════════════════════
-- 1. FUNCTION public.prod_cursor_rank  — אומתה בייט-בייט. אל תריץ.
-- ═══════════════════════════════════════════════════════════════════════
-- דירוג חמשת מצבי הפס האוטומטי. עד 0052 זה היה השער שאכף forward-only;
-- מ-0052 הוא רק מתייג את כיוון התנועה ב-payload של האירוע.

CREATE OR REPLACE FUNCTION public.prod_cursor_rank(s production_status)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case s
    when 'עתיד_להתחיל' then 0
    when 'בהקלטה'      then 1
    when 'הוקלט'       then 2
    when 'בעריכה'      then 3
    when 'נערך'        then 4
    else 99
  end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════
-- 2. FUNCTION public.derive_production_status  — אומתה בייט-בייט. אל תריץ.
-- ═══════════════════════════════════════════════════════════════════════
-- הערות הקוד שלהלן הן כפי שהן בסכימה החיה, כולל בלוק "rule 1 (0052)"
-- שנכתב בהדבקה הידנית ואינו קיים באף קובץ אחר בריפו.

CREATE OR REPLACE FUNCTION public.derive_production_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cur       production_status;
  frozen    boolean;
  reels_req boolean;
  ep_rec    stage_status;
  ep_edit   stage_status;
  ep_del    stage_status;
  re_edit   stage_status;
  re_del    stage_status;
  derived   production_status;
  auto_states constant production_status[] := array[
    'עתיד_להתחיל','בהקלטה','הוקלט','בעריכה','נערך'
  ]::production_status[];
begin
  -- assignee-only stage edits must not move the cursor
  if new.status is not distinct from old.status then
    return new;
  end if;

  select status, on_hold, review_reels_required
    into cur, frozen, reels_req
    from public.productions where id = new.production_id;

  -- rule 2: hands off once the cursor left the auto-controlled band, or frozen.
  -- (a NULL cur — impossible in practice — also stops here, safely.)
  if coalesce(frozen, false) or cur is null or not (cur = any(auto_states)) then
    return new;
  end if;

  select status into ep_rec  from public.stages where production_id = new.production_id and track = 'episode' and step = 'record';
  select status into ep_edit from public.stages where production_id = new.production_id and track = 'episode' and step = 'edit';
  select status into ep_del  from public.stages where production_id = new.production_id and track = 'episode' and step = 'deliver';
  select status into re_edit from public.stages where production_id = new.production_id and track = 'reels'   and step = 'edit';
  select status into re_del  from public.stages where production_id = new.production_id and track = 'reels'   and step = 'deliver';

  -- reels out of scope → they don't hold the cursor (treated as absent)
  if not coalesce(reels_req, true) then
    re_edit := null;
    re_del  := null;
  end if;

  -- highest applicable cursor from the stage picture
  if ep_del = 'done' and coalesce(re_del, 'done') = 'done' then
    derived := 'נערך';                         -- both lines delivered
  elsif ep_edit in ('in_progress','done')
        or coalesce(re_edit, 'pending') in ('in_progress','done')
        or ep_del <> 'pending'
        or coalesce(re_del, 'pending') <> 'pending' then
    derived := 'בעריכה';                       -- a line is at/past editing
  elsif ep_rec = 'done' then
    derived := 'הוקלט';                         -- episode recorded
  elsif ep_rec = 'in_progress' then
    derived := 'בהקלטה';                        -- recording started
  else
    derived := 'עתיד_להתחיל';
  end if;

  -- rule 1 (0052): the derivation now aligns in BOTH directions.
  -- forward-only was the trap: once the cursor reached נערך (top of the band)
  -- no stage change could ever move it again. rule 2 above still guarantees
  -- that anything outside the five auto states is never touched.
  if derived is distinct from cur then
    update public.productions set status = derived where id = new.production_id;
    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', new.production_id, 'status_auto_advanced', auth.uid(),
              jsonb_build_object('from', cur, 'to', derived,
                                 'source', 'stage_trigger', 'stage_id', new.id,
                                 'direction',
                                 case when public.prod_cursor_rank(derived)
                                         > public.prod_cursor_rank(cur)
                                      then 'forward' else 'backward' end));
  end if;
  return new;
end;
$function$;


-- ═══════════════════════════════════════════════════════════════════════
-- 3. הטריגרים החיים על stages ו-productions — מצב מלא, אל תריץ.
-- ═══════════════════════════════════════════════════════════════════════
-- נשמרים כאן כי סדר הירי בין trg_derive_production_status (על stages)
-- לבין trg_guard_client_approval / trg_on_production_approved (על
-- productions) הוא מה שמפריד בין הסמן האוטומטי לשער החיוב: הראשון עושה
-- UPDATE על productions.status, וה-UPDATE הזה הוא שמפעיל את השניים.
-- שלב 1 חייב לראות את התמונה הזו לפני שהוא נוגע ב-derive.

-- על public.productions:
CREATE TRIGGER trg_create_default_stages AFTER INSERT ON public.productions FOR EACH ROW EXECUTE FUNCTION create_default_stages();
CREATE TRIGGER trg_guard_client_approval BEFORE UPDATE OF status ON public.productions FOR EACH ROW EXECUTE FUNCTION guard_client_approval_transition();
CREATE TRIGGER trg_guard_production_calendar BEFORE UPDATE ON public.productions FOR EACH ROW EXECUTE FUNCTION guard_production_calendar_columns();
CREATE TRIGGER trg_guard_production_split BEFORE UPDATE ON public.productions FOR EACH ROW EXECUTE FUNCTION guard_production_split_columns();
CREATE TRIGGER trg_guard_production_stages BEFORE UPDATE ON public.productions FOR EACH ROW EXECUTE FUNCTION guard_production_stage_columns();
CREATE TRIGGER trg_log_disk_change AFTER UPDATE OF storage_disk ON public.productions FOR EACH ROW WHEN ((new.storage_disk IS DISTINCT FROM old.storage_disk)) EXECUTE FUNCTION log_disk_change();
CREATE TRIGGER trg_on_production_approved AFTER UPDATE OF status ON public.productions FOR EACH ROW EXECUTE FUNCTION on_production_approved();

-- על public.stages:
CREATE TRIGGER trg_derive_production_status AFTER UPDATE OF status ON public.stages FOR EACH ROW EXECUTE FUNCTION derive_production_status();
CREATE TRIGGER trg_enforce_stage_order BEFORE UPDATE ON public.stages FOR EACH ROW EXECUTE FUNCTION enforce_stage_order();
CREATE TRIGGER trg_log_stage_change AFTER UPDATE OF status ON public.stages FOR EACH ROW WHEN ((new.status IS DISTINCT FROM old.status)) EXECUTE FUNCTION log_stage_change();
CREATE TRIGGER trg_set_done_at BEFORE UPDATE ON public.stages FOR EACH ROW EXECUTE FUNCTION set_done_at();


-- ═══════════════════════════════════════════════════════════════════════
-- 4. הרישום — ההצהרה היחידה בקובץ שמורצת. הרץ אותה לבדה.
-- ═══════════════════════════════════════════════════════════════════════
do $$
begin
  if exists (select 1 from schema_ledger where version = '0054') then
    raise exception '0054 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- גארד: 0054 מתעדת מצב קיים. אם הפונקציה איננה, אין מה לתעד ומשהו
  -- אחר קרה שצריך לברר לפני שרושמים.
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'derive_production_status'
  ) then
    raise exception 'derive_production_status לא נמצאה — אין מה לתעד';
  end if;

  -- גארד: מוודא שמה שמתועד הוא באמת גרסת 0052 ולא משהו שהוחלף בינתיים
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'derive_production_status'
      and md5(p.prosrc) = '1941f4d549b1a514d7ac26568539df2c'
  ) then
    raise exception 'derive_production_status השתנתה מאז ההעתקה (md5 ≠ 1941f4d5…) — עדכן את 0054 לפני שרושמים';
  end if;

  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0054', now(), 'bnaya',
          'תיעוד בלבד, אפס שינוי התנהגות. העתקת derive_production_status החיה (כולל השינוי האבוד של 0052), prod_cursor_rank והטריגרים על stages/productions לקובץ 0054_document_live_derive.sql. לא הורצה שום הצהרת DDL — הפונקציות כבר היו במסד. md5 של derive בעת התיעוד: 1941f4d549b1a514d7ac26568539df2c (3461 תווים).');
end $$;
