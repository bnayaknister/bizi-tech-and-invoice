-- 0074: "רדיו ושונות" — עבודות שאינן פודקאסט, בטבלה משלהן.
--
-- ⚠️ בלוק DO אטומי אחד. מוסכמת ציטוט: החיצוני $mig$. להרצה ידנית ב-SQL Editor
-- בלבד — אין supabase db push.
--
-- סכימה בלבד. אפס שינוי התנהגות: שום קוד עדיין לא קורא את הטבלאות האלה, אין
-- backfill, ואף שורה קיימת לא נגעה. הראוט והמסך הם צעדים 2 ו-3.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A SEPARATE TABLE AND NOT kind='misc' ON productions
-- ═══════════════════════════════════════════════════════════════════════════
-- The obvious cheap move — one more value in production_kind — was measured
-- and rejected. `productions` is built around a podcast episode in the DATABASE
-- layer, not merely in the UI, and four separate mechanisms would each have to
-- be taught an exception:
--
--   1. create_default_stages (trigger, AFTER INSERT) ignores `kind` entirely.
--      Every new row is seeded 3-5 stages from has_episode / reels_count. A
--      radio job would carry episode/record, episode/edit, episode/deliver +
--      reels/edit, reels/deliver — five stages describing work nobody will do.
--   2. guard_production_composition CHECKs `has_episode OR reels_count > 0`, so
--      there is no way to insert a row that declares neither. The stages are
--      not avoidable, they are mandatory.
--   3. ensure_job_for_production (0060 → 0061 → 0064 → 0067) opens with
--      `if prod.kind <> 'client' then return null` — a misc row would silently
--      get NO job, which is precisely the thing this feature exists to create.
--   4. checkEligibility (enqueue.ts:232) refuses the same way, one layer up:
--      "הפקה מסוג 'misc' — לא מחויבת". Two independent blocks, both on kind.
--
-- On top of that, 32 files read `productions`, and derive_production_status
-- (trigger on stages) would auto-advance a radio job through בהקלטה/בעריכה the
-- first time anyone touched one of its phantom stages.
--
-- A separate table costs one join on the money screens later (step 4, not this
-- migration). Teaching `productions` to be two things costs an exception in
-- four mechanisms that exist to stop exactly that kind of drift.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY SUPPLIERS ARE A TABLE AND NOT JSONB ON THE ROW
-- ═══════════════════════════════════════════════════════════════════════════
-- The spec's suppliers are (name, service, price) — which JSONB would hold
-- perfectly well. What decides it is the field the spec implies but does not
-- name: a payment date, and reminders driven off it.
--
-- A reminder asks "which payments are due by date X, across every job" — one
-- predicate over all rows. As a table that is `where due_date <= $1 and
-- paid_at is null` against the partial index below. As JSONB it is
-- jsonb_array_elements over every misc_production, unindexable, growing with
-- the table forever.
--
-- Note also what is NOT here: a link to Morning's supplier module. It exists
-- (POST /suppliers/search returns 22) but all 22 carry `emails: []`, so a
-- linked supplier and a free-text one are equally unable to be emailed today.
-- The link is a later decision, not a prerequisite; supplier_name is text.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE ENUM, AND WHY 'בוטל' IS LAST — AND MUST NEVER BE RANGE-COMPARED
-- ═══════════════════════════════════════════════════════════════════════════
-- misc_production_status is ordered נפתח → בעבודה → הושלם, with בוטל LAST.
-- That ordering is the same trap production_status carries, and 0060, 0061 and
-- 0062 each warn about it in turn: because 'בוטל' sorts after every working
-- state, ANY test of the form `status >= 'הושלם'` or `status > 'בעבודה'`
-- sweeps cancelled rows INTO the set it meant to exclude.
--
-- ★ THE RULE FOR EVERY READER OF THIS COLUMN: name the states literally, never
--   compare by range. `status in ('נפתח','בעבודה')`, never `status < 'הושלם'`.
--   The enum order exists for display, not for logic.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ACL — DECLARED AND ASSERTED, PER THE RULE 0071 ESTABLISHED
-- ═══════════════════════════════════════════════════════════════════════════
-- ★ "A migration that creates an ACL-bearing object must declare that object's
--   privileges explicitly AND assert them before it writes its ledger row.
--   Creation is not a neutral act in this schema." (0071:153-157)
--
-- This file creates FOUR such objects — one enum, two tables, and the indexes
-- and policies on them — so it declares and asserts.
--
-- The mechanism it must defend against is pg_default_acl: schema public
-- carried ALTER DEFAULT PRIVILEGES entries handing arwdDxtm to anon AND to
-- authenticated on every newly created object. That is what killed 0071's
-- first run. 0069 part A removed the entries for defaclrole=postgres (the role
-- every migration in this repo runs as), so a table created today is born with
-- nothing for anon and INSERT/SELECT/UPDATE/DELETE for authenticated — the
-- latter deliberately, per 0069's reasoning that a forgotten GRANT renders as
-- a blank screen while a forgotten REVOKE is caught by RLS.
--
-- So this file does not TRUST that. It states the end state and proves it.
--
-- THE SHAPE OF THE MONEY RESTRICTION — measured, not assumed. The pattern that
-- actually holds in this database (verified 2026-09-08 against shows and
-- productions) is: table-level SELECT REVOKED, then SELECT granted column by
-- column for the columns that are not money.
--
--     has_table_privilege('authenticated','shows','SELECT')          = false
--     has_column_privilege('authenticated','shows','name','SELECT')  = true
--     has_column_privilege('authenticated','shows','default_rate',…) = false
--
-- 0031 tried the other shape on production_addons — `revoke select (col)` while
-- the table grant stood — and 0068 later had to revoke the table outright.
-- A column revoke does not override a table-level grant; only the absence of
-- the table grant makes the column grants load-bearing. This file therefore
-- enumerates. Enumerating is cheap here and exact: the columns are being
-- created three statements above, so there is no list that can go stale the
-- way 0070's 43-column list could.
--
-- WRITES: none, for anyone. There is no INSERT/UPDATE/DELETE policy and no
-- write grant. Every mutation is server-only, through the service role after
-- an explicit permission check — the same rule production_addons (0031) and
-- client_review_links (0029) follow, and the reason is the same: these rows
-- carry money, and a session that can write them is a session that can bill.
--
-- READS: can_view_stages(). The whole team sees the work; only the money
-- columns are compartmentalised, and those are read through the service role
-- after an app-level can_view_money check — exactly how shows.default_rate,
-- productions.price_override (0070) and production_addons.unit_price behave.

