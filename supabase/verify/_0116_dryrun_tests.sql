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
