-- 0081 — ensure_job_for_production כותבת paid במפורש
--
-- מה זה ולמה. עמודת jobs.paid היא NOT NULL עם DEFAULT 'לא ידוע', ו-
-- ensure_job_for_production — המסלול שיוצר את רוב העבודות במערכת — מעולם לא
-- נקבה בה ב-INSERT. שש עמודות נכתבות (client_id, contract_id, date, campaign,
-- amount, notes) ו-paid אינה ביניהן, ולכן כל עבודה שנולדה שם יצאה לדרך
-- כ'לא ידוע'. הקובץ הזה מוסיף עמודה אחת לאותו INSERT. שום דבר אחר בגוף
-- הפונקציה אינו משתנה.
--
-- ═══ למה זה משנה: 'לא ידוע' אינו 'לא', וחמישה קוראים בודקים שוויון מדויק ═══
-- הערך ברירת המחדל נכון לשורות מיובאות — ייבוא CSV באמת אינו יודע אם שולם,
-- ו-import/apply/route.ts:182 כותב אותו במודע דרך mapPaid. אבל עבודה שהמערכת
-- זה עתה יצרה על פרק שהוקלט אתמול אינה "לא ידוע": היא טרם שולמה, וזה 'לא'.
--
-- חמישה מקומות בודקים paid === 'לא' בשוויון מדויק, וכולם עיוורים ל'לא ידוע':
--
--   issue.ts:105        320 אינה מסמנת שולם
--   issue.ts:107        400 אינה מסמנת שולם
--   reconcile.ts:425    linkDocumentToJob אינה מסמנת שולם
--   reconcile.ts:172    jobNeedsDocType אינה מציעה מסמך תשלום כמועמד —
--                       מסך הפערים לא רואה את השורה בכלל
--   alerts.ts:263       debtToCollect אינה סופרת אותה
--
-- ⚠️ הכרעת הבעלים 15.9.26: מתקנים את המקור, לא מרחיבים את חמש הבדיקות.
-- הרחבה לכל חמשת הקוראים היא אותו כלל בחמישה מקומות וחור שישי מובטח — בדיוק
-- הנימוק ש-milestone.ts:17-25 רשמה כשסירבה ללמד ארבעה מסלולים לכתוב לאבן
-- הדרך. מקור אחד כותב את הערך; חמשת הקוראים נשארים כפי שהם.
-- ⚠️ ברירת המחדל של העמודה אינה משתנה. היא נכונה לשורות מיובאות.
--
-- ═══ מה זה עלה, נמדד ═══
-- קבלה 80063 (ל-עופר גולן, הונפקה 30.8.26 12:10 שעון ישראל) קישרה את 50069
-- וסגרה אותו במורנינג. issue.ts:858-892 היה אמור לסמן את job 97ab62f5 כשולם,
-- מצא אותו דרך bundle_job_ids, ויצא מהלולאה בשקט כי paid היה 'לא ידוע' ולא
-- 'לא'. ה-job נשאר לא-שולם 16 יום, עד שסומן ביד ב-15.9 09:29.
--
-- ולא היה זה מקרה בודד. 320 מספר 60189 (2.9.26, חמישה jobs של ברק הרשקוביץ)
-- כתב invoice_tax='60189' על כל החמישה — כלומר הלולאה רצה — ולא כתב paid על
-- אף אחד, מאותה סיבה בדיוק. הם סומנו ידנית ב-8.9. שתי ההנפקות לא הותירו אף
-- אירוע, וזה תוקן בקומיט שקדם לקובץ הזה: auto_receipt_paid_not_flipped ו-
-- auto_tax_receipt_paid_not_flipped נושאים מעכשיו את job_paid האמיתי.
--
-- ההתאמה מלאה לשני הכיוונים, נמדד 15.9.26:
--   27 שורות ב-'לא ידוע'  —  27 מהן נולדו כאן, 0 legacy
--   16 שורות ב-'לא'       —  0 מהן נולדו כאן
--
-- חמשת יוצרי ה-jobs האחרים כותבים 'לא' במפורש וכבר עשו זאת תמיד:
--   milestones/[mid]/issue/route.ts:73 · milestones/[mid]/enqueue/route.ts:145
--   documents/bundle-from-show/route.ts:112 · lib/misc/workOrder.ts:97
-- והשישי, import/apply/route.ts:182, כותב את מה שה-CSV אמר — כולל 'לא ידוע'
-- כברירת מחדל, וזה הנתיב שבשבילו ברירת המחדל של העמודה קיימת.
--
-- ═══ אפס יישור לשורות קיימות, בהכרעת הבעלים ═══
-- 22 השורות החיות ב-'לא ידוע' (5 נוספות מבוטלות בצדק — 2 הפקות טסט ו-3
-- כפילויות רישום מ-0065/0066) נמדדו ומוצגות, ולא נגעו. הסיווג:
--
--   1. כבר יש מסמך תשלום (320/400)   5 jobs   ₪5,100
--   2. מסמך חיוב בלבד (300/305)      7 jobs   ₪7,200
--   3. אין מסמך כלל                 10 jobs   ₪8,300
--
-- קבוצה 1 אינה חוב אלא תקבול שלא נרשם, וקבוצות 2 ו-3 הן ₪15,500 שייכנסו
-- ל-debtToCollect ביום שיישוירו ל-'לא'. שלוש הקבוצות דורשות שלוש הכרעות
-- שונות, ולכן אף אחת אינה מתקבלת כאן. הקובץ הזה עוצר את הדימום; הדם שכבר
-- על הרצפה הוא כרטיס נפרד.
--
-- ═══ PERMISSIONS — STATED, NOT ASSUMED (rule 49) ═══
-- הקובץ מחליף פונקציה קיימת ואינו יוצר שום אובייקט חדש נושא-ACL — לא טבלה,
-- לא עמודה, לא טיפוס, לא policy.
--
-- CREATE OR REPLACE FUNCTION משמר את ההרשאות הקיימות. הוא אינו נוגע ב-proacl
-- ואינו נוגע ב-proowner; רק CREATE של פונקציה שאינה קיימת נולד עם ברירת מחדל
-- (PUBLIC EXECUTE). לכן אין כאן GRANT, ואין מה לשכוח — ⚠️ ובלבד שהפונקציה
-- אכן קיימת ברגע ההחלפה. אילו לא הייתה, ההצהרה הזאת הייתה נכונה במילים
-- ושקרית בפועל, ולכן קיומה נבדק כשומר לפני ההחלפה ולא מונח.
--
-- ה-ACL הנוכחי, נקרא מהקטלוג 15.9.26:
--   {=X/postgres, postgres=X/postgres, anon=X/postgres,
--    authenticated=X/postgres, service_role=X/postgres}
-- כלומר EXECUTE ל-PUBLIC ובנוסף מפורשות לארבעת התפקידים. owner=postgres,
-- SECURITY DEFINER, search_path=public. כל ארבעת המאפיינים מוצהרים מחדש
-- ב-DDL כפי שהקטלוג מחזיק אותם, ו-ה-canary משווה את ה-ACL לפני ואחרי
-- במקום לסמוך על כך ש-CREATE OR REPLACE לא יכול היה להזיז אותו.
--
-- החצי של כלל 49 שמכה בשקט: SECURITY DEFINER על פונקציה בבעלות postgres
-- פירושו שכל מי שמחזיק EXECUTE רץ כ-postgres. זה המצב היום ולא נוצר כאן —
-- הפונקציה נושאת SECURITY DEFINER מ-0060 והגישה שלה לא נגעה. הדבר היחיד
-- שהשתנה בגוף הוא ליטרל אחד בעמודת paid.
--
-- ═══ הגוף ═══
-- נלקח מ-pg_get_functiondef בקטלוג החי (15.9.26) ולא מקובץ מיגרציה. זה משנה:
-- ⚠️ הגרסה החיה היא של 0077, לא של 0064. השרשרת היא
-- 0060 → 0061 → 0064 → 0067 → 0077, וזו המיגרציה השישית שכותבת את הגוף.
-- אומת שהגוף בקטלוג זהה תו-בתו לזה שבקובץ 0077 (137 שורות, אפס הפרש),
-- כלומר אין סחף בין הקובץ למסד.
--
-- md5(prosrc) של הגוף שנקרא: 62d64487b46cf979bcac2c2b9d480e15
-- הוא נבדק כשומר לפני ההחלפה. create or replace שותק לגבי מה שהרס, ולוגיקת
-- התמחור של 0067 והחותמת של 0077 יושבות שתיהן בתוך הגוף הזה.
--
-- ZERO DELETE. ZERO schema change. ZERO row updated. ליטרל אחד, עמודה אחת.

