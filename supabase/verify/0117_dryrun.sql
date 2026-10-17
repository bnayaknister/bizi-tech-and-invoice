-- ============================================================================
-- 0117 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0117_dryrun_tests.sql. הקובץ מריץ את הגוף, מוכיח את
-- ההתנהגות על פריט אמיתי, ומסיים ב-`raise exception` — אפס שינוי נשאר.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
-- Supabase SQL Editor אינו מציג NOTICE — כל הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rep    text := '';
  v_msg    text;
  v_caught int := 0;
  v_item   uuid;
  v_p      uuid;
  v_q      uuid;
  v_sha    text := repeat('c3', 32);
begin
  begin

    -- ════ גוף 0117, מילה במילה ════
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

    -- ════ ההוכחות (רצות אחרי גוף 0117, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    select id into v_item from public.client_review_items order by created_at, id limit 1;
    if v_item is null then
      raise exception 'dryrun: צריך לפחות פריט אחד ב-client_review_items כדי להוכיח';
    end if;
    v_rep := v_rep || E'\n  פריט בדיקה: ' || v_item;

    -- 1. a fetch that got no guid: 'uploading', no number (unchanged from 0116)
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item, 'bunny', 1, 'uploading', 'dryrun0117FILE000001', v_sha, 54500000, 'video/mp4', now() - interval '25 hours')
    returning id into v_p;
    v_rep := v_rep || E'\n  ✓ שורת משיכה בלי guid (uploading, בלי מספר) עדיין נוצרת';

    -- 2. while it is 'uploading', Q17 refuses the same file + sha256
    begin
      insert into public.client_review_versions
        (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
      values (v_item, 'bunny', 1, 'uploading', 'dryrun0117FILE000001', v_sha, 54500000, 'video/mp4', now());
      raise exception 'dryrun: אותו קובץ נשלח פעמיים בזמן שהראשון ב-uploading';
    exception when unique_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ כל עוד הראשונה ב-uploading, אותו קובץ נדחה (Q17)';

    -- 3. THE CHANGE: the cron marks it 'failed' — still without a guid
    update public.client_review_versions set bunny_status = 'failed', bunny_status_at = now() where id = v_p;
    v_rep := v_rep || E'\n  ✓ גרסה בלי guid מסומנת failed (זה מה ש-0116 דחתה)';

    -- 4. …and then the same file can be sent again (Q17 skips failed)
    insert into public.client_review_versions
      (item_id, source, bunny_library_id, bunny_status, drive_file_id, drive_sha256, drive_size_bytes, drive_mime_type, fetch_requested_at)
    values (v_item, 'bunny', 1, 'uploading', 'dryrun0117FILE000001', v_sha, 54500000, 'video/mp4', now())
    returning id into v_q;
    v_rep := v_rep || E'\n  ✓ אחרי failed, אותו קובץ נשלח שוב';

    -- 5. a guid-less row still cannot be numbered — 'failed' or not
    begin
      perform public.assign_review_version_number(v_p);
      raise exception 'dryrun: גרסה failed בלי guid קיבלה מספר';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      perform public.assign_review_version_number(v_q);
      raise exception 'dryrun: גרסה uploading בלי guid קיבלה מספר';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ בלי guid אין מספר, גם ב-failed וגם ב-uploading';

    -- 6. …and cannot move to any other status without a guid
    begin
      update public.client_review_versions set bunny_status = 'processing' where id = v_q;
      raise exception 'dryrun: גרסה בלי guid עברה ל-processing';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      update public.client_review_versions set bunny_status = 'created' where id = v_q;
      raise exception 'dryrun: גרסה בלי guid עברה ל-created';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ בלי guid: לא created ולא processing';

    -- 7. a Drive (backfill-shape) row still cannot carry a Bunny status
    begin
      insert into public.client_review_versions (item_id, source, number, media_link, bunny_status)
      values (v_item, 'drive', 99, 'https://drive.google.com/file/d/x/view', 'failed');
      raise exception 'dryrun: גרסת drive קיבלה bunny_status';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ גרסת drive עדיין בלי סטטוס Bunny';

    -- 8. sessions still refused
    execute 'set local role authenticated';
    begin
      perform bunny_status from public.client_review_versions limit 1;
      raise exception 'dryrun: authenticated קרא את client_review_versions';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';

    if v_caught <> 7 then
      raise exception 'dryrun: נתפסו % דחיות במקום 7', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ authenticated נדחה · סה"כ 7/7 דחיות כצפוי';
    end;
    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0117 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0117 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
