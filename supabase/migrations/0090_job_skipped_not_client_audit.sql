-- ============================================================================
-- 0090 — שני שערי ה-kind מפסיקים לשתוק: job_skipped_not_client
--
-- ⚠️ להריץ את supabase/verify/0090_dryrun.sql לפני. שם, ולא כאן, נמצאת
--    ההוכחה שההתנהגות לא זזה. כלל 50: קובץ אימות אינו יושב בתיקיית המיגרציות.
--
-- למה בכלל (תחקיר P9, 18.9): שתי נקודות ההחלטה שמונעות יצירת job יוצאות
-- בשקט מוחלט —
--   on_production_approved      : `if new.kind <> 'client' then return new;`
--   ensure_job_for_production   : `if prod.kind <> 'client' then return null;`
-- ולא נשארת מהן שום עקבה. זה חריג בתוך הפונקציה עצמה: שני מסלולי הדחייה
-- האחרים של ensure_job_for_production **כן** כותבים אירוע —
-- job_skipped_not_recorded (0061) ו-client_approved_already_billed (0060).
-- הקובץ הזה מיישר את השניים החסרים לאותו סטנדרט.
--
-- 🔴 אפס שינוי התנהגות. אותן הפקות נחסמות בדיוק, אף job חדש אינו נוצר, אף
--    job קיים אינו משתנה, ואף שורת job_productions אינה נכתבת. ההבדל היחיד
--    הוא שורת events. במיוחד: המיגרציה הזו **אינה** מתקנת אף אחת מ-110
--    ההפקות שנמצאו בתחקיר — ההכרעה המפורשת (P9, 18.9) היא לא לגעת בהן.
--
-- ⚠️ סדר הבדיקות ב-on_production_approved מתהפך במכוון, וזו הנקודה היחידה
--    בקובץ שדורשת תשומת לב. הטריגר הוא AFTER UPDATE OF status על טבלה עם
--    233 הפקות internal ו-317 contract, ולכן בדיקת kind ראשונה הייתה כותבת
--    אירוע על כל עדכון סטטוס של כל הפקה שאינה client — הצפה. לכן נבדק
--    קודם האם זו בכלל אחת משתי המעברים שהיו יוצרים job, ורק אז ה-kind.
--    שתי הבדיקות הן קריאות טהורות בלי תופעות לוואי, ולכן ההיפוך שקול לחלוטין:
--    עבור kind='client' נקראות בדיוק אותן שתי perform, ועבור כל kind אחר
--    מוחזר new בדיוק כמו קודם.
--
-- אפס שינוי סכימה · אפס DELETE · אפס UPDATE על נתונים · אפס שורה חדשה מלבד
-- שורת הפנקס והאירוע.
--
-- כלל 49 — השפעת ACL, מוצהרת: לא נוצר אף אובייקט נושא-ACL. שתי הפונקציות
-- קיימות, נשארות SECURITY DEFINER עם search_path='public' ובעלות postgres,
-- והגרנטים שלהן אינם נגעים. CREATE OR REPLACE שומר על ACL קיים.
-- ============================================================================

-- ── 1. on_production_approved ──────────────────────────────────────────────
-- החתימה, ה-SECURITY DEFINER, ה-search_path וגוף ההחלטה זהים ל-0060.
-- trg_on_production_approved עצמו אינו נוצר מחדש ואינו נגע.
create or replace function public.on_production_approved()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_billing_mode text;
begin
  -- שער ראשון: האם זו בכלל אחת משתי נקודות הכניסה של 0060? אם לא — אין מה
  -- לדווח, כי גם קודם לא היה נוצר כאן job. ראה ההערה על היפוך הסדר בראש הקובץ.
  if not (
       (new.status = 'הוקלט'            and old.status is distinct from 'הוקלט')
    or (new.status = 'אושר_ע"י_לקוח'    and old.status is distinct from 'אושר_ע"י_לקוח')
  ) then
    return new;
  end if;

  -- שער שני: ה-kind. זהו ה-`return new` ששתק, וכאן הוא מדבר.
  if new.kind <> 'client' then
    select s.billing_mode::text into v_billing_mode
    from public.shows s where s.id = new.show_id;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', new.id, 'job_skipped_not_client', auth.uid(),
            jsonb_build_object('production_id', new.id,
                               'client_id',     new.client_id,
                               'kind',          new.kind::text,
                               'billing_mode',  v_billing_mode,
                               'status',        new.status,
                               'fired_by',      'trigger'));
    return new;
  end if;

  -- מכאן ומטה — זהה תו-בתו ל-0060.
  if new.status = 'הוקלט' and old.status is distinct from 'הוקלט' then
    perform public.ensure_job_for_production(new.id, 'recorded');
  elsif new.status = 'אושר_ע"י_לקוח' and old.status is distinct from 'אושר_ע"י_לקוח' then
    perform public.ensure_job_for_production(new.id, 'client_approved');
  end if;

  return new;
