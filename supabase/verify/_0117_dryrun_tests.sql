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
