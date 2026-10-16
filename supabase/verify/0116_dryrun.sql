-- ============================================================================
-- 0116 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0116_dryrun_tests.sql. הקובץ מריץ את הגוף, מוכיח את
-- ההתנהגות על פריטים אמיתיים, ומסיים ב-`raise exception` — אפס שינוי נשאר.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
-- Supabase SQL Editor אינו מציג NOTICE — כל הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rep    text := '';
  v_msg    text;
  v_caught int := 0;
  v_item_a uuid;
  v_item_b uuid;
  v_p      uuid;
  v_q      uuid;
  v_audio  uuid;
  v_num    int;
  v_sha1   text := repeat('a1', 32);
  v_sha2   text := repeat('b2', 32);
begin
  begin
    -- ════ גוף 0116, מילה במילה ════
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

    -- ════ ההוכחות (רצות אחרי גוף 0116, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    select id into v_item_a from public.client_review_items order by created_at, id limit 1;
    select id into v_item_b from public.client_review_items where id <> v_item_a order by created_at, id limit 1;
    if v_item_a is null or v_item_b is null then
      raise exception 'dryrun: צריך לפחות שני פריטים ב-client_review_items כדי להוכיח';
    end if;
    v_rep := v_rep || E'\n  פריטי בדיקה: ' || v_item_a || ' / ' || v_item_b;

    -- 1. a Bunny version must come from Drive
    begin
      insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
      values (v_item_a, 'bunny', 1, gen_random_uuid(), 'created');
      raise exception 'dryrun: גרסת bunny בלי מקור Drive התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ גרסת bunny בלי drive_file_id / גודל / mime / מועד בקשה נדחית';

    -- 2. Q15: the row exists before the guid — 'uploading', no number
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item_a, 'bunny', 1, 'uploading', 'dryrunFILE0000000001', v_sha1, 7135800000, 'video/mp4', now())
    returning id into v_p;
    v_rep := v_rep || E'\n  ✓ שורת משיכה בלי guid (uploading, בלי מספר) נוצרת';

    -- 3. …and cannot be numbered, or move on, while the guid is unknown
    begin
      perform public.assign_review_version_number(v_p);
      raise exception 'dryrun: גרסה בלי guid קיבלה מספר';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      update public.client_review_versions set bunny_status = 'processing' where id = v_p;
      raise exception 'dryrun: גרסה בלי guid עברה ל-processing';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ בלי guid: אין מספר ואין התקדמות סטטוס';

    -- 4. the guid arrives → it can move on and be numbered
    update public.client_review_versions set bunny_video_id = gen_random_uuid(), bunny_status = 'processing' where id = v_p;
    v_num := public.assign_review_version_number(v_p);
    if v_num is null then
      raise exception 'dryrun: גרסה עם guid לא קיבלה מספר';
    end if;
    v_rep := v_rep || E'\n  ✓ אחרי שה-guid נקשר: processing ומספר v' || v_num;

    -- 5. Q17: same file + same sha256 to the same item is refused
    begin
      insert into public.client_review_versions
        (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
      values (v_item_a, 'bunny', 1, 'uploading', 'dryrunFILE0000000001', v_sha1, 7135800000, 'video/mp4', now());
      raise exception 'dryrun: אותו קובץ ואותו sha256 נשלחו פעמיים לאותו פריט';
    exception when unique_violation then v_caught := v_caught + 1;
    end;
    -- …the same file with a NEW sha256 (replaced in Drive) is a new version
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item_a, 'bunny', 1, 'uploading', 'dryrunFILE0000000001', v_sha2, 7135800001, 'video/mp4', now())
    returning id into v_q;
    -- …the same file + sha256 on ANOTHER item is fine
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item_b, 'bunny', 1, 'uploading', 'dryrunFILE0000000001', v_sha1, 7135800000, 'video/mp4', now());
    -- …and after the first one FAILED, a retry of the same file is allowed
    update public.client_review_versions set bunny_status = 'failed' where id = v_p;
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item_a, 'bunny', 1, 'uploading', 'dryrunFILE0000000001', v_sha1, 7135800000, 'video/mp4', now());
    v_rep := v_rep || E'\n  ✓ Q17: אותו קובץ + sha256 לאותו פריט נדחה; sha256 חדש, פריט אחר, וניסיון חוזר אחרי כשל — מתקבלים';

    -- 6. the Drive facts are checked by the database too
    begin
      insert into public.client_review_versions
        (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
      values (v_item_b, 'bunny', 1, 'uploading', 'dryrunFILE0000000002', upper(v_sha2), 1, 'video/mp4', now());
      raise exception 'dryrun: sha256 באותיות גדולות התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      insert into public.client_review_versions
        (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_size_bytes, drive_mime_type, fetch_requested_at)
      values (v_item_b, 'bunny', 1, 'uploading', 'dryrunFILE0000000003', 1, 'application/zip', now());
      raise exception 'dryrun: mime שאינו וידאו/אודיו התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      insert into public.client_review_versions
        (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_size_bytes, drive_mime_type, fetch_requested_at, is_audio_only)
      values (v_item_b, 'bunny', 1, 'uploading', 'dryrunFILE0000000004', 1, 'audio/mpeg', now(), false);
      raise exception 'dryrun: אודיו עם is_audio_only=false התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_size_bytes, drive_mime_type, fetch_requested_at, is_audio_only)
    values (v_item_b, 'bunny', 1, 'uploading', 'dryrunFILE0000000005', 77000000, 'audio/mpeg', now(), true)
    returning id into v_audio;
    v_rep := v_rep || E'\n  ✓ sha256 רק hex קטן, mime רק וידאו/אודיו, is_audio_only תואם ל-mime; mp3 בלי sha256 מתקבל';

    -- 7. integrity: value and time together; hash_match needs a Drive sha256
    begin
      update public.client_review_versions set integrity = 'size_match' where id = v_q;
      raise exception 'dryrun: integrity בלי integrity_at התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      update public.client_review_versions set integrity = 'hash_match', integrity_at = now() where id = v_audio;
      raise exception 'dryrun: hash_match בלי drive_sha256 התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    update public.client_review_versions set integrity = 'size_match', integrity_at = now() where id = v_audio;
    update public.client_review_versions set integrity = 'hash_match', integrity_at = now() where id = v_q;
    v_rep := v_rep || E'\n  ✓ integrity ו-integrity_at יחד; hash_match רק עם sha256 (אודיו: size_match)';

    -- 8. a Drive row carries none of the new columns
    begin
      insert into public.client_review_versions (item_id, number, source, media_link, drive_file_id)
      values (v_item_b, 999, 'drive', 'https://drive.google.com/dryrun', 'dryrunFILE0000000006');
      raise exception 'dryrun: גרסת drive עם drive_file_id התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    insert into public.client_review_versions (item_id, number, source, media_link)
    values (v_item_b, 998, 'drive', 'https://drive.google.com/dryrun');
    v_rep := v_rep || E'\n  ✓ גרסת drive (המסלול הישן וה-backfill) נשארת כמו שהייתה';

    -- 9. 0115 still holds: a fetch in progress blocks the purge date
    insert into public.client_review_approvals (item_id, decision, decided_at, is_backfill, backfill_source)
    values (v_item_b, 'approved', now() - interval '200 days', true, 'dryrun:0116');
    if not (select upload_pending from public.v_review_media_purge_due where item_id = v_item_b)
       or (select purge_after from public.v_review_media_purge_due where item_id = v_item_b) is not null then
      raise exception 'dryrun: משיכה בתהליך (בלי guid) לא חסמה את מועד המחיקה';
    end if;
    v_rep := v_rep || E'\n  ✓ משיכה בתהליך (בלי guid) חוסמת את מועד המחיקה (0115)';

    -- 10. sessions still refused, on the new columns too
    execute 'set local role authenticated';
    begin
      perform drive_sha256 from public.client_review_versions limit 1;
      raise exception 'dryrun: authenticated קרא את drive_sha256';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';

    if v_caught <> 11 then
      raise exception 'dryrun: נתפסו % דחיות במקום 11', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ authenticated נדחה בקריאת העמודות החדשות · סה"כ 11/11 דחיות כצפוי';
    end;
    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0116 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0116 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