do $mig$
declare
  -- the body about to be replaced must be the one that was read
  v_fn_md5_expected constant text := '62d64487b46cf979bcac2c2b9d480e15';
  v_fn_md5          text;
  v_exists          int;

  -- permissions, compared rather than assumed
  v_acl_pre         text;
  v_acl_post        text;
  v_secdef_pre      boolean;
  v_secdef_post     boolean;
  v_owner_pre       text;
  v_owner_post      text;
  v_config_pre      text;
  v_config_post     text;

  -- proof that not one row moved
  v_jobs_pre        int;
  v_jobs_post       int;
  v_unknown_pre     int;
  v_unknown_post    int;
  v_digest_pre      text;
  v_digest_post     text;

  -- what the owner will read back
  v_insert_line     text;
begin
  -- ---------------------------------------------------------------------
  -- 0. GUARDS — every assumption below, turned into a refusal.
  -- ---------------------------------------------------------------------

  -- 0a. the ledger is the sequence, not the filenames. If 0080 is missing then
  --     the numbering was derived from a different ledger and every count in
  --     the header was measured against a different database.
  if exists (select 1 from public.schema_ledger where version = '0081') then
    raise exception '0081 כבר רשומה בפנקס';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0080') then
    raise exception '0081: 0080 אינה בפנקס — המספור נגזר מפנקס אחר';
  end if;

  -- 0b. the function EXISTS. This is what makes the rule-49 declaration in the
  --     header true in fact and not only in words: CREATE OR REPLACE preserves
  --     an ACL, plain CREATE invents one.
  select count(*) into v_exists
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';
  if v_exists <> 1 then
    raise exception '0081: ensure_job_for_production אינה קיימת (% מופעים) — החלפה תיצור אותה עם הרשאות ברירת מחדל', v_exists;
  end if;

  -- 0c. the body about to be replaced is the body that was read. The guard
  --     that matters most here, for the same reason 0077 stated: 0067's
  --     pricing logic and 0077's work-order stamp both live inside it.
  select md5(p.prosrc) into v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';
  if v_fn_md5 is distinct from v_fn_md5_expected then
    raise exception '0081: גוף ensure_job_for_production אינו זה שנקרא 15.9 (md5=%) — מיגרציה מאוחרת יותר שינתה אותו, אל תדרוס', coalesce(v_fn_md5, 'לא קיימת');
  end if;

  -- 0d. permissions and identity, before.
  select coalesce(p.proacl::text, '(null)'), p.prosecdef,
         pg_get_userbyid(p.proowner), coalesce(p.proconfig::text, '(null)')
    into v_acl_pre, v_secdef_pre, v_owner_pre, v_config_pre
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';

  -- 0e. the jobs table, before. The digest covers EVERY column of every row,
  --     which is what proves zero side effects — not the absence of an UPDATE
  --     statement, which only proves nobody wrote one on purpose.
  select count(*) into v_jobs_pre from public.jobs;
  select count(*) into v_unknown_pre
    from public.jobs
   where paid = 'לא ידוע' and notes like 'נוצר אוטומטית%';
  select md5(string_agg(t.row_text, '|' order by t.row_text)) into v_digest_pre
    from (select j::text as row_text from public.jobs j) t;

  -- ---------------------------------------------------------------------
  -- 1. THE REPLACEMENT. 0077's body verbatim; the only change is `paid`
  --    named in the INSERT column list and 'לא' supplied for it.
  -- ---------------------------------------------------------------------
  create or replace function public.ensure_job_for_production(p_id uuid, p_reason text)
  returns uuid language plpgsql security definer set search_path = public as $fn$
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
  begin
    select * into prod from public.productions where id = p_id;
    if not found then return null; end if;

    if prod.kind <> 'client' then return null; end if;
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
  $fn$;

  -- ---------------------------------------------------------------------
  -- 2. CANARY — both directions, before the ledger row.
  -- ---------------------------------------------------------------------

  -- 2a. the body really changed, and to something that parses.
  select md5(p.prosrc) into v_fn_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';
  if v_fn_md5 = v_fn_md5_expected then
    raise exception '0081 canary: גוף הפונקציה לא השתנה — ההחלפה לא נתפסה';
  end if;

  -- 2b. it changed to the RIGHT thing. Existence alone would pass on any
  --     replacement at all, including one that dropped the pricing logic.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ensure_job_for_production'
       and p.prosrc like '%amount, paid, notes%'
       and p.prosrc like '%job_amount, ''לא'',%'
  ) then
    raise exception '0081 canary: paid אינו ב-INSERT של הגוף החדש';
  end if;

  -- 2c. and nothing ELSE was lost. Three fingerprints from the two migrations
  --     whose work lives inside this body — 0067's pricing and 0077's stamp.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'ensure_job_for_production'
       and p.prosrc like '%work_order_stamped%'
       and p.prosrc like '%per_hour%'
       and p.prosrc like '%job_skipped_not_recorded%'
  ) then
    raise exception '0081 canary: הגוף החדש איבד לוגיקה של 0061/0067/0077';
  end if;

  -- 2d. PERMISSIONS, unchanged — the claim rule 49 makes in the header, read
  --     back from the catalog instead of trusted. All four properties, because
  --     a SECURITY DEFINER function owned by postgres that quietly became
  --     SECURITY INVOKER would still pass an ACL comparison.
  select coalesce(p.proacl::text, '(null)'), p.prosecdef,
         pg_get_userbyid(p.proowner), coalesce(p.proconfig::text, '(null)')
    into v_acl_post, v_secdef_post, v_owner_post, v_config_post
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';

  if v_acl_post is distinct from v_acl_pre then
    raise exception '0081 canary: ה-ACL של הפונקציה השתנה: % -> %', v_acl_pre, v_acl_post;
  end if;
  if v_secdef_post is distinct from v_secdef_pre then
    raise exception '0081 canary: SECURITY DEFINER השתנה: % -> %', v_secdef_pre, v_secdef_post;
  end if;
  if v_owner_post is distinct from v_owner_pre then
    raise exception '0081 canary: הבעלות השתנתה: % -> %', v_owner_pre, v_owner_post;
  end if;
  if v_config_post is distinct from v_config_pre then
    raise exception '0081 canary: search_path השתנה: % -> %', v_config_pre, v_config_post;
  end if;

  -- 2e. ZERO ROWS TOUCHED. The owner decided existing rows are not aligned
  --     here, so this is not a formality: the digest covers every column of
  --     every job, and a single changed `paid` would break it.
  select count(*) into v_jobs_post from public.jobs;
  select count(*) into v_unknown_post
    from public.jobs
   where paid = 'לא ידוע' and notes like 'נוצר אוטומטית%';
  select md5(string_agg(t.row_text, '|' order by t.row_text)) into v_digest_post
    from (select j::text as row_text from public.jobs j) t;

  if v_jobs_post <> v_jobs_pre then
    raise exception '0081 canary: מספר ה-jobs השתנה: % -> %', v_jobs_pre, v_jobs_post;
  end if;
  if v_unknown_post <> v_unknown_pre then
    raise exception '0081 canary: מספר השורות ב-לא ידוע השתנה: % -> % — הקובץ הזה אינו מיישר שורות קיימות', v_unknown_pre, v_unknown_post;
  end if;
  if v_digest_post is distinct from v_digest_pre then
    raise exception '0081 canary: טבלת jobs השתנתה — הקובץ הזה אינו כותב ולו שורה אחת';
  end if;

  -- ---------------------------------------------------------------------
  -- 3. THE LEDGER — same atomic block, passes or falls with the change.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0081', now(), 'bnaya',
    'ensure_job_for_production כותבת paid במפורש. ליטרל אחד, עמודה אחת ב-INSERT, אפס שינוי סכימה, אפס DELETE ואפס שורה שנכתבה. הבעיה: jobs.paid הוא NOT NULL עם DEFAULT לא ידוע, והפונקציה שיוצרת את רוב העבודות במערכת מעולם לא נקבה בו — שש עמודות נכתבו (client_id, contract_id, date, campaign, amount, notes) ו-paid לא ביניהן — ולכן כל עבודה שנולדה שם יצאה לדרך כלא ידוע. זה משנה מפני שחמישה קוראים בודקים שוויון מדויק מול לא: issue.ts:105 שבו 320 אינה מסמנת שולם, issue.ts:107 שבו 400 אינה מסמנת שולם, reconcile.ts:425 שבו linkDocumentToJob אינה מסמנת שולם, reconcile.ts:172 שבו jobNeedsDocType אינה מציעה מסמך תשלום כמועמד ולכן מסך הפערים אינו רואה את השורה בכלל, ו-alerts.ts:263 שבו debtToCollect אינה סופרת אותה. מה שזה עלה, נמדד ולא נטען: קבלה 80063 לעופר גולן הונפקה 30.8.26 ב-12:10 שעון ישראל, קישרה את 50069 וסגרה אותו במורנינג, ו-issue.ts:858-892 מצא את job 97ab62f5 דרך bundle_job_ids ויצא מהלולאה בשקט כי paid היה לא ידוע ולא לא; ה-job נשאר לא-שולם 16 יום עד שסומן ביד ב-15.9 ב-09:29. ולא היה זה מקרה בודד: 320 מספר 60189 מ-2.9.26 על חמישה jobs של ברק הרשקוביץ כתב invoice_tax=60189 על כל החמישה, כלומר הלולאה רצה, ולא כתב paid על אף אחד מאותה סיבה בדיוק, והם סומנו ידנית ב-8.9. שתי ההנפקות לא הותירו אף אירוע, וזה תוקן בקומיט שקדם לקובץ הזה: auto_receipt_paid_not_flipped ו-auto_tax_receipt_paid_not_flipped נושאים מעכשיו את job_paid האמיתי, כך שהשאלה מי דילג ולמה תיענה מהלוג ולא משחזור. ההתאמה מלאה לשני הכיוונים, נמדד 15.9.26: 27 שורות בלא ידוע וכל 27 נולדו כאן ואפס מהן legacy, מול 16 שורות בלא ואפס מהן נולדו כאן. הכרעת הבעלים באותו יום, והיא ההקשר: מתקנים את המקור ולא מרחיבים את חמש הבדיקות, כי הרחבה לכל חמשת הקוראים היא אותו כלל בחמישה מקומות וחור שישי מובטח — בדיוק הנימוק ש-milestone.ts:17-25 רשמה כשסירבה ללמד ארבעה מסלולים לכתוב לאבן הדרך. ברירת המחדל של העמודה אינה משתנה כי היא נכונה לשורות מיובאות: ייבוא CSV באמת אינו יודע אם שולם, ו-import/apply/route.ts:182 כותב לא ידוע במודע דרך mapPaid. חמשת יוצרי ה-jobs האחרים כותבים לא במפורש וכבר עשו זאת תמיד — milestones issue:73, milestones enqueue:145, bundle-from-show:112 ו-misc/workOrder:97 — כך שאחרי הקובץ הזה כל יוצר במערכת נוקב בערך והשתיקה נעלמת מהמסלול. אפס יישור לשורות קיימות, בהכרעת הבעלים, והן נמדדו ומוצגות במקום להיות מתוקנות: 22 שורות חיות, ועוד 5 מבוטלות בצדק שהן שתי הפקות טסט ושלוש כפילויות רישום מ-0065 ו-0066. הסיווג של ה-22: 5 jobs בסך 5,100 כבר נושאים מסמך תשלום 320 או 400 ולכן אינם חוב אלא תקבול שלא נרשם; 7 jobs בסך 7,200 נושאים מסמך חיוב בלבד 300 או 305; ו-10 jobs בסך 8,300 אינם נושאים מסמך כלל. קבוצות 2 ו-3 הן 15,500 שייכנסו ל-debtToCollect ביום שיישוירו ללא, וקבוצה 1 דורשת הכרעה הפוכה — היא צריכה כן ולא לא. שלוש קבוצות ושלוש הכרעות שונות, ולכן אף אחת אינה מתקבלת כאן: הקובץ עוצר את הדימום, והדם שכבר על הרצפה הוא כרטיס נפרד. הגוף נלקח מ-pg_get_functiondef בקטלוג החי ולא מקובץ מיגרציה, וזה משנה כי הגרסה החיה היא של 0077 ולא של 0064 — השרשרת היא 0060 אל 0061 אל 0064 אל 0067 אל 0077 אל כאן, וזו המיגרציה השישית שכותבת את הגוף. אומת שהגוף בקטלוג זהה תו-בתו לזה שבקובץ 0077, 137 שורות ואפס הפרש, כלומר אין סחף בין הקובץ למסד. md5(prosrc) של הגוף שנקרא הוא 62d64487b46cf979bcac2c2b9d480e15 והוא נבדק כשומר לפני ההחלפה, מאותה סיבה ש-0077 בדקה את של 0067: create or replace שותק לגבי מה שהרס, ולוגיקת התמחור של 0067 והחותמת של 0077 יושבות שתיהן בתוך הגוף הזה. הרשאות מוצהרות לפי כלל 49: הקובץ מחליף פונקציה קיימת ואינו יוצר שום אובייקט חדש נושא-ACL, לא טבלה ולא עמודה ולא טיפוס ולא policy, ו-CREATE OR REPLACE FUNCTION משמר את ההרשאות הקיימות — הוא אינו נוגע ב-proacl ואינו נוגע ב-proowner, ורק CREATE של פונקציה שאינה קיימת נולד עם ברירת מחדל של PUBLIC EXECUTE. לכן אין כאן GRANT ואין מה לשכוח, ובלבד שהפונקציה אכן קיימת ברגע ההחלפה — אילו לא הייתה, ההצהרה הייתה נכונה במילים ושקרית בפועל, ולכן קיומה נבדק כשומר 0b ולא מונח. ה-ACL שנקרא מהקטלוג 15.9.26 הוא EXECUTE ל-PUBLIC ובנוסף מפורשות ל-postgres, anon, authenticated ו-service_role, הבעלות היא postgres, הפונקציה SECURITY DEFINER ו-search_path הוא public; כל ארבעת המאפיינים מוצהרים מחדש ב-DDL כפי שהקטלוג מחזיק אותם ונבדקים לפני ואחרי במקום להיות מונחים, כי פונקציה שהייתה SECURITY DEFINER והפכה בשקט ל-INVOKER הייתה עוברת השוואת ACL נקייה. החצי של כלל 49 שמכה בשקט מקבל משפט: SECURITY DEFINER על פונקציה בבעלות postgres פירושו שכל מי שמחזיק EXECUTE רץ כ-postgres, וזה המצב מ-0060 ולא נוצר כאן — הדבר היחיד שהשתנה בגוף הוא ליטרל אחד בעמודת paid. שמונה בדיקות canary לפני שורת הפנקס: הפנקס אינו מכיל 0081 והפנקס כן מכיל 0080; הפונקציה קיימת בדיוק פעם אחת לפני ההחלפה; md5 של הגוף הוא זה שנקרא; הגוף באמת השתנה; הגוף החדש נושא את paid ב-INSERT ואת הליטרל לא, ולא רק קיים; הגוף החדש עדיין נושא את work_order_stamped ואת per_hour ואת job_skipped_not_recorded, כלומר לא איבד את 0061 ו-0067 ו-0077; ה-ACL וה-SECURITY DEFINER והבעלות ו-search_path זהים לפני ואחרי; ומספר ה-jobs, מספר השורות בלא ידוע, ו-md5 על כל עמודה של כל שורה בטבלה זהים לפני ואחרי — הבדיקה האחרונה היא ההוכחה לאפס שינוי נתונים, ולא היעדר משפט UPDATE שמוכיח רק שאיש לא כתב אחד בכוונה. מחוץ להיקף במכוון, כל אחד צעד בפני עצמו: יישור 22 השורות הקיימות; חמשת הקוראים שבודקים שוויון מדויק, שנשארים כפי שהם בהכרעת הבעלים; ו-jobs.paid שאין לה עמודת חותמת זמן משלה מ-0001, כך שאירוע job_marked_paid נשאר הרישום היחיד של מתי הכסף נכנס.');

  -- ---------------------------------------------------------------------
  -- 4. THE NOTICE the owner pastes back — the line itself, out of the
  --    catalog, so the verification is the body and not a claim about it.
  -- ---------------------------------------------------------------------
  select (regexp_match(p.prosrc, '(insert into public\.jobs[^;]*?notes\))'))[1]
    into v_insert_line
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ensure_job_for_production';

  raise notice '0081 INSERT: %', coalesce(v_insert_line, '(לא נמצא — בדקי ידנית)');
  raise notice '0081 md5: % -> %', v_fn_md5_expected, v_fn_md5;
  raise notice '0081 ACL: % (ללא שינוי) · owner=% · secdef=% · %', v_acl_post, v_owner_post, v_secdef_post, v_config_post;
  raise notice '0081 jobs: % שורות, מהן % ב-לא ידוע — ללא שינוי, לא בוצע יישור', v_jobs_post, v_unknown_post;
  raise notice '0081 הוחלה ונרשמה. מעכשיו כל יוצר jobs במערכת נוקב ב-paid במפורש.';

end $mig$;
