-- ============================================================================
-- 0115 — E13-2/E13-6: the deletion date also waits for the latest version.
--
-- OWNER DECISION 15.10 (edge case raised in the E13-2 report): an item
-- approved more than 90 days ago that gets a NEW Bunny version would have been
-- purge-eligible on the very next cron run. The rule now:
--
--   purge_after = 90 days from the LATER of
--                 (a) the item's last valid approval (approved, not revoked), and
--                 (b) the moment the item's latest version reached 'ready'.
--
-- WHAT THIS CHANGES
--   1. client_review_versions.ready_at — when the version FIRST reached
--      'ready'. Owned by a trigger, not by callers: set once (now()) on the
--      transition to 'ready', never moved again, and anything a caller passes
--      is overwritten. bunny_status_at is NOT usable for this — it moves on
--      every status write, and a later refetch would silently push the date.
--      CHECK: 'ready' ⇒ ready_at; ready_at only on 'bunny' rows.
--   2. v_review_media_purge_due — same four leading columns (item_id,
--      approval_id, approved_at, purge_after; so `create or replace` keeps the
--      grants and the security_invoker option), plus three appended columns
--      that explain the date:
--        latest_version_id   the item's highest-numbered version
--        latest_ready_at     its ready_at (null for a Drive version)
--        upload_pending      a Bunny version without a number that has not
--                            failed and is not deleted — an upload in progress
--
-- HOW (b) IS READ — interpretation, stated so it can be overruled:
--   · "latest version" = highest `number`. Numberless rows are not versions
--     the client can see yet (Q11).
--   · latest is Bunny and not ready yet → (b) has not happened → purge_after
--     is NULL (not schedulable). It becomes a date when it reaches ready.
--   · latest is Drive → there is no Bunny ready moment; (a) alone applies.
--     (Drive files are never deleted by us — the cron only touches Bunny
--     versions, but older Bunny versions of the item still follow this date.)
--   · upload_pending → purge_after is NULL: the cron must not delete an item's
--     files while a new version of it is being uploaded.
--
-- No rows exist that this could break: the backfill (Drive only) has not run
-- and no Bunny version exists yet — the canary asserts no 'ready' row lacks
-- ready_at before the CHECK is added.
--
-- PERMISSIONS: unchanged and re-asserted — view and table closed to
-- anon/authenticated, service_role reads; the trigger function is not
-- callable from a session.
-- ============================================================================

do $mig$
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
end $mig$;
