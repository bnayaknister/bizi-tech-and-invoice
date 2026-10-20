-- ============================================================================
-- 0120 — B35: כונני אחסון כרשימה סגורה (storage_disks), איחוד כפולים.
--
-- הכרעות בעלים 20.10:
--   1. kong ו-kong 3 הם אותו כונן; השם שנשאר "kong". גם "kong 3\" → "kong".
--   2. wd3 → "wd 3".
--   3. "מקלובי" ו-"Mac lobby Pro Max" — שני מחשבים שונים, לא מאוחדים.
--   4. terra, zilla וכל השאר נשארים כמו שהם.
--   5. "2" (סטימצקי, 9.8, e72387e2) — השדה מתרוקן; ההפקה בלי כונן.
--   6. DESKTOP — קיים רק בהיסטוריה, לא נכנס לרשימה.
--   7. היסטוריה: גם יומן ההפקה (production_log, kind='disk') וגם האירועים
--      (events, payload.changes.storage_disk.from/to) משוכתבים — רק לשלושת
--      שמות האיחוד (kong 3, kong 3\, wd3) — בלי לסמן "נערך".
--
-- ═══ מה נבנה ═══
--   • storage_disk_key(text): השם בלי רווחים ובאותיות קטנות — המפתח הייחודי.
--   • storage_disks (id, name, hidden, created_at, created_by) + אינדקס ייחודי
--     על המפתח. RLS: קריאה — can_view_stages או can_view_money; כתיבה — is_owner
--     (owner או admin, 0119). הרשאות מוצהרות במפורש (pg_default_acl, 0071).
--   • productions.storage_disk_id → storage_disks(id) ON DELETE RESTRICT: כונן
--     שיש אליו הפקה לא נמחק (המסך מסתיר אותו במקום). grant select ל-authenticated
--     (רשימת היתר עמודתית, 0070). העמודה productions.storage_disk (טקסט) נשארת —
--     החיפוש, הדרואר וההיסטוריה קוראים אותה — והטריגר מחזיק את שתיהן מסונכרנות.
--   • trg_disk_sync (BEFORE INSERT/UPDATE של שתי העמודות): בחירה לפי id ממלאת
--     את השם; כתיבת טקסט (קוד ישן) מתורגמת לכונן לפי המפתח, ושם שאינו ברשימה
--     **נדחה** ("בחרו כונן מהרשימה, או בקשו מבניה להוסיף אותו"). בחירה חדשה של
--     כונן מוסתר נדחית; הפקה שכבר עליו נשארת.
--   • trg_disk_rename_cascade (AFTER UPDATE OF name על storage_disks): שינוי שם
--     מעדכן את הטקסט בהפקות של הכונן. log_disk_change מדלג על זה — שינוי שם
--     אינו "הטכנאי החליף כונן" — ולכן ההיסטוריה שומרת את השם שהיה אז.
--
-- ═══ שינוי נתונים ═══
--   productions.storage_disk: kong 3/kong 3\ → kong, wd3 → wd 3, "2" → NULL
--   (רק ההפקה e72387e2), רווחים בקצוות נחתכים. trg_log_disk_change כבוי בזמן
--   הזה — האיחוד אינו "החלפת כונן" ולא נכתבות שורות יומן מזויפות.
--   production_log.note (kind='disk') ו-events: אותם שלושה שמות בלבד.
--   trg_guard_production_log_edit כבוי בזמן הזה — אחרת edited_at מסמן "נערך".
--   אפס DELETE.
--
-- סדר: supabase/verify/0120_dryrun.sql → הקובץ הזה → supabase/verify/0120_verify.sql
-- אחרי ההחלה: gen types (שלב של הבעלים) — הקוד ממתין לזה.
-- ============================================================================

do $mig$
declare
  v_n         bigint;
  v_with_disk bigint;
  v_merged    bigint;
  v_cleared   bigint;
  v_log       bigint;
  v_ev_from   bigint;
  v_ev_to     bigint;
  v_disks     bigint;
