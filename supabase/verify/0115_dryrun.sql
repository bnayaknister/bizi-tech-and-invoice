-- ============================================================================
-- 0115 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0115_dryrun_tests.sql. הקובץ מריץ את הגוף, מוכיח את
-- ההתנהגות על פריטים אמיתיים, ומסיים ב-`raise exception` — אפס שינוי נשאר.
-- **גם הצלחה היא exception.** השורה האדומה בסוף היא הפלט הצפוי.
-- Supabase SQL Editor אינו מציג NOTICE — כל הדוח בהודעת השגיאה.
-- ============================================================================

do $dry$
declare
  v_rep    text := '';
  v_msg    text;
  v_caught int := 0;
  v_item_a  uuid;
  v_item_b  uuid;
  v_v1      uuid;
  v_v2      uuid;
  v_v3      uuid;
  v_v4      uuid;
  v_latest  uuid;
  v_pending boolean;
  v_ready1  timestamptz;
  v_ready2  timestamptz;
  v_purge   timestamptz;
begin
  begin
    -- ════ גוף 0115, מילה במילה ════
    declare
      v_n   bigint;
      v_bad text;
    begin
      -- ═══ 0. guards ═══
      if exists (select 1 from public.schema_ledger where version = '0115') then
        raise exception '0115 כבר רשומה בפנקס — אל תריץ שוב';
      end if;
      if not exists (select 1 from public.schema_ledger where version = '0114') then
        raise exception '0114 טרם הוחלה — הרץ אותה קודם';
      end if;
      if exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'client_review_versions'
                    and column_name = 'ready_at') then
        raise exception '0115: ready_at כבר קיימת — נוספה מחוץ לפנקס';
      end if;
      if exists (select 1 from public.client_review_versions where bunny_status = 'ready') then
        raise exception '0115: יש כבר גרסאות ready — אין להן רגע ready ידוע. עצור וברר לפני ההחלה';
      end if;

      -- ═══ 1. ready_at, owned by a trigger ═══
      alter table public.client_review_versions add column ready_at timestamptz;

      create function public.review_version_ready_at()
        returns trigger
        language plpgsql security definer set search_path = public
      as $fn$
      begin
        if tg_op = 'UPDATE' and old.ready_at is not null then
          new.ready_at := old.ready_at;          -- set once, never moved
        elsif new.bunny_status = 'ready' then
          new.ready_at := now();                 -- the first transition to ready
        else
          new.ready_at := null;                  -- callers cannot write it
        end if;
        return new;
      end;
      $fn$;

      create trigger trg_review_version_ready_at
        before insert or update on public.client_review_versions
        for each row execute function public.review_version_ready_at();

      alter table public.client_review_versions
        add constraint crv_ready_at_chk check (
          (ready_at is null or source = 'bunny')
          and (bunny_status is distinct from 'ready' or ready_at is not null)
        );

      comment on column public.client_review_versions.ready_at is
        '0115: מתי הגרסה הגיעה ל-ready לראשונה. נקבע בטריגר trg_review_version_ready_at בלבד, פעם אחת, ולא זז. עוגן (b) של מועד המחיקה.';

      revoke all on function public.review_version_ready_at() from public, anon, authenticated;

      -- ═══ 2. the view: same leading columns, three appended ═══
      create or replace view public.v_review_media_purge_due
        with (security_invoker = on) as
      with approval as (
        select distinct on (a.item_id)
               a.item_id, a.id as approval_id, a.decided_at
          from public.client_review_approvals a
         where a.decision = 'approved' and a.revoked_at is null
         order by a.item_id, a.decided_at desc, a.id
      ),
      latest as (
        select distinct on (v.item_id)
               v.item_id, v.id as version_id, v.source, v.ready_at
          from public.client_review_versions v
         where v.number is not null
         order by v.item_id, v.number desc
      ),
      pending as (
        select distinct v.item_id
          from public.client_review_versions v
         where v.source = 'bunny' and v.number is null
           and v.media_deleted_at is null
           and v.bunny_status is distinct from 'failed'
      )
      select ap.item_id,
             ap.approval_id,
             ap.decided_at as approved_at,
             case
               when p.item_id is not null then null
               when l.source = 'bunny' and l.ready_at is null then null
               else greatest(ap.decided_at, coalesce(l.ready_at, ap.decided_at)) + interval '90 days'
             end as purge_after,
             l.version_id as latest_version_id,
             l.ready_at   as latest_ready_at,
             (p.item_id is not null) as upload_pending
        from approval ap
        left join latest  l on l.item_id = ap.item_id
        left join pending p on p.item_id = ap.item_id;

      -- re-stated, not assumed: create or replace keeps grants, the canary proves it
      revoke all privileges on public.v_review_media_purge_due from public, anon, authenticated;
      grant select on public.v_review_media_purge_due to service_role;

      -- ═══ 3. CANARY ═══
      if has_table_privilege('anon', 'public.v_review_media_purge_due', 'SELECT')
         or has_table_privilege('authenticated', 'public.v_review_media_purge_due', 'SELECT')
         or has_table_privilege('anon', 'public.client_review_versions', 'SELECT')
         or has_table_privilege('authenticated', 'public.client_review_versions', 'SELECT') then
        raise exception '0115 canary: לסשן יש SELECT על התצוגה או על טבלת הגרסאות';
      end if;
      if has_column_privilege('authenticated', 'public.client_review_versions', 'ready_at', 'SELECT')
         or has_column_privilege('anon', 'public.client_review_versions', 'ready_at', 'SELECT') then
        raise exception '0115 canary: לסשן יש הרשאה עמודתית על ready_at';
      end if;
      if not has_table_privilege('service_role', 'public.v_review_media_purge_due', 'SELECT') then
        raise exception '0115 canary: ל-service_role אין SELECT על התצוגה';
      end if;
      if has_function_privilege('anon', 'public.review_version_ready_at()', 'EXECUTE')
         or has_function_privilege('authenticated', 'public.review_version_ready_at()', 'EXECUTE') then
        raise exception '0115 canary: פונקציית הטריגר ניתנת להרצה מסשן';
      end if;
      if not exists (select 1 from pg_class
                      where oid = 'public.v_review_media_purge_due'::regclass
                        and reloptions @> array['security_invoker=on']) then
        raise exception '0115 canary: התצוגה איבדה את security_invoker';
      end if;
      if not exists (select 1 from pg_trigger
                      where tgname = 'trg_review_version_ready_at'
                        and tgrelid = 'public.client_review_versions'::regclass
                        and not tgisinternal and tgenabled = 'O') then
        raise exception '0115 canary: הטריגר אינו פעיל';
      end if;
      select string_agg(column_name, ',' order by ordinal_position) into v_bad
        from information_schema.columns
       where table_schema = 'public' and table_name = 'v_review_media_purge_due';
      if v_bad <> 'item_id,approval_id,approved_at,purge_after,latest_version_id,latest_ready_at,upload_pending' then
        raise exception '0115: עמודות התצוגה אינן כצפוי: %', v_bad;
      end if;
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'client_review_versions';
      if v_n <> 25 then
        raise exception '0115: client_review_versions נושאת % עמודות במקום 25', v_n;
      end if;

      raise notice '0115 OK — ready_at (טריגר, נקבע פעם אחת) + v_review_media_purge_due לפי המאוחר מבין האישור ל-ready של הגרסה האחרונה · הרשאות ללא שינוי';

      -- ═══ 4. ledger row, last ═══
      insert into public.schema_ledger (version, applied_at, applied_by, note)
      values ('0115', now(), current_user,
        'E13-2/E13-6, הכרעת בעלים 15.10: מועד המחיקה הוא 90 יום מהמאוחר מבין האישור התקף האחרון של הפריט לבין הרגע שבו הגרסה האחרונה שלו הגיעה ל-ready. '
        || 'נוספה client_review_versions.ready_at — נקבעת רק בטריגר trg_review_version_ready_at (security definer), פעם אחת במעבר הראשון ל-ready, לא זזה ולא נכתבת ע"י קורא; CHECK: ready מחייב ready_at, ו-ready_at רק על bunny. bunny_status_at לא שימשה כי היא זזה בכל עדכון סטטוס. '
        || 'v_review_media_purge_due הוחלפה ב-create or replace: ארבע העמודות הקיימות נשמרו, ונוספו latest_version_id, latest_ready_at, upload_pending. '
        || 'פרשנות (ניתנת לשינוי): הגרסה האחרונה = המספר הגבוה; אחרונה bunny שעוד לא ready → purge_after ריק; אחרונה drive → האישור לבדו; העלאה בתהליך (bunny בלי מספר, לא failed ולא נמחקה) → purge_after ריק. '
        || 'הרשאות ללא שינוי: התצוגה והטבלה סגורות ל-anon/authenticated, service_role קורא, פונקציית הטריגר לא ניתנת להרצה מסשן.');

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
  end;
    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0115 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0115 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