end;
$function$;

comment on function public.on_production_approved() is
  'יוצר job במעבר ל-הוקלט או לאישור לקוח, על הפקות kind=client בלבד. 0090: דחייה על kind כותבת job_skipped_not_client במקום לצאת בשקט. סדר הבדיקות — מעבר סטטוס ואז kind — מונע הצפת אירועים על 550 הפקות internal/contract.';

-- ── 2. ensure_job_for_production ───────────────────────────────────────────
-- ⚠️ הגוף מועתק מההגדרה החיה (0077) תו-בתו, למעט חמש השורות של ה-insert
--    בשער ה-kind. כל שאר השערים, הגארד, התמחור, חותמת הזמנת העבודה ואירוע
--    ההצלחה — ללא שינוי.
create or replace function public.ensure_job_for_production(p_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
  declare
    prod public.productions%rowtype;
    new_job_id uuid;
    base_amount numeric;
    addon_total numeric;
    job_amount numeric;
    v_model public.show_pricing_model;
    v_hourly numeric;
    -- 0077: the open work order this job pays for, if one is already queued.
    v_work_order uuid;
    -- 0090: the show's declaration, for the refusal event only.
    v_billing_mode text;
  begin
    select * into prod from public.productions where id = p_id;
    if not found then return null; end if;

    -- 0090: THE GATE THAT USED TO BE SILENT.
    -- Behaviour is unchanged — it still returns null, and it still does so
    -- before the cancelled/merged checks, exactly as 0060 wrote it. The only
    -- addition is the audit row, so that a refusal on kind can be counted the
    -- way job_skipped_not_recorded and client_approved_already_billed already
    -- can be. This is the RPC-reachable path; the trigger pre-filters.
    if prod.kind <> 'client' then
      select s.billing_mode::text into v_billing_mode
      from public.shows s where s.id = prod.show_id;

      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'job_skipped_not_client', auth.uid(),
              jsonb_build_object('production_id', p_id,
                                 'client_id',     prod.client_id,
                                 'kind',          prod.kind::text,
                                 'billing_mode',  v_billing_mode,
                                 'status',        prod.status,
                                 'fired_by',      p_reason));
      return null;
    end if;

    if prod.cancelled_at is not null then return null; end if;
    if prod.merged_into is not null then return null; end if;

    -- 0061: the work has not been done yet. Named literally, never by enum
    -- order — 'בוטל' sorts last and would slip through a range test.
    if prod.status in ('עתיד_להתחיל', 'בהקלטה') then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'job_skipped_not_recorded', auth.uid(),
              jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                 'status', prod.status, 'fired_by', p_reason));
      return null;
    end if;

    -- THE DUPLICATE GUARD (0060). What makes הוקלט -> אושר safe, what makes a
    -- backfill safe to re-run, and what protects a status that moves backwards
    -- and forwards again.
    --
    -- 0077 NOTE: this early return is also the boundary of the stamp. A work
    -- order enqueued AFTER its job already exists is never seen by this
    -- function again, so it keeps job_id null. Measured 2026-09-10: zero such
    -- rows — 31 of 31 orders were created before their job. The fix for the
    -- case that has not happened yet is app-side (pass jobId at the three
    -- work_order enqueue sites) and deliberately not here.
    if exists (select 1 from public.job_productions where production_id = p_id) then
      insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
      values ('production', p_id, 'client_approved_already_billed', auth.uid(),
              jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                                 'fired_by', p_reason));
      return null;
    end if;

    -- 0067: the effective base, now across two pricing models.
    --   price_override      — the human said the number; it wins in both models
    --   per_hour            — hours × rate, rounded to agorot at the point of
    --                         derivation. The rounding is not cosmetic: the
    --                         balance gate added in c339215 compares
    --                         Σ(price × quantity) to the amount column with a
    --                         one-agora epsilon, and 1.5 × 333.33 = 499.995
    --                         would sit exactly on it.
    --   per_episode         — default_rate, unchanged
    -- A missing rate or missing hours leaves base_amount null, which lands on
    -- the existing "יש להשלים סכום" path below rather than inventing one.
    select s.pricing_model, s.hourly_rate into v_model, v_hourly
    from public.shows s where s.id = prod.show_id;

    if prod.price_override is not null then
      base_amount := prod.price_override;
    elsif v_model = 'per_hour' then
      if prod.studio_hours is not null and v_hourly is not null then
        base_amount := round(prod.studio_hours * v_hourly, 2);
      else
        base_amount := null;
      end if;
    else
      select s.default_rate into base_amount
      from public.shows s where s.id = prod.show_id;
    end if;

    select coalesce(sum(total), 0) into addon_total
    from public.production_addons
    where production_id = p_id and status = 'approved' and total is not null;

    if base_amount is not null then
      job_amount := base_amount + coalesce(addon_total, 0);
    else
      job_amount := null;
    end if;

    -- 0064: the work date. due_date and every ageing number downstream are
    -- derived from this column.
    -- 0081: paid IS WRITTEN EXPLICITLY. See the header of that migration.
    insert into public.jobs (client_id, contract_id, date, campaign, amount, paid, notes)
    values (prod.client_id, prod.contract_id,
            coalesce(prod.record_date, current_date),
            prod.podcast_name, job_amount, 'לא',
            case when job_amount is not null
                 then 'נוצר אוטומטית (' || p_reason || '). סכום = מחיר אפקטיבי + תוספות מאושרות — לאמת ולהנפיק חשבונית עסקה.'
                 else 'נוצר אוטומטית (' || p_reason || '). יש להשלים סכום וחשבונית עסקה.' end)
    returning id into new_job_id;

    insert into public.job_productions (job_id, production_id)
    values (new_job_id, p_id);

    -- ---------------------------------------------------------------------
    -- 0077: STAMP THE OPEN WORK ORDER.
    --
    -- The link only — no status, no payload, no amount, nothing a human owns.
    -- 0025 forbids the database PRODUCING a document; this writes a foreign
    -- key on a row a human already queued and does not move it one step
    -- closer to Morning.
    --
    -- `job_id is null` is the anti-overwrite guard. The status list is the
    -- one pending_documents_one_live_per_production carries after 0063, which
    -- is also why no ordering or LIMIT is needed: that unique index makes at
    -- most one row per production able to match, so this updates one row or
    -- none — never a set it would have to choose from.
    -- ---------------------------------------------------------------------
    update public.pending_documents
       set job_id = new_job_id
     where doc_type = 'work_order'
       and production_id = p_id
       and job_id is null
       and status not in ('rejected', 'failed', 'cancelled')
    returning id into v_work_order;

    insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
    values ('production', p_id, 'client_approved_job_created', auth.uid(),
            jsonb_build_object('production_id', p_id, 'client_id', prod.client_id,
                               'job_id', new_job_id, 'base_amount', base_amount,
                               'addon_total', addon_total, 'job_amount', job_amount,
                               'fired_by', p_reason,
                               -- 0067: how the base was derived, not only what
                               -- it came out as
                               'pricing_model', v_model::text,
                               'studio_hours', prod.studio_hours,
                               'hourly_rate', v_hourly,
                               -- 0077: which order was stamped, or null if the
                               -- order had not been queued yet. A key addition
                               -- only — the 0067 precedent — and no reader
                               -- depends on the shape of this payload.
                               'work_order_stamped', v_work_order));
    return new_job_id;
  end;
  $function$;

