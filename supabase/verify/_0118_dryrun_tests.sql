    -- ════ ההוכחות (רצות אחרי גוף 0118, בתוך אותה טרנזקציה שתתגלגל לאחור) ════
    -- פריט אמיתי עם גרסת bunny וקישור. כל מה שמשתנה כאן מתגלגל לאחור בסוף.
    select i.id, i.production_id, i.kind, v.id
      into v_item, v_prod, v_kind, v_ver
      from public.client_review_items i
      join public.client_review_versions v on v.item_id = i.id and v.source = 'bunny'
      join public.productions p on p.id = i.production_id and p.status <> 'בוטל'
     where exists (select 1 from public.client_review_links l where l.production_id = i.production_id)
     order by i.created_at, i.id
     limit 1;
    if v_item is null then
      raise exception 'dryrun: צריך פריט עם גרסת bunny ועם קישור להפקה שלו';
    end if;
    select id into v_link from public.client_review_links where production_id = v_prod order by created_at desc, id limit 1;
    select id into v_other_link from public.client_review_links where production_id <> v_prod order by created_at desc, id limit 1;
    select count(*) into v_jobs_before from public.job_productions where production_id = v_prod;
    v_rep := v_rep || E'\n  פריט בדיקה: ' || v_item || ' (' || v_kind || ') · גרסה ' || v_ver || ' · jobs מקושרים: ' || v_jobs_before;

    -- הכנה: קישור שנענה, הפריט מאושר עם שורת אישור, ההפקה "הופץ" ובארכיון, "קיבלתי" על הסבב
    update public.client_review_links set responded_at = coalesce(responded_at, now() - interval '1 day') where id = v_link;
    update public.client_review_items set approved = true, approved_at = now() - interval '1 day' where production_id = v_prod;
    insert into public.client_review_approvals (item_id, version_id, link_id, decision, decided_at)
    values (v_item, v_ver, v_link, 'approved', now() - interval '1 day');
    update public.productions set status = 'הופץ' where id = v_prod;
    update public.productions
       set board_archived_at = now(), needs_attention = false, review_ack_at = now(), review_ack_link_id = v_link,
           review_episode_approved = true, review_reels_approved = true
     where id = v_prod;
    if not exists (select 1 from public.v_review_media_purge_due where item_id = v_item) then
      raise exception 'dryrun: הכנה — לפריט אין אישור תקף בתצוגת המחיקה';
    end if;

    -- 1. נעץ על פריט מאושר → ביטול
    v_res := public.review_item_comment(v_link, v_item, v_ver, 'pin', 42180, 'dryrun 0118 נעץ');
    if not (v_res->>'revoked')::boolean or (v_res->>'pin_number') is null or not (v_res->>'after_response')::boolean then
      raise exception 'dryrun: נעץ על פריט מאושר לא החזיר ביטול: %', v_res;
    end if;
    if not exists (select 1 from public.client_review_comments
                    where id = (v_res->>'comment_id')::uuid and kind = 'pin' and time_ms = 42180
                      and version_id = v_ver and link_id = v_link and author_kind = 'client' and after_response) then
      raise exception 'dryrun: הנעץ לא נשמר כמו שצריך (זמן במילישניות, גרסה, קישור)';
    end if;
    if exists (select 1 from public.client_review_approvals where item_id = v_item and decision = 'approved' and revoked_at is null)
       or not exists (select 1 from public.client_review_approvals where item_id = v_item and revoked_reason = 'client_comment') then
      raise exception 'dryrun: האישור לא סומן כמבוטל (client_comment)';
    end if;
    if (select approved from public.client_review_items where id = v_item) then
      raise exception 'dryrun: הפריט נשאר מאושר';
    end if;
    select count(*) into v_n from public.productions
     where id = v_prod and status = 'בעריכה' and needs_attention and review_ack_link_id is null and review_ack_at is null
       and board_archived_at is null
       and (case when v_kind = 'episode' then not review_episode_approved else not review_reels_approved end);
    if v_n <> 1 then
      raise exception 'dryrun: ההפקה לא עברה לבעריכה עם נקודה אדומה, איפוס קיבלתי, יציאה מהארכיון ודגל כבוי';
    end if;
    if not exists (select 1 from public.events where entity_id = v_prod and event_type = 'client_review_approval_revoked'
                    and payload->>'from_status' = 'הופץ' and payload->>'item_id' = v_item::text) then
      raise exception 'dryrun: אין אירוע client_review_approval_revoked עם from_status הופץ';
    end if;
    if exists (select 1 from public.v_review_media_purge_due where item_id = v_item) then
      raise exception 'dryrun: שעון המחיקה לא נעצר (יש עדיין אישור תקף בתצוגה)';
    end if;
    v_rep := v_rep || E'\n  ✓ נעץ (42180ms) על פריט מאושר: האישור מבוטל ולא נמחק, הפריט ממתין, ההפקה הופץ→בעריכה, נקודה אדומה, קיבלתי אופס, יצאה מהארכיון, שעון המחיקה נעצר';

    -- 2. הערה כללית על אותו פריט (עכשיו ממתין) → בלי ביטול נוסף, נקודה אדומה
    update public.productions set needs_attention = false where id = v_prod;
    v_res := public.review_item_comment(v_link, v_item, null, 'general', null, 'dryrun 0118 כללית');
    if (v_res->>'revoked')::boolean or not (select needs_attention from public.productions where id = v_prod)
       or not exists (select 1 from public.events where entity_id = v_prod and event_type = 'client_review_post_response_comment') then
      raise exception 'dryrun: הערה אחרי תשובה על פריט ממתין: %', v_res;
    end if;
    v_rep := v_rep || E'\n  ✓ הערה כללית אחרי תשובה על פריט ממתין: נשמרת, נקודה אדומה, בלי ביטול נוסף';

    -- 3. אישור מחדש מאותו קישור → כל הפריטים מאושרים → אושר_ע"י_לקוח, בלי job שני, הנקודה נשארת
    v_res := public.review_item_reapprove(v_link, v_item, v_ver);
    if not (v_res->>'approved_all')::boolean or v_res->>'status' <> 'אושר_ע"י_לקוח' then
      raise exception 'dryrun: אישור מחדש לא החזיר את ההפקה לאושר_ע"י_לקוח: %', v_res;
    end if;
    if not (select approved from public.client_review_items where id = v_item)
       or not exists (select 1 from public.client_review_approvals where item_id = v_item and decision = 'approved' and revoked_at is null and link_id = v_link and version_id = v_ver)
       or not exists (select 1 from public.v_review_media_purge_due where item_id = v_item and approved_at > now() - interval '1 minute') then
      raise exception 'dryrun: אישור מחדש — שורת אישור חדשה / הפריט / שעון מחיקה חדש';
    end if;
    if not (select needs_attention from public.productions where id = v_prod) then
      raise exception 'dryrun: הנקודה האדומה כבתה באישור מחדש (הכרעה 3: נשארת עד קיבלתי)';
    end if;
    select count(*) into v_n from public.job_productions where production_id = v_prod;
    if (v_jobs_before >= 1 and v_n <> v_jobs_before) or (v_jobs_before = 0 and v_n > 1) then
      raise exception 'dryrun: מספר ה-jobs השתנה באישור מחדש: % → %', v_jobs_before, v_n;
    end if;
    v_rep := v_rep || E'\n  ✓ אישור מחדש: שורת אישור חדשה על הגרסה, הפריט מאושר, אושר_ע"י_לקוח, שעון 90 יום מחדש, הנקודה נשארת, jobs: ' || v_jobs_before || ' → ' || v_n;

    -- 4. הדחיות
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: אישור מחדש פעמיים עבר';
    exception when raise_exception then
      if sqlerrm not like '%כבר מאושר%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'pin', null, 'x');
      raise exception 'dryrun: נעץ בלי זמן עבר';
    exception when raise_exception then
      if sqlerrm not like '%נעץ צריך גרסה וזמן%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'general', null, '   ');
      raise exception 'dryrun: הערה ריקה עברה';
    exception when raise_exception then
      if sqlerrm not like '%ריק%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'bogus', null, 'x');
      raise exception 'dryrun: סוג לא מוכר עבר';
    exception when raise_exception then
      if sqlerrm not like '%סוג הערה לא מוכר%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    -- נעץ על גרסת drive (נוצרת כאן, מתגלגלת לאחור)
    insert into public.client_review_versions (item_id, number, source, media_link)
    values (v_item, (select coalesce(max(number), 0) + 1 from public.client_review_versions where item_id = v_item), 'drive', 'https://drive.google.com/file/d/dryrun0118/view')
    returning id into v_drive;
    begin
      perform public.review_item_comment(v_link, v_item, v_drive, 'pin', 1000, 'x');
      raise exception 'dryrun: נעץ על גרסת drive עבר';
    exception when raise_exception then
      if sqlerrm not like '%רק על גרסת Bunny%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    if v_other_link is not null then
      begin
        perform public.review_item_comment(v_other_link, v_item, v_ver, 'general', null, 'x');
        raise exception 'dryrun: קישור של הפקה אחרת עבר';
      exception when raise_exception then
        if sqlerrm not like '%אינו של ההפקה%' then raise; end if;
        v_caught := v_caught + 1;
      end;
    else
      v_caught := v_caught + 1;
      v_rep := v_rep || E'\n  (אין קישור של הפקה אחרת — בדיקת הקישור הזר דולגה)';
    end if;
    -- אישור שבוטל בגרירה אחורה (לא בהערה) → אין אישור מחדש
    update public.client_review_approvals set revoked_at = now(), revoked_reason = 'board_rollback'
     where item_id = v_item and decision = 'approved' and revoked_at is null;
    update public.client_review_items set approved = false where id = v_item;
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: אישור מחדש אחרי ביטול שלא בהערה עבר';
    exception when raise_exception then
      if sqlerrm not like '%אין אישור שבוטל בהערה%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_reapprove(v_link, v_item, null);
      raise exception 'dryrun: אישור מחדש בלי גרסה עבר';
    exception when raise_exception then
      if sqlerrm not like '%אישור צריך גרסה%' then raise; end if;
      v_caught := v_caught + 1;
    end;
    v_rep := v_rep || E'\n  ✓ נדחו: אישור כפול, נעץ בלי זמן, הערה ריקה, סוג לא מוכר, נעץ על drive, קישור זר, אישור מחדש אחרי ביטול בגרירה, אישור בלי גרסה';

    -- 5. קישור חי (לפני תשובה), פריט ממתין → ההערה נשמרת, ההפקה לא זזה
    update public.client_review_links set responded_at = null where id = v_link;
    update public.productions set needs_attention = false where id = v_prod;
    select status::text into v_kind from public.productions where id = v_prod;
    v_res := public.review_item_comment(v_link, v_item, v_ver, 'pin', 5000, 'dryrun 0118 לפני תשובה');
    if (v_res->>'after_response')::boolean or (v_res->>'revoked')::boolean
       or (select needs_attention from public.productions where id = v_prod)
       or (select status::text from public.productions where id = v_prod) <> v_kind then
      raise exception 'dryrun: נעץ בקישור חי על פריט ממתין הזיז את ההפקה: %', v_res;
    end if;
    v_rep := v_rep || E'\n  ✓ נעץ בקישור חי לפני תשובה: after_response=false, ההפקה לא זזה';

    -- 6. הרשאות
    execute 'set local role authenticated';
    begin
      perform public.review_item_comment(v_link, v_item, v_ver, 'general', null, 'x');
      raise exception 'dryrun: authenticated הריץ את review_item_comment';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    begin
      perform public.review_item_reapprove(v_link, v_item, v_ver);
      raise exception 'dryrun: authenticated הריץ את review_item_reapprove';
    exception when insufficient_privilege then v_caught := v_caught + 1;
    end;
    execute 'reset role';

    if v_caught <> 10 then
      raise exception 'dryrun: נתפסו % דחיות במקום 10', v_caught;
    end if;
    v_rep := v_rep || E'\n  ✓ authenticated נדחה בשתי הפונקציות · סה"כ 10/10 דחיות כצפוי';
