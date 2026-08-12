-- 0055: הרכב תוצרים — שלב 1 של מודל התוצרים.
--
-- ⚠️ בלוק DO אטומי אחד. מריצים אותו בשלמותו ב-SQL Editor. אם משהו נופל,
-- הכול מתגלגל אחורה ושום דבר לא הוחל למחצה. רישום הפנקס נמצא בתוך אותו
-- בלוק בכוונה — שינוי ורישום נופלים או עוברים יחד (תקדים 0050/0051).
--
-- ⚠️ מוסכמת ציטוט: הבלוק החיצוני הוא $mig$, וגופי הפונקציות הם $fn$.
-- אל תחליף אותם ל-$$ — הקינון יישבר.
--
-- ═══ הבעיה ═══
-- create_default_stages פולטת חמש שורות קשיחות לכל הפקה בעולם: episode
-- record/edit/deliver + reels edit/deliver. אין לתוכנית שום דרך לומר "אין
-- כאן פרק" או "יש כאן 5 רילז". התוצאה:
--   • הפקת רילז-בלבד (ICR / וואיקי דיגיטל) מקבלת 3 שלבי פרק פנטומיים,
--     נתקעת ב'בעריכה' לנצח (ראה derive למטה), ו-done<total תמיד — כלומר
--     התראת 🔵 "הופק ולא חויב" מתה עליה. זה בדיוק הבור של 0038.
--   • הפקת סאונד-בלבד מקבלת קו רילז שאיש לא ישלים.
--
-- ═══ מה המיגרציה עושה ═══
-- 1. shows מקבלת has_episode + reels_count — התבנית.
-- 2. productions מקבלת את אותן שתי עמודות, באותם שמות — המופע. שלושת
--    מסלולי היצירה מעתיקים תבנית→מופע ב-INSERT עצמו, בדיוק כמו
--    camera_count / studio / client_id / kind. הסמנטיקה זהה לזו של
--    default_rate (0032): שינוי בתוכנית חל על הפקות חדשות בלבד, לעולם
--    לא רטרואקטיבית.
-- 3. create_default_stages פולטת רק את הקווים שבהיקף — שורות שלא נוצרו,
--    לא שורות שמסוכות בזמן קריאה. מיסוך היה משאיר אותן ב-
--    production_stage_rollup.total ומחזיר את בור 0038.
-- 4. derive_production_status מקבלת בלוק נטרול סימטרי + ענף 'נערך'
--    מבוסס-דגל. פירוט בגוף.
--
-- ═══ מה המיגרציה לא עושה ═══
-- • אפס UPDATE, אפס DELETE. אדיטיבית בלבד. ברירות המחדל (true / 2) הן
--   בדיוק ההתנהגות של היום — 105 התוכניות ו-746 ההפקות הקיימות ממשיכות
--   זהה, בלי backfill.
-- • reels_count אינו יוצר N קווי רילז. unique(production_id,track,step)
--   אוסר שני reels/edit, ומעקב פר-ריל אינו הדרישה. reels_count הוא כמות
--   (לתצוגה ולחיוב); קו הרילז הוא קו עבודה אחד. ריל-עם-שלבים-משלו הוא
--   שלב 2, והוא דורש לשבור את ה-unique.
-- • אינה נוגעת בחיוב. enqueue ממשיך לגבות price_override ?? default_rate.
--   חיוב לפי חוזה נשאר עבודה נפרדת (contracts.show_id + אבני דרך).
--
-- ═══ הכרעות בעלים, 2026-08-12 ═══
-- • reels_count הוא stage-tier, לא money-tier (תקדים camera_count).
-- • מהפך 0036: productions.reels_count הוא מקור האמת לספירת הרילז.
--   production_addons נשארת רשומת הכסף בלבד. 0036 קבעה את ההפך ("התוספת
--   היא מקור האמת היחיד, בלי עמודת reels_count שתסטה") — הנימוק שלה היה
--   נכון כשלא היה מספר תוכניתי. עכשיו יש. העלות היום אפס: הטבלה ריקה.
-- • derive מתייעצת ב-reels_count>0, לא ב-review_reels_required. השני
--   נכתב רק מ-links.ts לפי scope של לינק אישור ומשמעותו "הלקוח לא נשאל",
--   לא "אין רילז". שני מושגים שהתערבבו, ונפרדים כאן.
-- • דגלי ההפקה הם read-after-create — נאכפים בטריגר, לא בהסכמה.


do $mig$
begin

  -- ═══ 0. גארדים — הבלוק מסרב לרוץ על מצב שאינו הצפוי ═══
  if exists (select 1 from schema_ledger where version = '0055') then
    raise exception '0055 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'shows' and column_name = 'has_episode'
  ) then
    raise exception 'shows.has_episode כבר קיימת — 0055 הוחלה קודם, אולי תחת מספר אחר. אל תוסיף רישום שני.';
  end if;

  -- שתי הפונקציות שנדרסות חייבות להיות הגרסאות שתועדו, אחרת אנחנו דורסים
  -- שינוי שאיש לא ראה — בדיוק מה ש-0052 עשתה
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'derive_production_status'
      and md5(p.prosrc) = '1941f4d549b1a514d7ac26568539df2c'
  ) then
    raise exception 'derive_production_status אינה הגרסה שתועדה ב-0054 (md5 ≠ 1941f4d5…) — עצור, תעד מחדש, ורק אז דרוס';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_default_stages'
      and md5(p.prosrc) = '50c441c81e6a6577726cc039ef694248'
  ) then
    raise exception 'create_default_stages אינה גרסת 0038 (md5 ≠ 50c441c8…) — עצור ובדוק';
  end if;


  -- ═══ 1. העמודות ═══
  -- not null + default: אין מצב "לא ידוע". ברירות המחדל הן ההתנהגות של
  -- היום, ולכן ההוספה אינה משנה אף שורה קיימת. reels_count=2 מחליף את
  -- הקבוע REELS_BASE=2 שהיה מקודד ב-API אחד-לאחד.
  alter table public.shows
    add column has_episode boolean not null default true,
    add column reels_count integer not null default 2;

  alter table public.productions
    add column has_episode boolean not null default true,
    add column reels_count integer not null default 2;

  alter table public.shows
    add constraint shows_reels_count_nonneg check (reels_count >= 0),
    add constraint shows_composition_nonempty check (has_episode or reels_count > 0);

  alter table public.productions
    add constraint productions_reels_count_nonneg check (reels_count >= 0),
    add constraint productions_composition_nonempty check (has_episode or reels_count > 0);


  -- ═══ 2. הרשאות קריאה — הבור של 0022 ═══
  -- 0022 הפך את ה-grant על shows לעמודתי-מפורש, ומזהיר בגוף המיגרציה:
  -- עמודה חדשה אינה קריאה למשתמש authenticated עד שהיא נוספת ל-grant.
  -- בלי השורה הזו כרטיס התוכנית נשבר לכל מי שאינו בעל הרשאת כספים.
  grant select (has_episode, reels_count) on public.shows to authenticated;
  -- productions אינה מוגבלת-עמודות, אבל מפורש עדיף (תקדים 0028, 0040)
  grant select (has_episode, reels_count) on public.productions to authenticated;


  -- ═══ 3. גארד הרכב על shows — הודעה בעברית, לא חריגת postgres ═══
  -- ה-CHECK הוא האכיפה האמיתית; הטריגר רץ לפניו (BEFORE ROW קודם ל-
  -- constraint) ומחזיר משפט שאדם יכול לקרוא. אותו דפוס כמו
  -- guard_show_money_columns (0008).
  create or replace function public.guard_show_composition()
  returns trigger language plpgsql as $fn$
  begin
    if new.reels_count is null or new.reels_count < 0 then
      raise exception 'כמות הרילז חייבת להיות מספר שלם שאינו שלילי';
    end if;
    if not new.has_episode and new.reels_count = 0 then
      raise exception 'תוכנית חייבת לכלול פרק מוקלט או לפחות ריל אחד — אחרת היא לא מייצרת שום תוצר';
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_guard_show_composition on public.shows;
  create trigger trg_guard_show_composition
  before insert or update on public.shows
  for each row execute function public.guard_show_composition();


  -- ═══ 4. גארד הרכב על productions — read-after-create ═══
  -- הכרעת בעלים 2026-08-12: אחרי שהשלבים נזרעו מהדגלים, שינוי הדגלים היה
  -- מותיר שורות שאינן תואמות להרכב — done<total לנצח והתראת 🔵 מתה
  -- (בור 0038). לכן has_episode מוקפא, וקו הרילז אינו נוסף/נגרע.
  -- הכמות עצמה כן זזה: תוספת רילז מאושרת מעלה אותה. מה שאסור הוא לחצות
  -- את גבול האפס, כי זה מה שמוסיף או מוריד את הקו.
  create or replace function public.guard_production_composition()
  returns trigger language plpgsql as $fn$
  begin
    if tg_op = 'INSERT' then
      if not new.has_episode and coalesce(new.reels_count, 0) = 0 then
        raise exception 'הפקה חייבת לכלול פרק מוקלט או לפחות ריל אחד';
      end if;
      return new;
    end if;

    if new.has_episode is distinct from old.has_episode then
      raise exception 'אי אפשר לשנות את הרכב התוצרים של הפקה קיימת — השלבים כבר נוצרו לפיו. שנה את הגדרת התוכנית, והשינוי יחול על הפקות חדשות';
    end if;
    if (coalesce(old.reels_count, 0) = 0) <> (coalesce(new.reels_count, 0) = 0) then
      raise exception 'אי אפשר להוסיף או להסיר את קו הרילז בהפקה קיימת — השלבים כבר נוצרו. שנה את הגדרת התוכנית, והשינוי יחול על הפקות חדשות';
    end if;
    if coalesce(new.reels_count, 0) < 0 then
      raise exception 'כמות הרילז חייבת להיות מספר שלם שאינו שלילי';
    end if;
    return new;
  end;
  $fn$;

  drop trigger if exists trg_guard_production_composition on public.productions;
  create trigger trg_guard_production_composition
  before insert or update on public.productions
  for each row execute function public.guard_production_composition();


  -- ═══ 5. create_default_stages — פולטת רק את מה שבהיקף ═══
  -- קוראת את NEW ולא את shows: שלושת מסלולי היצירה (calendar sync,
  -- POST /api/productions, split) מציבים את הדגלים בתוך ה-INSERT, כמו
  -- camera_count. כך הפונקציה נשארת פונקציה טהורה של השורה, בלי שאילתה
  -- ובלי תלות ב-show_id (nullable), וקורא שמשמיט אותם נוחת על ברירות
  -- המחדל = ההתנהגות הישנה. וגם: אין כאן UPDATE על productions, שהיה
  -- מפעיל את שבעת הטריגרים שעליה כולל on_production_approved.
  --
  -- reels_count>0 יוצר קו רילז אחד, לא reels_count קווים — ראה הכותרת.
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
    end if;

    return new;
  end;
  $fn$;


  -- ═══ 6. derive_production_status — שלושה שינויים מול 0054 ═══
  -- (א) קוראת has_episode + reels_count>0 מ-productions באותה שאילתה
  --     קיימת. אפס round-trips נוספים. review_reels_required יוצא מכאן.
  -- (ב) בלוק נטרול סימטרי: עד היום רק לרילז היה כזה, ולפרק לא — וזו
  --     בדיוק הא-סימטריה שתקעה הפקת רילז-בלבד ב'בעריכה' לנצח.
  -- (ג) ענף 'נערך' מבוסס-דגל ולא coalesce גורף. coalesce(ep_del,'done')
  --     ללא תנאי לא מבחין בין "הפרק מחוץ להיקף" (נכון לספור כנמסר) לבין
  --     "השורה נעלמה למרות שהיא אמורה להתקיים" (תקלת נתונים), והיה גוזר
  --     'נערך' בשקט על השנייה. בניסוח שלמטה, קו שבהיקף ששורתו חסרה
  --     משאיר את הסמן במקומו — ההתנהגות הבטוחה.
  --
  -- לא נוגעים: היציאה המוקדמת על עריכת assignee · חוק 2 (רצועת
  -- auto_states, מה ששומר על 'אושר_ע"י_לקוח' ידני ועל שער החיוב) ·
  -- היישור הדו-כיווני של 0052 · prod_cursor_rank · SECURITY DEFINER.
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
    elsif ep_rec = 'done' then
      derived := 'הוקלט';                         -- episode recorded
    elsif ep_rec = 'in_progress' then
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


  -- ═══ 7. הרישום ═══
  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0055', now(), 'bnaya',
          'הרכב תוצרים, שלב 1. shows + productions מקבלות has_episode boolean default true ו-reels_count integer default 2, עם CHECK (has_episode or reels_count>0) וגארד עברי. create_default_stages פולטת רק קווים שבהיקף (לא מיסוך בזמן קריאה — בור 0038). derive_production_status: נטרול סימטרי לשני הקווים + ענף נערך מבוסס-דגל במקום coalesce גורף; מתייעצת ב-reels_count>0 ולא ב-review_reels_required. דגלי ההפקה read-after-create (trg_guard_production_composition). grant select על שתי העמודות בשתי הטבלאות (בור 0022). אדיטיבי: אפס UPDATE, אפס DELETE, ברירות המחדל = ההתנהגות הקודמת ל-105 התוכניות ו-746 ההפקות.');

  raise notice '0055 הוחלה ונרשמה. הרכב תוצרים פעיל.';

end
$mig$;
