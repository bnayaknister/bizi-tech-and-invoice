    -- ════ ההוכחות (רצות אחרי גוף 0115, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    select id into v_item_a from public.client_review_items order by created_at, id limit 1;
    select id into v_item_b from public.client_review_items where id <> v_item_a order by created_at, id limit 1;
    if v_item_a is null or v_item_b is null then
      raise exception 'dryrun: צריך לפחות שני פריטים ב-client_review_items כדי להוכיח';
    end if;
    v_rep := v_rep || E'\n  פריטי בדיקה: ' || v_item_a || ' / ' || v_item_b;

    -- 1. ready_at belongs to the trigger
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status, ready_at)
    values (v_item_a, 'bunny', 1, gen_random_uuid(), 'created', now() - interval '1 year') returning id into v_v1;
    if (select ready_at from public.client_review_versions where id = v_v1) is not null then
      raise exception 'dryrun: ready_at שהועבר בהכנסה נשמר — הטריגר לא דרס';
    end if;
    perform public.assign_review_version_number(v_v1);
    update public.client_review_versions
       set bunny_status = 'ready', has_original = true, original_sha256 = 'h'
     where id = v_v1;
    select ready_at into v_ready1 from public.client_review_versions where id = v_v1;
    if v_ready1 is null then
      raise exception 'dryrun: מעבר ל-ready לא קבע ready_at';
    end if;
    update public.client_review_versions set ready_at = now() + interval '5 years', bunny_status_at = now() where id = v_v1;
    if (select ready_at from public.client_review_versions where id = v_v1) <> v_ready1 then
      raise exception 'dryrun: ready_at זז אחרי שנקבע';
    end if;
    v_rep := v_rep || E'\n  ✓ ready_at: נדרס בהכנסה, נקבע במעבר ל-ready, לא זז אחר כך';

    -- 2. the trigger fires for the service role too (no EXECUTE needed at fire time)
    execute 'set local role service_role';
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status, has_original, original_sha256)
    values (v_item_b, 'bunny', 1, gen_random_uuid(), 'ready', true, 'h') returning id into v_v2;
    execute 'reset role';
    perform public.assign_review_version_number(v_v2);
    if (select ready_at from public.client_review_versions where id = v_v2) is null then
      raise exception 'dryrun: הטריגר לא רץ עבור service_role';
    end if;
    v_rep := v_rep || E'\n  ✓ הטריגר רץ גם כשהכותב הוא service_role';

    -- 3. the date: approval 100 days ago, latest version ready NOW → ready + 90
    insert into public.client_review_approvals (item_id, version_id, decision, decided_at)
    values (v_item_a, v_v1, 'approved', now() - interval '100 days');
    select purge_after, latest_version_id, upload_pending into v_purge, v_latest, v_pending
      from public.v_review_media_purge_due where item_id = v_item_a;
    if v_purge is distinct from v_ready1 + interval '90 days' or v_latest <> v_v1 or v_pending then
      raise exception 'dryrun: מועד מחיקה % (צפוי ready+90 = %), latest %, pending %', v_purge, v_ready1 + interval '90 days', v_latest, v_pending;
    end if;
    v_rep := v_rep || E'\n  ✓ אישור לפני 100 יום + גרסה שהגיעה ל-ready עכשיו → מועד = ready + 90 (לא מחיקה מיידית)';

    -- 4. a newer numbered version, not ready yet → no date
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
    values (v_item_a, 'bunny', 1, gen_random_uuid(), 'processing') returning id into v_v3;
    perform public.assign_review_version_number(v_v3);
    if (select purge_after from public.v_review_media_purge_due where item_id = v_item_a) is not null then
      raise exception 'dryrun: גרסה אחרונה שעוד לא ready קיבלה מועד מחיקה';
    end if;
    v_rep := v_rep || E'\n  ✓ גרסה אחרונה שעוד לא ready → אין מועד';

    -- 5. it reaches ready → the date follows the NEW ready moment
    update public.client_review_versions
       set bunny_status = 'ready', has_original = true, original_sha256 = 'h'
     where id = v_v3;
    if (select purge_after from public.v_review_media_purge_due where item_id = v_item_a)
       is distinct from (select ready_at from public.client_review_versions where id = v_v3) + interval '90 days' then
      raise exception 'dryrun: המועד לא עבר ל-ready של הגרסה החדשה';
    end if;

    -- 6. an upload in progress (numberless, not failed) blocks the date
    insert into public.client_review_versions (item_id, source, bunny_library_id, bunny_video_id, bunny_status)
    values (v_item_a, 'bunny', 1, gen_random_uuid(), 'uploading') returning id into v_v4;
    select purge_after, upload_pending into v_purge, v_pending from public.v_review_media_purge_due where item_id = v_item_a;
    if v_purge is not null or not v_pending then
      raise exception 'dryrun: העלאה בתהליך לא חסמה את המועד (%, %)', v_purge, v_pending;
    end if;
    update public.client_review_versions set bunny_status = 'failed' where id = v_v4;
    if (select purge_after from public.v_review_media_purge_due where item_id = v_item_a) is null then
      raise exception 'dryrun: העלאה שנכשלה עדיין חוסמת';
    end if;
    v_rep := v_rep || E'\n  ✓ העלאה בתהליך חוסמת; כשהיא נכשלת — המועד חוזר';

    -- 7. Drive latest → the approval alone
    insert into public.client_review_versions (item_id, number, source, media_link)
    values (v_item_b, 99, 'drive', 'https://drive.google.com/dryrun');
    insert into public.client_review_approvals (item_id, decision, decided_at, is_backfill, backfill_source)
    values (v_item_b, 'approved', now() - interval '10 days', true, 'dryrun:0115');
    select purge_after, latest_ready_at into v_purge, v_ready2 from public.v_review_media_purge_due where item_id = v_item_b;
    if v_purge is distinct from (now() - interval '10 days') + interval '90 days' or v_ready2 is not null then
      raise exception 'dryrun: גרסה אחרונה drive — צפוי אישור + 90, התקבל %', v_purge;
    end if;
    v_rep := v_rep || E'\n  ✓ גרסה אחרונה drive → אישור + 90';

    -- 8. CHECK: ready_at on a drive row is refused even if the trigger is bypassed
    begin
      alter table public.client_review_versions disable trigger trg_review_version_ready_at;
      insert into public.client_review_versions (item_id, number, source, media_link, ready_at)
      values (v_item_b, 100, 'drive', 'https://drive.google.com/x', now());
      raise exception 'dryrun: ready_at על drive התקבל';
    exception when check_violation then v_caught := v_caught + 1;
    end;

    -- 9. sessions still refused
    execute 'set local role authenticated';
    begin
      perform 1 from public.v_review_media_purge_due limit 1;
      raise exception 'dryrun: authenticated קרא את התצוגה';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';

    if v_caught <> 2 then
      raise exception 'dryrun: נתפסו % דחיות במקום 2', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ CHECK על ready_at ב-drive, ו-authenticated נדחה בתצוגה (2/2)';
