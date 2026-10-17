-- ============================================================================
-- 0117 — E13-5: a Bunny version without a guid may be marked 'failed'.
--
-- Plan: docs/plans/E13-review-bunny.md §9.2 E13-5 (c)(3). Owner decision 17.10.
--
-- WHY: 0116 let a Bunny row lack bunny_video_id ONLY while it is 'uploading'
-- and unnumbered. Since decision 15 (16.10) the row is written only after
-- Bunny ACCEPTED the Fetch Video, so a row without a guid means Bunny took the
-- request and never listed a video for it. Such a row could never leave
-- 'uploading' — and uq_crv_item_drive_sha (Q17), which skips only 'failed'
-- rows, then refused the same Drive file for that item forever. The hourly
-- cron (E13-5) marks a row 'failed' when it has had no guid for 24 hours.
--
-- WHAT THIS CHANGES — crv_bunny_fields_chk only, the Bunny branch:
--   before: bunny_video_id is not null
--           or (bunny_status = 'uploading' and number is null)
--   after:  bunny_video_id is not null
--           or (bunny_status in ('uploading', 'failed') and number is null)
-- Everything else in the CHECK is copied from 0116 unchanged. A guid-less row
-- still cannot be numbered (assign_review_version_number's update fails this
-- CHECK) and cannot be 'created' / 'processing' / 'playable' / 'ready'.
-- A guid-less 'failed' row drops out of the Q17 index by that index's own
-- predicate (bunny_status <> 'failed'), so the technician can send the same
-- file again. The index itself is not touched.
--
-- No column, no function, no data change. Permissions unchanged and
-- re-asserted. database.types.ts does not carry CHECKs: no gen types needed.
-- Order: supabase/verify/0117_dryrun.sql → this file → supabase/verify/0117_verify.sql
-- ============================================================================

do $mig$
declare
  v_n   bigint;
  v_bad text;
begin
  -- ═══ 0. guards ═══
  if exists (select 1 from public.schema_ledger where version = '0117') then
    raise exception '0117 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0116') then
    raise exception '0116 טרם הוחלה — הרץ אותה קודם';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'crv_bunny_fields_chk'
                    and conrelid = 'public.client_review_versions'::regclass
                    and pg_get_constraintdef(oid) like '%bunny_status = ''uploading''%') then
    raise exception '0117: crv_bunny_fields_chk אינה בצורה ש-0116 השאירה — עצור וברר';
  end if;
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_review_versions';
  if v_n <> 32 then
    raise exception '0117: client_review_versions נושאת % עמודות במקום 32 — הסכימה אינה כפי ש-0116 השאירה', v_n;
  end if;

  -- ═══ 1. the shape CHECK, replaced ═══
  alter table public.client_review_versions drop constraint crv_bunny_fields_chk;
  alter table public.client_review_versions
    add constraint crv_bunny_fields_chk check (
      (source = 'bunny'
         and bunny_library_id is not null
         and bunny_status is not null and media_link is null
         and drive_file_id is not null and drive_size_bytes is not null
         and drive_mime_type is not null and fetch_requested_at is not null
         and (bunny_video_id is not null
              or (bunny_status in ('uploading', 'failed') and number is null)))
      or
      (source = 'drive'
         and media_link is not null and number is not null
         and bunny_library_id is null and bunny_video_id is null
         and bunny_status is null and bunny_status_raw is null and bunny_status_at is null
         and has_original is null and original_sha256 is null
         and media_deleted_at is null and delete_attempts = 0
         and delete_last_error is null and delete_last_attempt_at is null
         and drive_file_id is null and drive_sha256 is null and drive_size_bytes is null
         and drive_mime_type is null and integrity is null and integrity_at is null
         and fetch_requested_at is null)
    );

  -- re-stated, not assumed
  revoke all privileges on public.client_review_versions from public, anon, authenticated;

  -- ═══ 2. CANARY ═══
  if has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT')
     or has_table_privilege('anon', 'public.client_review_versions', 'INSERT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'INSERT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'DELETE') then
    raise exception '0117 canary: לסשן יש הרשאה על client_review_versions';
  end if;
  select string_agg(c.column_name, ',') into v_bad
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_review_versions'
     and (has_column_privilege('anon', 'public.client_review_versions', c.column_name, 'SELECT')
       or has_column_privilege('authenticated', 'public.client_review_versions', c.column_name, 'SELECT'));
  if v_bad is not null then
    raise exception '0117 canary: הרשאה עמודתית לסשן על: %', v_bad;
  end if;
  if not (has_table_privilege('service_role', 'public.client_review_versions', 'SELECT')
          and has_table_privilege('service_role', 'public.client_review_versions', 'INSERT')
          and has_table_privilege('service_role', 'public.client_review_versions', 'UPDATE')) then
    raise exception '0117 canary: ל-service_role אין SELECT/INSERT/UPDATE על client_review_versions';
  end if;
  select count(*) into v_n from pg_constraint
   where conrelid = 'public.client_review_versions'::regclass and contype = 'c' and convalidated
     and conname in ('crv_bunny_fields_chk', 'crv_drive_source_chk', 'crv_ready_needs_original_chk', 'crv_ready_at_chk');
  if v_n <> 4 then
    raise exception '0117 canary: בדיקות הצורה אינן במקומן (%/4)', v_n;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'crv_bunny_fields_chk'
                    and conrelid = 'public.client_review_versions'::regclass
                    and pg_get_constraintdef(oid) like '%''failed''%') then
    raise exception '0117 canary: crv_bunny_fields_chk החדשה לא נמצאה';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'client_review_versions'
                    and indexname = 'uq_crv_item_drive_sha' and indexdef like '%<> ''failed''%') then
    raise exception '0117 canary: uq_crv_item_drive_sha חסר, או שאינו מדלג על failed';
  end if;
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_review_versions';
  if v_n <> 32 then
    raise exception '0117: client_review_versions נושאת % עמודות במקום 32', v_n;
  end if;

  raise notice '0117 OK — גרסת bunny בלי guid מותרת ב-uploading או failed, תמיד בלי מספר · Q17 מדלג על failed · הרשאות ללא שינוי';

  -- ═══ 3. ledger row, last ═══
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0117', now(), current_user,
    'E13-5, הכרעת בעלים 17.10: crv_bunny_fields_chk הוחלפה — גרסת bunny בלי bunny_video_id מותרת ב-uploading או ב-failed (עד עכשיו רק uploading), תמיד בלי מספר. '
    || 'הסיבה: מאז הכרעה 15 (16.10) השורה נכתבת רק אחרי ש-Bunny קיבל את בקשת ה-fetch, ושורה שלא קיבלה guid הייתה נתקעת ב-uploading, ו-uq_crv_item_drive_sha (Q17) חסם שליחה חוזרת של אותו קובץ. '
    || 'הקרון השעתי של E13-5 מסמן failed אחרי 24 שעות בלי guid, והאינדקס מדלג על failed. שאר הבדיקה מועתקת מ-0116 ללא שינוי; גרסה בלי guid עדיין לא מקבלת מספר ולא מתקדמת. '
    || 'אפס עמודות, אפס פונקציות, אפס שינוי נתונים; הרשאות ללא שינוי.');
end $mig$;
