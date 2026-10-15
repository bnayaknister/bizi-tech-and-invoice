    -- ════ ההוכחות (רצות אחרי גוף 0114, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    select id into v_item_a from public.client_review_items order by created_at, id limit 1;
    select id into v_item_b from public.client_review_items where id <> v_item_a order by created_at, id limit 1;
    if v_item_a is null or v_item_b is null then
      raise exception 'dryrun: צריך לפחות שני פריטים ב-client_review_items כדי להוכיח';
    end if;
    v_rep := v_rep || E'\n  פריטי בדיקה: ' || v_item_a || ' / ' || v_item_b;

    -- 1. drive v1 is born numbered
    insert into public.client_review_versions (item_id, number, source, media_link)
    values (v_item_a, 1, 'drive', 'https://drive.google.com/dryrun') returning id into v_drive;
    v_rep := v_rep || E'\n  ✓ גרסת drive v1 נוצרה';

    -- 2. a drive version without a number is refused
    begin
      insert into public.client_review_versions (item_id, source, media_link)
      values (v_item_a, 'drive', 'https://drive.google.com/x');
      raise exception 'dryrun: drive בלי מספר התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;

    -- 3. bunny versions are born numberless (Q11), numbered on success, idempotently
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
    values (v_item_a, 'bunny', 1, gen_random_uuid(), 'created') returning id into v_bunny1;
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
    values (v_item_a, 'bunny', 1, gen_random_uuid(), 'created') returning id into v_bunny2;
    -- a failed upload stays numberless; the next successful one must NOT skip a number
    v_n1 := public.assign_review_version_number(v_bunny2);
    v_n2 := public.assign_review_version_number(v_bunny2);
    if v_n1 <> 2 or v_n2 <> 2 then
      raise exception 'dryrun: הקצאה צפויה 2 ואידמפוטנטית, התקבל % ואז %', v_n1, v_n2;
    end if;
    if (select number from public.client_review_versions where id = v_bunny1) is not null then
      raise exception 'dryrun: גרסה שלא הוקצתה קיבלה מספר';
    end if;
    v_rep := v_rep || E'\n  ✓ Q11: bunny נולדת בלי מספר; ההקצאה נותנת 2 (בלי פער), וקריאה שנייה מחזירה 2';

    -- 4. ready without the original is refused (§9 🔴)
    begin
      update public.client_review_versions set bunny_status = 'ready' where id = v_bunny2;
      raise exception 'dryrun: ready בלי מקור התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    update public.client_review_versions
       set bunny_status = 'ready', has_original = true, original_sha256 = 'abc'
     where id = v_bunny2;
    v_rep := v_rep || E'\n  ✓ ready רק עם has_original + original_sha256';

    -- 5. bunny version without a video id / backfill bunny are refused
    begin
      insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_status)
      values (v_item_a, 'bunny', 1, 'created');
      raise exception 'dryrun: bunny בלי video id התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status, is_backfill)
      values (v_item_a, 'bunny', 1, gen_random_uuid(), 'created', true);
      raise exception 'dryrun: backfill bunny התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;

    -- 6. pins: numbered per version, 1 then 2; a second version starts at 1
    v_pin1 := (public.create_review_pin(v_bunny2, null, 1000, 'נעץ א', 'client', 'לקוח', null, false)).pin_number;
    v_pin2 := (public.create_review_pin(v_bunny2, null, 2000, 'נעץ ב', 'client', 'לקוח', null, false)).pin_number;
    v_pin3 := (public.create_review_pin(v_drive,  null,  500, 'נעץ ג', 'client', 'לקוח', null, false)).pin_number;
    if v_pin1 <> 1 or v_pin2 <> 2 or v_pin3 <> 1 then
      raise exception 'dryrun: מספור נעצים % % % במקום 1 2 1', v_pin1, v_pin2, v_pin3;
    end if;
    v_rep := v_rep || E'\n  ✓ נעצים ממוספרים פר גרסה (1, 2 ואז 1 בגרסה אחרת)';

    -- 7. a comment whose version belongs to ANOTHER item is refused (composite FK)
    begin
      insert into public.client_review_comments (item_id, version_id, kind, pin_number, time_ms, body, author_kind)
      values (v_item_b, v_bunny2, 'pin', 99, 1, 'x', 'client');
      raise exception 'dryrun: נעץ עם גרסה של פריט אחר התקבל';
    exception when foreign_key_violation then v_caught := v_caught + 1;
    end;
    -- a general comment carrying a time is refused; a pin without a version is refused
    begin
      insert into public.client_review_comments (item_id, kind, time_ms, body, author_kind)
      values (v_item_a, 'general', 5, 'x', 'client');
      raise exception 'dryrun: הערה כללית עם זמן התקבלה';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    begin
      insert into public.client_review_comments (item_id, kind, pin_number, time_ms, body, author_kind)
      values (v_item_a, 'pin', 1, 5, 'x', 'client');
      raise exception 'dryrun: נעץ בלי גרסה התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;

    -- 8. the purge date: last valid approval + 90 days; revoked → no row
    insert into public.client_review_approvals (item_id, version_id, decision, decided_at)
    values (v_item_a, v_bunny2, 'approved', now() - interval '100 days') returning id into v_appr;
    select purge_after into v_purge from public.v_review_media_purge_due where item_id = v_item_a;
    if v_purge is null or v_purge > now() then
      raise exception 'dryrun: מועד מחיקה % — צפוי לפני עכשיו (אושר לפני 100 יום)', v_purge;
    end if;
    update public.client_review_approvals set revoked_at = now(), revoked_reason = 'board_reset:dryrun' where id = v_appr;
    if exists (select 1 from public.v_review_media_purge_due where item_id = v_item_a) then
      raise exception 'dryrun: אישור שבוטל עדיין מייצר מועד מחיקה';
    end if;
    if exists (select 1 from public.v_review_media_purge_due where item_id = v_item_b) then
      raise exception 'dryrun: פריט בלי אישור קיבל מועד מחיקה';
    end if;
    -- a non-backfill approval must name its version
    begin
      insert into public.client_review_approvals (item_id, decision, decided_at)
      values (v_item_a, 'approved', now());
      raise exception 'dryrun: אישור חי בלי גרסה התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ מועד מחיקה = אישור + 90 יום; אישור שבוטל ופריט בלי אישור — אין שורה';

    -- 9. sessions are refused at the table, not just by RLS
    execute 'set local role authenticated';
    begin
      perform 1 from public.client_review_versions limit 1;
      raise exception 'dryrun: authenticated קרא את client_review_versions';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    begin
      perform public.assign_review_version_number(v_bunny1);
      raise exception 'dryrun: authenticated הריץ את assign_review_version_number';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';
    execute 'set local role anon';
    begin
      perform 1 from public.v_review_media_purge_due limit 1;
      raise exception 'dryrun: anon קרא את v_review_media_purge_due';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';
    v_rep := v_rep || E'\n  ✓ authenticated/anon נדחים ב-42501 (טבלה, פונקציה, תצוגה)';

    if v_caught <> 11 then
      raise exception 'dryrun: נתפסו % דחיות במקום 11', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ 11/11 דחיות צפויות נתפסו';
