-- ============================================================================
-- 0116 — E13-3: a Bunny version is pulled from Google Drive. SCHEMA ONLY.
--
-- Plan: docs/plans/E13-review-bunny.md §0א (owner decisions 16.10), §2.2, §5.
--
-- THE ROUTE (owner 16.10): the technician uploads to Drive ("BIZI PODCLUB"),
-- pastes the link in the drawer, the server checks the file (files.get) and
-- sends Bunny a Fetch Video with a service-account Bearer. No browser upload.
-- That needs the Drive facts on the version row, and one change to the 0114
-- shape CHECK: Fetch Video returns NO guid, so a version exists before its
-- bunny_video_id is known.
--
-- WHAT THIS CHANGES on client_review_versions (25 → 32 columns):
--   drive_file_id       the Drive file the version was pulled from
--   drive_sha256        files.get sha256Checksum, lower-case hex; NULL when
--                       Drive gave none (integrity then falls back to size)
--   drive_size_bytes    files.get size
--   drive_mime_type     files.get mimeType — the ONLY source of is_audio_only
--                       (Bunny reports an mp3 as 1280x720, 16.10)
--   integrity           decision 4, after Bunny finished:
--                         hash_match  video: originalHash = drive_sha256
--                         size_match  audio, or no sha256: /original size = drive_size_bytes
--                         mismatch    either differs — never shown to the client (Q14)
--                         unchecked   the check could not run yet (retried)
--   integrity_at        when `integrity` was last set
--   fetch_requested_at  when the Fetch Video request was sent
--
--   crv_bunny_fields_chk is REPLACED (Q15, owner 16.10):
--     · a 'bunny' row must carry drive_file_id, drive_size_bytes,
--       drive_mime_type and fetch_requested_at — every Bunny version comes
--       from Drive now;
--     · bunny_video_id may be NULL ONLY while bunny_status = 'uploading' and
--       number is NULL ("the fetch was sent, the guid is not known yet").
--       So assign_review_version_number CANNOT number a version before its
--       guid is attached: the update it makes fails this CHECK.
--     · a 'drive' row (the old route and the backfill) carries none of the
--       new columns.
--   crv_drive_source_chk (new): drive_mime_type is video/* or audio/*,
--       is_audio_only = (drive_mime_type is audio/*), drive_sha256 is 64
--       lower-case hex or NULL, integrity and integrity_at are set together,
--       and hash_match needs a drive_sha256.
--   uq_crv_item_drive_sha (Q17, owner 16.10): the same Drive file with the
--       same sha256 cannot be sent twice to the same item. Rows that failed or
--       whose media was deleted do not count, so a retry after a failed fetch
--       is allowed; the same file id with a NEW sha256 (the file was replaced
--       in Drive) is a new version. Without a sha256 there is nothing to
--       compare and the index does not apply.
--
-- Q14 (do not show a version whose integrity check failed) is a READ rule —
-- the client player of E13-6 shows only hash_match / size_match. Nothing here
-- reads it yet; the column and its values are what that rule needs.
--
-- No rows exist that this could break: no code has written a 'bunny' row
-- (the drawer route is E13-4) — the guard refuses to run if one exists,
-- because the new CHECK would reject it. Drive rows (if the backfill already
-- ran) satisfy the drive branch unchanged.
--
-- PERMISSIONS: unchanged and re-asserted — the table stays closed to
-- anon/authenticated (no table or column privilege on the new columns),
-- service_role reads and writes. No function is added.
-- ============================================================================

do $mig$
declare
  v_n   bigint;
  v_bad text;
begin
  -- ═══ 0. guards ═══
  if exists (select 1 from public.schema_ledger where version = '0116') then
    raise exception '0116 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0115') then
    raise exception '0115 טרם הוחלה — הרץ אותה קודם';
  end if;
  select string_agg(column_name, ',') into v_bad
    from information_schema.columns
   where table_schema = 'public' and table_name = 'client_review_versions'
     and column_name in ('drive_file_id', 'drive_sha256', 'drive_size_bytes', 'drive_mime_type',
                         'integrity', 'integrity_at', 'fetch_requested_at');
  if v_bad is not null then
    raise exception '0116: העמודות % כבר קיימות — נוספו מחוץ לפנקס', v_bad;
  end if;
  select count(*) into v_n from public.client_review_versions where source = 'bunny';
  if v_n <> 0 then
    raise exception '0116: יש כבר % גרסאות bunny, ואין להן מקור Drive. הבדיקה החדשה תדחה אותן. עצור וברר לפני ההחלה', v_n;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'crv_bunny_fields_chk'
                    and conrelid = 'public.client_review_versions'::regclass) then
    raise exception '0116: crv_bunny_fields_chk לא נמצאה — הסכימה אינה כפי ש-0114 השאירה';
  end if;

  -- ═══ 1. the Drive columns ═══
  alter table public.client_review_versions
    add column drive_file_id      text,
    add column drive_sha256       text,
    add column drive_size_bytes   bigint check (drive_size_bytes >= 0),
    add column drive_mime_type    text,
    add column integrity          text check (integrity in ('hash_match', 'size_match', 'mismatch', 'unchecked')),
    add column integrity_at       timestamptz,
    add column fetch_requested_at timestamptz;

  -- ═══ 2. the shape CHECK, replaced (Q15) ═══
  alter table public.client_review_versions drop constraint crv_bunny_fields_chk;
  alter table public.client_review_versions
    add constraint crv_bunny_fields_chk check (
      (source = 'bunny'
         and bunny_library_id is not null
         and bunny_status is not null and media_link is null
         and drive_file_id is not null and drive_size_bytes is not null
         and drive_mime_type is not null and fetch_requested_at is not null
         and (bunny_video_id is not null
              or (bunny_status = 'uploading' and number is null)))
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

  alter table public.client_review_versions
    add constraint crv_drive_source_chk check (
      (drive_mime_type is null or lower(drive_mime_type) ~ '^(video|audio)/')
      and (drive_mime_type is null or is_audio_only = (lower(drive_mime_type) like 'audio/%'))
      and (drive_sha256 is null or drive_sha256 ~ '^[0-9a-f]{64}$')
      and ((integrity is null) = (integrity_at is null))
      and (integrity is distinct from 'hash_match' or drive_sha256 is not null)
    );

  -- ═══ 3. Q17: the same file + sha256 once per item ═══
  create unique index uq_crv_item_drive_sha
    on public.client_review_versions (item_id, drive_file_id, drive_sha256)
    where source = 'bunny' and drive_sha256 is not null
      and bunny_status <> 'failed' and media_deleted_at is null;

  comment on column public.client_review_versions.drive_file_id is
    '0116: קובץ ה-Drive שממנו Bunny משך את הגרסה (תיקיית BIZI PODCLUB).';
  comment on column public.client_review_versions.drive_sha256 is
    '0116: sha256Checksum מ-files.get, hex באותיות קטנות. ריק אם Drive לא החזיר — אז אימות השלמות לפי גודל.';
  comment on column public.client_review_versions.drive_size_bytes is
    '0116: size מ-files.get.';
  comment on column public.client_review_versions.drive_mime_type is
    '0116: mimeType מ-files.get. המקור היחיד של is_audio_only (Bunny מדווח על mp3 כ-1280x720).';
  comment on column public.client_review_versions.integrity is
    '0116: אימות שלמות אחרי ש-Bunny סיים (הכרעה 4, 16.10). וידאו: originalHash מול drive_sha256; אודיו: גודל בלבד. mismatch לא מוצג ללקוח (Q14).';
  comment on column public.client_review_versions.fetch_requested_at is
    '0116: מתי נשלחה בקשת Fetch Video ל-Bunny.';
  comment on column public.client_review_versions.original_sha256 is
    '0114/0116: originalHash כפי ש-Bunny מחזיר. באודיו הוא לא תואם למקור (16.10) ואינו הוכחה — מקור האמת לשלמות הוא integrity.';

  -- re-stated, not assumed
  revoke all privileges on public.client_review_versions from public, anon, authenticated;

  -- ═══ 4. CANARY ═══
  if has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT')
     or has_table_privilege('anon', 'public.client_review_versions', 'INSERT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'INSERT')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.client_review_versions', 'DELETE') then
    raise exception '0116 canary: לסשן יש הרשאה על client_review_versions';
  end if;
  select string_agg(c.column_name, ',') into v_bad
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'client_review_versions'
     and (has_column_privilege('anon', 'public.client_review_versions', c.column_name, 'SELECT')
       or has_column_privilege('authenticated', 'public.client_review_versions', c.column_name, 'SELECT'));
  if v_bad is not null then
    raise exception '0116 canary: הרשאה עמודתית לסשן על: %', v_bad;
  end if;
  if not (has_table_privilege('service_role', 'public.client_review_versions', 'SELECT')
          and has_table_privilege('service_role', 'public.client_review_versions', 'INSERT')
          and has_table_privilege('service_role', 'public.client_review_versions', 'UPDATE')) then
    raise exception '0116 canary: ל-service_role אין SELECT/INSERT/UPDATE על client_review_versions';
  end if;
  select count(*) into v_n from pg_policies where schemaname = 'public' and tablename = 'client_review_versions';
  if v_n <> 0 then
    raise exception '0116 canary: נמצאו % policies על client_review_versions', v_n;
  end if;
  select count(*) into v_n from pg_constraint
   where conrelid = 'public.client_review_versions'::regclass and contype = 'c' and convalidated
     and conname in ('crv_bunny_fields_chk', 'crv_drive_source_chk');
  if v_n <> 2 then
    raise exception '0116 canary: בדיקות הצורה אינן במקומן (%/2)', v_n;
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'public' and tablename = 'client_review_versions'
                    and indexname = 'uq_crv_item_drive_sha') then
    raise exception '0116 canary: האינדקס uq_crv_item_drive_sha חסר';
  end if;
  select count(*) into v_n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_review_versions';
  if v_n <> 32 then
    raise exception '0116: client_review_versions נושאת % עמודות במקום 32', v_n;
  end if;

  raise notice '0116 OK — עמודות Drive + integrity על client_review_versions, גרסת bunny בלי guid רק בזמן משיכה, אותו קובץ ו-sha256 פעם אחת לפריט · הרשאות ללא שינוי';

  -- ═══ 5. ledger row, last ═══
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0116', now(), current_user,
    'E13-3, הכרעות בעלים 16.10: מסלול ההעלאה הוא Drive → Bunny fetch. נוספו ל-client_review_versions: drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, integrity (hash_match/size_match/mismatch/unchecked), integrity_at, fetch_requested_at (25 → 32 עמודות). '
    || 'crv_bunny_fields_chk הוחלפה: גרסת bunny חייבת מקור Drive (קובץ, גודל, mime, מועד בקשה); bunny_video_id ריק מותר רק ב-uploading ובלי מספר (Q15) — ולכן אי אפשר למספר גרסה לפני שה-guid ידוע; גרסת drive בלי אף אחת מהעמודות החדשות. '
    || 'crv_drive_source_chk: mime וידאו/אודיו, is_audio_only לפי ה-mime, sha256 כ-hex קטן, integrity ו-integrity_at יחד, hash_match מחייב sha256. '
    || 'uq_crv_item_drive_sha (Q17): אותו קובץ עם אותו sha256 פעם אחת לפריט, לא כולל גרסאות failed או שנמחקו. Q14 (לא להציג mismatch) הוא כלל קריאה ב-E13-6. '
    || 'הרשאות ללא שינוי: הטבלה סגורה ל-anon/authenticated, service_role קורא וכותב.');
end $mig$;
