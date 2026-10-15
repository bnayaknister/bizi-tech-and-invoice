-- ============================================================================
-- 0114 — הרצה מדומה. להריץ **לפני** קובץ המיגרציה.
--
-- גוף המיגרציה הועתק לכאן **מילה במילה** בסקריפט (לא ביד), ואחריו
-- supabase/verify/_0114_dryrun_tests.sql. הקובץ מריץ את הגוף, מוכיח את
-- האילוצים, ההקצאה (Q11), הנעצים, מועד המחיקה וההרשאות על פריטים אמיתיים,
-- ומסיים ב-`raise exception` — אפס שינוי נשאר.
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
  v_drive  uuid;
  v_bunny1 uuid;
  v_bunny2 uuid;
  v_appr   uuid;
  v_n1     int;
  v_n2     int;
  v_pin1   int;
  v_pin2   int;
  v_pin3   int;
  v_purge  timestamptz;
begin
  begin
    -- ════ גוף 0114, מילה במילה ════
    declare
      v_items_before bigint;
      v_links_before bigint;
      v_prod_before  bigint;
      v_n            bigint;
      v_t            text;
      v_bad          text;
    begin
      -- ═══ 0. guards ═══
      if exists (select 1 from public.schema_ledger where version = '0114') then
        raise exception '0114 כבר רשומה בפנקס — אל תריץ שוב';
      end if;
      if not exists (select 1 from public.schema_ledger where version = '0113') then
        raise exception '0113 טרם הוחלה — הרץ אותה קודם';
      end if;
      -- 0069 removed postgres'' default grants to anon; without it every object
      -- created here is born readable to anon and the canary below would refuse.
      if not exists (select 1 from public.schema_ledger where version = '0069') then
        raise exception '0069 טרם הוחלה — בלעדיה כל טבלה חדשה נולדת קריאה ל-anon';
      end if;
      if exists (select 1 from information_schema.tables
                  where table_schema = 'public'
                    and table_name in ('client_review_versions', 'client_review_comments',
                                       'client_review_approvals', 'v_review_media_purge_due')) then
        raise exception '0114: אחת הטבלאות/התצוגה כבר קיימת — נוצרה מחוץ לפנקס';
      end if;

      select count(*) into v_items_before from public.client_review_items;
      select count(*) into v_links_before from public.client_review_links;
      select count(*) into v_prod_before  from public.productions;

      -- ═══ 1. versions ═══
      create table public.client_review_versions (
        id                     uuid primary key default gen_random_uuid(),
        item_id                uuid not null references public.client_review_items(id) on delete restrict,
        -- Q11: null until the upload succeeded; allocated only by
        -- assign_review_version_number. Never max+1 in application code.
        number                 int check (number >= 1),
        source                 text not null check (source in ('drive', 'bunny')),
        media_link             text,
        bunny_library_id       bigint,
        bunny_video_id         uuid unique,
        -- OUR status, derived from a freshly fetched video object (never from a
        -- webhook payload number — the two Bunny enums differ). 'uploading' is set
        -- by us when the browser upload starts; Bunny has no such state.
        bunny_status           text check (bunny_status in ('created', 'uploading', 'processing', 'playable', 'ready', 'failed')),
        bunny_status_raw       int,
        bunny_status_at        timestamptz,
        is_audio_only          boolean not null default false,
        duration_ms            int check (duration_ms >= 0),
        original_filename      text,
        original_size_bytes    bigint check (original_size_bytes >= 0),
        has_original           boolean,
        original_sha256        text,
        timeline_offset_ms     int,
        is_backfill            boolean not null default false,
        created_by             uuid references public.profiles(id),
        created_at             timestamptz not null default now(),
        -- set ONLY after Bunny confirmed the delete (2xx or 404). Never in advance.
        media_deleted_at       timestamptz,
        delete_attempts        int not null default 0 check (delete_attempts >= 0),
        delete_last_error      text,
        delete_last_attempt_at timestamptz,

        constraint crv_bunny_fields_chk check (
          (source = 'bunny'
             and bunny_library_id is not null and bunny_video_id is not null
             and bunny_status is not null and media_link is null)
          or
          (source = 'drive'
             and media_link is not null and number is not null
             and bunny_library_id is null and bunny_video_id is null
             and bunny_status is null and bunny_status_raw is null and bunny_status_at is null
             and has_original is null and original_sha256 is null
             and media_deleted_at is null and delete_attempts = 0
             and delete_last_error is null and delete_last_attempt_at is null)
        ),
        -- §9 🔴: no version is ready without the original kept by Bunny.
        constraint crv_ready_needs_original_chk check (
          bunny_status is distinct from 'ready'
          or (has_original is true and original_sha256 is not null)
        ),
        -- the backfill only ever creates Drive history.
        constraint crv_backfill_is_drive_chk check (not is_backfill or source = 'drive'),
        -- target of the composite FKs below: a comment/approval's version must
        -- belong to the same item the row names.
        constraint crv_id_item_uq unique (id, item_id)
      );

      create unique index uq_crv_item_number
        on public.client_review_versions (item_id, number) where number is not null;
      create index idx_crv_item_latest
        on public.client_review_versions (item_id, number desc);
      create index idx_crv_bunny_live
        on public.client_review_versions (item_id) where source = 'bunny' and media_deleted_at is null;

      -- ═══ 2. comments + pins ═══
      create table public.client_review_comments (
        id              uuid primary key default gen_random_uuid(),
        item_id         uuid not null references public.client_review_items(id) on delete restrict,
        version_id      uuid,
        -- WHERE it was written from (provenance), not its anchor.
        link_id         uuid references public.client_review_links(id) on delete set null,
        kind            text not null check (kind in ('pin', 'general')),
        pin_number      int check (pin_number >= 1),
        time_ms         int check (time_ms >= 0),
        body            text not null check (btrim(body) <> ''),
        author_kind     text not null check (author_kind in ('client', 'team')),
        author_name     text,
        author_id       uuid references public.profiles(id),
        created_at      timestamptz not null default now(),
        resolved_at     timestamptz,
        resolved_by     uuid references public.profiles(id),
        acked_at        timestamptz,
        acked_by        uuid references public.profiles(id),
        after_response  boolean not null default false,
        is_backfill     boolean not null default false,
        backfill_source text,

        constraint crc_version_item_fk foreign key (version_id, item_id)
          references public.client_review_versions (id, item_id) on delete restrict,
        -- a pin without a version would float onto another cut (research 8.10).
        constraint crc_pin_shape_chk check (
          (kind = 'pin' and version_id is not null and pin_number is not null and time_ms is not null)
          or (kind = 'general' and pin_number is null and time_ms is null)
        ),
        constraint crc_author_chk check (author_kind = 'team' or author_id is null),
        constraint crc_resolved_chk check (resolved_by is null or resolved_at is not null),
        constraint crc_acked_chk check (acked_by is null or acked_at is not null),
        constraint crc_backfill_source_chk check ((backfill_source is not null) = is_backfill)
      );

      create unique index uq_crc_version_pin
        on public.client_review_comments (version_id, pin_number) where kind = 'pin';
      create unique index uq_crc_backfill_source
        on public.client_review_comments (backfill_source) where backfill_source is not null;
      create index idx_crc_item_created on public.client_review_comments (item_id, created_at);
      create index idx_crc_version on public.client_review_comments (version_id);

      -- ═══ 3. approvals (append-only) ═══
      create table public.client_review_approvals (
        id              uuid primary key default gen_random_uuid(),
        item_id         uuid not null references public.client_review_items(id) on delete restrict,
        version_id      uuid,
        link_id         uuid references public.client_review_links(id) on delete set null,
        decision        text not null check (decision in ('approved', 'revisions')),
        note            text,
        decided_at      timestamptz not null,
        -- B10 (board drag-back) marks here; nothing is ever deleted.
        revoked_at      timestamptz,
        revoked_reason  text,
        is_backfill     boolean not null default false,
        backfill_source text,
        created_at      timestamptz not null default now(),

        constraint cra_version_item_fk foreign key (version_id, item_id)
          references public.client_review_versions (id, item_id) on delete restrict,
        constraint cra_version_chk check (version_id is not null or is_backfill),
        constraint cra_revoked_chk check (revoked_reason is null or revoked_at is not null),
        constraint cra_backfill_source_chk check ((backfill_source is not null) = is_backfill)
      );

      create unique index uq_cra_backfill_source
        on public.client_review_approvals (backfill_source) where backfill_source is not null;
      create index idx_cra_item_valid
        on public.client_review_approvals (item_id, decided_at desc)
        where decision = 'approved' and revoked_at is null;

      -- ═══ 4. the deletion date, derived (§2.4 / §6) ═══
      -- One row per item that has a valid approval: the LAST approved, unrevoked
      -- decision. purge_after applies to EVERY Bunny version of that item. An item
      -- with no valid approval has no row and is therefore never purged.
      create view public.v_review_media_purge_due
        with (security_invoker = on) as
      select distinct on (a.item_id)
             a.item_id,
             a.id          as approval_id,
             a.decided_at  as approved_at,
             a.decided_at + interval '90 days' as purge_after
        from public.client_review_approvals a
       where a.decision = 'approved' and a.revoked_at is null
       order by a.item_id, a.decided_at desc, a.id;

      -- ═══ 5. number allocation (§2.6) ═══
      -- Q11: called once the upload is confirmed (video status >= Uploaded on a
      -- fresh fetch). Idempotent: a version that already has a number keeps it.
      create function public.assign_review_version_number(p_version_id uuid)
        returns int
        language plpgsql security definer set search_path = public
      as $fn$
      declare
        v_item uuid;
        v_num  int;
        v_next int;
      begin
        select item_id, number into v_item, v_num
          from public.client_review_versions where id = p_version_id;
        if v_item is null then
          raise exception 'assign_review_version_number: גרסה % לא קיימת', p_version_id;
        end if;
        if v_num is not null then
          return v_num;
        end if;

        -- the item row is the lock: two versions of the same item serialise here.
        perform 1 from public.client_review_items where id = v_item for update;

        -- re-read under the lock: a concurrent call may have numbered it.
        select number into v_num from public.client_review_versions where id = p_version_id for update;
        if v_num is not null then
          return v_num;
        end if;

        select coalesce(max(number), 0) + 1 into v_next
          from public.client_review_versions where item_id = v_item;
        update public.client_review_versions set number = v_next where id = p_version_id;
        return v_next;
      end;
      $fn$;

      -- A pin is numbered 1, 2, 3… per VERSION, under a lock on the version row,
      -- and written in the same transaction (header: why insert, not return).
      -- after_response is decided by the server from the link's responded_at.
      create function public.create_review_pin(
        p_version_id     uuid,
        p_link_id        uuid,
        p_time_ms        int,
        p_body           text,
        p_author_kind    text,
        p_author_name    text,
        p_author_id      uuid,
        p_after_response boolean
      )
        returns public.client_review_comments
        language plpgsql security definer set search_path = public
      as $fn$
      declare
        v_item uuid;
        v_next int;
        v_row  public.client_review_comments;
      begin
        select item_id into v_item
          from public.client_review_versions where id = p_version_id for update;
        if v_item is null then
          raise exception 'create_review_pin: גרסה % לא קיימת', p_version_id;
        end if;

        select coalesce(max(pin_number), 0) + 1 into v_next
          from public.client_review_comments
         where version_id = p_version_id and kind = 'pin';

        insert into public.client_review_comments
          (item_id, version_id, link_id, kind, pin_number, time_ms, body,
           author_kind, author_name, author_id, after_response)
        values
          (v_item, p_version_id, p_link_id, 'pin', v_next, p_time_ms, p_body,
           p_author_kind, p_author_name, p_author_id, coalesce(p_after_response, false))
        returning * into v_row;
        return v_row;
      end;
      $fn$;

      -- ═══ 6. permissions — closed, then nothing granted to sessions ═══
      revoke all privileges on public.client_review_versions   from public, anon, authenticated;
      revoke all privileges on public.client_review_comments   from public, anon, authenticated;
      revoke all privileges on public.client_review_approvals  from public, anon, authenticated;
      revoke all privileges on public.v_review_media_purge_due from public, anon, authenticated;
      alter table public.client_review_versions  enable row level security;
      alter table public.client_review_comments  enable row level security;
      alter table public.client_review_approvals enable row level security;

      revoke all on function public.assign_review_version_number(uuid) from public, anon, authenticated;
      revoke all on function public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean) from public, anon, authenticated;
      grant execute on function public.assign_review_version_number(uuid) to service_role;
      grant execute on function public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean) to service_role;
      grant select, insert, update on public.client_review_versions  to service_role;
      grant select, insert, update on public.client_review_comments  to service_role;
      grant select, insert, update on public.client_review_approvals to service_role;
      grant select on public.v_review_media_purge_due to service_role;

      -- ═══ 7. CANARY — all before the ledger row ═══
      -- 7a. sessions get nothing, in any direction, on any new object.
      foreach v_t in array array['client_review_versions', 'client_review_comments',
                                 'client_review_approvals', 'v_review_media_purge_due'] loop
        if has_table_privilege('anon', 'public.' || v_t, 'SELECT')
           or has_table_privilege('authenticated', 'public.' || v_t, 'SELECT')
           or has_table_privilege('anon', 'public.' || v_t, 'INSERT')
           or has_table_privilege('authenticated', 'public.' || v_t, 'INSERT')
           or has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE')
           or has_table_privilege('authenticated', 'public.' || v_t, 'DELETE') then
          raise exception '0114 canary: ל-anon/authenticated יש הרשאה על % — ה-revoke לא תפס (בדוק pg_default_acl, 0069)', v_t;
        end if;
        if not has_table_privilege('service_role', 'public.' || v_t, 'SELECT') then
          raise exception '0114 canary: ל-service_role אין SELECT על % — הראוטים לא יוכלו לקרוא', v_t;
        end if;
      end loop;

      -- 7b. ...and nothing at column level either (a table-level false does not imply it).
      select string_agg(c.table_name || '.' || c.column_name, ', ') into v_bad
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.table_name in ('client_review_versions', 'client_review_comments',
                              'client_review_approvals', 'v_review_media_purge_due')
         and (has_column_privilege('anon', 'public.' || c.table_name, c.column_name, 'SELECT')
           or has_column_privilege('authenticated', 'public.' || c.table_name, c.column_name, 'SELECT'));
      if v_bad is not null then
        raise exception '0114 canary: הרשאה עמודתית לסשן על: %', v_bad;
      end if;

      -- 7c. RLS on, zero policies.
      if exists (select 1 from pg_class
                  where oid in ('public.client_review_versions'::regclass,
                                'public.client_review_comments'::regclass,
                                'public.client_review_approvals'::regclass)
                    and not relrowsecurity) then
        raise exception '0114 canary: RLS כבוי על אחת הטבלאות החדשות';
      end if;
      select count(*) into v_n from pg_policies
       where schemaname = 'public'
         and tablename in ('client_review_versions', 'client_review_comments', 'client_review_approvals');
      if v_n <> 0 then
        raise exception '0114 canary: נמצאו % policies — הטבלאות אמורות להיות service-role בלבד', v_n;
      end if;

      -- 7d. functions: service_role only, security definer, pinned search_path.
      if has_function_privilege('anon', 'public.assign_review_version_number(uuid)', 'EXECUTE')
         or has_function_privilege('authenticated', 'public.assign_review_version_number(uuid)', 'EXECUTE')
         or has_function_privilege('anon', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE')
         or has_function_privilege('authenticated', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE') then
        raise exception '0114 canary: פונקציית הקצאה ניתנת להרצה מסשן — ה-revoke לא תפס';
      end if;
      if not has_function_privilege('service_role', 'public.assign_review_version_number(uuid)', 'EXECUTE')
         or not has_function_privilege('service_role', 'public.create_review_pin(uuid, uuid, int, text, text, text, uuid, boolean)', 'EXECUTE') then
        raise exception '0114 canary: ל-service_role אין EXECUTE על פונקציות ההקצאה';
      end if;
      select count(*) into v_n from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('assign_review_version_number', 'create_review_pin')
         and prosecdef and proconfig @> array['search_path=public'];
      if v_n <> 2 then
        raise exception '0114 canary: פונקציות ההקצאה אינן security definer עם search_path קבוע (%/2)', v_n;
      end if;

      -- 7e. the view runs with the CALLER's rights, not the owner's.
      if not exists (select 1 from pg_class
                      where oid = 'public.v_review_media_purge_due'::regclass
                        and reloptions @> array['security_invoker=on']) then
        raise exception '0114 canary: v_review_media_purge_due אינה security_invoker';
      end if;

      -- 7f. structure as literals.
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'client_review_versions';
      if v_n <> 24 then raise exception '0114: client_review_versions נושאת % עמודות במקום 24', v_n; end if;
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'client_review_comments';
      if v_n <> 19 then raise exception '0114: client_review_comments נושאת % עמודות במקום 19', v_n; end if;
      select count(*) into v_n from information_schema.columns
       where table_schema = 'public' and table_name = 'client_review_approvals';
      if v_n <> 12 then raise exception '0114: client_review_approvals נושאת % עמודות במקום 12', v_n; end if;

      -- 7g. born empty; nothing existing touched.
      if exists (select 1 from public.client_review_versions)
         or exists (select 1 from public.client_review_comments)
         or exists (select 1 from public.client_review_approvals) then
        raise exception '0114: טבלה חדשה אינה ריקה — עצור וברר';
      end if;
      if (select count(*) from public.client_review_items) <> v_items_before
         or (select count(*) from public.client_review_links) <> v_links_before
         or (select count(*) from public.productions) <> v_prod_before then
        raise exception '0114: ספירת טבלה קיימת השתנתה — המיגרציה אמורה להיות אדיטיבית בלבד';
      end if;

      raise notice '0114 OK — 3 טבלאות (24/19/12 עמודות) + תצוגה + 2 פונקציות · anon/authenticated אפס · service_role בלבד · items=% links=% productions=% ללא שינוי',
        v_items_before, v_links_before, v_prod_before;

      -- ═══ 8. ledger row, last ═══
      insert into public.schema_ledger (version, applied_at, applied_by, note)
      values ('0114', now(), current_user,
        'E13-2: סכימה בלבד לביקורת לקוח על Bunny Stream (docs/plans/E13-review-bunny.md). שלוש טבלאות חדשות, תצוגה ושתי פונקציות; אפס שינוי בטבלה קיימת ואפס backfill. '
        || 'client_review_versions — גרסה פר קובץ של פריט (v1, v2…), source drive או bunny, מזהה הספרייה וה-guid של Bunny, הסטטוס שלנו (created/uploading/processing/playable/ready/failed) והקוד הגולמי, has_original ו-original_sha256, ועמודות מחיקה (media_deleted_at נכתב רק אחרי מחיקה שאושרה, delete_attempts, delete_last_error). '
        || 'Q11 (הכרעת בעלים 15.10): המספר מוקצה רק אחרי העלאה מוצלחת — number nullable, unique חלקי (item_id, number) where number is not null, והקצאה רק דרך assign_review_version_number בנעילת שורת הפריט; גרסת drive נולדת ממוספרת. '
        || 'CHECK: ready רק עם has_original=true ו-original_sha256 (הכלל של §9 נאכף גם בבסיס). '
        || 'client_review_comments — נעצים (מעוגנים לגרסה, מספור פר גרסה) והערות כלליות, עם resolved/acked/after_response. create_review_pin מקצה מספר ומכניס את הנעץ באותה נעילה. '
        || 'client_review_approvals — היסטוריית החלטות append-only, revoked_at ל-B10. v_review_media_purge_due — מועד המחיקה הנגזר: האישור התקף האחרון + 90 יום, לכל גרסאות ה-Bunny של הפריט; פריט בלי אישור תקף לא נמחק לעולם. '
        || 'סטיות מהתכנון: backfill_source ו-created_at על האישורים; ה-backfill בסקריפט נפרד (scripts/e13_backfill_v1.ts, dry-run כברירת מחדל) ולא במיגרציה. '
        || 'הרשאות: anon/authenticated אפס על הכל, RLS דלוק, אפס policies, service_role בלבד; הפונקציות security definer עם search_path=public ו-EXECUTE ל-service_role בלבד.');

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
  end;
    raise exception 'DRYRUN_PASS';
  exception when others then
    if sqlerrm = 'DRYRUN_PASS' then
      v_msg := E'✅ 0114 dryrun עברה. **אפס שינוי נשאר על המסד** — השורה האדומה הזאת היא הפלט הצפוי.\n═══ מה הוכח ═══' || v_rep;
    else
      v_msg := E'❌ 0114 dryrun נכשלה.\n═══ מה נבדק עד לנקודת הכשל ═══' || v_rep
            || E'\n\n═══ השגיאה ═══\n  ' || sqlstate || ' ' || sqlerrm;
    end if;
  end;
  raise exception '%', v_msg;
end $dry$;