begin
  -- >>> BODY
  -- ═══ 0. guards ═══
  if exists (select 1 from public.schema_ledger where version = '0120') then
    raise exception '0120 כבר רשומה בפנקס — אל תריץ שוב';
  end if;
  if not exists (select 1 from public.schema_ledger where version = '0119') then
    raise exception '0119 טרם הוחלה — הרץ אותה קודם';
  end if;
  if to_regclass('public.storage_disks') is not null then
    raise exception '0120: הטבלה storage_disks כבר קיימת — עצור וברר';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'productions' and column_name = 'storage_disk_id') then
    raise exception '0120: productions.storage_disk_id כבר קיימת — עצור וברר';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.productions'::regclass
                  and tgname = 'trg_log_disk_change' and tgenabled = 'O') then
    raise exception '0120: trg_log_disk_change אינו קיים/פעיל — עצור וברר';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.production_log'::regclass
                  and tgname = 'trg_guard_production_log_edit' and tgenabled = 'O') then
    raise exception '0120: trg_guard_production_log_edit אינו קיים/פעיל — עצור וברר';
  end if;
  if pg_get_functiondef('public.log_disk_change()'::regprocedure) not like '%''disk'', new.storage_disk, auth.uid()%' then
    raise exception '0120: log_disk_change() אינה בצורה הצפויה — עצור וברר';
  end if;
  -- "2" is exactly the one production the owner decided about
  select count(*) into v_n from public.productions where storage_disk = '2';
  if v_n > 1 or (v_n = 1 and not exists (select 1 from public.productions
                  where id = 'e72387e2-bf88-4ed0-8ee1-8234c266b1b0' and storage_disk = '2')) then
    raise exception '0120: הכונן "2" מופיע בהפקה אחרת מזו שהוכרעה (%) — עצור וברר', v_n;
  end if;

  -- ═══ 1. the key: no spaces, lower case ═══
  create function public.storage_disk_key(p text)
   returns text
   language sql
   immutable parallel safe
   set search_path to 'pg_catalog'
  as $f$ select lower(regexp_replace(btrim(p), '\s+', '', 'g')) $f$;
  revoke all on function public.storage_disk_key(text) from public;
  grant execute on function public.storage_disk_key(text) to authenticated, service_role;

  -- ═══ 2. the table ═══
  create table public.storage_disks (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    hidden     boolean not null default false,
    created_at timestamptz not null default now(),
    created_by uuid references public.profiles(id) on delete set null,
    constraint storage_disks_name_clean check (name = btrim(name) and name <> '' and char_length(name) <= 60)
  );
  create unique index storage_disks_key_uniq on public.storage_disks (public.storage_disk_key(name));
  comment on table public.storage_disks is
    'B35 (0120): the closed list of recording disks. productions.storage_disk_id points here; the technician picks from the non-hidden rows. A disk with productions is hidden, never deleted (FK RESTRICT). Unique by storage_disk_key(name): no spaces, lower case.';

  alter table public.storage_disks enable row level security;
  create policy storage_disks_select on public.storage_disks
    for select using ((select public.can_view_stages()) or (select public.can_view_money()));
  create policy storage_disks_insert on public.storage_disks
    for insert with check ((select public.is_owner()));
  create policy storage_disks_update on public.storage_disks
    for update using ((select public.is_owner())) with check ((select public.is_owner()));
  create policy storage_disks_delete on public.storage_disks
    for delete using ((select public.is_owner()));
  revoke all on table public.storage_disks from public, anon, authenticated;
  grant select, insert, update, delete on table public.storage_disks to authenticated;
  grant all on table public.storage_disks to service_role;

  -- ═══ 3. merge the duplicates on productions (owner 20.10) ═══
  select count(*) into v_with_disk from public.productions where storage_disk is not null;
  alter table public.productions disable trigger trg_log_disk_change;
  update public.productions p
     set storage_disk = m.to_name
    from (values ('kong 3', 'kong'), ('kong 3\', 'kong'), ('wd3', 'wd 3')) as m(from_name, to_name)
   where p.storage_disk = m.from_name;
  get diagnostics v_merged = row_count;
  update public.productions
     set storage_disk = null
   where id = 'e72387e2-bf88-4ed0-8ee1-8234c266b1b0' and storage_disk = '2';
  get diagnostics v_cleared = row_count;
  update public.productions
     set storage_disk = nullif(btrim(storage_disk), '')
   where storage_disk is distinct from nullif(btrim(storage_disk), '');
  alter table public.productions enable trigger trg_log_disk_change;

  -- ═══ 4. history: the same three names, never marked "edited" ═══
  alter table public.production_log disable trigger trg_guard_production_log_edit;
  update public.production_log l
     set note = m.to_name
    from (values ('kong 3', 'kong'), ('kong 3\', 'kong'), ('wd3', 'wd 3')) as m(from_name, to_name)
   where l.kind = 'disk' and l.note = m.from_name;
  get diagnostics v_log = row_count;
  alter table public.production_log enable trigger trg_guard_production_log_edit;

  update public.events e
     set payload = jsonb_set(e.payload, '{changes,storage_disk,from}', to_jsonb(m.to_name))
    from (values ('kong 3', 'kong'), ('kong 3\', 'kong'), ('wd3', 'wd 3')) as m(from_name, to_name)
   where e.entity_type = 'production'
     and e.payload #>> '{changes,storage_disk,from}' = m.from_name;
  get diagnostics v_ev_from = row_count;
  update public.events e
     set payload = jsonb_set(e.payload, '{changes,storage_disk,to}', to_jsonb(m.to_name))
    from (values ('kong 3', 'kong'), ('kong 3\', 'kong'), ('wd3', 'wd 3')) as m(from_name, to_name)
   where e.entity_type = 'production'
     and e.payload #>> '{changes,storage_disk,to}' = m.from_name;
  get diagnostics v_ev_to = row_count;

  -- ═══ 5. the list: every disk a production carries now ═══
  insert into public.storage_disks (name, created_at)
  select s.d,
         coalesce((select min(l.created_at) from public.production_log l where l.kind = 'disk' and l.note = s.d), now())
    from (select distinct storage_disk as d from public.productions where storage_disk is not null) s;
  get diagnostics v_disks = row_count;

  -- ═══ 6. the reference ═══
  alter table public.productions
    add column storage_disk_id uuid references public.storage_disks(id) on delete restrict;
  create index productions_storage_disk_id_idx on public.productions (storage_disk_id) where storage_disk_id is not null;
  grant select (storage_disk_id) on public.productions to authenticated;
  update public.productions p
     set storage_disk_id = d.id
    from public.storage_disks d
   where d.name = p.storage_disk;

  -- ═══ 7. keep the two columns in step; refuse a name that is not on the list ═══
  create function public.storage_disk_sync()
   returns trigger
   language plpgsql
   security definer
   set search_path to 'public'
  as $f$
  declare
    v_id     uuid;
    v_name   text;
    v_hidden boolean;
  begin
    if tg_op = 'UPDATE'
       and new.storage_disk_id is not distinct from old.storage_disk_id
       and new.storage_disk is not distinct from old.storage_disk then
      return new;
    end if;

    -- the id path (the app): the name follows the id
    if (tg_op = 'INSERT' and new.storage_disk_id is not null)
       or (tg_op = 'UPDATE' and new.storage_disk_id is distinct from old.storage_disk_id) then
      if new.storage_disk_id is null then
        new.storage_disk := null;
        return new;
      end if;
      select name, hidden into v_name, v_hidden from public.storage_disks where id = new.storage_disk_id;
      if not found then
        raise exception 'הכונן שנבחר אינו קיים — בחרו כונן מהרשימה';
      end if;
      if v_hidden then
        raise exception 'הכונן "%" מוסתר — בחרו כונן מהרשימה', v_name;
      end if;
      new.storage_disk := v_name;
      return new;
    end if;

    -- the text path (older code, the rename cascade): by the key, or refused
    if new.storage_disk is null or btrim(new.storage_disk) = '' then
      new.storage_disk := null;
      new.storage_disk_id := null;
      return new;
    end if;
    select id, name, hidden into v_id, v_name, v_hidden
      from public.storage_disks where public.storage_disk_key(name) = public.storage_disk_key(new.storage_disk);
    if not found then
      raise exception 'הכונן "%" אינו ברשימה — בחרו כונן מהרשימה, או בקשו מבניה להוסיף אותו', new.storage_disk;
    end if;
    if v_hidden and (tg_op = 'INSERT' or v_id is distinct from old.storage_disk_id) then
      raise exception 'הכונן "%" מוסתר — בחרו כונן מהרשימה', v_name;
    end if;
    new.storage_disk_id := v_id;
    new.storage_disk := v_name;
    return new;
  end;
  $f$;
  revoke all on function public.storage_disk_sync() from public;
  grant execute on function public.storage_disk_sync() to authenticated, service_role;
  -- "trg_disk_…" sorts BEFORE "trg_guard_…": the stages guard sees the final name
  create trigger trg_disk_sync
    before insert or update of storage_disk, storage_disk_id on public.productions
    for each row execute function public.storage_disk_sync();

  -- ═══ 8. a rename reaches the productions, and is not a disk change ═══
  create function public.storage_disk_rename_cascade()
   returns trigger
   language plpgsql
   security definer
   set search_path to 'public'
  as $f$
  begin
    update public.productions
       set storage_disk = new.name
     where storage_disk_id = new.id and storage_disk is distinct from new.name;
    return new;
  end;
  $f$;
  revoke all on function public.storage_disk_rename_cascade() from public;
  grant execute on function public.storage_disk_rename_cascade() to authenticated, service_role;
  create trigger trg_disk_rename_cascade
    after update of name on public.storage_disks
    for each row when (new.name is distinct from old.name)
    execute function public.storage_disk_rename_cascade();

  create or replace function public.log_disk_change()
   returns trigger
   language plpgsql
   security definer
   set search_path to 'public'
  as $f$
  begin
    -- 0120: the same disk under a new name (storage_disks rename) is not a
    -- change of disk — the log keeps the name it had at the time
    if new.storage_disk_id is not null and new.storage_disk_id is not distinct from old.storage_disk_id then
      return new;
    end if;
    insert into public.production_log (production_id, kind, note, author_id)
    values (new.id, 'disk', new.storage_disk, auth.uid());
    return new;
  end;
  $f$;
  -- `UPDATE OF storage_disk` alone does NOT fire when the statement sets only
  -- storage_disk_id and trg_disk_sync fills the name (a column trigger fires on
  -- the SET list, not on what a BEFORE trigger changed) — caught on local PG:
  -- choosing a disk from the list would have left no line in the log
  drop trigger trg_log_disk_change on public.productions;
  create trigger trg_log_disk_change
    after update of storage_disk, storage_disk_id on public.productions
    for each row when (new.storage_disk is distinct from old.storage_disk)
    execute function public.log_disk_change();

  -- ═══ 9. canaries ═══
  select count(*) into v_n from public.productions
   where storage_disk is not null
     and (storage_disk_id is null
          or storage_disk is distinct from (select d.name from public.storage_disks d where d.id = storage_disk_id));
  if v_n <> 0 then raise exception '0120 canary: % הפקות עם טקסט כונן שאין לו שורה תואמת', v_n; end if;
  select count(*) into v_n from public.productions where storage_disk is not null;
  if v_n <> v_with_disk - v_cleared then
    raise exception '0120 canary: מספר ההפקות עם כונן השתנה (% לפני, % אחרי, % רוקנו)', v_with_disk, v_n, v_cleared;
  end if;
  select count(*) into v_n from public.productions where storage_disk in ('kong 3', 'kong 3\', 'wd3', '2');
  if v_n <> 0 then raise exception '0120 canary: % הפקות עדיין עם שם שאוחד/רוקן', v_n; end if;
  select count(*) into v_n from public.production_log where kind = 'disk' and note in ('kong 3', 'kong 3\', 'wd3');
  if v_n <> 0 then raise exception '0120 canary: % שורות יומן עדיין עם שם שאוחד', v_n; end if;
  select count(*) into v_n from public.events
   where payload #>> '{changes,storage_disk,from}' in ('kong 3', 'kong 3\', 'wd3')
      or payload #>> '{changes,storage_disk,to}' in ('kong 3', 'kong 3\', 'wd3');
  if v_n <> 0 then raise exception '0120 canary: % אירועים עדיין עם שם שאוחד', v_n; end if;
  if exists (select 1 from public.storage_disks where name in ('kong 3', 'wd3', '2', 'DESKTOP')) then
    raise exception '0120 canary: שם שאוחד/רוקן/היסטורי נכנס לרשימה';
  end if;
  if exists (select 1 from public.production_log where edited_at = now()) then  -- now() = this transaction: only a row this migration touched
    raise exception '0120 canary: שורת יומן סומנה "נערך"';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.productions'::regclass and tgname = 'trg_log_disk_change' and tgenabled = 'O')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.production_log'::regclass and tgname = 'trg_guard_production_log_edit' and tgenabled = 'O') then
    raise exception '0120 canary: טריגר שכובה לא הודלק מחדש';
  end if;
  if has_table_privilege('anon', 'public.storage_disks', 'select') then
    raise exception '0120 canary: ל-anon יש הרשאה על storage_disks';
  end if;
  if not has_column_privilege('authenticated', 'public.productions', 'storage_disk_id', 'select') then
    raise exception '0120 canary: authenticated אינו קורא את storage_disk_id';
  end if;

  raise notice '0120 OK — % כוננים, % הפקות אוחדו, % רוקנו, % שורות יומן, %+% אירועים', v_disks, v_merged, v_cleared, v_log, v_ev_from, v_ev_to;

  -- ═══ 10. ledger row, last ═══
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0120', now(), current_user,
    'B35, הכרעות בעלים 20.10: storage_disks (רשימה סגורה, ייחודי לפי storage_disk_key = בלי רווחים ובאותיות קטנות, RLS: קריאה stages/money, כתיבה is_owner), '
    || 'productions.storage_disk_id (FK RESTRICT, grant select), trg_disk_sync (שם לפי id; טקסט מתורגם לפי המפתח או נדחה; כונן מוסתר לא נבחר מחדש), '
    || 'trg_disk_rename_cascade + log_disk_change מדלג על שינוי שם. איחוד: kong 3/kong 3\ → kong, wd3 → wd 3 (הפקות ' || v_merged
    || ', יומן ' || v_log || ', אירועים ' || (v_ev_from + v_ev_to) || ', בלי "נערך" ובלי שורות יומן חדשות); "2" רוקן בהפקה e72387e2 (' || v_cleared
    || '); ' || v_disks || ' כוננים ברשימה. אפס DELETE.');
  -- <<< BODY
end $mig$;
