-- ============================================================================
-- 0112 — Q10: ארכוב הפקות מטור "הופץ" בקנבן.
--
-- ═══ מה זה, ומה זה לא ═══
-- ארכוב של **הקנבן**, לא של המערכת (הכרעות הבעלים 18.9 ו-13.10). שתי עמודות
-- חדשות ב-productions — board_archived_at, board_archived_by — שרק הקנבן
-- (ProductionsClient.tsx) קורא כדי להסתיר כרטיס כשהמתג "הצג מאורכבים" כבוי.
-- הן **אינן** משנות status, כסף, merged_into, jobs.dismissed, ואינן מייצרות
-- או מונעות מסמך. הסנכרון, החיפוש, הרדאר וכל צרכן של status /
-- hasBeenPerformed אינם מסננים לפיהן — וזה מכוון: מנגנון "הסתרה" שזולג
-- למסכים אחרים הוא בדיוק הדפוס של Q9 ו-0087.
--
-- ═══ שלוש הגנות במסד, כדי שאף מסלול לא יפספס ═══
--   1. **ביטול ארכוב אוטומטי (הכרעה 3).** טריגר BEFORE UPDATE: כל שינוי status
--      של הפקה מאורכבת מנקה את שתי העמודות ורושם אירוע
--      `production_board_unarchived` (מי — auth.uid(), מתי, מאיזה סטטוס לאיזה).
--      טריגר ולא קוד, כי status נכתב מכמה מסלולים: גרירה בקנבן ו"קפיצה חריגה"
--      במגירה (api/productions/[id]), תגובה מקישור הביקורת (applyResponse ב-
--      links.ts — אישור או בקשת תיקון), ביטול (api/productions/[id]/cancel),
--      טריגר השלבים (0039, אם כי הוא לא נוגע במצבים ידניים), ו-SQL ידני.
--      טריגר תופס את כולם, כולל מסלול שעוד לא נכתב.
--      שינוי status **אף פעם** אינו משאיר הפקה מאורכבת — גם לא כשמישהו מנסה
--      לארכב ולהזיז באותו UPDATE.
--   2. **רק השרת מארכב (הכרעה 5).** ל-authenticated יש UPDATE ברמת טבלה על
--      productions (0070), ולכן שלילה עמודתית לא הייתה עובדת (הרשאות מצטברות —
--      הלקח של 0032/0070). במקום זה הטריגר דוחה כל שינוי של העמודות מסשן
--      מחובר (auth.uid() קיים) — אותה צורה כמו guard_studio_admin_flag (0107).
--      הארכוב והשליפה נעשים בראוט שבודק studio_admin ואז כותב ב-service role.
--      הפקה חדשה אינה נולדת מאורכבת.
--   3. **CHECK:** הפקה מאורכבת היא תמיד ב-"הופץ", ו-board_archived_by בלי
--      board_archived_at אינו מצב.
--
-- ═══ הרשאות ═══
-- productions נושאת רשימת היתר עמודתית ל-SELECT (0070 — אין SELECT ברמת טבלה),
-- ולכן עמודה חדשה **אינה קריאה** לסשן בלי גרנט מפורש. הקנבן קורא אותה דרך
-- קליינט המשתמש, ולכן: grant select לשתי העמודות ל-authenticated. anon — כלום.
--
-- אפס backfill, אפס DELETE, אפס שינוי בשורה קיימת (שתי העמודות נולדות ריקות).
-- אחרי ההחלה: gen types (שלב של הבעלים) — הקוד שקורא את העמודות ממתין לזה.
-- סדר: supabase/verify/0112_dryrun.sql → הקובץ הזה → supabase/verify/0112_verify.sql
-- ============================================================================

do $mig$
declare
  v_rows_before int;
  v_rows_after int;
