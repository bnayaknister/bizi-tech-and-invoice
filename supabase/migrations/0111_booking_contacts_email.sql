-- ============================================================================
-- 0111 — E22: מייל (אופציונלי) למורשים לקבוע הקלטות.
--
-- ═══ למה במבנה הקיים ═══
-- "מורשים לקבוע הקלטות" כבר קיימים: booking_contacts (0103) — לפי תוכנית
-- (show_id), עם שם (name) וטלפון (wa_id, E.164 בלי פלוס), אינדקס ייחודי על
-- (show_id, wa_id). המבנה עונה על הכרעות הבעלים 11.10/12.10 כמו שהוא —
-- לתוכנית עם לקוח ובלי לקוח כאחד — וחסר לו רק המייל. לכן עמודה, לא טבלה
-- חדשה, ואין מה "להעביר": 15 השורות הקיימות נשארות במקומן, עם email ריק.
--
-- ═══ למה המייל ═══
-- B26: הזימון ליומן גוגל נשלח גם למיילים של המורשים בתוכנית (בנוסף למיילים
-- של כרטיס הלקוח במורנינג, אם יש לקוח). בתוכנית פנימית — בלי לקוח — אלה
-- המיילים היחידים.
--
-- ═══ הערך השמור קנוני ═══
-- כמו wa_id ב-0103: מנורמל באפליקציה בדרך פנימה (lib/booking/bookers.ts —
-- trim + lowercase), וה-CHECK מוודא שמה שנשמר כבר קנוני ושצורתו בסיסית
-- תקינה. ריק = NULL, לא מחרוזת ריקה.
--
-- ═══ הרשאות ═══
-- booking_contacts נעולה מכל סשן מאז 0103 (revoke all, RLS בלי policy) —
-- עמודה חדשה יורשת את זה. ה-canary מוודא שהמייל לא קריא מסשן.
--
-- אפס backfill, אפס DELETE, אפס שינוי בשורה קיימת.
-- אחרי ההחלה: gen types (שלב של הבעלים) — הקוד שקורא את העמודה ממתין לזה.
-- סדר: supabase/verify/0111_dryrun.sql → הקובץ הזה → supabase/verify/0111_verify.sql
-- ============================================================================

do $mig$
declare
  v_rows_before int;
  v_rows_after int;
begin
  -- >>> BODY
  if exists (select 1 from public.schema_ledger where version = '0111') then
    raise exception '0111 כבר הוחלה';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0110') then
    raise exception '0110 טרם הוחלה — הרץ אותה קודם';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'booking_contacts' and column_name = 'email') then
    raise exception '0111: booking_contacts.email כבר קיימת — נוספה מחוץ לפנקס';
  end if;

  select count(*) into v_rows_before from public.booking_contacts;

  alter table public.booking_contacts add column email text;

  alter table public.booking_contacts
    add constraint booking_contacts_email_chk
    check (
      email is null
      or (
        email = lower(btrim(email))
        and char_length(email) between 3 and 254
        and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    );

  comment on column public.booking_contacts.email is
    'E22: מייל של המורשה לקבוע הקלטות — אופציונלי. מקבל זימון ליומן גוגל להקלטה שנקבעה (B26). trim+lowercase, NULL כשאין.';

  -- ── canary ────────────────────────────────────────────────────────────────
  select count(*) into v_rows_after from public.booking_contacts;
  if v_rows_after <> v_rows_before then
    raise exception '0111 canary: nrows before=% after=%', v_rows_before, v_rows_after;
  end if;
  if exists (select 1 from public.booking_contacts where email is not null) then
    raise exception '0111 canary: עמודה חדשה אינה ריקה';
  end if;
  if has_column_privilege('anon', 'public.booking_contacts', 'email', 'SELECT')
     or has_column_privilege('authenticated', 'public.booking_contacts', 'email', 'SELECT') then
    raise exception '0111 canary: booking_contacts.email קריא מסשן — 0103 נעלה את הטבלה';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'booking_contacts') then
    raise exception '0111 canary: נמצאה policy על booking_contacts';
  end if;

  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0111', now(), 'bnaya',
    'E22: booking_contacts.email — מייל אופציונלי למורשה לקבוע הקלטות, לזימון ליומן גוגל (B26). '
    'עמודה במבנה הקיים (0103: show_id, name, wa_id), לא טבלה חדשה; ' || v_rows_before || ' שורות קיימות נשארו כמו שהן עם email ריק. '
    'CHECK: NULL, או trim+lowercase בצורה בסיסית תקינה, 3-254 תווים. נעולה מסשן כמו הטבלה. אפס backfill, אפס DELETE.');
  -- <<< BODY

  raise notice '✅ 0111: booking_contacts.email נוספה. nrows=%', v_rows_before;
end $mig$;
