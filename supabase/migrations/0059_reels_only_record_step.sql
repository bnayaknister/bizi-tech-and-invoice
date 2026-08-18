-- 0059: שלב הקלטה להפקת רילז-בלבד.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- ═══ הבעיה ═══
-- 0038 הסירה את reels/record מתוך תיקון מודל נכון (בעלים 24.7): רילז
-- נחתכים מאותו גלם של הפרק, ולכן אין להם הקלטה נפרדת. ההנחה שם הייתה
-- שרילז תמיד מלווים פרק. 0055 הפכה הפקת **רילז-בלבד** לאפשרית
-- (has_episode=false), ושם ההנחה נשברת: גלם כן מוקלט, אבל אין שום שלב
-- שמייצג את זה — ולא רק במגירה. ב-derive_production_status הסטטוסים
-- 'בהקלטה' ו-'הוקלט' נגזרים מ-ep_rec בלבד, שמנוטרל ל-NULL כשאין פרק,
-- כך שהפקת רילז-בלבד קופצת מ-'עתיד_להתחיל' ישר ל-'בעריכה' ולעולם
-- אינה יכולה להיות 'הוקלט'.
--
-- ═══ מה יש כאן ═══
-- 1. create_default_stages: reels/record נזרע **רק** כשיש רילז ואין פרק.
--    כשיש פרק — ההחלטה של 0038 נשארת בתוקף בדיוק כפי שהיא: הגלם של הפרק
--    הוא המקור, ואין הקלטה כפולה.
-- 2. derive_production_status: שני ענפי ההקלטה קוראים גם re_rec, ו-re_rec
--    מצטרף לבלוק הנטרול הסימטרי של 0055. כל שאר הפונקציה ביט-זהה.
-- 3. Backfill לשתי ההפקות הקיימות מסוג רילז-בלבד.
--
-- ═══ מדוע שני הענפים לא יכולים להתנגש ═══
-- reels/record קיים רק כש-has_episode=false, ואז בלוק הנטרול כבר קבע
-- ep_rec := null. כלומר השניים סותרים זה את זה בבנייה ולעולם לא שניהם
-- לא-NULL. ה-OR נכתב בכל זאת הגנתית: שורת reels/record שהוכנסה ידנית
-- להפקה עם פרק תקדם את הסמן, וזו הפרשנות הנכונה ("גלם הוקלט").
--
-- ═══ תופעת לוואי מוצהרת של ה-Backfill ═══
-- הוספת שלב pending מורידה את icr spotlight ל-done<total, ולכן היא לא
-- תיחשב "הופקה במלואה" עד שהשלב יושלם. בפועל אין לזה השפעה: היא
-- kind='contract', והתרעת "הופק ולא חויב" בודקת kind='client' בלבד.
-- מישל רילז עדיין ב-'עתיד_להתחיל' — אין לה מה לאבד.
--
-- ═══ מה 0059 לא עושה ═══
-- • לא נוגעת ב-enum stage_step (record כבר חוקי לכל מסלול מ-0001),
--   ולא ב-unique(production_id,track,step).
-- • לא נוגעת ב-alerts.ts (done===total דינמי — עמיד לשינוי הרכב),
--   ולא ב-client_review_items (ההרכב שם נגזר מ-has_episode/reels_count).
-- • אפס DELETE. אפס שינוי סכימה.

do $mig$
declare
  seeded int;