comment on function public.ensure_job_for_production(uuid, text) is
  'יוצר job להפקת לקוח שבוצעה, או מסרב ומסביר. 0090: הסירוב על kind<>client כותב job_skipped_not_client, ביישור לשני מסלולי הדחייה שכבר כתבו (job_skipped_not_recorded מ-0061, client_approved_already_billed מ-0060).';

-- ── שער: ההתנהגות לא זזה ───────────────────────────────────────────────────
-- שתי הפונקציות אמורות להישאר SECURITY DEFINER עם search_path='public'.
-- אם CREATE OR REPLACE איבד אחד מהם — לעצור כאן ולא להשאיר מסד חצי-מעודכן.
do $guard$
declare
  v_bad int;
begin
  select count(*) into v_bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('on_production_approved', 'ensure_job_for_production')
    and (p.prosecdef is not true
         or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=public%');
  if v_bad > 0 then
    raise exception '0090 עצרה: % פונקציות איבדו SECURITY DEFINER או search_path=public.', v_bad;
  end if;

  -- הטריגר חייב להישאר בדיוק כפי שהיה — הקובץ אינו יוצר אותו מחדש
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'productions' and t.tgname = 'trg_on_production_approved'
      and not t.tgisinternal
  ) then
    raise exception '0090 עצרה: trg_on_production_approved אינו קיים.';
  end if;

  raise notice '0090: שתי הפונקציות הוחלפו, SECURITY DEFINER ו-search_path נשמרו, הטריגר במקומו.';