begin
  -- >>> BODY
  if exists (select 1 from public.schema_ledger where version = '0112') then
    raise exception '0112 כבר הוחלה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0111') then
    raise exception '0111 טרם הוחלה — הרץ אותה קודם';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'productions'
                and column_name in ('board_archived_at', 'board_archived_by')) then
    raise exception '0112: עמודות הארכוב כבר קיימות ב-productions — נוספו מחוץ לפנקס';
  end if;

  select count(*) into v_rows_before from public.productions;

  alter table public.productions
    add column board_archived_at timestamptz,
    add column board_archived_by uuid references public.profiles(id) on delete set null;

  alter table public.productions
    add constraint productions_board_archive_status_chk
    check (board_archived_at is null or status = 'הופץ');
  alter table public.productions
    add constraint productions_board_archive_by_chk
    check (board_archived_by is null or board_archived_at is not null);

  comment on column public.productions.board_archived_at is
    'Q10: מתי ההפקה הוסתרה מטור "הופץ" בקנבן. תצוגה בלבד — אינה משנה status, כסף או מסמכים, ושום מסך מלבד הקנבן אינו מסנן לפיה. מתנקה אוטומטית בכל שינוי status (trg_board_archive).';
  comment on column public.productions.board_archived_by is
    'Q10: מי ארכב (studio_admin, דרך השרת). NULL כשלא מאורכבת.';

  create or replace function public.board_archive_guard()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  begin
    if tg_op = 'INSERT' then
      if new.board_archived_at is not null or new.board_archived_by is not null then
        raise exception 'Q10: הפקה חדשה אינה נולדת מאורכבת';
      end if;
      return new;
    end if;

    -- הכרעה 3: כל שינוי status מחזיר את ההפקה לקנבן, מכל מסלול שהוא
    if new.status is distinct from old.status then
      if old.board_archived_at is not null then
        insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
        values ('production', new.id, 'production_board_unarchived', auth.uid(),
                jsonb_build_object('reason',      'status_change',
                                   'from_status', old.status::text,
                                   'to_status',   new.status::text,
                                   'archived_at', old.board_archived_at,
                                   'archived_by', old.board_archived_by,
                                   'fired_by',    'trigger'));
      end if;
      new.board_archived_at := null;
      new.board_archived_by := null;
      return new;
    end if;

    -- הכרעה 5: ארכוב ושליפה — רק השרת (service role / SQL Editor), לא סשן
    if (new.board_archived_at is distinct from old.board_archived_at
        or new.board_archived_by is distinct from old.board_archived_by)
       and auth.uid() is not null then
      raise exception 'Q10: ארכוב בקנבן נעשה רק דרך השרת (studio_admin)';
    end if;
    return new;
  end;
  $fn$;

  revoke all on function public.board_archive_guard() from public, anon, authenticated;

  drop trigger if exists trg_board_archive on public.productions;
  create trigger trg_board_archive
    before insert or update on public.productions
    for each row execute function public.board_archive_guard();

  -- הקנבן קורא את העמודות דרך קליינט המשתמש (0070: רשימת היתר עמודתית)
  grant select (board_archived_at, board_archived_by) on public.productions to authenticated;

  -- ── canary ────────────────────────────────────────────────────────────────
  select count(*) into v_rows_after from public.productions;
  if v_rows_after <> v_rows_before then
    raise exception '0112 canary: nrows before=% after=%', v_rows_before, v_rows_after;
  end if;
  if exists (select 1 from public.productions where board_archived_at is not null or board_archived_by is not null) then
    raise exception '0112 canary: עמודות חדשות אינן ריקות';
  end if;
  if not has_column_privilege('authenticated', 'public.productions', 'board_archived_at', 'SELECT')
     or not has_column_privilege('authenticated', 'public.productions', 'board_archived_by', 'SELECT') then
    raise exception '0112 canary: הקנבן לא יוכל לקרוא את עמודות הארכוב';
  end if;
  if has_column_privilege('anon', 'public.productions', 'board_archived_at', 'SELECT') then
    raise exception '0112 canary: anon קורא את עמודות הארכוב';
  end if;
  if has_table_privilege('authenticated', 'public.productions', 'SELECT') then
    raise exception '0112 canary: SELECT ברמת טבלה חזר ל-authenticated — 0070 נפתחה';
  end if;
  if has_column_privilege('authenticated', 'public.productions', 'price_override', 'SELECT') then
    raise exception '0112 canary: price_override קריאה לסשן — 0070 נפתחה';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_board_archive'
                   and tgrelid = 'public.productions'::regclass and not tgisinternal) then
    raise exception '0112 canary: הטריגר חסר';
  end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0112', now(), 'bnaya',
    'Q10: ארכוב הפקות מטור "הופץ" בקנבן — תצוגה בלבד. productions.board_archived_at/_by (ריקות; ' || v_rows_before || ' שורות לא זזו). '
    'trg_board_archive (BEFORE INSERT/UPDATE, security definer): כל שינוי status מנקה את הארכוב ורושם production_board_unarchived — '
    'תופס את כל מסלולי הסטטוס כולל applyResponse של קישור הביקורת; שינוי העמודות מסשן מחובר נדחה (רק הראוט, studio_admin, ב-service role); '
    'הפקה חדשה אינה נולדת מאורכבת. CHECK: מאורכבת => status=הופץ; by => at. grant select לשתי העמודות ל-authenticated (0070 = רשימת היתר עמודתית). '
    'שום מסך מלבד הקנבן אינו מסנן לפיהן: לא הסנכרון, לא החיפוש, לא הרדאר, לא החיוב. אפס backfill, אפס DELETE.');
  -- <<< BODY

  raise notice '✅ 0112: ארכוב קנבן נוסף. nrows=%', v_rows_before;
end $mig$;