do $mig$
declare
  v_cols_pub int;
  v_cols_sup int;
begin

  -- ---------------------------------------------------------------------
  -- 0. re-run guard. Loud, never idempotent-by-silence.
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0074') then
    raise exception '0074 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. ordering guard. 0069 is what removed the pg_default_acl entries for
  --    postgres; without it every object below is born readable by anon and
  --    the canary at step 7 would (correctly) refuse to let this commit.
  --    Named as a requirement rather than left to the canary so the failure
  --    says what to do instead of only what went wrong.
  -- ---------------------------------------------------------------------
  if not exists (select 1 from public.schema_ledger where version = '0069') then
    raise exception '0069 טרם הוחלה — היא מסירה את ברירות המחדל של pg_default_acl, ובלעדיה כל טבלה כאן נולדת קריאה ל-anon. הרץ אותה קודם';
  end if;

  -- ---------------------------------------------------------------------
  -- 2. the status enum. See the header: 'בוטל' is LAST and must never be
  --    reached by a range comparison.
  -- ---------------------------------------------------------------------
  if not exists (select 1 from pg_type where typname = 'misc_production_status') then
    create type public.misc_production_status as enum ('נפתח', 'בעבודה', 'הושלם', 'בוטל');
  else
    raise notice '0074: הטיפוס misc_production_status כבר קיים';
  end if;

  -- ---------------------------------------------------------------------
  -- 3. misc_productions.
  --
  --    work_date is NOT NULL, and that is a decision rather than an
  --    oversight: 0064 made jobs.date the work date, every ageing number
  --    downstream (due_date, the radar) derives from it, and the projects
  --    screen rejects a dateless row outright (projects/page.tsx:36-65 —
  --    "a production with no recording date has not been recorded"). A row
  --    that cannot answer "when was this done" cannot be billed honestly.
  --
  --    client_id is NOT NULL for the same reason it is checked on
  --    productions (0002:162): a billable row with no client is a charge
  --    addressed to nobody. Here it is unconditional — misc work is always
  --    for a client, there is no 'internal' variant.
  --
  --    job_id is nullable and is the ONLY link to the billing chain. It is
  --    written when the work order is created (step 2), which means a row
  --    with job_id null is a job that was recorded but not yet billed — a
  --    legitimate, visible state, and the retry point if the queue insert
  --    fails.
  --
  --    No cancelled_at column: `productions` carries one only because
  --    merged_into is a SECOND soft-delete mechanism there and the two are
  --    disjoint (0064/0065/0066 argue this at length). Nothing here merges,
  --    so a single status plus a reason is the whole truth.
  -- ---------------------------------------------------------------------
  create table if not exists public.misc_productions (
    id               uuid primary key default gen_random_uuid(),
    client_id        uuid not null references public.clients(id),
    name             text not null,
    work_date        date not null,
    client_order_ref text,
    amount           numeric not null,
    description      text,
    status           public.misc_production_status not null default 'נפתח',
    cancel_reason    text,
    job_id           uuid references public.jobs(id),
    created_at       timestamptz not null default now(),
    created_by       uuid references public.profiles(id),
    updated_at       timestamptz not null default now(),
    updated_by       uuid references public.profiles(id),
    constraint misc_productions_amount_nonneg check (amount >= 0),
    constraint misc_productions_name_nonempty check (btrim(name) <> '')
  );

  -- ---------------------------------------------------------------------
  -- 4. misc_production_suppliers.
  --
  --    ON DELETE CASCADE: a supplier line has no meaning without its job.
  --    This is the one place in the schema where a cascade is right — the
  --    child is a component of the parent, not a record of its own.
  --
  --    paid_at IS the payment status. A separate boolean would be a second
  --    source for the same fact and they would disagree the first time one
  --    was written without the other; NULL means unpaid, and it carries the
  --    date for free.
  --
  --    price is nullable: a supplier can be recorded before the fee is
  --    agreed. due_date is nullable for the same reason — but the reminder
  --    index below only sees rows that carry one, which is correct: a
  --    payment with no date cannot be due.
  -- ---------------------------------------------------------------------
  create table if not exists public.misc_production_suppliers (
    id                  uuid primary key default gen_random_uuid(),
    misc_production_id  uuid not null references public.misc_productions(id) on delete cascade,
    supplier_name       text not null,
    service             text,
    price               numeric,
    due_date            date,
    paid_at             timestamptz,
    created_at          timestamptz not null default now(),
    created_by          uuid references public.profiles(id),
    constraint misc_suppliers_price_nonneg check (price is null or price >= 0),
    constraint misc_suppliers_name_nonempty check (btrim(supplier_name) <> '')
  );

  -- ---------------------------------------------------------------------
  -- 5. indexes.
  --    The last one is the reason suppliers are a table at all — see the
  --    header. Partial on `paid_at is null` because a paid line is never
  --    due, so it has no business in the index a reminder scans.
  -- ---------------------------------------------------------------------
  create index if not exists misc_productions_client_idx
    on public.misc_productions (client_id);
  create index if not exists misc_productions_work_date_idx
    on public.misc_productions (work_date);
  create index if not exists misc_productions_status_idx
    on public.misc_productions (status);
  create index if not exists misc_suppliers_production_idx
    on public.misc_production_suppliers (misc_production_id);
  create index if not exists misc_suppliers_due_idx
    on public.misc_production_suppliers (due_date) where paid_at is null;

  -- ---------------------------------------------------------------------
  -- 6. RLS and ACL. See the header for the shape and why it is this shape.
  -- ---------------------------------------------------------------------
  alter table public.misc_productions           enable row level security;
  alter table public.misc_production_suppliers  enable row level security;

  drop policy if exists misc_productions_select on public.misc_productions;
  create policy misc_productions_select on public.misc_productions
    for select using (public.can_view_stages());

  drop policy if exists misc_production_suppliers_select on public.misc_production_suppliers;
  create policy misc_production_suppliers_select on public.misc_production_suppliers
    for select using (public.can_view_stages());

  -- Everything off first, for every role that is not service_role. `public`
  -- is included even though the diagnosis in 0071 found named grants rather
  -- than PUBLIC: revoking a shape we did not find costs nothing and removes
  -- the need to have been right.
  revoke all privileges on public.misc_productions          from public, anon, authenticated;
  revoke all privileges on public.misc_production_suppliers from public, anon, authenticated;

  -- Then SELECT back, column by column, everything that is not money.
  -- `amount` and `price` are absent BY CONSTRUCTION, not by a later revoke —
  -- which is what makes them actually unreadable (see the header).
  grant select (
    id, client_id, name, work_date, client_order_ref, description,
    status, cancel_reason, job_id, created_at, created_by, updated_at, updated_by
  ) on public.misc_productions to authenticated;

  grant select (
    id, misc_production_id, supplier_name, service, due_date, paid_at,
    created_at, created_by
  ) on public.misc_production_suppliers to authenticated;

  -- service_role is left exactly as the platform sets it, like every other
  -- table in this schema — it is the trusted role by construction, and
  -- singling these two out would be a local exception with no rule behind it.

  -- ---------------------------------------------------------------------
  -- 7. THE CANARY. Inside the same transaction, before the ledger row.
  --    Both directions are checked, because this schema has been burned by
  --    each of them: 0071's first run died because anon held a privilege
  --    nobody granted, and 0055 had to add a grant it had forgotten after a
  --    show card rendered blank. An over-broad revoke and an over-broad
  --    grant are both failures, and neither announces itself on a screen.
  -- ---------------------------------------------------------------------

  -- 7a. anon holds NOTHING. The check that caught pg_default_acl.
  if has_table_privilege('anon', 'public.misc_productions', 'SELECT')
     or has_table_privilege('anon', 'public.misc_productions', 'INSERT')
     or has_table_privilege('anon', 'public.misc_productions', 'UPDATE')
     or has_table_privilege('anon', 'public.misc_productions', 'DELETE')
     or has_table_privilege('anon', 'public.misc_production_suppliers', 'SELECT')
     or has_table_privilege('anon', 'public.misc_production_suppliers', 'INSERT')
     or has_table_privilege('anon', 'public.misc_production_suppliers', 'UPDATE')
     or has_table_privilege('anon', 'public.misc_production_suppliers', 'DELETE') then
    raise exception '0074 canary: ל-anon יש הרשאה על אחת הטבלאות החדשות — ה-revoke בשלב 6 לא תפס. בדוק pg_default_acl (0069 חלק א׳)';
  end if;

  -- column level too: a table-level `false` with a column-level grant to anon
  -- would still leak, and that is exactly the asymmetry 0068 measured.
  if has_column_privilege('anon', 'public.misc_productions', 'name', 'SELECT')
     or has_column_privilege('anon', 'public.misc_productions', 'amount', 'SELECT')
     or has_column_privilege('anon', 'public.misc_production_suppliers', 'supplier_name', 'SELECT')
     or has_column_privilege('anon', 'public.misc_production_suppliers', 'price', 'SELECT') then
    raise exception '0074 canary: ל-anon יש הרשאה עמודתית על הטבלאות החדשות';
  end if;

  -- 7b. the money columns are NOT readable by authenticated.
  if has_column_privilege('authenticated', 'public.misc_productions', 'amount', 'SELECT') then
    raise exception '0074 canary: authenticated מחזיק SELECT על misc_productions.amount — הכסף אינו מקומפרטמנט. ודא שה-revoke ברמת הטבלה קדם לגרנטים העמודתיים';
  end if;
  if has_column_privilege('authenticated', 'public.misc_production_suppliers', 'price', 'SELECT') then
    raise exception '0074 canary: authenticated מחזיק SELECT על misc_production_suppliers.price — הכסף אינו מקומפרטמנט';
  end if;

  -- 7c. and the OTHER direction — the columns that must be readable are.
  --     This is the 0055 failure: a forgotten grant does not announce
  --     itself, it renders as an empty screen on somebody's phone.
  if not has_column_privilege('authenticated', 'public.misc_productions', 'id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'client_id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'name', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'work_date', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'status', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'client_order_ref', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'description', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_productions', 'job_id', 'SELECT') then
    raise exception '0074 canary: עמודות לא-כספיות של misc_productions אינן קריאות ל-authenticated — המסך יירנדר ריק';
  end if;
  if not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'misc_production_id', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'supplier_name', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'service', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'due_date', 'SELECT')
     or not has_column_privilege('authenticated', 'public.misc_production_suppliers', 'paid_at', 'SELECT') then
    raise exception '0074 canary: עמודות לא-כספיות של misc_production_suppliers אינן קריאות ל-authenticated';
  end if;

  -- 7d. no writes from a session, on either table.
  if has_table_privilege('authenticated', 'public.misc_productions', 'INSERT')
     or has_table_privilege('authenticated', 'public.misc_productions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.misc_productions', 'DELETE')
     or has_table_privilege('authenticated', 'public.misc_production_suppliers', 'INSERT')
     or has_table_privilege('authenticated', 'public.misc_production_suppliers', 'UPDATE')
     or has_table_privilege('authenticated', 'public.misc_production_suppliers', 'DELETE') then
    raise exception '0074 canary: ל-authenticated נשארה הרשאת כתיבה — כל כתיבה כאן היא server-only דרך service role';
  end if;

  -- 7e. RLS is ON and the read policy exists. Without RLS the column grants
  --     above would hand every authenticated user every row.
  if not exists (
    select 1 from pg_class where oid = 'public.misc_productions'::regclass and relrowsecurity
  ) or not exists (
    select 1 from pg_class where oid = 'public.misc_production_suppliers'::regclass and relrowsecurity
  ) then
    raise exception '0074 canary: RLS אינו מופעל על אחת הטבלאות החדשות';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'misc_productions'
      and policyname = 'misc_productions_select'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'misc_production_suppliers'
      and policyname = 'misc_production_suppliers_select'
  ) then
    raise exception '0074 canary: policy ה-SELECT חסר על אחת הטבלאות החדשות';
  end if;

  -- 7f. structural proof the tables are what this file says they are.
  select count(*) into v_cols_pub
  from information_schema.columns
  where table_schema = 'public' and table_name = 'misc_productions';
  if v_cols_pub <> 14 then
    raise exception '0074: misc_productions נוצרה עם % עמודות במקום 14', v_cols_pub;
  end if;

  select count(*) into v_cols_sup
  from information_schema.columns
  where table_schema = 'public' and table_name = 'misc_production_suppliers';
  if v_cols_sup <> 9 then
    raise exception '0074: misc_production_suppliers נוצרה עם % עמודות במקום 9', v_cols_sup;
  end if;

  -- both tables are born empty — nothing writes them yet
  if exists (select 1 from public.misc_productions)
     or exists (select 1 from public.misc_production_suppliers) then
    raise exception '0074: הטבלאות אינן ריקות לפני שהמיגרציה רצה — עצור וברר';
  end if;

  -- ---------------------------------------------------------------------
  -- 8. the ledger, inside the same block — a schema change that is not
  --    recorded is a schema change nobody can find later (0052).
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0074', now(), 'bnaya',
          'רדיו ושונות — סכימה בלבד, אפס שינוי התנהגות: שום קוד עדיין לא קורא את הטבלאות, אין backfill ואף שורה קיימת לא נגעה. שתי טבלאות (misc_productions, misc_production_suppliers) וטיפוס misc_production_status. למה טבלה נפרדת ולא kind=misc ב-productions, וזו ההכרעה הנושאת: productions בנויה סביב פרק פודקאסט בשכבת ה-DB ולא רק ב-UI, וארבעה מנגנונים היו צריכים ללמוד חריג — create_default_stages מתעלמת מ-kind לחלוטין וזורעת 3-5 שלבים על כל שורה חדשה; guard_production_composition דורשת has_episode או reels_count>0 ולכן השלבים אינם ניתנים להימנעות אלא חובה; ensure_job_for_production (0060 דרך 0061, 0064, 0067) נפתחת ב-if prod.kind <> client then return null ולכן שורת misc לא הייתה מקבלת job כלל — בדיוק מה שהפיצ׳ר קיים כדי ליצור; ו-checkEligibility (enqueue.ts:232) מסרבת באותו אופן שכבה אחת מעל. בנוסף 32 קבצים קוראים productions, ו-derive_production_status הייתה מקדמת אוטומטית עבודת רדיו דרך בהקלטה/בעריכה ברגע שמישהו נוגע באחד השלבים המדומים. טבלה נפרדת עולה join אחד במסכי הכסף בהמשך; ללמד את productions להיות שני דברים עולה חריג בארבעה מנגנונים שקיימים כדי למנוע בדיוק את הסחף הזה. למה ספקים בטבלה ולא JSONB: שלושת השדות שבאפיון (שם, שירות, מחיר) היו יושבים ב-JSONB היטב, ומה שמכריע הוא השדה שהאפיון מרמז עליו ולא נוקב — תאריך תשלום ותזכורות שנגזרות ממנו. תזכורת שואלת אילו תשלומים מגיעים עד תאריך X על פני כל העבודות, כלומר פרדיקט אחד על כל השורות: כטבלה זה due_date <= $1 and paid_at is null מול אינדקס חלקי, כ-JSONB זה jsonb_array_elements על כל השורות בלי אפשרות לאינדקס. paid_at הוא סטטוס התשלום עצמו ולא בוליאני נפרד, כי שני מקורות לאותה עובדה סותרים זה את זה בפעם הראשונה שאחד נכתב בלי השני. אין קישור למודול הספקים של מורנינג: הוא קיים (POST /suppliers/search מחזיר 22) אבל כל 22 נושאים emails ריק, ולכן ספק מקושר וספק בטקסט חופשי חסרי יכולת שליחה באותה מידה — הקישור הוא החלטה מאוחרת ולא תנאי מוקדם. הטיפוס misc_production_status מסודר נפתח, בעבודה, הושלם, ובוטל אחרון — וזו אותה מלכודת ש-0060, 0061 ו-0062 מזהירות ממנה בתורן: מכיוון שבוטל ממוין אחרי כל מצב עבודה, כל בדיקה מסוג status >= הושלם גורפת שורות מבוטלות פנימה. הכלל לכל קורא של העמודה: לנקוב במצבים בשמם, לעולם לא בטווח; סדר ה-enum קיים לתצוגה, לא ללוגיקה. work_date הוא NOT NULL בהחלטה ולא בהשמטה: 0064 הפכה את jobs.date לתאריך העבודה, כל מספר הזדקנות במורד הזרם נגזר ממנו, ומסך מעקב הפרויקטים דוחה שורה חסרת תאריך מכל וכל (projects/page.tsx:36-65) — שורה שאינה יכולה לענות מתי זה נעשה אינה ניתנת לחיוב ביושר. client_id הוא NOT NULL ללא תנאי, בשונה מ-productions שם ה-CHECK מותנה ב-kind (0002:162), כי לעבודת misc אין וריאנט internal. job_id הוא הקישור היחיד לשרשרת החיוב, נכתב כשנוצרת הזמנת העבודה בצעד 2, ושורה עם job_id ריק היא עבודה שנרשמה וטרם חויבה — מצב לגיטימי, נראה, ונקודת הניסיון החוזר אם הכנסת שורת התור נכשלת. אין עמודת cancelled_at: ב-productions היא קיימת רק משום ש-merged_into הוא מנגנון מחיקה רכה שני והשניים זרים זה לזה (0064, 0065 ו-0066 מנמקות זאת באריכות), וכאן דבר אינו ממוזג ולכן סטטוס יחיד עם סיבה הוא כל האמת. ON DELETE CASCADE על שורות הספקים: שורת ספק חסרת משמעות בלי העבודה שלה, והיא רכיב של האב ולא רשומה בפני עצמה. ההרשאות מוצהרות ומאומתות לפי הכלל ש-0071 קבעה — מיגרציה שיוצרת אובייקט נושא-ACL חייבת להצהיר על הרשאותיו במפורש ולאמת אותן לפני שורת הפנקס, כי יצירה אינה פעולה ניטרלית בסכימה הזו. צורת ההגבלה הכספית נמדדה ולא הונחה: הדפוס שמחזיק בפועל במסד (אומת 8.9.26 מול shows ו-productions) הוא שלילת SELECT ברמת הטבלה ואז הענקה עמודה-עמודה לעמודות שאינן כסף — has_table_privilege על shows מחזיר false בעוד has_column_privilege על name מחזיר true ועל default_rate false. 0031 ניסתה את הצורה ההפוכה על production_addons, revoke select על עמודה בזמן שהגרנט ברמת הטבלה עומד, ו-0068 נאלצה מאוחר יותר לשלול את הטבלה כולה: שלילה עמודתית אינה גוברת על גרנט ברמת טבלה, ורק היעדר גרנט הטבלה הופך את הגרנטים העמודתיים לנושאי משקל. amount ו-price נעדרים מרשימות הגרנט בבנייה ולא בשלילה מאוחרת, וזה מה שהופך אותם לבלתי קריאים בפועל. מנייה כאן זולה ומדויקת כי העמודות נוצרות שלוש הצהרות למעלה, ואין רשימה שיכולה להתיישן כפי שרשימת 43 העמודות של 0070 יכולה. אפס הרשאות כתיבה לאף תפקיד מלבד service_role ואין policy ל-INSERT/UPDATE/DELETE: כל שינוי הוא server-only אחרי בדיקת הרשאה מפורשת, אותו כלל של production_addons (0031) ו-client_review_links (0029), ומאותה סיבה — השורות נושאות כסף, ומי שיכול לכתוב אותן יכול לחייב. קריאה היא can_view_stages: כל הצוות רואה את העבודה, ורק עמודות הכסף מקומפרטמנטות ונקראות דרך service role אחרי בדיקת can_view_money באפליקציה, בדיוק כפי ש-shows.default_rate, productions.price_override (0070) ו-production_addons.unit_price מתנהגות. ה-canary בודק את שני הכיוונים כי הסכימה נכוותה מכל אחד מהם: ההרצה הראשונה של 0071 מתה כי anon החזיק הרשאה שאיש לא העניק, ו-0055 נאלצה להוסיף גרנט שנשכח אחרי שכרטיס תוכנית רונדר ריק. שש בדיקות: anon אפס ברמת טבלה וברמת עמודה, amount ו-price אינם קריאים ל-authenticated, העמודות הלא-כספיות כן קריאות, אין הרשאת כתיבה, RLS דלוק ושני ה-policies קיימים, ומבנה הטבלאות הוא 14 ו-9 עמודות. הטבלאות נולדות ריקות ונבדק שהן ריקות. גארד סדר: 0069 נדרשת כי היא זו שהסירה את רשומות pg_default_acl עבור postgres, ובלעדיה כל אובייקט כאן נולד קריא ל-anon. מחוץ להיקף במכוון: הראוט (צעד 2), המסך (צעד 3), הופעה במעקב הפרויקטים (צעד נפרד אחרי שהמסך עובד), תזכורות (אין תשתית שליחה במערכת כלל), וקישור לספקי מורנינג. אפס DELETE, אפס שינוי נתונים, אפס נגיעה בטבלה קיימת.');

  raise notice '0074 הוחלה. שתי טבלאות (% + % עמודות), טיפוס אחד, 5 אינדקסים, RLS על שתיהן. הצעד הבא: database.types.ts, ואז ראוט היצירה.',
               v_cols_pub, v_cols_sup;

end
$mig$;