end $guard$;

-- ── שובל האודיט ───────────────────────────────────────────────────────────
-- actor_id נשאר null במכוון: מיגרציה עשתה זאת, לא אדם.
insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
values ('schema', '00000000-0000-0000-0000-000000000000', 'kind_gate_audited', null,
        jsonb_build_object(
          'migration', '0090',
          'functions', jsonb_build_array('public.on_production_approved()',
                                         'public.ensure_job_for_production(uuid,text)'),
          'new_event_type', 'job_skipped_not_client',
          'behaviour_change', false,
          'productions_touched', 0,
          'jobs_touched', 0,
          'source', 'P9 investigation 2026-09-18'));

insert into public.schema_ledger (version, applied_at, applied_by, note)
values ('0090', now(), 'bnaya',
        'שני שערי ה-kind מפסיקים לשתוק. on_production_approved ו-ensure_job_for_production כותבות job_skipped_not_client לפני ה-return כשההפקה אינה kind=client, עם production_id, client_id, kind, billing_mode של התוכנית, status ו-fired_by. זהו אודיט בלבד: אותן הפקות נחסמות בדיוק, אף job חדש לא נוצר, אף job קיים לא השתנה ואף שורת job_productions לא נכתבה. הרקע — תחקיר P9 מ-18.9 מצא ששתי נקודות ההחלטה האלה הן היחידות במסלול שיוצאות בלי שום עקבה, בעוד ששני מסלולי הדחייה האחרים באותה פונקציה עצמה כותבים אירוע מאז 0060 ו-0061; מסמך שנחסם הוא החלטה, והחלטה חייבת להשאיר שורה. שינוי היחיד שדורש תשומת לב הוא היפוך סדר הבדיקות ב-on_production_approved: הטריגר הוא AFTER UPDATE OF status על טבלה עם 233 הפקות internal ו-317 contract, ולכן בדיקת kind ראשונה הייתה כותבת אירוע על כל עדכון סטטוס של כל הפקה שאינה client; לכן נבדק קודם האם זו אחת משתי נקודות הכניסה של 0060 (מעבר ל-הוקלט או לאישור לקוח) ורק אז ה-kind. שתי הבדיקות הן קריאות טהורות בלי תופעות לוואי ולכן ההיפוך שקול: עבור kind=client נקראות בדיוק אותן שתי perform ועבור כל kind אחר מוחזר new כמו קודם. ensure_job_for_production שומרת על סדר השערים המקורי של 0060, כולל זה שבדיקת ה-kind מקדימה את cancelled_at ואת merged_into. מה שאינו כאן ובמכוון: אף אחת מ-110 ההפקות שהתחקיר מצא אינה מתוקנת — הכרעת בעלים 18.9 היא לא לגעת בהן, כי תיקון דינמיקס איזון היה יוצר job כפול מול 60184 ששולמה (אין שורת job_productions שהגארד יתפוס) ותיקון 107 שורות הלגסי היה מייצר התראות שווא; וגם ההתראה ברדאר אינה כאן, כי היא תלויה בסימון עקיפה מכוונת שטרם הוכרע. כלל 49, ACL מוצהר: לא נוצר אף אובייקט נושא-ACL, שתי הפונקציות קיימות ו-CREATE OR REPLACE שומר על הגרנטים ועל הבעלות. אפס שינוי סכימה, אפס DELETE, אפס UPDATE על נתונים, אפס שורה חדשה מלבד האירוע ושורת הפנקס. ההרצה המדומה ב-supabase/verify/0090_dryrun.sql ושאילתת האימות ב-supabase/verify/0090_verify.sql — כלל 50.');
