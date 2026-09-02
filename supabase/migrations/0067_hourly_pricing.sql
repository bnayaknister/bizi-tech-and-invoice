-- 0067: hourly studio pricing — SCHEMA ONLY (F6, owner spec 2026-09-02).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$,
-- גופי הפונקציות $fn$. להרצה ידנית ב-SQL Editor בלבד — אין supabase db push.
--
-- WHAT THIS IS. A show may be billed per episode (today's only model) or by
-- the studio hour. This migration lays the columns, the constraint that keeps
-- the two models unambiguous, the permission walls, and the one SQL price
-- derivation. It changes NO behaviour: every existing row keeps the model it
-- has, and no code reads the new columns yet. The UI and enqueue.ts are a
-- separate step, deliberately after this one has been applied and verified.
--
-- ---------------------------------------------------------------------------
-- A SEPARATE AXIS, NOT A FOURTH billing_mode.
-- ---------------------------------------------------------------------------
-- show_billing_mode is ('per_episode','contract','none') since 0012, and the
-- tempting move was to add 'per_hour' to it. Rejected, twice over:
--
--   1. `billing_mode = 'per_episode'` is read in places that have nothing to
--      do with pricing — the contract branch in checkEligibility, the shows
--      create route, the shows screen, the radar classifier, /projects. A
--      fourth value turns every one of them into a site that must be revisited,
--      and a site that is missed classifies an hourly show as "does not bill"
--      SILENTLY. That is the exact failure mode 0024 exists to prevent.
--   2. `alter type ... add value` cannot be used in the transaction that adds
--      it (55P04) — the restriction that forced the 0046/0047 split and the
--      three-statement shape of 0053. A NEW type has no such restriction: it is
--      created and consumed in this one block, which is why 0067 is atomic
--      while 0053 could not be.
--
-- So an hourly show keeps billing_mode='per_episode' — it genuinely does bill
-- once per production — and only the way the amount is COMPUTED changes.
--
-- ---------------------------------------------------------------------------
-- NO AMBIGUITY, BY CONSTRAINT.
-- ---------------------------------------------------------------------------
-- shows.default_rate keeps its exact meaning ("price per episode") and
-- hourly_rate is new ("₪ per studio hour"). shows_one_rate_per_model makes it
-- impossible for a show to carry both, so "which rate applies?" is not a
-- question that can be asked. Today the same rule is only a comment in
-- ShowsClient.tsx (the confirm that wipes default_rate when a show moves to
-- contract/none); this turns it into a wall. Note that it CANNOT fail on
-- legacy data: hourly_rate is added by this same statement and is null on
-- every existing row, so the check is satisfied by construction.
--
-- ---------------------------------------------------------------------------
-- GRANTS — the trap 0022 left for every future column.
-- ---------------------------------------------------------------------------
-- 0022 revoked table-level SELECT on public.shows and re-granted it column by
-- column, precisely so a money column cannot leak by being forgotten. Its own
-- maintenance note says a NEW column "will NOT be readable by stages users
-- until it's added to a grant like the one below". That cuts both ways here:
--   • pricing_model MUST be granted — the technician's drawer has to know the
--     show is hourly in order to ask for hours at all. It is classification,
--     not an amount.
--   • hourly_rate MUST NOT be granted, exactly as default_rate is omitted
--     there. Money users read it through the service role, the way the shows
--     page already reads default_rate.
-- productions is not column-restricted, but 0028/0040/0055 grant new columns
-- explicitly anyway; studio_hours follows that convention.
--
-- ---------------------------------------------------------------------------
-- TWO GUARDS, NOT ONE — and the second is not on the owner's list.
-- ---------------------------------------------------------------------------
-- guard_show_money_columns (0008 → 0012 → 0024) gains hourly_rate and
-- pricing_model: both are money configuration, and without them a stages-only
-- user could move a show onto hourly billing or set its rate.
--
-- ADDED BEYOND THE BRIEF, and flagged as such: guard_production_stage_columns
-- (0010 → 0040) gains studio_hours. The hours are entered by the TECHNICIAN and
-- are therefore a stage-tier fact, exactly like storage_disk — but they are
-- multiplied by a rate to produce a document amount, so leaving them unguarded
-- would let a user with no can_edit_stages set the number that decides the
-- money. The wall belongs on the same column list as storage_disk, and adding
-- it later means shipping the window in between.
--
-- ---------------------------------------------------------------------------
-- THE SQL PRICE DERIVATION — the copy that is easy to forget.
-- ---------------------------------------------------------------------------
-- `price_override ?? default_rate` is written in FOUR places: enqueue.ts:160,
-- price.ts:36, addons/route.ts:81 — and here, inside
-- ensure_job_for_production, which is what writes jobs.amount and therefore
-- what the deal invoice is built from. Teaching only TypeScript about hourly
-- pricing would leave every hourly job carrying null (default_rate is null on
-- an hourly show), so the function is replaced here, in the same migration
-- that creates the columns it reads.
--
-- ORDER OF EVENTS, AND WHY null IS STILL CORRECT HERE. The job is created on
-- the transition INTO הוקלט (0060), and the hours are typed immediately after
-- that transition — so at job-creation time an hourly production normally has
-- no hours yet and job_amount is null. That is the SAME accepted consequence
-- 0060 already records for add-ons approved after the fact ("KNOWN
-- CONSEQUENCE, ACCEPTED"), it lands on the existing "יש להשלים סכום" note, and
-- the hours route will write jobs.amount when the number arrives. The deal
-- invoice computes its own total regardless and is unaffected.
--
-- The base is derived verbatim from 0064's body with ONE expression changed;
-- everything else — the 0061 not-recorded guard, the 0060 duplicate guard, the
-- 0064 work-date coalesce, the events — is byte-for-byte what is live today.
-- The audit event gains pricing_model / studio_hours / hourly_rate so that
-- "why is this job 875 ₪" is answerable from the log rather than reconstructed;
-- additive keys only, nothing reads the payload by shape.
--
-- ---------------------------------------------------------------------------
-- NOT IN THIS MIGRATION, ON PURPOSE.
-- ---------------------------------------------------------------------------
-- No backfill (nothing to backfill — no show is hourly yet). No upper bound on
-- studio_hours beyond > 0: a sane ceiling is a route-level judgement with a
-- readable message, not a constraint violation. No DELETE, no data change, no
-- row touched. hourly_rate is bare `numeric` like its sibling default_rate
-- (0008:11) rather than numeric(10,2): a scale cap ROUNDS on write instead of
-- refusing, and money that changes itself on the way into the column is the one
-- thing this system does not do. studio_hours is numeric(5,2) per the owner's
-- spec — hours are entered in quarter-hour steps, so the scale is exact for
-- every value the form can produce.

do $mig$
declare
  v_shows        int;
  v_productions  int;
  v_hourly       int;
begin

  -- ---------------------------------------------------------------------
  -- 0. re-run guard. Loud, never idempotent-by-silence: a second run that
  --    did nothing would still add a second ledger row (0053's precedent).
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0067') then
    raise exception '0067 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. the type. CREATE TYPE (unlike ALTER TYPE ... ADD VALUE) is usable in
  --    the same transaction that defines it — see the header.
  -- ---------------------------------------------------------------------
  if not exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typname = 'show_pricing_model' and n.nspname = 'public'
  ) then
    create type public.show_pricing_model as enum ('per_episode', 'per_hour');
    raise notice '0067: show_pricing_model נוצר';
  else
    raise notice '0067: show_pricing_model כבר קיים — מדלג על היצירה';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. the columns.
  --    pricing_model is NOT NULL DEFAULT 'per_episode' so every existing show
  --    keeps exactly the model it has today, stated rather than implied.
  -- ---------------------------------------------------------------------
  alter table public.shows
    add column if not exists pricing_model public.show_pricing_model not null default 'per_episode',
    add column if not exists hourly_rate   numeric;

  alter table public.productions
    add column if not exists studio_hours numeric(5, 2);

  -- ---------------------------------------------------------------------
  -- 3. the constraints.
  --    Neither can fail on existing data: both columns were just added and
  --    are null everywhere, and pricing_model defaulted to 'per_episode'.
  -- ---------------------------------------------------------------------
  begin
    alter table public.shows
      add constraint shows_one_rate_per_model check (
        (pricing_model = 'per_episode' and hourly_rate  is null)
        or
        (pricing_model = 'per_hour'    and default_rate is null)
      );
  exception when duplicate_object then
    raise notice '0067: shows_one_rate_per_model כבר קיים';
  end;

  begin
    alter table public.productions
      add constraint productions_studio_hours_positive check (
        studio_hours is null or studio_hours > 0
      );
  exception when duplicate_object then
    raise notice '0067: productions_studio_hours_positive כבר קיים';
  end;

  -- ---------------------------------------------------------------------
  -- 4. grants. See the header: 0022 made this mandatory for shows, and the
  --    asymmetry between the two new columns IS the security decision.
  -- ---------------------------------------------------------------------
  grant select (pricing_model) on public.shows to authenticated;
  -- hourly_rate is intentionally omitted, exactly as default_rate is omitted
  -- from the grant list in 0022:22-26. A stages user must not read a rate.
  -- Money users read it through the service role (src/app/shows/page.tsx:75
  -- already does this for default_rate).

  grant select (studio_hours) on public.productions to authenticated;

  -- ---------------------------------------------------------------------
  -- 5. the show money guard (0008 → 0012 → 0024 → here).
  --    Body is 0024's, with hourly_rate and pricing_model appended. The
  --    trigger binding trg_guard_show_money (0008:59-62) is NOT recreated —
  --    only the function it calls.
  -- ---------------------------------------------------------------------
  create or replace function public.guard_show_money_columns()
  returns trigger language plpgsql as $fn$
  begin
    if new.default_rate is distinct from old.default_rate
       or new.client_id is distinct from old.client_id
       or new.billing_mode is distinct from old.billing_mode
       or new.internal_confirmed_at is distinct from old.internal_confirmed_at
       or new.internal_confirmed_by is distinct from old.internal_confirmed_by
       -- 0067: the hourly model. pricing_model decides WHICH rate is billed and
       -- hourly_rate is that rate — both are money configuration, and a
       -- stages-only user must not be able to move a show between models.
       or new.pricing_model is distinct from old.pricing_model
       or new.hourly_rate is distinct from old.hourly_rate then
      if not public.can_edit_money() then
        raise exception 'רק בעל הרשאת עריכת כספים יכול לשנות מחיר, לקוח או מודל חיוב של תוכנית';
      end if;
    end if;
    return new;
  end;
  $fn$;

  -- ---------------------------------------------------------------------
  -- 6. the production stage guard (0010 → 0040 → here).
  --    Body is 0040's, with studio_hours appended. See the header: this one
  --    is beyond the owner's list and is flagged in the ledger note.
  -- ---------------------------------------------------------------------
  create or replace function public.guard_production_stage_columns()
  returns trigger language plpgsql as $fn$
  begin
    if new.on_hold is distinct from old.on_hold
       or new.storage_disk is distinct from old.storage_disk
       -- 0067: the recorded studio hours. A stage-tier fact like the disk —
       -- the technician enters it — but it is multiplied by a rate to produce
       -- a document amount, so it needs the same wall rather than none.
       or new.studio_hours is distinct from old.studio_hours
       or (new.status is distinct from old.status and new.status <> 'אושר_ע"י_לקוח') then
      if not public.can_edit_stages() then
        raise exception 'רק בעל הרשאת עריכת שלבים יכול לשנות סטטוס, הקפאה, דיסק או שעות הקלטה של הפקה';
      end if;
    end if;
    return new;
  end;
  $fn$;

  -- ---------------------------------------------------------------------
  -- 7. ensure_job_for_production (0060 → 0061 → 0064 → here).
  --    0064's body verbatim; ONLY the base_amount expression changes.
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
    insert into public.jobs (client_id, contract_id, date, campaign, amount, notes)
    values (prod.client_id, prod.contract_id,
            coalesce(prod.record_date, current_date),
            prod.podcast_name, job_amount,
            case when job_amount is not null
                 then 'נוצר אוטומטית (' || p_reason || '). סכום = מחיר אפקטיבי + תוספות מאושרות — לאמת ולהנפיק חשבונית עסקה.'
                 else 'נוצר אוטומטית (' || p_reason || '). יש להשלים סכום וחשבונית עסקה.' end)
    returning id into new_job_id;

    insert into public.job_productions (job_id, production_id)
    values (new_job_id, p_id);

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
                               'hourly_rate', v_hourly));
    return new_job_id;
  end;
  $fn$;

  -- ---------------------------------------------------------------------
  -- 8. what the migration found, for the notice below and for the ledger.
  -- ---------------------------------------------------------------------
  select count(*) into v_shows       from public.shows;
  select count(*) into v_productions from public.productions;
  select count(*) into v_hourly      from public.shows where pricing_model = 'per_hour';

  if v_hourly <> 0 then
    raise exception '0067: % תוכניות כבר מסומנות per_hour לפני שהמיגרציה רצה — עצור וברר', v_hourly;
  end if;

  -- ---------------------------------------------------------------------
  -- 9. the ledger, inside the same block — a schema change that is not
  --    recorded is a schema change nobody can find later (0052).
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0067', now(), 'bnaya',
          'F6 שלב 1 — תמחור לפי שעת אולפן, סכימה בלבד. אפס שינוי התנהגות: כל התוכניות הקיימות נשארות per_episode, שום קוד עדיין לא קורא את העמודות החדשות, ואין backfill כי אין עדיין תוכנית שעתית אחת. נוסף טיפוס show_pricing_model (per_episode/per_hour) כציר נפרד ולא כערך רביעי ב-show_billing_mode, משתי סיבות: (א) billing_mode=per_episode נקרא בעשרות אתרים שאינם תמחור — ענף החוזה ב-checkEligibility, מסך התוכניות, סיווג הרדאר, /projects — וערך רביעי היה הופך כל אחד מהם לאתר שצריך לבדוק, ואתר שנשכח מסווג תוכנית שעתית כלא-מחויבת בשקט; (ב) alter type add value אינו שמיש באותה טרנזקציה (55P04) וזה מה שאילץ את פיצול 0046/0047 ואת שלוש ההצהרות של 0053, בעוד create type מותר — ולכן 0067 אטומית. תוכנית שעתית שומרת billing_mode=per_episode כי היא באמת מחייבת פעם לכל הפקה; רק אופן חישוב הסכום משתנה. עמודות: shows.pricing_model (not null default per_episode, כך שכל שורה קיימת מצהירה על המודל שכבר יש לה), shows.hourly_rate (numeric חשוף כמו default_rate ב-0008:11 ולא numeric(10,2) — סקאלה מעגלת בכתיבה במקום לסרב, וכסף שמשנה את עצמו בדרך לעמודה הוא הדבר האחד שהמערכת הזו לא עושה), productions.studio_hours numeric(5,2) לפי אפיון הבעלים — הטופס מזין ברבעי שעה ולכן הסקאלה מדויקת לכל ערך שהוא יכול להפיק. אילוץ shows_one_rate_per_model: או per_episode עם hourly_rate ריק או per_hour עם default_rate ריק, כך ש"איזה מחיר תקף" אינה שאלה שניתן לשאול. עד היום הכלל הזה היה הערה בלבד ב-ShowsClient (ה-confirm שמוחק את המחיר במעבר ל-contract/none) והוא הופך כאן לקיר. האילוץ אינו יכול להיכשל על נתונים היסטוריים כי hourly_rate נוספה באותה הצהרה וריקה בכל שורה. אילוץ שני: studio_hours ריק או חיובי — 0 שעות פירושו שההקלטה לא התרחשה, ואז המסלול הוא ביטול ההפקה (0062) ולא מסמך על 0 ש"ח. תקרה עליונה לא נוספה במכוון: היא שיפוט ברמת ה-route עם הודעה קריאה, לא הפרת אילוץ. הרשאות: pricing_model הוענקה ל-authenticated כי הדרואר של הטכנאי חייב לדעת שהתוכנית שעתית כדי לבקש שעות בכלל — זו סיווג ולא סכום; hourly_rate הושמטה במפורש בדיוק כפי ש-default_rate מושמטת ב-0022:22-26, ומשתמשי כסף יקראו אותה דרך service role כמו שמסך התוכניות כבר עושה. הערת התחזוקה של 0022 היא מה שהפך את שתי ההחלטות האלה לחובה ולא לאופציה: עמודה חדשה ב-shows בלתי-נראית ל-authenticated עד שנוקבים בשמה. studio_hours הוענקה גם היא, לפי מוסכמת 0028/0040/0055, אף ש-productions אינה מוגבלת-עמודות. שני שומרים הורחבו: guard_show_money_columns (גוף 0024) קיבל hourly_rate ו-pricing_model, אחרת משתמש שלבים היה מעביר תוכנית למודל שעתי או קובע תעריף; ו-guard_production_stage_columns (גוף 0040) קיבל studio_hours — זו תוספת מעבר לרשימה שהבעלים נקב בה, ומדווחת ככזו: השעות הן עובדה ברמת שלבים בדיוק כמו storage_disk, אבל הן מוכפלות בתעריף ומייצרות סכום מסמך, ולכן היעדר שומר היה מתיר למי שאין לו can_edit_stages לקבוע את המספר שמכריע את הכסף. ensure_job_for_production הוחלפה (גוף 0064 מילה במילה, ביטוי base_amount היחיד שהשתנה) כי היא הכתובת הרביעית של הכלל price_override ?? default_rate — לצד enqueue.ts:160, price.ts:36 ו-addons/route.ts:81 — והיא זו שכותבת jobs.amount שממנו נבנית חשבונית העסקה; לימוד TypeScript בלבד היה משאיר כל job שעתי עם null כי default_rate ריקה בתוכנית שעתית. הכלל החדש: price_override מנצח בשני המודלים, per_hour מחשב round(שעות × תעריף, 2), per_episode ללא שינוי. העיגול אינו קוסמטי — שער האיזון של c339215 משווה Σ(price×quantity) ל-amount באפסילון של אגורה ו-1.5 × 333.33 = 499.995 יושב עליו בדיוק. חסר תעריף או חסרות שעות משאירים base_amount null ונופלים על מסלול "יש להשלים סכום" הקיים במקום להמציא חדש; זה תקין וצפוי, כי ה-job נולד במעבר ל-הוקלט (0060) והשעות מוקלדות מיד אחריו — אותה KNOWN CONSEQUENCE ש-0060 כבר רשמה על תוספות שאושרו בדיעבד, ונתיב השעות יכתוב את jobs.amount כשהמספר יגיע. אירוע client_approved_job_created קיבל שלושה מפתחות נוספים (pricing_model, studio_hours, hourly_rate) כדי ש"למה ה-job הזה 875 ש"ח" ייענה מהלוג ולא משחזור; תוספת מפתחות בלבד, שום קורא אינו תלוי בצורה. אפס DELETE, אפס עדכון נתונים, אפס שורה שנגעה.');

  raise notice '0067 הוחלה. % תוכניות ו-% הפקות קיבלו את העמודות החדשות; כולן נשארו per_episode. הצעד הבא: database.types.ts, ורק אחריו הלוגיקה.',
               v_shows, v_productions;
end $mig$;