begin

  -- ═══ 0. גארדים ═══
  if exists (select 1 from public.schema_ledger where version = '0059') then
    raise exception '0059 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from public.schema_ledger where version = '0055') then
    raise exception '0055 טרם הוחלה — 0059 מניחה את מודל התוצרים. הרץ אותה קודם.';
  end if;


  -- ═══ 1. create_default_stages ═══
  -- זהה ל-0055 פרט לבלוק ה-record של הרילז. שאר ההערות של 0055 בתוקף:
  -- הפונקציה נשארת פונקציה טהורה של השורה, בלי שאילתה ובלי תלות ב-show_id,
  -- ובלי UPDATE על productions (שהיה מפעיל את on_production_approved).
  create or replace function public.create_default_stages()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  begin
    if coalesce(new.has_episode, true) then
      insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
      select new.id, new.podcast_name, new.guest, new.record_date, v.track, v.step, 'pending'
      from (values
        ('episode'::stage_track, 'record'::stage_step),
        ('episode'::stage_track, 'edit'::stage_step),
        ('episode'::stage_track, 'deliver'::stage_step)
      ) as v(track, step);
    end if;

    if coalesce(new.reels_count, 0) > 0 then
      insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
      select new.id, new.podcast_name, new.guest, new.record_date, v.track, v.step, 'pending'
      from (values
        ('reels'::stage_track, 'edit'::stage_step),
        ('reels'::stage_track, 'deliver'::stage_step)
      ) as v(track, step);

      -- 0059: רילז-בלבד — אין גלם של פרק לחתוך ממנו, ולכן ההקלטה היא
      -- שלב אמיתי של המסלול הזה. כשיש פרק, 0038 נשארת: אין הקלטה כפולה.
      if not coalesce(new.has_episode, true) then
        insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
        values (new.id, new.podcast_name, new.guest, new.record_date, 'reels', 'record', 'pending');
      end if;
    end if;

    return new;
  end;
  $fn$;


  -- ═══ 2. derive_production_status ═══
  -- מול 0055 השתנו שלושה דברים בלבד: הצהרת re_rec, שליפתו, צירופו לבלוק
  -- הנטרול, ושני ענפי ההקלטה. כל השאר — היציאה המוקדמת על עריכת assignee,
  -- חוק 2 (רצועת auto_states ששומרת על 'אושר_ע"י_לקוח' הידני ועל שער
  -- החיוב), הנטרול הסימטרי, ענף 'נערך' מבוסס-הדגלים, היישור הדו-כיווני
  -- של 0052, prod_cursor_rank ו-SECURITY DEFINER — ביט-זהה.
  create or replace function public.derive_production_status()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  declare
    cur       production_status;
    frozen    boolean;
    ep_req    boolean;
    reels_req boolean;
    ep_rec    stage_status;
    ep_edit   stage_status;
    ep_del    stage_status;
    re_rec    stage_status;
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

    -- 0055: the composition comes from the production's own flags, copied
    -- from the show at creation. NOT from review_reels_required — that one
    -- means "the client wasn't asked", which is a different question.
    select status, on_hold, has_episode, reels_count > 0
      into cur, frozen, ep_req, reels_req
      from public.productions where id = new.production_id;

    -- rule 2: hands off once the cursor left the auto-controlled band, or frozen.
    -- (a NULL cur — impossible in practice — also stops here, safely.)
    if coalesce(frozen, false) or cur is null or not (cur = any(auto_states)) then
      return new;
    end if;

    select status into ep_rec  from public.stages where production_id = new.production_id and track = 'episode' and step = 'record';
    select status into ep_edit from public.stages where production_id = new.production_id and track = 'episode' and step = 'edit';
    select status into ep_del  from public.stages where production_id = new.production_id and track = 'episode' and step = 'deliver';
    select status into re_rec  from public.stages where production_id = new.production_id and track = 'reels'   and step = 'record';
    select status into re_edit from public.stages where production_id = new.production_id and track = 'reels'   and step = 'edit';
    select status into re_del  from public.stages where production_id = new.production_id and track = 'reels'   and step = 'deliver';

    -- 0055: a track outside this production's deliverables never holds the
    -- cursor. Symmetric for both — before 0055 only the reels side had this.
    if not coalesce(ep_req, true) then
      ep_rec  := null;
      ep_edit := null;
      ep_del  := null;
    end if;
    if not coalesce(reels_req, true) then
      re_rec  := null;
      re_edit := null;
      re_del  := null;
    end if;

    -- highest applicable cursor from the stage picture.
    -- 'נערך' is flag-driven: every track that IS in scope must actually be
    -- delivered, and at least one track must be in scope. A missing row on an
    -- in-scope track yields NULL here, so the branch is not taken and the
    -- cursor simply stays put.
    if (coalesce(ep_req, true) or coalesce(reels_req, true))
       and (not coalesce(ep_req, true)    or ep_del = 'done')
       and (not coalesce(reels_req, true) or re_del = 'done') then
      derived := 'נערך';                         -- every line in scope delivered
    elsif coalesce(ep_edit, 'pending') in ('in_progress','done')
          or coalesce(re_edit, 'pending') in ('in_progress','done')
          or coalesce(ep_del, 'pending') <> 'pending'
          or coalesce(re_del, 'pending') <> 'pending' then
      derived := 'בעריכה';                       -- a line is at/past editing
    elsif ep_rec = 'done' or re_rec = 'done' then
      derived := 'הוקלט';                         -- raw recorded (0059: either track)
    elsif ep_rec = 'in_progress' or re_rec = 'in_progress' then
      derived := 'בהקלטה';                        -- recording started
    else
      derived := 'עתיד_להתחיל';
    end if;

    -- rule 1 (0052): the derivation aligns in BOTH directions. rule 2 above
    -- still guarantees that anything outside the five auto states is never
    -- touched.
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
  $fn$;


  -- ═══ 3. Backfill ═══
  -- כל הפקת רילז-בלבד קיימת שאין לה עדיין שורת reels/record. השדות
  -- המשוכפלים (podcast_name, guest, record_date) מועתקים בדיוק כמו
  -- בזריעה. NOT EXISTS ולא ON CONFLICT — עובד גם אם האינדקס הייחודי
  -- ישתנה בעתיד.
  insert into public.stages (production_id, podcast_name, guest, record_date, track, step, status)
  select p.id, p.podcast_name, p.guest, p.record_date, 'reels', 'record', 'pending'
  from public.productions p
  where coalesce(p.has_episode, true) = false
    and coalesce(p.reels_count, 0) > 0
    and not exists (
      select 1 from public.stages s
      where s.production_id = p.id and s.track = 'reels' and s.step = 'record'
    );
  get diagnostics seeded = row_count;
  raise notice '0059: reels/record הושלם ל-% הפקות רילז-בלבד קיימות', seeded;


  -- ═══ 4. הרישום ═══
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0059', now(), 'bnaya',
          'שלב הקלטה להפקת רילז-בלבד. create_default_stages זורעת reels/record רק כש-reels_count>0 AND NOT has_episode — כשיש פרק ההחלטה של 0038 נשארת (הגלם של הפרק הוא המקור, אין הקלטה כפולה). derive_production_status: re_rec הוצהר, נשלף, צורף לבלוק הנטרול הסימטרי של 0055, ושני ענפי ההקלטה קוראים ep_rec=''done'' OR re_rec=''done'' (ובהתאמה in_progress) — קודם רילז-בלבד לא יכלה להגיע ל-''הוקלט''/''בהקלטה'' לעולם. השניים סותרים בבנייה (reels/record קיים רק כשאין פרק, ואז ep_rec מנוטרל). Backfill לשתי ההפקות הקיימות. תופעת לוואי מוצהרת: icr spotlight יורדת ל-done<total אך היא kind=contract והרדאר בודק kind=client בלבד. אפס שינוי סכימה, אפס DELETE, לא נוגעת ב-enum/CHECK/alerts.ts/client_review_items.');

  raise notice '0059 הוחלה ונרשמה. רילז-בלבד מקבל שלב הקלטה, והסמן יודע לזוז בעקבותיו.';

end
$mig$;
